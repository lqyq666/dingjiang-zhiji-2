import { requestWithTimeout } from "./request-with-timeout";
import {
  validationWorkpaperViewSchema,
  type ValidationCandidateRunInput,
  type ValidationWorkpaperCompleteInput,
  type ValidationWorkpaperDraftInput,
  type ValidationWorkpaperReopenInput,
  type ValidationWorkpaperView,
} from "@dingjiang/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

type WorkpaperCommand =
  | ValidationCandidateRunInput
  | ValidationWorkpaperDraftInput
  | ValidationWorkpaperCompleteInput
  | ValidationWorkpaperReopenInput;

const inferredErrorCode = (message: string) =>
  message.includes("STALE_WORKPAPER")
    ? "STALE_WORKPAPER"
    : message.includes("DOWNSTREAM_DEPENDENCY")
      ? "DOWNSTREAM_DEPENDENCY"
      : undefined;

async function requestWorkpaper(
  projectId: string,
  suffix: string,
  init?: RequestInit,
): Promise<ValidationWorkpaperView> {
  return requestWithTimeout(
    `${API_BASE}/vs16/projects/${encodeURIComponent(projectId)}/root-cause-workpaper${suffix}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-vs01-role": "PMC",
        ...init?.headers,
      },
    },
    async (response) => {
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof payload.message === "string"
            ? payload.message
            : `核验底稿请求失败（${response.status}）`;
        const error = new Error(message) as Error & { code?: string };
        if (
          typeof payload === "object" &&
          payload !== null &&
          "code" in payload &&
          typeof payload.code === "string"
        )
          error.code = payload.code;
        else error.code = inferredErrorCode(message);
        throw error;
      }
      return validationWorkpaperViewSchema.parse(payload);
    },
    60_000,
  );
}

export const getRootCauseWorkpaper = (projectId: string) =>
  requestWorkpaper(projectId, "");

const command = (
  projectId: string,
  suffix: string,
  method: "POST" | "PUT",
  body: WorkpaperCommand,
) =>
  requestWorkpaper(projectId, suffix, {
    method,
    body: JSON.stringify(body),
  });

export const generateRootCauseCandidate = (
  projectId: string,
  input: ValidationCandidateRunInput,
) => command(projectId, "/candidate-runs", "POST", input);

export const saveRootCauseWorkpaperDraft = (
  projectId: string,
  input: ValidationWorkpaperDraftInput,
) => command(projectId, "/draft", "PUT", input);

export const completeRootCauseWorkpaper = (
  projectId: string,
  input: ValidationWorkpaperCompleteInput,
) => command(projectId, "/complete", "POST", input);

export const reopenRootCauseWorkpaper = (
  projectId: string,
  input: ValidationWorkpaperReopenInput,
) => command(projectId, "/reopen", "POST", input);
