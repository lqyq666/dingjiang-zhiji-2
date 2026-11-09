import { z } from "zod";
import {
  workExecutionRequestSchema,
  workExecutionContextSchema,
  materialVerificationRequestSchema,
  materialVerificationPayloadSchema,
  materialVerificationResultSchema,
  evidenceConfirmationRequestSchema,
  evidenceConfirmationPayloadSchema,
  evidenceConfirmationResultSchema,
  workpaperProposalPayloadSchema,
  workpaperProposeRequestSchema,
  workpaperProposeResultSchema,
  materialCreatePayloadSchema,
  materialCreateRequestSchema,
  materialCreateResultSchema,
  evidenceProposalPayloadSchema,
  evidenceProposeRequestSchema,
  evidenceProposeResultSchema,
  governedCommandResultSchema,
  integrationCurrentWorkItemSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationExperienceEvidenceSchema,
  integrationExperienceSearchSchema,
  integrationFormalExperienceSchema,
  integrationMaterialListSchema,
  integrationMaterialPreviewSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationProjectStateSchema,
  integrationSourceVersionSchema,
  integrationValidationWorkpaperSchema,
  integrationWorkItemListSchema,
  evidenceProposalReviewListSchema,
  nextActionSchema,
} from "@dingjiang/contracts";

import {
  IntegrationClientError,
  IntegrationTransportError,
  integrationEventsSchema,
} from "./client";
import type { DingjiangIntegrationClient } from "./client";
import { createSessionProfile, type SessionProfile } from "./session-profile";

export { latestProtocolVersion } from "./session-profile";

/**
 * Reported in `serverInfo`. Defined once and used by the handler, so the
 * announced identity cannot lag the constant; `package.json` carries the
 * release number for packaging, and the two are bumped together.
 */
export const serverVersion = "0.7.0";

/**
 * The governance contract handed to the client in the `initialize` result.
 *
 * Clients place this in the model context before the first tool call, which
 * makes it the one supported way to state the product invariant in every host
 * rather than depending on each host's prompt to be worded correctly.
 */
export const serverInstructions = [
  "鼎江智绩治理型 MCP。PostgreSQL 是唯一业务事实源；工具返回的是服务端已授权的事实快照。",
  "",
  "必须遵守：",
  "1. AI 归纳出的任何结论一律是 PROPOSAL，不得表述为 FACT、根因或已确认结论。",
  "2. 调用 work.execute / material.verify / evidence.confirm / workpaper.propose / material.create / evidence.propose 前，先读 work.operations 取得最新 expectedVersion 与 allowedActions，向用户展示具体影响并取得本次确认；confirmation 保存用户原话，不得代写。",
  "3. 超时或网络错误不得更换 requestId 重试，必须复用原 requestId 核对服务端状态。",
  "4. 方案定稿仅 OWNER，经验发布仅 EXPERT_REVIEWER；工具不因调用方声明而放宽角色。",
].join("\n");

type JsonSchemaObject = {
  [keyword: string]: unknown;
  additionalProperties?: unknown;
};

export type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

type ToolSeed = {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
};

export type ToolDescriptor = ToolSeed & {
  annotations: ToolAnnotations;
  outputSchema?: JsonSchemaObject;
};

type ToolKind = "read" | "governed-write";

/**
 * Governance classification per tool.
 *
 * Without annotations every tool inherits the protocol defaults
 * (`readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`), so a
 * host cannot tell a GET-style lookup from a governed write: it either prompts
 * before every read or — worse, if a write were mislabelled — skips the
 * confirmation the whole model depends on. Classifying each tool explicitly is
 * what makes the read/write boundary machine-readable.
 */
const toolGovernance = {
  "workspace.events": { title: "列出授权事件与项目入口", kind: "read" },
  "work.operations": { title: "读取操作版本与获准动作", kind: "read" },
  "work.execute": { title: "记录进展、确认或提交方案", kind: "governed-write" },
  "material.verify": { title: "记录材料人工核验", kind: "governed-write" },
  "evidence.confirm": { title: "确认或驳回证据提案", kind: "governed-write" },
  "workspace.resume": { title: "恢复当前项目全貌与下一动作", kind: "read" },
  "work.context": { title: "读取项目完整工作上下文", kind: "read" },
  "evidence.bundle": { title: "读取证据包与材料核验", kind: "read" },
  "experience.search": { title: "检索已发布正式经验", kind: "read" },
  "project.next_action": { title: "派生唯一可解释的下一动作", kind: "read" },
  list_projects: { title: "列出授权咨询项目", kind: "read" },
  get_current_project: { title: "读取当前咨询项目", kind: "read" },
  get_project_context: { title: "读取项目工作上下文", kind: "read" },
  get_project_state: { title: "读取项目状态与阶段", kind: "read" },
  get_current_work_item: { title: "读取当前事项", kind: "read" },
  list_project_work_items: { title: "列出阶段事项", kind: "read" },
  list_evidence: { title: "列出可追溯事实证据", kind: "read" },
  list_traceable_materials: { title: "列出材料摘要与核验状态", kind: "read" },
  get_material_preview: { title: "读取材料安全摘要", kind: "read" },
  get_evidence: { title: "读取单条事实证据", kind: "read" },
  get_source_version: { title: "解析来源版本定位", kind: "read" },
  get_validation_workpaper: { title: "读取根因核验工作底稿", kind: "read" },
  search_formal_experiences: { title: "检索正式经验", kind: "read" },
  get_formal_experience: { title: "读取单条正式经验", kind: "read" },
  get_experience_evidence: { title: "读取经验引用的证据定位", kind: "read" },
  "workpaper.propose": {
    title: "追加根因核验或分析 Proposal",
    kind: "governed-write",
  },
  "material.create": { title: "登记待核验材料版本", kind: "governed-write" },
  "evidence.propose": { title: "登记证据 Proposal", kind: "governed-write" },
} as const satisfies Record<string, { title: string; kind: ToolKind }>;

