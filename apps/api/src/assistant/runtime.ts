import type {
  AssistantProvider,
  AssistantRunRequest,
  AssistantScope,
  AssistantSuggestion,
  AssistantToolResult,
} from "./contracts";
import type { Vs01ContextAdapter } from "./context";
import { rejectModelScopeArguments } from "./scope";

export const piToolAllowlist = [
  "get_current_work_context",
  "get_recent_work_events",
  "get_evidence",
  "get_material_preview",
] as const;

const piBuiltinTools = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export const assertEffectivePiTools = (tools: readonly string[]): void => {
  if (
    tools.length !== piToolAllowlist.length ||
    tools.some(
      (tool) =>
        !piToolAllowlist.includes(tool as (typeof piToolAllowlist)[number]),
    )
  )
    throw new Error(
      "Pi effective tools must match the read-only VS12 allowlist",
    );
  if (tools.some((tool) => piBuiltinTools.has(tool)))
    throw new Error("Pi builtin tools are prohibited in VS12");
};

export type AssistantRuntimePort = {
  readonly provider: AssistantProvider;
  run(input: {
    scope: AssistantScope;
    request: AssistantRunRequest;
    context: Vs01ContextAdapter;
  }): Promise<AssistantSuggestion>;
};

type PiCustomTool = {
  name: (typeof piToolAllowlist)[number];
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: { status: string; evidenceIds: string[]; data?: unknown };
  }>;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const pick = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  const input = object(value);
  return Object.fromEntries(
    keys.flatMap((key) =>
      input[key] === undefined ? [] : [[key, input[key]]],
    ),
  );
};

const locator = (value: unknown) =>
  pick(value, ["sourceObjectId", "sourceVersionId", "reference"]);

const material = (value: unknown, includePreview: boolean) => {
  const input = object(value);
  const file = object(input.file);
  return {
    ...pick(input, [
      "id",
      "requirementId",
      "title",
      "note",
      "kind",
      "status",
      "situationCode",
    ]),
    ...(input.locator ? { locator: locator(input.locator) } : {}),
    ...(input.file
      ? {
          file: {
            ...pick(file, [
              "originalName",
              "mediaType",
              "extractionStatus",
              "readableByAi",
            ]),
            ...(includePreview && typeof file.contentPreview === "string"
              ? { contentPreview: file.contentPreview }
              : {}),
          },
        }
      : {}),
  };
};

const phase = (value: unknown) => {
  const input = object(value);
  return {
    ...pick(input, [
      "code",
      "name",
      "status",
      "progress",
      "completedTaskCount",
      "totalTaskCount",
      "purpose",
    ]),
    ...(Array.isArray(input.tasks)
      ? {
          tasks: input.tasks.map((task) => {
            const item = object(task);
            const output = object(item.output);
            return {
              ...pick(item, [
                "id",
                "title",
                "purpose",
                "status",
                "owner",
                "completionNote",
                "completedAt",
                "reopenReason",
              ]),
              ...(Array.isArray(item.inputs)
                ? {
                    inputs: item.inputs.map((entry) =>
                      pick(entry, [
                        "label",
                        "status",
                        "reference",
                        "requirementId",
                      ]),
                    ),
                  }
                : {}),
              ...(item.output
                ? {
                    output: {
                      ...pick(output, ["expected", "reference"]),
                      ...(output.locator
                        ? { locator: locator(output.locator) }
                        : {}),
                    },
                  }
                : {}),
            };
          }),
        }
      : {}),
  };
};

const evidence = (value: unknown) => {
  const input = object(value);
  return pick(input, [
    "id",
    "sourceObjectId",
    "sourceVersionId",
    "sourceFile",
    "sourceSheet",
    "sourceRow",
    "fields",
    "classification",
  ]);
};

