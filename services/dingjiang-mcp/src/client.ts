import { validateIntegrationBaseUrl } from "./endpoint-policy";
import {
  workExecutionContextSchema,
  workProgressReadbackSchema,
  governedCommandResultSchema,
  materialVerificationResultSchema,
  evidenceConfirmationResultSchema,
  type WorkExecutionRequest,
  type MaterialVerificationRequest,
  type EvidenceConfirmationRequest,
  integrationCurrentWorkItemSchema,
  integrationEvidenceBundleSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationExperienceEvidenceSchema,
  integrationExperienceSearchSchema,
  integrationFailureEnvelopeSchema,
  integrationFormalExperienceSchema,
  integrationMaterialListSchema,
  integrationMaterialPreviewSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationProjectStateSchema,
  integrationSourceVersionSchema,
  integrationSuccessEnvelopeSchema,
  integrationValidationWorkpaperSchema,
  integrationWorkContextSchema,
  integrationWorkItemListSchema,
  integrationWorkspaceResumeSchema,
  workpaperProposeResultSchema,
  materialCreateResultSchema,
  evidenceProposeResultSchema,
  nextActionSchema,
  type IntegrationFailureEnvelope,
  type WorkpaperProposeRequest,
  type MaterialCreateRequest,
  type EvidenceProposalPayload,
  type GovernedCommandRequest,
} from "@dingjiang/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export class IntegrationClientError extends Error {
  constructor(
    readonly failure: IntegrationFailureEnvelope,
    readonly retryAfterSeconds?: number,
    readonly requestCorrelationId?: string,
  ) {
    super(failure.error.message);
    this.name = "IntegrationClientError";
  }
}

export type IntegrationTransportCode =
  | "INTEGRATION_TIMEOUT"
  | "INTEGRATION_NETWORK_ERROR"
  | "INTEGRATION_INVALID_RESPONSE";

/**
 * Transport-level failure, distinct from a server-returned business failure and
 * from caller input validation. Keeping these separate matters: a ZodError
 * raised while validating the *response* used to surface as INVALID_REQUEST,
 * which blamed the caller for a server/contract mismatch.
 */
export class IntegrationTransportError extends Error {
  readonly correlationId?: string;

  constructor(
    readonly code: IntegrationTransportCode,
    message: string,
    options?: ErrorOptions & { correlationId?: string },
  ) {
    super(message, options);
    this.name = "IntegrationTransportError";
    this.correlationId = options?.correlationId;
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export const resolveTimeoutMs = (
  value: string | undefined = process.env.DINGJIANG_MCP_TIMEOUT_MS,
): number => {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 100), 120_000);
};

const classifyFetchError = (
  error: unknown,
  correlationId: string,
): IntegrationTransportError => {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError")
    return new IntegrationTransportError(
      "INTEGRATION_TIMEOUT",
      "Integration API 请求超时。不得改 requestId 重试，必须复用原请求核对服务端状态",
      { cause: error, correlationId },
    );
  return new IntegrationTransportError(
    "INTEGRATION_NETWORK_ERROR",
    "无法连接 Integration API；请确认本地服务已启动且 DINGJIANG_API_BASE_URL 配置正确",
    { cause: error, correlationId },
  );
};

const readJsonPayload = async (
  response: Response,
  correlationId: string,
): Promise<unknown> => {
  const text = await response.text().catch((error: unknown) => {
    throw classifyFetchError(error, correlationId);
  });
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IntegrationTransportError(
      "INTEGRATION_INVALID_RESPONSE",
      `Integration API 未返回 JSON 响应（HTTP ${response.status}）`,
      { correlationId },
    );
  }
};

// RFC 9110 permits delay-seconds and three HTTP-date formats.
const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }

  const now = Date.now();
  // Normalize the obsolete formats before validating calendar fields and weekday.
  const date = value
    .replace(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/,
      (
        _,
        weekday: string,
        day: string,
        month: string,
        shortYear: string,
        time: string,
      ) => {
        const limit = new Date(now);
        limit.setUTCFullYear(limit.getUTCFullYear() + 50);
        const suffix = Number(shortYear);
        const year =
          Math.floor((limit.getUTCFullYear() - suffix) / 100) * 100 + suffix;
        const format = (fullYear: number) =>
          `${weekday.slice(0, 3)}, ${day} ${month} ${fullYear} ${time} GMT`;
        return Date.parse(format(year)) > limit.getTime()
          ? format(year - 100)
          : format(year);
      },
    )
    .replace(
      /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/,
      (
        _,
        weekday: string,
        month: string,
        day: string,
        time: string,
        year: string,
      ) =>
        `${weekday}, ${day.trimStart().padStart(2, "0")} ${month} ${year} ${time} GMT`,
    );
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== date)
    return undefined;
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
};