/**
 * Fails closed: a tool that is listed without a governance classification
 * cannot be given honest hints, and the safe default would be to label it
 * destructive — which hides the real writes among a wall of false ones.
 */
const annotationsFor = (name: string): ToolAnnotations => {
  const entry = toolGovernance[name as keyof typeof toolGovernance] as
    { title: string; kind: ToolKind } | undefined;
  if (!entry)
    throw new Error(
      `Missing tool governance metadata for ${name}; every tool must declare whether it reads or writes before it can be listed`,
    );
  const governedWrite = entry.kind === "governed-write";
  return {
    title: entry.title,
    readOnlyHint: !governedWrite,
    destructiveHint: governedWrite,
    // Same requestId + expectedVersion replays into the same receipt, because
    // the governed command contract makes requestId the idempotency key. That
    // is also why a timeout must reuse the original requestId instead of
    // minting a new one. Reads are trivially idempotent.
    idempotentHint: true,
    // Every tool reaches the first-party Integration API scoped to the caller's
    // token. None of them browse the open web, so their output must not be
    // treated as untrusted external content by the host.
    openWorldHint: false,
  };
};

/**
 * Shape of the single derived next action. It is declared here rather than
 * inferred from the builder so that `classification` is a literal type: the
 * derivation cannot start emitting `FACT` (or any other value) without a
 * compile error, which is the cheapest possible guard for the one field an
 * agent is most likely to over-read.
 */
/**
 * Output contracts for the three aggregate tools.
 *
 * Their payload is assembled from parts, so the shape is written explicitly
 * instead of derived from one client schema. Each composite is parsed before
 * it is returned, which makes `structuredContent` conformant by construction
 * here too rather than by promise.
 */
const workContextOutput = z
  .object({
    projectId: z.string(),
    context: integrationProjectContextSchema,
    state: integrationProjectStateSchema,
    currentWorkItem: integrationCurrentWorkItemSchema,
    workItems: integrationWorkItemListSchema,
  })
  .strict();

const evidenceBundleOutput = z
  .object({
    projectId: z.string(),
    evidence: integrationEvidenceListSchema,
    materials: integrationMaterialListSchema,
    workpaper: integrationValidationWorkpaperSchema.nullable(),
    proposals: evidenceProposalReviewListSchema,
  })
  .strict();

const workspaceResumeOutput = z
  .object({
    projects: integrationProjectListSchema,
    ...workContextOutput.shape,
    evidence: integrationEvidenceListSchema,
    materials: integrationMaterialListSchema,
    workpaper: integrationValidationWorkpaperSchema.nullable(),
    proposals: evidenceProposalReviewListSchema,
    nextAction: nextActionSchema,
  })
  .strict();

/**
 * Declared output contracts, taken from the exact Zod schemas the client
 * already validates each Integration response with. Deriving rather than
 * hand-writing means a contract change cannot leave `outputSchema` behind, and
 * `structuredContent` is conformant by construction rather than by promise.
 *
 * The aggregate tools assemble their payload from several responses, so their
 * contracts are written explicitly and the result is parsed before return. A
 * guessed shape would be a contract the implementation could drift from
 * silently; parsing closes that gap.
 */
const outputContractSchemas: Record<string, z.ZodType> = {
  "workspace.events": integrationEventsSchema,
  "work.operations": workExecutionContextSchema,
  "work.execute": governedCommandResultSchema,
  "material.verify": materialVerificationResultSchema,
  "evidence.confirm": evidenceConfirmationResultSchema,
  list_projects: integrationProjectListSchema,
  get_current_project: integrationProjectStateSchema,
  get_project_context: integrationProjectContextSchema,
  get_project_state: integrationProjectStateSchema,
  get_current_work_item: integrationCurrentWorkItemSchema,
  list_project_work_items: integrationWorkItemListSchema,
  list_evidence: integrationEvidenceListSchema,
  list_traceable_materials: integrationMaterialListSchema,
  get_material_preview: integrationMaterialPreviewSchema,
  get_evidence: integrationEvidenceDetailSchema,
  get_source_version: integrationSourceVersionSchema,
  get_validation_workpaper: integrationValidationWorkpaperSchema,
  search_formal_experiences: integrationExperienceSearchSchema,
  "experience.search": integrationExperienceSearchSchema,
  get_formal_experience: integrationFormalExperienceSchema,
  get_experience_evidence: integrationExperienceEvidenceSchema,
  "workpaper.propose": workpaperProposeResultSchema,
  "material.create": materialCreateResultSchema,
  "evidence.propose": evidenceProposeResultSchema,
  "project.next_action": nextActionSchema,
  "workspace.resume": workspaceResumeOutput,
  "work.context": workContextOutput,
  "evidence.bundle": evidenceBundleOutput,
};

