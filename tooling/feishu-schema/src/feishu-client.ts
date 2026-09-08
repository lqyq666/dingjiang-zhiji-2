import { randomUUID } from "node:crypto";

import type {
  FeishuFieldSnapshot,
  FeishuSchemaSnapshot,
  FeishuTableSnapshot,
  FeishuViewSnapshot,
} from "./engine";
import type { FeishuFieldKind, FieldManifest, TableManifest } from "./manifest";

const API_ROOT = "https://open.feishu.cn/open-apis";
const DEFAULT_TIMEOUT_MS = 10_000;

export class FeishuSchemaApiError extends Error {
  constructor(
    readonly code:
      | "CONFIG_MISSING"
      | "HTTP_FAILED"
      | "API_FAILED"
      | "INVALID_RESPONSE"
      | "TIMEOUT",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FeishuSchemaApiError";
  }
}

type FeishuClientOptions = {
  appId: string;
  appSecret: string;
  baseAppToken: string;
  reviewTableId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

export class FeishuSchemaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private tokenCache: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: FeishuClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  configuredTableIds(): Readonly<Record<string, string>> {
    return { FEISHU_REVIEW_TABLE_ID: this.options.reviewTableId };
  }

  async snapshot(): Promise<FeishuSchemaSnapshot> {
    const tables = await this.listTables();
    const hydrated: FeishuTableSnapshot[] = [];
    for (const table of tables) {
      const [fields, views, recordCount] = await Promise.all([
        this.listFields(table.id),
        this.listViews(table.id),
        table.id === this.options.reviewTableId
          ? this.recordCount(table.id)
          : Promise.resolve(null),
      ]);
      hydrated.push({ ...table, fields, views, recordCount });
    }
    return { tables: hydrated };
  }

  async createTable(table: TableManifest): Promise<string> {
    const response = await this.request(
      "POST",
      `/bitable/v1/apps/${this.appToken()}/tables`,
      {
        table: {
          name: table.name,
          default_view_name: table.views[0] ?? "表格",
          fields: table.fields.map(fieldRequest),
        },
      },
    );
    return requiredText(objectField(response, "data"), "table_id");
  }

  async createField(tableId: string, field: FieldManifest): Promise<string> {
    const response = await this.request(
      "POST",
      `/bitable/v1/apps/${this.appToken()}/tables/${encodeURIComponent(tableId)}/fields?client_token=${randomUUID()}`,
      fieldRequest(field),
    );
    return requiredText(
      objectField(objectField(response, "data"), "field"),
      "field_id",
    );
  }

  async createView(tableId: string, viewName: string): Promise<string> {
    const response = await this.request(
      "POST",
      `/bitable/v1/apps/${this.appToken()}/tables/${encodeURIComponent(tableId)}/views`,
      { view_name: viewName, view_type: "grid" },
    );
    return requiredText(
      objectField(objectField(response, "data"), "view"),
      "view_id",
    );
  }

  private async listTables(): Promise<
    Omit<FeishuTableSnapshot, "fields" | "views" | "recordCount">[]
  > {
    const items = await this.paginated(
      `/bitable/v1/apps/${this.appToken()}/tables`,
      100,
    );
    return items.map((item) => ({
      id: requiredText(item, "table_id"),
      name: requiredText(item, "name"),
    }));
  }

  private async listFields(tableId: string): Promise<FeishuFieldSnapshot[]> {
    const items = await this.paginated(
      `/bitable/v1/apps/${this.appToken()}/tables/${encodeURIComponent(tableId)}/fields`,
      200,
    );
    return items.map((item) => ({
      id: requiredText(item, "field_id"),
      name: requiredText(item, "field_name"),
      kind: fieldKind(item.type),
      options: selectOptionNames(item.property),
    }));
  }

  private async listViews(tableId: string): Promise<FeishuViewSnapshot[]> {
    const items = await this.paginated(
      `/bitable/v1/apps/${this.appToken()}/tables/${encodeURIComponent(tableId)}/views`,
      200,
    );
    return items.map((item) => ({
      id: requiredText(item, "view_id"),
      name: requiredText(item, "view_name"),
      type: requiredText(item, "view_type"),
    }));
  }

  private async recordCount(tableId: string): Promise<number> {
    const response = await this.request(
      "GET",
      `/bitable/v1/apps/${this.appToken()}/tables/${encodeURIComponent(tableId)}/records?page_size=1`,
    );
    return requiredNumber(objectField(response, "data"), "total");
  }

  private async paginated(
    path: string,
    pageSize: number,
  ): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    let pageToken: string | undefined;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const query = `${separator}page_size=${pageSize}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await this.request("GET", `${path}${query}`);
      const data = objectField(response, "data");
      items.push(
        ...requiredArray(data, "items").map((item) =>
          requiredObject(item, "item"),
        ),
      );
      pageToken =
        data.has_more === true ? requiredText(data, "page_token") : undefined;
    } while (pageToken);
    return items;
  }

  private async tenantToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now())
      return this.tokenCache.value;
    const response = await this.request(
      "POST",
      "/auth/v3/tenant_access_token/internal",
      { app_id: this.options.appId, app_secret: this.options.appSecret },
      false,
    );
    const value = requiredText(response, "tenant_access_token");
    const expiresIn = requiredNumber(response, "expire");
    this.tokenCache = {
      value,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 0) * 1_000,
    };
    return value;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: JsonObject,
    authenticated = true,
  ): Promise<JsonObject> {
    const attempts = method === "GET" || !authenticated ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce(method, path, body, authenticated);
      } catch (error) {
        if (
          !(error instanceof FeishuSchemaApiError) ||
          !error.retryable ||
          attempt + 1 >= attempts
        ) {
          throw error;
        }
      }
    }
    throw new FeishuSchemaApiError("HTTP_FAILED", "Feishu API request failed");
  }

  private async requestOnce(
    method: "GET" | "POST",
    path: string,
    body: JsonObject | undefined,
    authenticated: boolean,
  ): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body
            ? { "Content-Type": "application/json; charset=utf-8" }
            : {}),
          ...(authenticated
            ? { Authorization: `Bearer ${await this.tenantToken()}` }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new FeishuSchemaApiError(
          "HTTP_FAILED",
          `Feishu HTTP request failed (${response.status})`,
          response.status === 429 || response.status >= 500,
        );
      }
      const payload = requiredObject(await response.json(), "response");
      if (payload.code !== 0) {
        throw new FeishuSchemaApiError(
          "API_FAILED",
          `Feishu API request failed (code ${String(payload.code)})`,
        );
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new FeishuSchemaApiError(
          "TIMEOUT",
          "Feishu API request timed out",
          true,
        );
      }
      if (error instanceof FeishuSchemaApiError) throw error;
      throw new FeishuSchemaApiError(
        "HTTP_FAILED",
        "Feishu API request failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private appToken(): string {
    return encodeURIComponent(this.options.baseAppToken);
  }
}

function fieldRequest(field: FieldManifest): JsonObject {
  const request: JsonObject = {
    field_name: field.name,
    type: fieldType(field.kind),
  };
  if (field.kind === "select") {
    request.property = {
      options: (field.options ?? []).map((name) => ({ name })),
    };
  } else if (field.kind === "datetime") {
    request.property = { date_formatter: "yyyy/MM/dd HH:mm" };
  } else if (field.kind === "number") {
    request.property = { formatter: "0" };
  }
  return request;
}

function fieldType(kind: FeishuFieldKind): number {
  if (kind === "text") return 1;
  if (kind === "number") return 2;
  if (kind === "select") return 3;
  return 5;
}

function fieldKind(value: unknown): FeishuFieldKind | "unknown" {
  if (value === 1) return "text";
  if (value === 2) return "number";
  if (value === 3) return "select";
  if (value === 5) return "datetime";
  return "unknown";
}

function selectOptionNames(property: unknown): string[] {
  if (!property || typeof property !== "object" || Array.isArray(property))
    return [];
  const options = (property as JsonObject).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option))
      return [];
    const name = (option as JsonObject).name;
    return typeof name === "string" ? [name] : [];
  });
}

function requiredObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuSchemaApiError(
      "INVALID_RESPONSE",
      `Feishu ${name} response is invalid`,
    );
  }
  return value as JsonObject;
}

function objectField(value: JsonObject, field: string): JsonObject {
  return requiredObject(value[field], field);
}

function requiredArray(value: JsonObject, field: string): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) {
    throw new FeishuSchemaApiError(
      "INVALID_RESPONSE",
      `Feishu ${field} response is invalid`,
    );
  }
  return candidate;
}

function requiredText(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new FeishuSchemaApiError(
      "INVALID_RESPONSE",
      `Feishu ${field} response is invalid`,
    );
  }
  return candidate;
}

function requiredNumber(value: JsonObject, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new FeishuSchemaApiError(
      "INVALID_RESPONSE",
      `Feishu ${field} response is invalid`,
    );
  }
  return candidate;
}
