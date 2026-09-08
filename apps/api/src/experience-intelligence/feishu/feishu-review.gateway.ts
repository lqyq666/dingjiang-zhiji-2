import type {
  FeishuProviderMode,
  FeishuPushReceipt,
  FeishuReviewPullItem,
  StructuredExperienceCard,
} from "@dingjiang/contracts";

const TOKEN_EXPIRY_SAFETY_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PULL_PAGES = 2;

export type FeishuFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type FeishuCandidateProjection = {
  candidateId: string;
  candidateVersionId: string;
  projectId: string;
  title: string;
  applicableSituation: string;
  businessProblem: string;
  practice: string;
  resultSummary: string;
  limitations: string;
  structuredCard: StructuredExperienceCard;
  cozeExecuteId?: string | null;
  dingjiangUrl?: string | null;
};

export type FeishuReviewGatewayOptions = {
  mode: FeishuProviderMode;
  appId?: string;
  appSecret?: string;
  baseAppToken?: string;
  reviewTableId?: string;
  timeoutMs?: number;
  maxPullPages?: number;
  fetchImpl?: FeishuFetch;
  now?: () => Date;
};

export class FeishuGatewayError extends Error {
  constructor(
    readonly code: "PROVIDER_FAILED" | "PROVIDER_TIMEOUT" | "INVALID_REVIEW",
    message: string,
  ) {
    super(message);
    this.name = "FeishuGatewayError";
  }
}

type TokenCache = { value: string; expiresAtMs: number };

/**
 * Boundary for Feishu Bitable only. It never knows or changes domain state.
 */
export class FeishuReviewGateway {
  private tokenCache: TokenCache | null = null;
  private readonly timeoutMs: number;
  private readonly maxPullPages: number;
  private readonly fetchImpl: FeishuFetch;
  private readonly now: () => Date;
  private readonly demoRecords = new Map<string, FeishuCandidateProjection>();