const outputSchemaFor = (name: string): JsonSchemaObject | undefined => {
  const schema = outputContractSchemas[name];
  if (!schema) return undefined;
  // `io: "output"` describes what the server emits rather than what it accepts:
  // an input-oriented schema would advertise defaulted fields as optional and
  // let a client validate against a shape this server never returns.
  return z.toJSONSchema(schema, { io: "output" }) as JsonSchemaObject;
};

/** Number of tools that declare an output contract; asserted by the tests. */
export const outputContractToolCount = Object.keys(
  outputContractSchemas,
).length;

/**
 * Attaches governance metadata and the output contract to a declared tool.
 * Applied at surface construction so the tool literals below stay readable
 * schemas, and so a newly added tool cannot skip classification silently.
 */
const finalize = (tools: readonly ToolSeed[]): ToolDescriptor[] =>
  tools.map((tool) => {
    const outputSchema = outputSchemaFor(tool.name);
    return {
      ...tool,
      annotations: annotationsFor(tool.name),
      ...(outputSchema ? { outputSchema } : {}),
    };
  });

type JsonRpcId = string | number | null;
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: { code: number; message: string; data?: unknown };
    };

export type IntegrationClient = Pick<
  DingjiangIntegrationClient,
  | "listEvents"
  | "getExecutionContext"
  | "executeWork"
  | "verifyMaterial"
  | "confirmEvidence"
  | "getEvidenceProposals"
  | "listProjects"
  | "getCurrentProject"
  | "getProjectContext"
  | "getProjectState"
  | "getCurrentWorkItem"
  | "listProjectWorkItems"
  | "listEvidence"
  | "getEvidence"
  | "listTraceableMaterials"
  | "getMaterialPreview"
  | "getSourceVersion"
  | "getValidationWorkpaper"
  | "getNextAction"
  | "searchFormalExperiences"
  | "getFormalExperience"
  | "getExperienceEvidence"
  | "proposeWorkpaper"
  | "createMaterial"
  | "proposeEvidence"
>;

const emptyInput = z.object({}).strict();
const identifierInput = z
  .object({ projectId: z.string().trim().min(1).max(120) })
  .strict();
const materialInput = identifierInput
  .extend({
    materialId: z.string().trim().min(1).max(120),
  })
  .strict();
const evidenceInput = identifierInput
  .extend({
    evidenceId: z.string().trim().min(1).max(120),
  })
  .strict();
const sourceVersionInput = identifierInput
  .extend({
    sourceVersionId: z.string().trim().min(1).max(160),
  })
  .strict();
const experienceInput = z
  .object({ experienceId: z.string().trim().min(1).max(120) })
  .strict();
const searchInput = z
  .object({ query: z.string().trim().max(200).default("") })
  .strict();
const workpaperProposeInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: workpaperProposalPayloadSchema,
  })
  .strict();
const materialCreateInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: materialCreatePayloadSchema,
  })
  .strict();
const evidenceProposeInput = z
  .object({
    projectId: z.string().trim().min(1).max(120),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    correlationId: z.string().uuid(),
    payload: evidenceProposalPayloadSchema,
  })
  .strict();

