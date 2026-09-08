export const assistantRoles = ["PMC", "OWNER", "EXPERT_REVIEWER"] as const;
export type AssistantRole = (typeof assistantRoles)[number];

export type AssistantScope = {
  tenantId: string;
  subjectId: string;
  role: AssistantRole;
  projectId: string;
  sourceTaskId: string | null;
  policyVersion: "VS12-1";
};

export type AssistantRunStatus =
  "QUEUED" | "THINKING" | "COMPLETED" | "FAILED" | "FALLBACK";
export type AssistantProvider = "PI" | "DEMO_RULES";
export type AssistantToolResultStatus =
  | "OK"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "BODY_NOT_AVAILABLE"
  | "TEMPORARILY_UNAVAILABLE"
  | "STALE_CONTEXT";
export type AssistantStreamType =
  | "STREAM_READY"
  | "RUN_STARTED"
  | "STATE_CHANGED"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TEXT_DELTA"
  | "SUGGESTION"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "HEARTBEAT";

export type AssistantStreamEvent = {
  cursor: string;
  sessionId: string;
  runId: string | null;
  stageCode: string | null;
  occurredAt: string;
  type: AssistantStreamType;
  payload: Record<string, unknown>;
};

export type AssistantSuggestion = {
  classification: "PROPOSAL";
  answer: string;
  evidenceIds: string[];
  nextAction: string;
  provider: AssistantProvider;
  fallbackReason?: string;
};

export type AssistantRunSuggestion = Omit<
  AssistantSuggestion,
  "provider" | "fallbackReason"
>;

export type AssistantRunRequest = {
  stageCode?: string;
  question?: string;
  intent?: string;
};

export type AssistantRun = {
  id: string;
  sessionId: string;
  projectId: string;
  sourceTaskId: string;
  correlationKey: string;
  intent: string;
  question: string;
  stageCode: string | null;
  status: AssistantRunStatus;
  provider: AssistantProvider;
  classification: "PROPOSAL";
  createdAt: string;
  completedAt: string | null;
  suggestion: AssistantRunSuggestion | null;
  fallbackReason: string | null;
};

export type AssistantHistory = {
  session: {
    id: string;
    scope: Required<AssistantScope>;
    createdAt: string;
    lastActiveAt: string;
  };
  runs: AssistantRun[];
  latestCursor: string;
};

/** Small envelope copied by the database trigger; it is never a business fact. */
export type AssistantWorkEvent = {
  id: string;
  tenantId: string;
  projectId: string;
  sourceTaskId: string;
  correlationKey: string;
  eventType: string;
  stageCode: string | null;
  actorRole: AssistantRole;
  payload: Record<string, unknown>;
};

export type AssistantToolResult<T = Record<string, unknown>> = {
  status: AssistantToolResultStatus;
  data?: T;
  evidenceIds?: string[];
};