  constructor(private readonly options: FeishuReviewGatewayOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPullPages = options.maxPullPages ?? DEFAULT_MAX_PULL_PAGES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async pushCandidate(
    input: FeishuCandidateProjection,
  ): Promise<FeishuPushReceipt> {
    if (this.options.mode === "DEMO_RULES") {
      this.demoRecords.set(this.demoKey(input), input);
      return this.pushReceipt(input, `demo-${this.demoKey(input)}`);
    }

    const token = await this.tenantAccessToken();
    const existingRecordId = await this.findRecordId(input, token);
    const fields = this.projectionFields(input);
    const recordId = existingRecordId
      ? await this.updateRecord(existingRecordId, fields, token)
      : await this.createRecord(fields, token);
    return this.pushReceipt(input, recordId);
  }

  async pullReviewDecisions(): Promise<FeishuReviewPullItem[]> {
    if (this.options.mode === "DEMO_RULES") {
      return [...this.demoRecords.values()].map((projection) => ({
        provider: "DEMO_RULES",
        candidateId: projection.candidateId,
        candidateVersionId: projection.candidateVersionId,
        decision: {
          result: "PENDING_REVIEW",
          comment: "",
          reviewer: "DEMO_RULES",
        },
        pulledAt: this.now().toISOString(),
      }));
    }

    const token = await this.tenantAccessToken();
    const items: FeishuReviewPullItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.maxPullPages; page += 1) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (pageToken) body.page_token = pageToken;
      const response = await this.requestJson(
        this.recordsSearchUrl(),
        token,
        "POST",
        body,
      );
      const data = objectField(response, "data");
      const records = requiredArray(data, "items");
      for (const record of records) items.push(this.toReviewPullItem(record));
      if (data.has_more !== true) break;
      pageToken = requiredText(data, "page_token");
    }
    return items;
  }

  private async tenantAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.tokenCache && this.tokenCache.expiresAtMs > nowMs)
      return this.tokenCache.value;
    const config = this.requiredConfig();
    const response = await this.requestJson(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      undefined,
      "POST",
      { app_id: config.appId, app_secret: config.appSecret },
    );
    const token = requiredText(response, "tenant_access_token");
    const expirySeconds = requiredPositiveNumber(response, "expire");
    this.tokenCache = {
      value: token,
      expiresAtMs:
        nowMs +
        Math.max(0, expirySeconds - TOKEN_EXPIRY_SAFETY_SECONDS) * 1_000,
    };
    return token;
  }

  private async findRecordId(
    input: FeishuCandidateProjection,
    token: string,
  ): Promise<string | null> {
    const response = await this.requestJson(
      this.recordsSearchUrl(),
      token,
      "POST",
      {
        filter: {
          conjunction: "and",
          conditions: [
            {
              field_name: "候选ID",
              operator: "is",
              value: [input.candidateId],
            },
            {
              field_name: "候选版本",
              operator: "is",
              value: [input.candidateVersionId],
            },
          ],
        },
        page_size: 2,
      },
    );
    const items = requiredArray(objectField(response, "data"), "items");
    if (items.length === 0) return null;
    return requiredText(requiredObject(items[0], "record"), "record_id");
  }

  private async createRecord(
    fields: Record<string, string>,
    token: string,
  ): Promise<string> {
    const response = await this.requestJson(this.recordsUrl(), token, "POST", {
      fields,
    });
    return this.recordIdFromWrite(response);
  }

  private async updateRecord(
    recordId: string,
    fields: Record<string, string>,
    token: string,
  ): Promise<string> {
    const response = await this.requestJson(
      `${this.recordsUrl()}/${encodeURIComponent(recordId)}`,
      token,
      "PUT",
      { fields },
    );
    return this.recordIdFromWrite(response);
  }

  private recordIdFromWrite(response: Record<string, unknown>): string {
    return requiredText(
      objectField(objectField(response, "data"), "record"),
      "record_id",
    );
  }

  private async requestJson(
    url: string,
    token: string | undefined,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new FeishuGatewayError(
          "PROVIDER_FAILED",
          "Feishu provider request failed",
        );
      const payload = requiredObject(await response.json(), "response");
      if (payload.code !== 0)
        throw new FeishuGatewayError(
          "PROVIDER_FAILED",
          "Feishu provider request failed",
        );
      return payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new FeishuGatewayError(
          "PROVIDER_TIMEOUT",
          "Feishu provider timed out",
        );
      if (error instanceof FeishuGatewayError) throw error;
      throw new FeishuGatewayError(
        "PROVIDER_FAILED",
        "Feishu provider request failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private toReviewPullItem(record: unknown): FeishuReviewPullItem {
    const fields = objectField(requiredObject(record, "record"), "fields");
    const result = reviewResult(requiredText(fields, "审核结果"));
    const candidateId = requiredText(fields, "候选ID");
    const candidateVersionId = requiredText(fields, "候选版本");
    const reviewer = requiredText(fields, "审核人");
    const comment = optionalText(fields, "审核意见");
    return {
      provider: "FEISHU",
      candidateId,
      candidateVersionId,
      decision: { result, comment, reviewer },
      pulledAt: this.now().toISOString(),
    };
  }

  private projectionFields(
    input: FeishuCandidateProjection,
  ): Record<string, string> {
    const card = input.structuredCard;
    return {
      候选ID: input.candidateId,
      候选版本: input.candidateVersionId,
      项目ID: input.projectId,
      标题: input.title,
      适用情境: input.applicableSituation,
      经营问题: input.businessProblem,
      采取做法: input.practice,
      结果摘要: input.resultSummary,
      限制: input.limitations,
      触发条件: card.trigger,
      判断条件: card.conditions.join("\n"),
      推荐动作: card.actions
        .map((action) => `${action.order}. ${action.action}`)
        .join("\n"),
      原因: card.rationale,
      例外: card.exceptions.join("\n"),
      EvidenceRefs: card.evidenceRefs
        .map(
          (reference) =>
            `${reference.sourceObjectId} / ${reference.sourceVersionId} / ${reference.reference}`,
        )
        .join("\n"),
      CozeExecuteId: input.cozeExecuteId ?? "",
      鼎江智绩链接: input.dingjiangUrl ?? "",
    };
  }

  private pushReceipt(
    input: FeishuCandidateProjection,
    recordId: string,
  ): FeishuPushReceipt {
    return {
      provider: this.options.mode,
      candidateId: input.candidateId,
      candidateVersionId: input.candidateVersionId,
      recordId,
      pushedAt: this.now().toISOString(),
    };
  }

  private requiredConfig(): Required<
    Pick<
      FeishuReviewGatewayOptions,
      "appId" | "appSecret" | "baseAppToken" | "reviewTableId"
    >
  > {
    const { appId, appSecret, baseAppToken, reviewTableId } = this.options;
    if (!appId || !appSecret || !baseAppToken || !reviewTableId) {
      throw new FeishuGatewayError(
        "PROVIDER_FAILED",
        "Feishu configuration is incomplete",
      );
    }
    return { appId, appSecret, baseAppToken, reviewTableId };
  }

  private recordsUrl(): string {
    const config = this.requiredConfig();
    return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(config.baseAppToken)}/tables/${encodeURIComponent(config.reviewTableId)}/records`;
  }

  private recordsSearchUrl(): string {
    return `${this.recordsUrl()}/search`;
  }

  private demoKey(
    input: Pick<
      FeishuCandidateProjection,
      "candidateId" | "candidateVersionId"
    >,
  ): string {
    return `${input.candidateId}-${input.candidateVersionId}`;
  }
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FeishuGatewayError(
      "PROVIDER_FAILED",
      `Feishu ${field} is invalid`,
    );
  return value as Record<string, unknown>;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  const source = requiredObject(value, field);
  const candidate = source[field];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new FeishuGatewayError(
      "PROVIDER_FAILED",
      `Feishu ${field} is invalid`,
    );
  }
  return candidate as Record<string, unknown>;
}

function requiredArray(
  value: Record<string, unknown>,
  field: string,
): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate))
    throw new FeishuGatewayError(
      "PROVIDER_FAILED",
      `Feishu ${field} is invalid`,
    );
  return candidate;
}

function requiredText(value: Record<string, unknown>, field: string): string {
  const text = plainText(value[field]);
  if (!text)
    throw new FeishuGatewayError(
      "PROVIDER_FAILED",
      `Feishu ${field} is invalid`,
    );
  return text;
}

function optionalText(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) return "";
  const text = plainText(candidate);
  if (text === null)
    throw new FeishuGatewayError("INVALID_REVIEW", "Feishu review is invalid");
  return text;
}

function plainText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const fragment of value) {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment))
      return null;
    const fields = fragment as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (keys.length !== 2 || !keys.includes("text") || !keys.includes("type"))
      return null;
    if (fields.type !== "text" || typeof fields.text !== "string") return null;
    parts.push(fields.text);
  }
  return parts.join("").trim();
}

function requiredPositiveNumber(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate <= 0
  ) {
    throw new FeishuGatewayError(
      "PROVIDER_FAILED",
      `Feishu ${field} is invalid`,
    );
  }
  return candidate;
}

function reviewResult(
  value: string,
): "PENDING_REVIEW" | "APPROVED" | "RETURNED" {
  if (value === "待审核") return "PENDING_REVIEW";
  if (value === "批准") return "APPROVED";
  if (value === "退回") return "RETURNED";
  throw new FeishuGatewayError("INVALID_REVIEW", "Feishu review is invalid");
}