const workExecuteInput = workExecutionRequestSchema.safeExtend({
  projectId: z.string().trim().min(1).max(120),
});
const materialVerifyInput = z
  .object({
    ...materialCreateInput.shape,
    payload: materialVerificationPayloadSchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
const evidenceConfirmInput = z
  .object({
    ...evidenceProposeInput.shape,
    payload: evidenceConfirmationPayloadSchema,
  })
  .strict();
const operationTools: ToolSeed[] = [
  {
    name: "workspace.events",
    description:
      "列出服务端明确授权的事件与项目入口，包含尚未建项事件的预留 projectId；只能使用返回的 ID。",
    inputSchema: z.toJSONSchema(emptyInput),
  },
  {
    name: "work.operations",
    description:
      "读取项目最新事实、操作版本与当前身份获准的动作。执行前必读；allowedActions 代表权限，实际执行仍检查阶段和完成条件。",
    inputSchema: z.toJSONSchema(identifierInput),
  },
  {
    name: "work.execute",
    description:
      "根据用户明确指令记录进展、确认事项或结果、提交方案/经验。先读取 work.operations，展示具体影响并取得本次用户确认；confirmation 保存用户原话。方案定稿仅 OWNER、经验发布仅 EXPERT_REVIEWER。所有字段由已知上下文组装，只询问缺少的实际事实。成功回执包含提交后的项目事实；超时不得改 requestId 重试，必须复用原请求核对。",
    inputSchema: z.toJSONSchema(workExecuteInput),
  },
  {
    name: "material.verify",
    description:
      "用户核对具体材料内容后，由有 material:verify 权限的 PMC 记录核验或退回。先展示内容与来源，不得以 AI 判断冒充人工核验。",
    inputSchema: z.toJSONSchema(materialVerifyInput),
  },
  {
    name: "evidence.confirm",
    description:
      "用户核对 evidence.bundle 中的原文、来源版本及证据提案后，由有 evidence:confirm 权限的 PMC 确认或驳回。不得自行把提案升级为事实。",
    inputSchema: z.toJSONSchema(evidenceConfirmInput),
  },
];

const compatibilitySeeds: ToolSeed[] = [
  ...operationTools,
  {
    name: "list_projects",
    description:
      "列出当前服务端身份已授权的咨询项目，并返回服务端派生的当前项目。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_current_project",
    description:
      "读取当前服务端身份在授权集合中的当前咨询项目；调用方不能指定权限范围。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_project_context",
    description:
      "读取已授权咨询项目的完整只读工作上下文、事实、阶段、材料缺口和最近活动。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_project_state",
    description: "读取已授权咨询项目的当前状态、进度、阶段和经营结果状态。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_current_work_item",
    description: "读取当前授权项目中由服务端状态派生的唯一当前事项。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_project_work_items",
    description: "列出已授权咨询项目的阶段事项及其输入、输出与完成事实。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_evidence",
    description: "列出已授权咨询项目来源任务中的可追溯事实证据。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_traceable_materials",
    description:
      "列出已授权咨询项目的安全材料摘要与输入缺口；每条材料显式返回 verificationStatus，以及 latestVerificationAudit（最近人工核验的 eventType/version/actor/note/occurredAt，未核验时为 null）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_material_preview",
    description:
      "读取授权项目内一条材料的安全摘要、verificationStatus 与 latestVerificationAudit；不可读附件不返回原始 bytes 或存储键。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        materialId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId", "materialId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_evidence",
    description: "读取授权项目内一条可追溯事实证据。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        evidenceId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId", "evidenceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_source_version",
    description:
      "在授权项目范围内解析一个不可覆盖 SourceVersion 定位，不返回原始存储信息。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        sourceVersionId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["projectId", "sourceVersionId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_validation_workpaper",
    description: "读取授权项目的根因核验工作底稿、版本历史和证据定位。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_formal_experiences",
    description: "检索已发布正式经验；返回内容只能作为 PROPOSAL 候选参考。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200, default: "" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_formal_experience",
    description: "读取一条已发布正式经验及其适用范围、限制和证据定位。",
    inputSchema: {
      type: "object",
      properties: {
        experienceId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["experienceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_experience_evidence",
    description: "读取一条正式经验所引用的来源结果证据定位。",
    inputSchema: {
      type: "object",
      properties: {
        experienceId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["experienceId"],
      additionalProperties: false,
    },
  },
  {
    name: "material.create",
    description:
      "由 PMC 在授权项目与事项中登记一条待核验材料并形成不可覆盖版本；不会创建 Evidence、推进事项或确认业务结论。首版不上传文件。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        requestId: { type: "string", format: "uuid" },
        expectedVersion: { type: "integer", minimum: 0 },
        reason: { type: "string", minLength: 3, maxLength: 500 },
        correlationId: { type: "string", format: "uuid" },
        payload: {
          type: "object",
          properties: {
            workItemId: { type: "string", minLength: 1, maxLength: 160 },
            situationCode: {
              type: "string",
              enum: ["BOM_DELAY", "PURCHASE_DELAY", "CAPACITY_RISK"],
            },
            requirementId: { type: "string", minLength: 1, maxLength: 160 },
            materialType: {
              type: "string",
              enum: ["MANUAL_REFERENCE", "CONTROLLED_TEXT"],
            },
            displayName: { type: "string", minLength: 3, maxLength: 200 },
            sourceMetadata: {
              type: "object",
              properties: {
                sourceType: {
                  type: "string",
                  enum: [
                    "INTERNAL_RECORD",
                    "EXTERNAL_DOCUMENT",
                    "HUMAN_PROVIDED",
                  ],
                },
                sourceName: { type: "string", minLength: 3, maxLength: 200 },
                sourceReference: {
                  type: "string",
                  minLength: 1,
                  maxLength: 300,
                  pattern:
                    "^(?![A-Za-z][A-Za-z0-9+.-]*://)(?![A-Za-z]:[\\\\/])(?!\\\\\\\\)(?!/).+$",
                },
              },
              required: ["sourceType", "sourceName"],
              additionalProperties: false,
            },
            safeSummary: { type: "string", minLength: 3, maxLength: 1000 },
            controlledTextContent: {
              type: "string",
              minLength: 3,
              maxLength: 20000,
            },
          },
          required: [
            "workItemId",
            "situationCode",
            "requirementId",
            "materialType",
            "displayName",
            "sourceMetadata",
            "safeSummary",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "projectId",
        "requestId",
        "expectedVersion",
        "reason",
        "correlationId",
        "payload",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "workpaper.propose",
    description:
      "由 PMC 在授权项目中追加一份可追溯的根因核验或分析 Proposal；不会确认根因、推进事项、批准方案或发布经验。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        requestId: { type: "string", format: "uuid" },
        expectedVersion: { type: "integer", minimum: 0 },
        reason: { type: "string", minLength: 3, maxLength: 500 },
        correlationId: { type: "string", format: "uuid" },
        payload: {
          type: "object",
          properties: {
            proposalType: {
              type: "string",
              enum: ["ROOT_CAUSE_VALIDATION", "ANALYSIS"],
            },
            summary: { type: "string", minLength: 3, maxLength: 500 },
            reasoning: { type: "string", minLength: 3, maxLength: 4000 },
            evidenceFindings: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  evidenceId: { type: "string", minLength: 1, maxLength: 160 },
                  assertion: { type: "string", minLength: 3, maxLength: 1000 },
                },
                required: ["evidenceId", "assertion"],
                additionalProperties: false,
              },
            },
            materialFindings: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  materialId: { type: "string", minLength: 1, maxLength: 160 },
                  assertion: { type: "string", minLength: 3, maxLength: 1000 },
                  assessment: {
                    type: "string",
                    enum: ["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"],
                  },
                  note: { type: "string", maxLength: 500 },
                },
                required: ["materialId", "assertion", "assessment"],
                additionalProperties: false,
              },
            },
            experienceReferences: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  experienceId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 160,
                  },
                  applicationNote: {
                    type: "string",
                    minLength: 3,
                    maxLength: 500,
                  },
                },
                required: ["experienceId", "applicationNote"],
                additionalProperties: false,
              },
            },
            assumptions: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 3, maxLength: 500 },
            },
            missingInformation: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 3, maxLength: 500 },
            },
            limitations: { type: "string", minLength: 3, maxLength: 1000 },
          },
          required: [
            "proposalType",
            "summary",
            "reasoning",
            "evidenceFindings",
            "materialFindings",
            "experienceReferences",
            "assumptions",
            "missingInformation",
            "limitations",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "projectId",
        "requestId",
        "expectedVersion",
        "reason",
        "correlationId",
        "payload",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "evidence.propose",
    description:
      "由 PMC 从授权项目内 VERIFIED Material 的不可覆盖 SourceVersion 与 exact span 登记 Evidence Proposal；仍非 FACT，必须经 PMC human gate 确认。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        requestId: { type: "string", format: "uuid" },
        expectedVersion: { type: "integer", minimum: 0 },
        reason: { type: "string", minLength: 3, maxLength: 500 },
        correlationId: { type: "string", format: "uuid" },
        payload: {
          type: "object",
          properties: {
            workItemId: { type: "string", minLength: 1, maxLength: 160 },
            materialId: { type: "string", minLength: 1, maxLength: 160 },
            claim: { type: "string", minLength: 3, maxLength: 1000 },
            evidenceType: {
              type: "string",
              enum: ["OBSERVATION", "METRIC", "DOCUMENTED_FACT"],
            },
            sourceObjectId: { type: "string", minLength: 1, maxLength: 160 },
            sourceVersionId: { type: "string", minLength: 1, maxLength: 160 },
            exactSpan: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["TEXT_SPAN"] },
                start: { type: "integer", minimum: 0 },
                end: { type: "integer", minimum: 1 },
                exactText: { type: "string", minLength: 1, maxLength: 4000 },
              },
              required: ["kind", "start", "end", "exactText"],
              additionalProperties: false,
            },
            reasoning: { type: "string", minLength: 3, maxLength: 4000 },
            limitations: { type: "string", minLength: 3, maxLength: 1000 },
          },
          required: [
            "workItemId",
            "materialId",
            "claim",
            "evidenceType",
            "sourceObjectId",
            "sourceVersionId",
            "exactSpan",
            "reasoning",
            "limitations",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "projectId",
        "requestId",
        "expectedVersion",
        "reason",
        "correlationId",
        "payload",
      ],
      additionalProperties: false,
    },
  },
];