// Validating a URL on every call was repeated work on the hot path. The cache is
// keyed by the raw environment value, so tests and rotations that change
// DINGJIANG_API_BASE_URL still trigger a fresh validation.
let cachedBaseUrl: { raw: string; allowedHosts: string; url: URL } | undefined;
const integrationBaseUrl = (): URL => {
  const raw =
    process.env.DINGJIANG_API_BASE_URL?.trim() || "http://127.0.0.1:3001/api";
  const allowedHosts = process.env.DINGJIANG_API_ALLOWED_HOSTS?.trim() ?? "";
  // The allowlist is part of the cache key. Narrowing it without touching the
  // URL must re-run validation, otherwise a host removed from the list keeps
  // receiving the bearer token until the process restarts.
  if (cachedBaseUrl?.raw === raw && cachedBaseUrl.allowedHosts === allowedHosts)
    return cachedBaseUrl.url;
  const url = validateIntegrationBaseUrl(raw, { allowedHosts });
  cachedBaseUrl = { raw, allowedHosts, url };
  return url;
};

const apiToken = (): string => {
  const token = process.env.DINGJIANG_MCP_API_TOKEN?.trim();
  if (!token || /^\$\{[A-Z0-9_]+\}$/.test(token))
    throw new Error("DINGJIANG_MCP_API_TOKEN 未配置");
  return token;
};

/**
 * Exported so the MCP layer can declare the same schema as `outputSchema`
 * instead of restating the shape by hand. One definition, two consumers.
 */
export const integrationEventsSchema = z.object({
  items: z.array(
    z.object({
      projectId: z.string(),
      sourceTaskId: z.string(),
      title: z.string(),
      status: z.string(),
    }),
  ),
});

export class DingjiangIntegrationClient {
  constructor(
    private readonly readSignal?: AbortSignal,
    private readonly boundToken?: string,
  ) {}

