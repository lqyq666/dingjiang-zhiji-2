import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  applyFeishuSchema,
  FeishuSchemaConflictError,
  planFeishuSchema,
  verifyFeishuSchema,
} from "./engine";
import { FeishuSchemaApiError, FeishuSchemaClient } from "./feishu-client";
import { feishuPermissionManifest, feishuSchemaManifest } from "./manifest";

type Command = "plan" | "apply" | "verify";

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !["plan", "apply", "verify"].includes(command)) {
    throw new Error("Usage: tsx src/cli.ts <plan|apply|verify>");
  }
  const repoRoot = await findRepoRoot(process.cwd());
  await loadDotEnv(join(repoRoot, ".env"));
  const client = clientFromEnvironment();
  const snapshot = await client.snapshot();
  const configuredIds = client.configuredTableIds();

  if (command === "plan") {
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      snapshot,
      configuredIds,
    );
    print({
      command,
      readOnly: true,
      diff: plan.diff,
      actions: plan.actions.map(publicAction),
      conflicts: plan.conflicts,
      summary: {
        create: plan.actions.length,
        resourcesToCreate: plan.diff.filter((item) =>
          item.status.startsWith("CREATE_"),
        ).length,
        conflicts: plan.conflicts.length,
        byStatus: countByStatus(plan.diff),
        destructive: plan.destructiveChanges,
      },
    });
    if (plan.conflicts.length > 0) process.exitCode = 2;
    return;
  }

  if (command === "apply") {
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      snapshot,
      configuredIds,
    );
    const applied = await applyFeishuSchema(plan, client);
    const auditPath = join(repoRoot, ".feishu-schema", "audit.jsonl");
    for (const action of applied) {
      await audit(auditPath, action);
    }
    const after = await client.snapshot();
    const verification = verifyFeishuSchema(
      feishuSchemaManifest,
      after,
      configuredIds,
    );
    print({
      command,
      applied,
      summary: {
        created: applied.length,
        destructive: 0,
        verified: verification.ok,
      },
      permission: feishuPermissionManifest.status,
    });
    if (!verification.ok) process.exitCode = 3;
    return;
  }

  const verification = verifyFeishuSchema(
    feishuSchemaManifest,
    snapshot,
    configuredIds,
  );
  print({
    command,
    ok: verification.ok,
    missing: verification.plan.actions.map(publicAction),
    conflicts: verification.plan.conflicts,
    recordCountFailures: verification.recordCountFailures,
    destructive: verification.plan.destructiveChanges,
    permission: feishuPermissionManifest,
  });
  if (!verification.ok) process.exitCode = 4;
}

function clientFromEnvironment(): FeishuSchemaClient {
  const required = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BASE_APP_TOKEN",
    "FEISHU_REVIEW_TABLE_ID",
  ] as const;
  for (const name of required) requiredEnvironment(name);
  if (process.env.FEISHU_PROVIDER_MODE !== "FEISHU") {
    throw new FeishuSchemaApiError(
      "CONFIG_MISSING",
      "FEISHU_PROVIDER_MODE must be FEISHU",
    );
  }
  return new FeishuSchemaClient({
    appId: requiredEnvironment("FEISHU_APP_ID"),
    appSecret: requiredEnvironment("FEISHU_APP_SECRET"),
    baseAppToken: requiredEnvironment("FEISHU_BASE_APP_TOKEN"),
    reviewTableId: requiredEnvironment("FEISHU_REVIEW_TABLE_ID"),
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /^<.+>$/.test(value)) {
    throw new FeishuSchemaApiError(
      "CONFIG_MISSING",
      `${name} is not configured`,
    );
  }
  return value;
}

async function loadDotEnv(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    const raw = match[2] ?? "";
    process.env[match[1]] = unquote(raw.trim());
  }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function findRepoRoot(start: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      await readFile(join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("Repository root not found");
      current = parent;
    }
  }
}

async function audit(path: string, action: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", { flag: "a" });
  await appendFile(
    path,
    `${JSON.stringify({ at: new Date().toISOString(), ...action })}\n`,
    "utf8",
  );
}

function publicAction(
  action: ReturnType<typeof planFeishuSchema>["actions"][number],
) {
  if (action.type === "create_table") {
    return { type: action.type, table: action.table.name };
  }
  if (action.type === "create_field") {
    return {
      type: action.type,
      table: action.tableName,
      field: action.field.name,
    };
  }
  return { type: action.type, table: action.tableName, view: action.viewName };
}

function countByStatus(
  diff: ReturnType<typeof planFeishuSchema>["diff"],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of diff) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const safe =
    error instanceof FeishuSchemaApiError ||
    error instanceof FeishuSchemaConflictError
      ? {
          name: error.name,
          code: "code" in error ? error.code : "SCHEMA_CONFLICT",
          message: error.message,
        }
      : {
          name: "Error",
          code: "UNEXPECTED",
          message: error instanceof Error ? error.message : "Unexpected error",
        };
  process.stderr.write(`${JSON.stringify({ ok: false, error: safe })}\n`);
  process.exitCode = 1;
});