const businessOnlySeeds: ToolSeed[] = [
  {
    name: "workspace.resume",
    description:
      "一次恢复服务端身份的当前项目、阶段、事项、缺口、关键 Evidence/Material、Workpaper 与唯一下一动作。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "work.context",
    description:
      "读取一个已授权项目的完整工作上下文、状态、事项与服务端派生进度。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "evidence.bundle",
    description:
      "读取授权项目的 Evidence、材料核验、SourceVersion locator、缺口与当前 Workpaper 证据包。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "experience.search",
    description:
      "从 PostgreSQL 实时检索 PUBLISHED 正式经验，保留 locator、limitations 与适用性边界。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200, default: "" } },
      additionalProperties: false,
    },
  },
  {
    name: "project.next_action",
    description:
      "从已授权项目的服务端状态、当前事项和材料缺口派生唯一且可解释的下一动作。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
];

/**
 * One definition per tool. Both surfaces below are ordered name lists over this
 * registry rather than copies of the schemas, so a tool shared by the two
 * surfaces cannot drift between them.
 */
const toolRegistry = new Map<string, ToolDescriptor>(
  finalize([...compatibilitySeeds, ...businessOnlySeeds]).map((tool) => [
    tool.name,
    tool,
  ]),
);

const toolFromRegistry = (name: string): ToolDescriptor => {
  const tool = toolRegistry.get(name);
  if (!tool) throw new Error(`Missing tool in registry: ${name}`);
  return tool;
};

const businessToolNames: readonly string[] = [
  ...operationTools.map((tool) => tool.name),
  ...businessOnlySeeds.map((tool) => tool.name),
  "workpaper.propose",
  "material.create",
  "evidence.propose",
];

const compatibilityToolNames: readonly string[] = compatibilitySeeds.map(
  (tool) => tool.name,
);

/** Exported views share the very same ToolDescriptor instances. */
export const dingjiangTools: ToolDescriptor[] =
  businessToolNames.map(toolFromRegistry);
export const dingjiangCompatibilityTools: ToolDescriptor[] =
  compatibilityToolNames.map(toolFromRegistry);

/**
 * Tool list for the surface this deployment serves.
 *
 * The order is the declaration order, not a dictionary walk: the protocol
 * recommends a deterministic order so client-side prompt caching can reuse the
 * tool block across turns instead of re-hashing a reshuffled list.
 */
const toolSurface = (profile: SessionProfile): ToolDescriptor[] =>
  profile.toolSurface === "compatibility"
    ? dingjiangCompatibilityTools
    : dingjiangTools;

