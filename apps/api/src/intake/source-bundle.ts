import { createHash } from "node:crypto";

export const sourceNames = ["orders.csv", "bom.csv", "purchases.csv"] as const;
export type SourceName = (typeof sourceNames)[number];
export const columns: Record<SourceName, readonly string[]> = {
  "orders.csv": [
    "orderId",
    "customer",
    "promisedDate",
    "forecastDate",
    "status",
  ],
  "bom.csv": ["orderId", "plannedBomDate", "actualBomDate", "completionStatus"],
  "purchases.csv": [
    "orderId",
    "plannedStartDate",
    "actualStartDate",
    "arrivalRisk",
  ],
};
export const intakeLimits = {
  bytesPerFile: 5 * 1024 * 1024,
  rows: 10000,
  fieldCharacters: 500,
} as const;
export type SourceRecord = {
  sourceRow: number;
  values: Record<string, string>;
};
export type ParsedSource = {
  name: SourceName;
  bytes: Buffer;
  sha256: string;
  records: SourceRecord[];
};
export type SourceBundle = {
  schemaVersion: 1;
  batchId: string;
  digest: string;
  files: ParsedSource[];
};
const fail = (message: string): never => {
  throw new Error(`Source intake: ${message}`);
};
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function validDate(value: string): boolean {
  if (!/^(20\d\d|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}
/** Strict UTF-8 CSV. Source row is a 1-based LOGICAL record (header is 1),
 * not a physical line when a quoted cell contains a newline. No repair/guessing. */
export function parseSource(name: SourceName, input: Uint8Array): ParsedSource {
  if (!sourceNames.includes(name)) fail("unknown file");
  if (input.byteLength < 1 || input.byteLength > intakeLimits.bytesPerFile)
    fail(`${name}: invalid file size`);
  const bytes = Buffer.from(input);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${name}: expected UTF-8`);
  }
  text = text.replace(/^\uFEFF/, "");
  const hasControlCharacter = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
  if (hasControlCharacter) fail(`${name}: control character`);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let endedRecord = false;
  const pushField = () => {
    if (field.length > intakeLimits.fieldCharacters)
      fail(`${name}: cell too long`);
    record.push(field);
    field = "";
    state = "start";
    if (record.length > columns[name].length) fail(`${name}: extra field`);
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
    if (records.length > intakeLimits.rows + 1)
      fail(`${name}: too many records`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    endedRecord = false;
    if (state === "quoted") {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else field += ch;
    } else if (ch === ",") pushField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r") {
        if (text[i + 1] !== "\n")
          fail(`${name}: bare CR outside a quoted field`);
        i++;
      }
      pushRecord();
      endedRecord = true;
    } else if (ch === '"' && state === "start") state = "quoted";
    else {
      if (state === "closed" || ch === '"') fail(`${name}: malformed quoting`);
      field += ch;
      state = "plain";
    }
    if (field.length > intakeLimits.fieldCharacters)
      fail(`${name}: cell too long`);
  }
  if (state === "quoted") fail(`${name}: unclosed quote`);
  if (!endedRecord) pushRecord();
  const header = records.shift();
  if (
    !header ||
    header.length !== columns[name].length ||
    header.some((x, i) => x !== columns[name][i])
  )
    fail(`${name}: headers must exactly be ${columns[name].join(",")}`);
  if (!records.length) fail(`${name}: empty dataset`);
  const ids = new Set<string>();
  const parsed = records.map((fields, index) => {
    if (fields.length !== columns[name].length)
      fail(`${name}: record ${index + 2}: wrong field count`);
    const values: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [column, value] of columns[name].map(
      (key, n) => [key, fields[n]!] as const,
    )) {
      if (!value || value !== value.trim())
        fail(`${name}: record ${index + 2}: blank or padded ${column}`);
      if (column.endsWith("Date") && !validDate(value))
        fail(`${name}: record ${index + 2}: invalid calendar date`);
      if (
        column === "orderId" &&
        !/^[A-Za-z0-9][A-Za-z0-9_-]{1,100}$/.test(value)
      )
        fail(`${name}: invalid order ID`);
      if (column !== "customer" && /[\r\n\t]/.test(value))
        fail(`${name}: invalid newline/tab`);
      if (column === "status" && value === "E2E_ACCEPTANCE")
        fail("test-only status is not business data");
      values[column] = value;
    }
    const id = values.orderId!;
    if (ids.has(id)) fail(`${name}: duplicate order ID`);
    ids.add(id);
    return { sourceRow: index + 2, values };
  });
  return { name, bytes, sha256: sha256(bytes), records: parsed };
}
export function parseBundle(
  batchId: string,
  files: Record<SourceName, Uint8Array>,
): SourceBundle {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      batchId,
    )
  )
    fail("batchId must be a UUID");
  if (
    Object.keys(files).length !== 3 ||
    Object.keys(files).some((key) => !sourceNames.includes(key as SourceName))
  )
    fail("exactly three source files are required");
  const parsed = sourceNames.map((name) => parseSource(name, files[name]));
  const ids = new Set(parsed[0]!.records.map((row) => row.values.orderId));
  for (const file of parsed.slice(1))
    if (
      file.records.length !== ids.size ||
      file.records.some((row) => !ids.has(row.values.orderId))
    )
      fail(
        "orders, BOM and purchases must contain the same complete order ID set",
      );
  return {
    schemaVersion: 1,
    batchId: batchId.toLowerCase(),
    digest: sha256(
      JSON.stringify({
        schemaVersion: 1,
        files: parsed.map((f) => ({ name: f.name, sha256: f.sha256 })),
      }),
    ),
    files: parsed,
  };
}