  private async request<T>(
    path: string,
    dataSchema: z.ZodType<T>,
    options: { method: "GET" | "POST"; body?: unknown; correlationId?: string },
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), integrationBaseUrl());
    // Configuration errors must keep their own message instead of being
    // reclassified as network failures.
    const token = this.boundToken ?? apiToken();
    const correlationId = options.correlationId ?? randomUUID();
    const timeout = AbortSignal.timeout(resolveTimeoutMs());
    const signal =
      options.method === "GET" && this.readSignal
        ? AbortSignal.any([this.readSignal, timeout])
        : timeout;
    const response = await fetch(url, {
      redirect: "error",
      ...(options.method === "POST" ? { method: "POST" } : {}),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-correlation-id": correlationId,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal,
    }).catch((error: unknown) => {
      throw classifyFetchError(error, correlationId);
    });
    const payload = await readJsonPayload(response, correlationId);
    if (!response.ok) {
      const failure = integrationFailureEnvelopeSchema.safeParse(payload);
      if (failure.success)
        throw new IntegrationClientError(
          failure.data,
          parseRetryAfter(response.headers.get("retry-after")),
          failure.data.correlationId === correlationId
            ? undefined
            : correlationId,
        );
      throw new IntegrationTransportError(
        "INTEGRATION_INVALID_RESPONSE",
        `Integration API 请求失败（HTTP ${response.status}），且未返回标准 failure envelope`,
        { correlationId },
      );
    }
    try {
      return integrationSuccessEnvelopeSchema(dataSchema).parse(payload).data;
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new IntegrationTransportError(
          "INTEGRATION_INVALID_RESPONSE",
          "Integration API 响应与 contract 不一致；请检查服务端与 MCP 的版本是否匹配",
          { cause: error, correlationId },
        );
      throw error;
    }
  }

  private get<T>(path: string, dataSchema: z.ZodType<T>): Promise<T> {
    return this.request(path, dataSchema, { method: "GET" });
  }

  private post<T>(
    path: string,
    body: unknown,
    dataSchema: z.ZodType<T>,
    correlationId: string,
  ): Promise<T> {
    return this.request(path, dataSchema, {
      method: "POST",
      body,
      correlationId,
    });
  }

  getProjectContext(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/context`,
      integrationProjectContextSchema,
    );
  }

  getWorkContext(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/work-context`,
      integrationWorkContextSchema,
    );
  }

  getEvidenceBundle(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence-bundle`,
      integrationEvidenceBundleSchema,
    );
  }

  getWorkspaceResume() {
    return this.get(
      "integration/workspace/resume",
      integrationWorkspaceResumeSchema,
    );
  }

  listProjects() {
    return this.get("integration/projects", integrationProjectListSchema);
  }

  getCurrentProject() {
    return this.get(
      "integration/projects/current",
      integrationProjectStateSchema,
    );
  }

  getCurrentWorkItem() {
    return this.get(
      "integration/projects/current/work-item",
      integrationCurrentWorkItemSchema,
    );
  }

  listProjectWorkItems(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/work-items`,
      integrationWorkItemListSchema,
    );
  }

  getProjectState(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/state`,
      integrationProjectStateSchema,
    );
  }

  listEvidence(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence`,
      integrationEvidenceListSchema,
    );
  }

  listTraceableMaterials(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/materials`,
      integrationMaterialListSchema,
    );
  }

  getMaterialPreview(projectId: string, materialId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/preview`,
      integrationMaterialPreviewSchema,
    );
  }

  getEvidence(projectId: string, evidenceId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidenceId)}`,
      integrationEvidenceDetailSchema,
    );
  }

  getSourceVersion(projectId: string, sourceVersionId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/source-versions/${encodeURIComponent(sourceVersionId)}`,
      integrationSourceVersionSchema,
    );
  }

  /** Derived on the server: "what happens next" is a business rule, not a
   * formatting decision, and a second front end must get the same answer. */
  getNextAction(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/next-action`,
      nextActionSchema,
    );
  }

  getValidationWorkpaper(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/workpaper`,
      integrationValidationWorkpaperSchema,
    );
  }

  searchFormalExperiences(query: string) {
    const parameters = new URLSearchParams({ query });
    return this.get(
      `integration/experiences/search?${parameters.toString()}`,
      integrationExperienceSearchSchema,
    );
  }

  getFormalExperience(experienceId: string) {
    return this.get(
      `integration/experiences/${encodeURIComponent(experienceId)}`,
      integrationFormalExperienceSchema,
    );
  }

  getExperienceEvidence(experienceId: string) {
    return this.get(
      `integration/experiences/${encodeURIComponent(experienceId)}/evidence`,
      integrationExperienceEvidenceSchema,
    );
  }

  listEvents() {
    return this.get("integration/events", integrationEventsSchema);
  }
  getExecutionContext(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/operations`,
      workExecutionContextSchema,
    );
  }
  getProgressReadback(projectId: string, workItemId: string) {
    const query = new URLSearchParams({ workItemId });
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/operations?${query}`,
      workProgressReadbackSchema,
    );
  }
  executeWork(projectId: string, request: WorkExecutionRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/operations`,
      request,
      governedCommandResultSchema,
      request.correlationId,
    );
  }
  verifyMaterial(projectId: string, request: MaterialVerificationRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(request.payload.materialId)}/verification`,
      request,
      materialVerificationResultSchema,
      request.correlationId,
    );
  }
  confirmEvidence(projectId: string, request: EvidenceConfirmationRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/confirmation`,
      request,
      evidenceConfirmationResultSchema,
      request.correlationId,
    );
  }

  proposeWorkpaper(projectId: string, request: WorkpaperProposeRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/workpaper/proposals`,
      request,
      workpaperProposeResultSchema,
      request.correlationId,
    );
  }

  createMaterial(projectId: string, request: MaterialCreateRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/materials`,
      request,
      materialCreateResultSchema,
      request.correlationId,
    );
  }

  proposeEvidence(
    projectId: string,
    request: GovernedCommandRequest & { payload: EvidenceProposalPayload },
  ) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/proposals`,
      request,
      evidenceProposeResultSchema,
      request.correlationId,
    );
  }
}