/**
 * A refusal the caller can act on: the request was well formed and the server
 * declined it for a stated reason. Its message is safe to return; an arbitrary
 * exception message is not, so only this type survives the sanitiser.
 */
class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requiresHuman = false,
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

const safeToolError = (error: unknown) => {
  if (error instanceof IntegrationClientError)
    return {
      code: error.failure.error.code,
      message: error.failure.error.message,
      retryable: error.failure.error.retryable,
      requiresHuman: error.failure.error.requiresHuman,
      correlationId: error.failure.correlationId,
    };
  if (error instanceof IntegrationTransportError)
    return {
      code: error.code,
      message: error.message,
      // Governed writes must be reconciled with the original requestId rather
      // than blindly retried, and a degraded transport needs a human to restore
      // the local service before any retry is meaningful.
      retryable: false,
      requiresHuman: true,
    };
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_REQUEST",
      message: "工具参数不符合 contract",
      retryable: false,
      requiresHuman: false,
    };
  if (error instanceof ToolRefusal)
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      requiresHuman: error.requiresHuman,
    };
  // Never echo an arbitrary exception message: it can carry file paths or
  // internal identifiers straight into the host transcript. Callers get a
  // stable code, and the API path already supplies a correlation id.
  return {
    code: "TOOL_UNAVAILABLE",
    message: "MCP 工具调用失败；请按 correlationId 核对服务端日志",
    retryable: false,
    requiresHuman: true,
  };
};

const toolResult = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

const errorResult = (payload: {
  code: string;
  message: string;
  retryable: boolean;
  requiresHuman: boolean;
  correlationId?: string;
}) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  structuredContent: payload,
  isError: true,
});

/**
 * Runtime check for the aggregate tools.
 *
 * Their payload is assembled from responses the client already validated
 * against the same schemas, so re-parsing the composite would only prove that
 * a test fixture matches the contract. What assembly can still get wrong is a
 * missing or misnamed top-level key, and that is what this checks.
 */
const assertCompositeShape = <T extends Record<string, unknown>>(
  data: T,
  expectedKeys: readonly string[],
): T => {
  const missing = expectedKeys.filter((key) => !(key in data));
  if (missing.length)
    throw new Error(`聚合结果缺少声明的字段：${missing.join(", ")}`);
  return data;
};

/**
 * A JSON-RPC level failure, distinct from a tool result.
 *
 * The specification separates "your request was malformed" (-32600), "the
 * method or its parameters are wrong" (-32601 / -32602) and "the handler
 * broke" (-32603) from "the tool ran and reported a business failure", which
 * belongs in the result with `isError: true`. Collapsing the two makes a client
 * retry a request that can never succeed.
 */
const protocolError = (
  id: string | number | null,
  code: number,
  message: string,
  dataCode: string,
  extra: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, data: { code: dataCode, ...extra } },
});

const loadWorkContext = async (
  client: IntegrationClient,
  projectId: string,
  knownCurrentWorkItem?: Awaited<
    ReturnType<IntegrationClient["getCurrentWorkItem"]>
  >,
) => {
  const [context, state, currentWorkItem, workItems] = await Promise.all([
    client.getProjectContext(projectId),
    client.getProjectState(projectId),
    knownCurrentWorkItem ?? client.getCurrentWorkItem(),
    client.listProjectWorkItems(projectId),
  ]);
  const scopedWorkItem =
    currentWorkItem.projectId === projectId
      ? currentWorkItem
      : {
          projectId,
          item:
            workItems.items.find(
              (item) =>
                item.phaseCode === state.currentStage?.code &&
                item.origin === "LIVE" &&
                ["READY", "IN_PROGRESS", "WAITING_REVIEW", "RETURNED"].includes(
                  item.status,
                ),
            ) ?? null,
        };
  return {
    projectId,
    context,
    state,
    currentWorkItem: scopedWorkItem,
    workItems,
  };
};

/**
 * Reads a constituent that is allowed not to exist yet.
 *
 * The composite tools (`workspace.resume`, `evidence.bundle`) used to fail
 * outright on a project that had not produced a workpaper: the aggregation
 * propagated the 404 of one optional constituent. A freshly created project
 * therefore could not be resumed at all, which is exactly when resume matters.
 *
 * Only NOT_FOUND is degraded. Verified against the real API: a missing scope or
 * an out-of-scope project is answered with 403 FORBIDDEN, so this cannot turn
 * an authorization failure into a silent null.
 */
const absentAsNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof IntegrationClientError &&
      error.failure.error.code === "NOT_FOUND"
    )
      return null;
    throw error;
  }
};

const loadEvidenceBundle = async (
  client: IntegrationClient,
  projectId: string,
) => {
  const [evidence, materials, workpaper, proposals] = await Promise.all([
    client.listEvidence(projectId),
    client.listTraceableMaterials(projectId),
    absentAsNull(() => client.getValidationWorkpaper(projectId)),
    client.getEvidenceProposals(projectId),
  ]);
  return { projectId, evidence, materials, workpaper, proposals };
};

/**
 * Builds the single derived next action.
 *
 * The result is parsed through `nextActionSchema` rather than merely typed:
 * `project.next_action` declares that schema as its `outputSchema`, and a
 * hand-assembled object is exactly the place where a declared contract and the
 * emitted payload drift apart. Parsing makes the declaration true at runtime
 * and keeps `classification` pinned to PROPOSAL.
 */
