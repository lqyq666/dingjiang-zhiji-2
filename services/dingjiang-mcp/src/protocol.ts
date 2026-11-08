import { z } from "zod";
import {
  workExecutionRequestSchema,
  materialVerificationRequestSchema,
  materialVerificationPayloadSchema,
  evidenceConfirmationRequestSchema,
  evidenceConfirmationPayloadSchema,
  workpaperProposalPayloadSchema,
  workpaperProposeRequestSchema,
  materialCreatePayloadSchema,
  materialCreateRequestSchema,
  evidenceProposalPayloadSchema,
  evidenceProposeRequestSchema,
} from "@dingjiang/contracts";

import { IntegrationClientError, IntegrationTransportError } from "./client";
import type { DingjiangIntegrationClient } from "./client";

const protocolVersion = "2025-06-18";

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
const operationTools = [
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

const compatibilityTools = [
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
] as const;

const existingTool = (name: string) => {
  const tool = compatibilityTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing compatibility tool: ${name}`);
  return tool;
};

const businessTools = [
  ...operationTools,
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
  existingTool("workpaper.propose"),
  existingTool("material.create"),
  existingTool("evidence.propose"),
] as const;

const toolSurface = () =>
  process.env.DINGJIANG_MCP_TOOL_SURFACE === "compatibility"
    ? compatibilityTools
    : businessTools;

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
  return {
    code: "TOOL_UNAVAILABLE",
    message: error instanceof Error ? error.message : "MCP 工具调用失败",
    retryable: false,
    requiresHuman: true,
  };
};

const toolResult = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
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

const loadEvidenceBundle = async (
  client: IntegrationClient,
  projectId: string,
) => {
  const [evidence, materials, workpaper, proposals] = await Promise.all([
    client.listEvidence(projectId),
    client.listTraceableMaterials(projectId),
    client.getValidationWorkpaper(projectId),
    client.getEvidenceProposals(projectId),
  ]);
  return { projectId, evidence, materials, workpaper, proposals };
};

const deriveNextAction = (
  state: Awaited<ReturnType<IntegrationClient["getProjectState"]>>,
  currentWorkItem: Awaited<ReturnType<IntegrationClient["getCurrentWorkItem"]>>,
  materials: Awaited<ReturnType<IntegrationClient["listTraceableMaterials"]>>,
) => {
  if (currentWorkItem.projectId === state.id && currentWorkItem.item)
    return {
      kind: "WORK_ITEM",
      projectId: state.id,
      workItemId: currentWorkItem.item.id,
      title: currentWorkItem.item.title,
      responsibleRole: currentWorkItem.item.owner,
      explanation: "当前服务端派生事项优先处理",
      classification: "PROPOSAL",
    };
  const gap = materials.gaps[0];
  if (gap)
    return {
      kind: "MATERIAL_GAP",
      projectId: state.id,
      requirementId: gap.requirementId,
      title: gap.label,
      explanation: `材料缺口状态为 ${gap.status}`,
      classification: "PROPOSAL",
    };
  return {
    kind: "HUMAN_GATE_OR_REVIEW",
    projectId: state.id,
    title: "查看当前状态对应的人工 gate 或完成条件",
    explanation: `项目状态为 ${state.status}`,
    classification: "PROPOSAL",
  };
};

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
          throw new Error("当前项目与当前事项不一致，请刷新后重试");
        const [work, bundle] = await Promise.all([
          loadWorkContext(client, projectId, currentWorkItem),
          loadEvidenceBundle(client, projectId),
        ]);
        return toolResult({
          projects,
          ...work,
          ...bundle,
          currentWorkItem,
          nextAction: deriveNextAction(
            work.state,
            currentWorkItem,
            bundle.materials,
          ),
        });
      }
      case "work.context": {
        const body = identifierInput.parse(input);
        return toolResult(await loadWorkContext(client, body.projectId));
      }
      case "evidence.bundle": {
        const body = identifierInput.parse(input);
        return toolResult(await loadEvidenceBundle(client, body.projectId));
      }
      case "experience.search": {
        const body = searchInput.parse(input);
        return toolResult(await client.searchFormalExperiences(body.query));
      }
      case "project.next_action": {
        const body = identifierInput.parse(input);
        const [work, materials] = await Promise.all([
          loadWorkContext(client, body.projectId),
          client.listTraceableMaterials(body.projectId),
        ]);
        return toolResult(
          deriveNextAction(work.state, work.currentWorkItem, materials),
        );
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "UNKNOWN_TOOL",
                message: "未公开该 MCP 工具",
                retryable: false,
                requiresHuman: false,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify(safeToolError(error)) }],
      isError: true,
    };
  }
};

export type McpBuildIdentity = {
  startup: string;
  current(): string;
};

export const createMcpHandler =
  (
    client: IntegrationClient,
    identity: McpBuildIdentity = {
      startup: "development",
      current: () => "development",
    },
  ) =>
  async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    if (request.id === undefined) return undefined;
    const id = request.id;
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
      if (request.method === "initialize")
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "dingjiang-mcp",
              version: "0.6.0",
              buildIdentity: identity.startup,
            },
          },
        };
      if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (request.method === "tools/list")
        return { jsonrpc: "2.0", id, result: { tools: toolSurface() } };
      if (request.method === "tools/call")
        return {
          jsonrpc: "2.0",
          id,
          result: await callTool(client, request.params),
        };
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

export const dingjiangTools = businessTools;
export const dingjiangCompatibilityTools = compatibilityTools;