const safeCurrentContext = (data: unknown) => {
  const input = object(data);
  const project = object(input.project);
  const sourceTask = object(input.sourceTask);
  return {
    ...(input.project
      ? {
          project: {
            ...pick(project, ["id", "name", "status", "progress"]),
            ...(project.currentStage
              ? { currentStage: phase(project.currentStage) }
              : {}),
            ...(Array.isArray(project.phases)
              ? { phases: project.phases.map(phase) }
              : {}),
            ...(project.outcome
              ? {
                  outcome: pick(project.outcome, [
                    "baseline",
                    "target",
                    "current",
                    "status",
                    "conclusion",
                    "locator",
                  ]),
                }
              : {}),
            ...(Array.isArray(project.experienceSummary)
              ? {
                  experienceSummary: project.experienceSummary.map((item) =>
                    pick(item, ["id", "title", "status", "locator"]),
                  ),
                }
              : {}),
            ...(Array.isArray(project.recentActivities)
              ? {
                  recentActivities: project.recentActivities.map((item) =>
                    pick(item, [
                      "eventType",
                      "phaseCode",
                      "note",
                      "actor",
                      "createdAt",
                    ]),
                  ),
                }
              : {}),
            ...(project.latestConfirmedWorkpaper
              ? {
                  latestConfirmedWorkpaper: pick(
                    project.latestConfirmedWorkpaper,
                    [
                      "status",
                      "revision",
                      "conclusion",
                      "locator",
                      "confirmedAt",
                      "confirmedBy",
                    ],
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(input.sourceTask
      ? {
          sourceTask: {
            ...pick(sourceTask, ["id", "status"]),
            ...(Array.isArray(sourceTask.facts)
              ? {
                  facts: sourceTask.facts.map((item) =>
                    pick(item, ["label", "value", "evidenceId"]),
                  ),
                }
              : {}),
            ...(Array.isArray(sourceTask.evidence)
              ? { evidence: sourceTask.evidence.map(evidence) }
              : {}),
            ...(Array.isArray(sourceTask.materials)
              ? {
                  materials: sourceTask.materials.map((item) =>
                    material(item, true),
                  ),
                }
              : {}),
            ...(Array.isArray(sourceTask.materialGaps)
              ? {
                  materialGaps: sourceTask.materialGaps.map((item) =>
                    pick(item, [
                      "requirementId",
                      "label",
                      "status",
                      "situationCode",
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
};

const safeRecentEvents = (data: unknown) => {
  const events = object(data).events;
  return {
    events: Array.isArray(events)
      ? events.map((event) =>
          pick(event, [
            "id",
            "eventType",
            "stageCode",
            "actorRole",
            "occurredAt",
            "evidenceIds",
          ]),
        )
      : [],
  };
};

const safeEvidence = (data: unknown) => {
  const values = object(data).evidence;
  return { evidence: Array.isArray(values) ? values.map(evidence) : [] };
};

const safeMaterialPreview = (data: unknown) => {
  const input = object(data);
  return input.material ? { material: material(input.material, true) } : {};
};

const safeToolResult = (
  result: AssistantToolResult,
  type: (typeof piToolAllowlist)[number],
) => ({
  status: result.status,
  evidenceIds: result.evidenceIds ?? [],
  ...(result.data === undefined
    ? {}
    : {
        data:
          type === "get_current_work_context"
            ? safeCurrentContext(result.data)
            : type === "get_recent_work_events"
              ? safeRecentEvents(result.data)
              : type === "get_evidence"
                ? safeEvidence(result.data)
                : safeMaterialPreview(result.data),
      }),
});

const strictEmptyObject = (params: unknown): void => {
  rejectModelScopeArguments(params);
  if (!params || typeof params !== "object" || Object.keys(params).length !== 0)
    throw new Error("Pi read-only tool accepts an empty object only");
};

const strictEvidenceInput = (params: unknown): { evidenceId: string } => {
  rejectModelScopeArguments(params);
  if (!params || typeof params !== "object")
    throw new Error("get_evidence requires evidenceId");
  const input = params as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    typeof input.evidenceId !== "string" ||
    input.evidenceId.trim() === ""
  )
    throw new Error("get_evidence accepts evidenceId only");
  return { evidenceId: input.evidenceId };
};

const strictMaterialInput = (params: unknown): { materialId: string } => {
  rejectModelScopeArguments(params);
  if (!params || typeof params !== "object")
    throw new Error("get_material_preview requires materialId");
  const input = params as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    typeof input.materialId !== "string" ||
    input.materialId.trim() === ""
  )
    throw new Error("get_material_preview accepts materialId only");
  return { materialId: input.materialId };
};

/** Exposed for SDK-free tests; the Runtime only supplies server-derived scope. */
export const createPiCustomTools = (input: {
  scope: AssistantScope;
  context: Vs01ContextAdapter;
}): PiCustomTool[] => [
  {
    name: "get_current_work_context",
    label: "get_current_work_context",
    description: "Read the current authorized consulting work context.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_toolCallId, params) => {
      strictEmptyObject(params);
      const result = await input.context.currentWorkContext(input.scope, {});
      const safe = safeToolResult(result, "get_current_work_context");
      return {
        content: [{ type: "text", text: JSON.stringify(safe) }],
        details: safe,
      };
    },
  },
  {
    name: "get_recent_work_events",
    label: "get_recent_work_events",
    description: "Read recent authorized project work-event envelopes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_toolCallId, params) => {
      strictEmptyObject(params);
      const result = await input.context.recentWorkEvents(input.scope, {});
      const safe = safeToolResult(result, "get_recent_work_events");
      return {
        content: [{ type: "text", text: JSON.stringify(safe) }],
        details: safe,
      };
    },
  },
  {
    name: "get_evidence",
    label: "get_evidence",
    description: "Read an authorized evidence reference by evidenceId.",
    parameters: {
      type: "object",
      properties: { evidenceId: { type: "string", minLength: 1 } },
      required: ["evidenceId"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const evidence = strictEvidenceInput(params);
      const result = await input.context.evidence(input.scope, evidence);
      const safe = safeToolResult(result, "get_evidence");
      return {
        content: [{ type: "text", text: JSON.stringify(safe) }],
        details: safe,
      };
    },
  },
  {
    name: "get_material_preview",
    label: "get_material_preview",
    description:
      "Read a safe preview of one active material in the authorized consulting task.",
    parameters: {
      type: "object",
      properties: { materialId: { type: "string", minLength: 1 } },
      required: ["materialId"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const materialInput = strictMaterialInput(params);
      const result = await input.context.materialPreview(
        input.scope,
        materialInput,
      );
      const safe = safeToolResult(result, "get_material_preview");
      return {
        content: [{ type: "text", text: JSON.stringify(safe) }],
        details: safe,
      };
    },
  },
];

export class DemoRulesRuntimeAdapter implements AssistantRuntimePort {
  readonly provider = "DEMO_RULES" as const;

  async run(input: {
    scope: AssistantScope;
    request: AssistantRunRequest;
    context: Vs01ContextAdapter;
  }): Promise<AssistantSuggestion> {
    const context = await input.context.currentWorkContext(input.scope);
    const project = context.data?.project as
      | {
          currentStage?: {
            name?: string;
            tasks?: Array<{
              title?: string;
              status?: string;
              owner?: string;
              reopenReason?: string;
            }>;
          };
          phases?: Array<{ name: string; progress: number }>;
          latestConfirmedWorkpaper?: {
            revision?: number;
            conclusion?: { statement?: string; limitations?: string };
          };
        }
      | undefined;
    const stage = project?.currentStage?.name ?? "当前工作节点";
    const phase = project?.phases?.find((item) => item.name === stage);
    const currentItem =
      project?.currentStage?.tasks?.find((item) =>
        ["READY", "IN_PROGRESS", "RETURNED", "WAITING_REVIEW"].includes(
          item.status ?? "",
        ),
      ) ?? project?.currentStage?.tasks?.[0];
    const reopenReason = currentItem?.reopenReason?.trim();
    const confirmed = project?.latestConfirmedWorkpaper;
    const conclusion = confirmed?.conclusion?.statement?.trim();
    const limitations = confirmed?.conclusion?.limitations?.trim();
    const confirmedHistory = conclusion
      ? `历史上已确认的根因结论（v${confirmed?.revision ?? "?"}）：${conclusion}${limitations ? ` 限制与边界：${limitations}` : ""}。${reopenReason ? "该事项已重新打开，上述内容是历史确认版本，不能替代这次更新后的员工结论。" : "该结论仅供当前工作复查，是否沿用或调整仍由员工决定。"}`.replace(
          /。{2,}/gu,
          "。",
        )
      : "当前没有可复查的已确认根因结论；请以本次员工核验的材料和结论为准。";
    const owner =
      currentItem?.owner === "PMC" || !currentItem?.owner
        ? "你"
        : `当前责任人（${currentItem.owner}）`;
    const actionableTask = currentItem?.title?.trim();
    const nextAction = actionableTask
      ? `${owner}先在“${stage}”完成“${actionableTask}”的材料核对与结论更新${reopenReason ? `（重新打开原因：${reopenReason}）` : ""}，再由员工确认完成；确认后系统才会推进下一步。`
      : phase && phase.progress < 100
        ? "继续完成当前节点中尚未确认的事项；由员工确认完成后系统才会推进下一步。"
        : "查看下一节点的输入与待办，并由对应员工确认完成。";
    return {
      classification: "PROPOSAL",
      provider: "DEMO_RULES",
      fallbackReason: "Pi 模型未配置；当前为本地规则建议",
      evidenceIds: context.evidenceIds ?? [],
      answer: `我已读取“${stage}”的授权工作上下文。${confirmedHistory} 本建议是只读 PROPOSAL，不会替代员工判断、确认或推进状态。 下一步：${nextAction}`,
      nextAction,
    };
  }
}

/** Deterministic test double; never used as a production provider. */
export class FakeRuntimeAdapter implements AssistantRuntimePort {
  readonly provider = "PI" as const;
  constructor(private readonly suggestion: AssistantSuggestion) {}
  async run(): Promise<AssistantSuggestion> {
    return this.suggestion;
  }
}

type PiModule = {
  createAgentSession?: (options: Record<string, unknown>) => Promise<unknown>;
  defineTool?: (tool: Record<string, unknown>) => unknown;
  DefaultResourceLoader?: new (options: Record<string, unknown>) => unknown;
};

const nativeDynamicImport = async (specifier: string): Promise<PiModule> =>
  Function(
    "specifier",
    "return import(specifier)",
  )(specifier) as Promise<PiModule>;

/**
 * ESM-only SDK boundary. It is intentionally opt-in: VS12 has no authority to
 * call a paid provider, while construction keeps the future vendor seam real.
 */
export class PiRuntimeAdapter implements AssistantRuntimePort {
  readonly provider = "PI" as const;
  constructor(
    private readonly loadPi: (
      specifier: string,
    ) => Promise<PiModule> = nativeDynamicImport,
  ) {}

  async run(input: {
    scope: AssistantScope;
    request: AssistantRunRequest;
    context: Vs01ContextAdapter;
  }): Promise<AssistantSuggestion> {
    if (process.env.PI_RUNTIME_ENABLED !== "true")
      throw new Error("PI_RUNTIME_DISABLED");
    if (process.env.PI_PROVIDER_AUTHORIZED !== "true")
      throw new Error("PI_PROVIDER_NOT_AUTHORIZED");
    assertEffectivePiTools(piToolAllowlist);
    const sdk = await this.loadPi("@earendil-works/pi-coding-agent");
    if (
      !sdk.createAgentSession ||
      !sdk.DefaultResourceLoader ||
      !sdk.defineTool
    )
      throw new Error("Pi SDK does not expose the expected runtime API");
    // Construct only. A real provider/model is deliberately not invoked without
    // explicit Founder authorization and a separately configured model seam.
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      systemPromptOverride: () =>
        "You are a read-only consulting copilot. All output is PROPOSAL.",
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    const customTools = createPiCustomTools(input).map((tool) =>
      sdk.defineTool?.(tool),
    );
    await sdk.createAgentSession({
      noTools: "builtin",
      resourceLoader,
      customTools,
      tools: [...piToolAllowlist],
    });
    throw new Error("PI_PROVIDER_EXECUTION_NOT_IMPLEMENTED");
  }
}

export const asProposal = (
  suggestion: AssistantSuggestion,
): AssistantSuggestion => ({
  ...suggestion,
  classification: "PROPOSAL",
  evidenceIds: [...new Set(suggestion.evidenceIds)],
});

export type ReadOnlyTool = (input: unknown) => Promise<AssistantToolResult>;