// `deriveNextAction` used to live here. It is a business rule (stage + current
// work item + material gaps -> next action), so it moved to
// apps/api/src/integration/next-action.service.ts. This adapter now calls
// GET /api/integration/projects/:id/next-action, and a second front end gets
// the same answer instead of a copy of the rule.

const callTool = async (client: IntegrationClient, params: unknown) => {
  const parsed = z
    .object({ name: z.string(), arguments: z.unknown().optional() })
    .passthrough()
    .parse(params);
  const input = parsed.arguments ?? {};
  try {
    switch (parsed.name) {
      case "workspace.events": {
        emptyInput.parse(input);
        return toolResult(await client.listEvents());
      }
      case "work.operations": {
        const body = identifierInput.parse(input);
        return toolResult(await client.getExecutionContext(body.projectId));
      }
      case "work.execute": {
        const { projectId, ...request } = workExecuteInput.parse(input);
        return toolResult(
          await client.executeWork(
            projectId,
            workExecutionRequestSchema.parse(request),
          ),
        );
      }
      case "material.verify": {
        const { projectId, ...request } = materialVerifyInput.parse(input);
        return toolResult(
          await client.verifyMaterial(
            projectId,
            materialVerificationRequestSchema.parse(request),
          ),
        );
      }
      case "evidence.confirm": {
        const { projectId, ...request } = evidenceConfirmInput.parse(input);
        return toolResult(
          await client.confirmEvidence(
            projectId,
            evidenceConfirmationRequestSchema.parse(request),
          ),
        );
      }
      case "workspace.resume": {
        emptyInput.parse(input);
        const [projects, currentProject, currentWorkItem] = await Promise.all([
          client.listProjects(),
          client.getCurrentProject(),
          client.getCurrentWorkItem(),
        ]);
        const projectId = currentProject.id;
        if (currentWorkItem.projectId !== projectId)
          throw new ToolRefusal(
            "CONTEXT_DRIFT",
            "当前项目与当前事项不一致，请刷新后重试",
            true,
          );
        const [work, bundle, nextAction] = await Promise.all([
          loadWorkContext(client, projectId, currentWorkItem),
          loadEvidenceBundle(client, projectId),
          client.getNextAction(projectId),
        ]);
        return toolResult(
          assertCompositeShape(
            { projects, ...work, ...bundle, currentWorkItem, nextAction },
            Object.keys(workspaceResumeOutput.shape),
          ),
        );
      }
      case "work.context": {
        const body = identifierInput.parse(input);
        return toolResult(
          assertCompositeShape(
            await loadWorkContext(client, body.projectId),
            Object.keys(workContextOutput.shape),
          ),
        );
      }
      case "evidence.bundle": {
        const body = identifierInput.parse(input);
        return toolResult(
          assertCompositeShape(
            await loadEvidenceBundle(client, body.projectId),
            Object.keys(evidenceBundleOutput.shape),
          ),
        );
      }
      case "experience.search": {
        const body = searchInput.parse(input);
        return toolResult(await client.searchFormalExperiences(body.query));
      }
      case "project.next_action": {
        const body = identifierInput.parse(input);
        return toolResult(await client.getNextAction(body.projectId));
      }
      case "list_projects": {
        emptyInput.parse(input);
        return toolResult(await client.listProjects());
      }
      case "get_current_project": {
        emptyInput.parse(input);
        return toolResult(await client.getCurrentProject());
      }
      case "get_project_context": {
        const body = identifierInput.parse(input);
        return toolResult(await client.getProjectContext(body.projectId));
      }
      case "get_project_state": {
        const body = identifierInput.parse(input);
        return toolResult(await client.getProjectState(body.projectId));
      }
      case "get_current_work_item": {
        emptyInput.parse(input);
        return toolResult(await client.getCurrentWorkItem());
      }
      case "list_project_work_items": {
        const body = identifierInput.parse(input);
        return toolResult(await client.listProjectWorkItems(body.projectId));
      }
      case "list_evidence": {
        const body = identifierInput.parse(input);
        return toolResult(await client.listEvidence(body.projectId));
      }
      case "list_traceable_materials": {
        const body = identifierInput.parse(input);
        return toolResult(await client.listTraceableMaterials(body.projectId));
      }
      case "get_material_preview": {
        const body = materialInput.parse(input);
        return toolResult(
          await client.getMaterialPreview(body.projectId, body.materialId),
        );
      }
      case "get_evidence": {
        const body = evidenceInput.parse(input);
        return toolResult(
          await client.getEvidence(body.projectId, body.evidenceId),
        );
      }
      case "get_source_version": {
        const body = sourceVersionInput.parse(input);
        return toolResult(
          await client.getSourceVersion(body.projectId, body.sourceVersionId),
        );
      }
      case "get_validation_workpaper": {
        const body = identifierInput.parse(input);
        return toolResult(await client.getValidationWorkpaper(body.projectId));
      }
      case "search_formal_experiences": {
        const body = searchInput.parse(input);
        return toolResult(await client.searchFormalExperiences(body.query));
      }
      case "get_formal_experience": {
        const body = experienceInput.parse(input);
        return toolResult(await client.getFormalExperience(body.experienceId));
      }
      case "get_experience_evidence": {
        const body = experienceInput.parse(input);
        return toolResult(
          await client.getExperienceEvidence(body.experienceId),
        );
      }
      case "workpaper.propose": {
        const { projectId, ...request } = workpaperProposeInput.parse(input);
        return toolResult(
          await client.proposeWorkpaper(
            projectId,
            workpaperProposeRequestSchema.parse(request),
          ),
        );
      }
      case "material.create": {
        const { projectId, ...request } = materialCreateInput.parse(input);
        return toolResult(
          await client.createMaterial(
            projectId,
            materialCreateRequestSchema.parse(request),
          ),
        );
      }
      case "evidence.propose": {
        const { projectId, ...request } = evidenceProposeInput.parse(input);
        return toolResult(
          await client.proposeEvidence(
            projectId,
            evidenceProposeRequestSchema.parse(request),
          ),
        );
      }
      default:
        return errorResult({
          code: "UNKNOWN_TOOL",
          message: "未公开该 MCP 工具",
          retryable: false,
          requiresHuman: false,
        });
    }
  } catch (error) {
    return errorResult(safeToolError(error));
  }
};

