import {
  assistantStreamEventSchema,
  type AssistantRun,
  type AssistantStreamEvent,
} from "@dingjiang/contracts";

export type AssistantUiStatus =
  "OBSERVING" | "THINKING" | "SUGGESTING" | "CONVERSATION";

export type AssistantProvider = AssistantRun["provider"];

export type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  provider?: AssistantProvider;
  evidenceIds: string[];
  pending?: boolean;
};

export type AssistantStreamState = {
  cursor: string | null;
  status: AssistantUiStatus;
  provider: AssistantProvider | null;
  notice: string | null;
  activeTool: string | null;
  messages: AssistantMessage[];
};

export const createAssistantStreamState = (): AssistantStreamState => ({
  cursor: null,
  status: "OBSERVING",
  provider: null,
  notice: null,
  activeTool: null,
  messages: [],
});

export function restoreAssistantStreamHistory(
  state: AssistantStreamState,
  history: { runs: AssistantRun[]; latestCursor: string },
): AssistantStreamState {
  return {
    ...state,
    cursor: history.latestCursor,
    messages:
      state.messages.length > 0
        ? state.messages
        : history.runs.flatMap((run) =>
            run.suggestion
              ? [
                  {
                    id: `history-${run.id}`,
                    role: "assistant" as const,
                    text: run.suggestion.answer,
                    provider: run.provider,
                    evidenceIds: run.suggestion.evidenceIds,
                  },
                ]
              : [],
          ),
  };
}

function parseEvent(data: string): AssistantStreamEvent | null {
  try {
    return assistantStreamEventSchema.safeParse(JSON.parse(data)).data ?? null;
  } catch {
    return null;
  }
}

export function parseSseChunk(
  chunk: string,
  remainder = "",
): { events: AssistantStreamEvent[]; remainder: string } {
  const source = `${remainder}${chunk}`.replace(/\r\n/g, "\n");
  const frames = source.split("\n\n");
  const trailing = frames.pop() ?? "";
  const events = frames.flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const event = data ? parseEvent(data) : null;
    return event ? [event] : [];
  });
  return { events, remainder: trailing };
}

function statusFromRun(
  status: Extract<AssistantStreamEvent, { type: "STATE_CHANGED" }>["status"],
): AssistantUiStatus {
  if (status === "THINKING") return "THINKING";
  if (status === "COMPLETED") return "CONVERSATION";
  return "OBSERVING";
}

export function reduceAssistantStreamEvent(
  state: AssistantStreamState,
  event: AssistantStreamEvent,
): AssistantStreamState {
  if (state.cursor === event.cursor) return state;
  const next = { ...state, cursor: event.cursor };
  if (event.type === "RUN_STARTED")
    return { ...next, status: "THINKING", notice: null };
  if (event.type === "STATE_CHANGED")
    return { ...next, status: statusFromRun(event.status) };
  if (event.type === "TOOL_STARTED")
    return { ...next, status: "THINKING", activeTool: event.toolName };
  if (event.type === "TOOL_COMPLETED") return { ...next, activeTool: null };
  if (event.type === "TEXT_DELTA") {
    const previous = next.messages.at(-1);
    const messages =
      previous?.role === "assistant" && previous.pending
        ? [
            ...next.messages.slice(0, -1),
            { ...previous, text: `${previous.text}${event.text}` },
          ]
        : [
            ...next.messages,
            {
              id: `stream-${event.cursor}`,
              role: "assistant" as const,
              text: event.text,
              evidenceIds: [],
              pending: true,
            },
          ];
    return { ...next, status: "SUGGESTING", messages };
  }
  if (event.type === "SUGGESTION") {
    const withoutDelta = next.messages.at(-1)?.pending
      ? next.messages.slice(0, -1)
      : next.messages;
    return {
      ...next,
      status: "SUGGESTING",
      messages: [
        ...withoutDelta,
        {
          id: `suggestion-${event.cursor}`,
          role: "assistant",
          text: event.suggestion.answer,
          evidenceIds: event.suggestion.evidenceIds,
        },
      ],
    };
  }
  if (event.type === "RUN_COMPLETED") {
    const latest = next.messages.at(-1);
    return {
      ...next,
      status: "CONVERSATION",
      provider: event.provider,
      activeTool: null,
      messages:
        latest?.role === "assistant" && !latest.provider
          ? [
              ...next.messages.slice(0, -1),
              { ...latest, provider: event.provider },
            ]
          : next.messages,
    };
  }
  if (event.type === "RUN_FAILED")
    return {
      ...next,
      status: "OBSERVING",
      activeTool: null,
      notice: event.reason,
    };
  return next;
}
