import {
  experienceAiDraftInputSchema,
  experienceAiDraftResponseSchema,
  experienceAnswerInputSchema,
  experienceAnswerResponseSchema,
  experiencePublishReceiptSchema,
  feishuPullInputSchema,
  feishuPullReceiptSchema,
  feishuPushInputSchema,
  feishuPushReceiptSchema,
  formalExperiencePublishInputSchema,
  type ExperienceAiDraftInput,
  type ExperienceAiDraftResponse,
  type ExperienceAnswerInput,
  type ExperienceAnswerResponse,
  type ExperiencePublishReceipt,
  type FeishuPullInput,
  type FeishuPullReceipt,
  type FeishuPushInput,
  type FeishuPushReceipt,
  type FormalExperiencePublishInput,
} from "@dingjiang/contracts";

type DemoRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";
type ParseSchema<T> = { parse(input: unknown): T };
type Vs17RequestError = Error & { code?: string };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

async function request<T>(
  path: string,
  schema: ParseSchema<T>,
  role: DemoRole,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-vs01-role": role,
      ...init.headers,
    },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : `请求失败（${response.status}）`;
    const error = new Error(message) as Vs17RequestError;
    if (
      typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      typeof payload.code === "string"
    )
      error.code = payload.code;
    throw error;
  }
  return schema.parse(payload);
}

/** Produces a proposal only. Candidate creation remains an explicit PMC action. */
export const generateExperienceAiDraft = (
  projectId: string,
  input: ExperienceAiDraftInput,
): Promise<ExperienceAiDraftResponse> =>
  request(
    `/vs17/projects/${encodeURIComponent(projectId)}/experience-drafts/ai`,
    experienceAiDraftResponseSchema,
    "PMC",
    json(experienceAiDraftInputSchema.parse(input)),
  );

export const pushExperienceCandidateToFeishu = (
  candidateId: string,
  input: FeishuPushInput,
): Promise<FeishuPushReceipt> =>
  request(
    `/vs17/experience-candidates/${encodeURIComponent(candidateId)}/feishu/push`,
    feishuPushReceiptSchema,
    "EXPERT_REVIEWER",
    json(feishuPushInputSchema.parse(input)),
  );

export const pullFeishuExperienceReviews = (
  input: FeishuPullInput,
): Promise<FeishuPullReceipt> =>
  request(
    "/vs17/feishu/reviews/pull",
    feishuPullReceiptSchema,
    "EXPERT_REVIEWER",
    json(feishuPullInputSchema.parse(input)),
  );

export const publishFormalExperienceToCoze = (
  experienceId: string,
  input: FormalExperiencePublishInput,
): Promise<ExperiencePublishReceipt> =>
  request(
    `/vs17/experiences/${encodeURIComponent(experienceId)}/coze/publish`,
    experiencePublishReceiptSchema,
    "EXPERT_REVIEWER",
    json(formalExperiencePublishInputSchema.parse(input)),
  );

/** Answers are proposal-only and never change project or experience state. */
export const answerExperience = (
  input: ExperienceAnswerInput,
): Promise<ExperienceAnswerResponse> =>
  request(
    "/vs17/experience-answer",
    experienceAnswerResponseSchema,
    "PMC",
    json(experienceAnswerInputSchema.parse(input)),
  );
