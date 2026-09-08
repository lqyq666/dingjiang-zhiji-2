import {
  experienceAnswerResultSchema,
  experienceExtractionResultSchema,
  type ExperienceAnswerResult,
  type ExperienceExtractionResult,
} from "@dingjiang/contracts";

import type {
  ExperienceAiProvider,
  ExperienceAnswerInput,
  ExperienceExtractionInput,
  ExperiencePublishInput,
  ProviderExecution,
  ProviderUsage,
  PublishProviderExecution,
} from "../contracts";

const cozeWorkflowUrl = "https://api.coze.cn/v1/workflow/run";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class ExperienceProviderError extends Error {
  constructor(
    readonly code:
      "INVALID_PROVIDER_OUTPUT" | "PROVIDER_TIMEOUT" | "PROVIDER_FAILED",
  ) {
    super(code);
    this.name = "ExperienceProviderError";
  }
}

type CozeExperienceProviderOptions = {
  token: string;
  workflowIds: { extract: string; publish: string; answer: string };
  fetcher?: Fetcher;
  timeoutMs?: number;
};

type CozeExecution = Omit<
  ProviderExecution<null>,
  "provider" | "workflowId" | "output"
>;

export class CozeExperienceProvider implements ExperienceAiProvider {
  readonly provider = "COZE" as const;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(private readonly options: CozeExperienceProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  workflowIdFor(purpose: "EXTRACT" | "PUBLISH" | "ANSWER"): string {
    return this.options.workflowIds[
      purpose.toLowerCase() as "extract" | "publish" | "answer"
    ];
  }

  async extractCandidate(
    input: ExperienceExtractionInput,
  ): Promise<ProviderExecution<ExperienceExtractionResult>> {
    return this.run(
      this.workflowIdFor("EXTRACT"),
      input,
      experienceExtractionResultSchema,
    );
  }

  async publishExperience(
    input: ExperiencePublishInput,
  ): Promise<PublishProviderExecution> {
    const workflowId = this.workflowIdFor("PUBLISH");
    const execution = await this.execute(workflowId, input, true);
    return { provider: this.provider, workflowId, ...execution };
  }

  async answerQuestion(
    input: ExperienceAnswerInput,
  ): Promise<ProviderExecution<ExperienceAnswerResult>> {
    return this.run(
      this.workflowIdFor("ANSWER"),
      input,
      experienceAnswerResultSchema,
    );
  }

  private async run<T>(
    workflowId: string,
    parameters: object,
    schema: {
      safeParse(
        input: unknown,
      ): { success: true; data: T } | { success: false };
    },
  ): Promise<ProviderExecution<T>> {
    const execution = await this.execute(workflowId, parameters);
    const parsed = schema.safeParse(execution.data);
    if (!parsed.success)
      throw new ExperienceProviderError("INVALID_PROVIDER_OUTPUT");
    return {
      provider: this.provider,
      workflowId,
      output: parsed.data,
      executeId: execution.executeId,
      debugUrl: execution.debugUrl,
      usage: execution.usage,
    };
  }

  private async execute(
    workflowId: string,
    parameters: object,
    allowEmptyDirectData = false,
  ): Promise<CozeExecution & { data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(cozeWorkflowUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workflow_id: workflowId, parameters }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ExperienceProviderError("PROVIDER_FAILED");
      const envelope: unknown = await response.json().catch(() => {
        throw new ExperienceProviderError("PROVIDER_FAILED");
      });
      if (
        !isRecord(envelope) ||
        envelope.code !== 0 ||
        (!isRecord(envelope.data) && typeof envelope.data !== "string")
      )
        throw new ExperienceProviderError("PROVIDER_FAILED");
      const data = parseCozeData(envelope.data, allowEmptyDirectData);
      return {
        data,
        executeId: asNonEmptyString(envelope.execute_id),
        debugUrl: asSafeUrl(envelope.debug_url),
        usage: usageFrom(envelope.usage),
      };
    } catch (error) {
      if (error instanceof ExperienceProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError")
        throw new ExperienceProviderError("PROVIDER_TIMEOUT");
      throw new ExperienceProviderError("PROVIDER_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asSafeUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

const usageFrom = (value: unknown): ProviderUsage | null => {
  if (!isRecord(value)) return null;
  const inputTokens = value.input_count;
  const outputTokens = value.output_count;
  const totalTokens = value.token_count;
  if (
    ![inputTokens, outputTokens, totalTokens].every(
      (item) => typeof item === "number" && Number.isInteger(item) && item >= 0,
    )
  )
    return null;
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens: totalTokens as number,
  };
};

const parseCozeData = (
  value: string | Record<string, unknown>,
  allowEmptyDirectData: boolean,
): unknown => {
  let data: unknown = value;
  if (typeof data === "string") {
    data = parseJson(data);
  }
  if (!isRecord(data))
    throw new ExperienceProviderError("INVALID_PROVIDER_OUTPUT");
  if (isCozeTextEnvelope(data)) return parseJson(data.data);
  if ("output" in data) {
    if (typeof data.output !== "string")
      throw new ExperienceProviderError("INVALID_PROVIDER_OUTPUT");
    return parseJson(data.output);
  }
  if (allowEmptyDirectData && Object.keys(data).length === 0) return data;
  return data;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new ExperienceProviderError("INVALID_PROVIDER_OUTPUT");
  }
};

const isCozeTextEnvelope = (
  value: Record<string, unknown>,
): value is Record<"content_type" | "data", unknown> & {
  content_type: 1;
  data: string;
} => {
  const allowedKeys = new Set([
    "content_type",
    "data",
    "original_result",
    "type_for_model",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.content_type !== 1 || typeof value.data !== "string") return false;
  if ("original_result" in value && value.original_result !== null)
    return false;
  return !("type_for_model" in value) || value.type_for_model === 2;
};