/**
 * Tool names the dispatcher actually implements.
 *
 * Tool schemas live in `businessTools` / `compatibilityTools`, while dispatch
 * lives in `callTool`'s switch; the two can drift silently when a tool is added
 * to one side only. `tool-contract.test.ts` asserts this set and the declared
 * schemas are identical in both directions, and that every declared tool
 * reaches its implementation instead of `UNKNOWN_TOOL`.
 */
export const dispatchedToolNames: ReadonlySet<string> = new Set([
  "workspace.events",
  "work.operations",
  "work.execute",
  "material.verify",
  "evidence.confirm",
  "workspace.resume",
  "work.context",
  "evidence.bundle",
  "experience.search",
  "project.next_action",
  "list_projects",
  "get_current_project",
  "get_project_context",
  "get_project_state",
  "get_current_work_item",
  "list_project_work_items",
  "list_evidence",
  "list_traceable_materials",
  "get_material_preview",
  "get_evidence",
  "get_source_version",
  "get_validation_workpaper",
  "search_formal_experiences",
  "get_formal_experience",
  "get_experience_evidence",
  "workpaper.propose",
  "material.create",
  "evidence.propose",
]);

export type McpBuildIdentity = {
  startup: string;
  current(): string;
};

/**
 * Negotiation is per session, so it lives in the closure rather than in module
 * state: `tools/list` must describe the revision this session agreed on, not
 * the newest revision the build happens to support.
 */
export const createMcpHandler = (
  client: IntegrationClient,
  identity: McpBuildIdentity = {
    startup: "development",
    current: () => "development",
  },
) => {
  let sessionProfile = createSessionProfile();
  let handshaken = false;

  return async (
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse | undefined> => {
    // Validate the JSON-RPC envelope before the dispatcher sees it. A payload
    // that is not an object, carries a non-scalar id, omits the version, or
    // has a non-string method is a protocol error, not a tool failure.
    const envelope = request as unknown;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    )
      return protocolError(null, -32600, "Invalid Request", "INVALID_ENVELOPE");

    const rawId = (request as { id?: unknown }).id;
    if (rawId === undefined) return undefined; // notification: no response
    if (
      rawId !== null &&
      typeof rawId !== "string" &&
      typeof rawId !== "number"
    )
      return protocolError(null, -32600, "Invalid Request", "INVALID_ID");
    const id = rawId as string | number | null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
      return protocolError(id, -32600, "Invalid Request", "INVALID_ENVELOPE");
    if (
      request.params !== undefined &&
      (request.params === null ||
        typeof request.params !== "object" ||
        Array.isArray(request.params))
    )
      return protocolError(id, -32602, "Invalid params", "INVALID_PARAMS");

    try {
      const deployedBuildIdentity = identity.current();
      if (deployedBuildIdentity !== identity.startup)
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "WorkBuddy MCP process is stale; start a new session",
            data: {
              code: "SESSION_MCP_PROCESS_STALE",
              startupBuildIdentity: identity.startup,
              deployedBuildIdentity,
              requiresNewSession: true,
            },
          },
        };
      if (request.method === "initialize") {
        // A client should handshake once. A repeat is answered with the first
        // negotiation instead of silently re-scoping the session, which would
        // change what an earlier tools/list already promised.
        if (!handshaken) {
          sessionProfile = createSessionProfile();
          handshaken = true;
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: sessionProfile.revision,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "dingjiang-mcp",
              version: serverVersion,
              buildIdentity: identity.startup,
            },
            instructions: serverInstructions,
          },
        };
      }
      if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (request.method === "tools/list")
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: toolSurface(sessionProfile) },
        };
      if (request.method === "tools/call") {
        // An unknown tool name is a parameter error, not a tool result: the
        // specification puts it under -32602 so a client can tell "you called
        // something that does not exist" from "the tool ran and failed".
        const toolName = (request.params as { name?: unknown } | undefined)
          ?.name;
        if (typeof toolName !== "string" || !dispatchedToolNames.has(toolName))
          return protocolError(id, -32602, "Invalid params", "UNKNOWN_TOOL", {
            tool: typeof toolName === "string" ? toolName : null,
          });
        return {
          jsonrpc: "2.0",
          id,
          result: await callTool(client, request.params),
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof z.ZodError ? -32602 : -32603,
          message:
            error instanceof z.ZodError ? "Invalid params" : "Internal error",
        },
      };
    }
  };
};

// Tool views are exported beside the single registry above.
