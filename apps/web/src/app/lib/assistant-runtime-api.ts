import {
  assistantHistorySchema,
  assistantRunRequestSchema,
  assistantRunSchema,
  type AssistantRun,
  type AssistantRunRequest,
  type AssistantStreamEvent,
} from "@dingjiang/contracts";

import { parseSseChunk } from "./assistant-stream";

type DemoRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";
type AssistantHistory = ReturnType<typeof assistantHistorySchema.parse>;

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

async function runtimeRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "x-vs01-role": "PMC" satisfies DemoRole,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload: unknown = await response.json();
      if (
        payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
      )
        message = payload.message;
    } catch {
      // The status is the safe fallback when a proxy returned a non-JSON error.
    }
    throw new Error(message);
  }
  return response;
}

export async function createAssistantRuntimeRun(
  projectId: string,
  input: AssistantRunRequest,
): Promise<AssistantRun> {
  const body = assistantRunRequestSchema.parse(input);
  const response = await runtimeRequest(
    `/vs12/projects/${encodeURIComponent(projectId)}/assistant/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return assistantRunSchema.parse(await response.json());
}

export async function getAssistantRuntimeHistory(
  projectId: string,
): Promise<AssistantHistory> {
  const response = await runtimeRequest(
    `/vs12/projects/${encodeURIComponent(projectId)}/assistant/history`,
  );
  return assistantHistorySchema.parse(await response.json());
}

export async function readAssistantRuntimeStream({
  projectId,
  after,
  signal,
  onEvent,
}: {
  projectId: string;
  after: string | null;
  signal: AbortSignal;
  onEvent: (event: AssistantStreamEvent) => void;
}): Promise<void> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  const response = await runtimeRequest(
    `/vs12/projects/${encodeURIComponent(projectId)}/assistant/stream${query}`,
    { signal, headers: { accept: "text/event-stream" } },
  );
  if (!response.body) throw new Error("实时助手未返回可读取的数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainder = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const parsed = parseSseChunk(
        decoder.decode(result.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      parsed.events.forEach(onEvent);
    }
    const final = parseSseChunk(decoder.decode(), remainder);
    final.events.forEach(onEvent);
  } finally {
    reader.releaseLock();
  }
}
