import type { AssistantStreamEvent } from "@dingjiang/contracts";
import { describe, expect, it } from "vitest";

import {
  createAssistantStreamState,
  parseSseChunk,
  reduceAssistantStreamEvent,
  restoreAssistantStreamHistory,
} from "./assistant-stream";

const event = <T extends AssistantStreamEvent["type"]>(
  type: T,
  detail: Omit<
    Extract<AssistantStreamEvent, { type: T }>,
    "cursor" | "sessionId" | "runId" | "stageCode" | "occurredAt" | "type"
  >,
  cursor = "8",
): Extract<AssistantStreamEvent, { type: T }> =>
  ({
    cursor,
    sessionId: "ASST-PRJ-OTD-001",
    runId: "run-1",
    stageCode: "EXECUTION_CONTROL",
    occurredAt: "2026-08-17T12:00:00.000Z",
    type,
    ...detail,
  }) as Extract<AssistantStreamEvent, { type: T }>;

describe("assistant stream", () => {
  it("restores the persisted cursor so reconnect does not replay history", () => {
    const restored = restoreAssistantStreamHistory(
      createAssistantStreamState(),
      {
        latestCursor: "42",
        runs: [],
      },
    );

    expect(restored.cursor).toBe("42");
  });
  it("parses a split SSE frame against the public VS12 contract", () => {
    const first = parseSseChunk(
      'event: assistant\ndata: {"cursor":"7","sessionId":"ASST-PRJ-OTD-001",',
      "",
    );
    const second = parseSseChunk(
      '"runId":"run-1","stageCode":"EXECUTION_CONTROL","occurredAt":"2026-08-17T12:00:00.000Z","type":"TEXT_DELTA","text":"请先核对 BOM"}\n\n',
      first.remainder,
    );

    expect(first.events).toEqual([]);
    expect(second.events).toEqual([
      expect.objectContaining({
        cursor: "7",
        type: "TEXT_DELTA",
        text: "请先核对 BOM",
      }),
    ]);
    expect(second.remainder).toBe("");
  });

  it("ignores a replayed cursor while streaming a proposal", () => {
    const first = reduceAssistantStreamEvent(
      createAssistantStreamState(),
      event("TEXT_DELTA", { text: "建议先核对" }),
    );
    const replay = reduceAssistantStreamEvent(
      first,
      event("TEXT_DELTA", { text: "建议先核对" }),
    );
    const complete = reduceAssistantStreamEvent(
      replay,
      event(
        "SUGGESTION",
        {
          suggestion: {
            classification: "PROPOSAL",
            answer: "建议先核对 BOM 版本，再决定是否补料。",
            evidenceIds: ["E-102"],
            nextAction: "核对 BOM 版本",
          },
        },
        "9",
      ),
    );

    expect(replay.messages).toHaveLength(1);
    expect(complete.status).toBe("SUGGESTING");
    expect(complete.messages.at(-1)).toMatchObject({
      text: "建议先核对 BOM 版本，再决定是否补料。",
      evidenceIds: ["E-102"],
    });
  });

  it("shows an explicit fallback without treating it as a Pi answer", () => {
    const state = reduceAssistantStreamEvent(
      createAssistantStreamState(),
      event("RUN_FAILED", { reason: "Pi Provider 暂未配置" }),
    );

    expect(state.status).toBe("OBSERVING");
    expect(state.provider).toBeNull();
    expect(state.notice).toBe("Pi Provider 暂未配置");
  });
});
