import { z } from "zod";
import {
  emptyInput,
  evidenceConfirmInput,
  materialVerifyInput,
  outputSchemaFor,
  workExecuteInput,
  workOperationsInput,
  type JsonSchemaObject,
} from "./schemas";

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
  "work.context": { title: "读取项目工作上下文摘要", kind: "read" },
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
  list_traceable_materials: { title: "列出材料与核验状态", kind: "read" },
  get_material_preview: { title: "读取材料受控预览", kind: "read" },
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

export const isReadOnlyTool = (name: string): boolean =>
  Object.hasOwn(toolGovernance, name) &&
  toolGovernance[name as keyof typeof toolGovernance].kind === "read";

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

const operationTools: ToolSeed[] = [
  {
    name: "workspace.events",
    description:
      "列出服务端明确授权的事件与项目入口，包含尚未建项事件的预留 projectId；只能使用返回的 ID。",
    inputSchema: z.toJSONSchema(emptyInput),
  },
  {
    name: "work.operations",
    description: [
      "读取项目操作版本与获准动作。用户只给事项名称时，先从 workspace.events 获取授权项目，在可能匹配的项目查找。多处同名时先请用户选择项目。",
      '记录进展时，在请用户确认前先做项目级查询，传 {"projectId":"实际项目 ID","responseFormat":"compact"}，不传 workItemId。项目级结果返回候选事项、version 和 stateFingerprint。',
      "取齐 version 和 stateFingerprint 再请用户确认。两项均为提交必填。首次提交将 version 填入 expectedVersion，将 stateFingerprint 原样填入 payload.stateFingerprint。",
      "请在用户确认前说明状态变化。首次在 READY（待开始）的事项上记录进展会将事项转为 IN_PROGRESS（进行中），所属阶段若同为 READY 也会转为 IN_PROGRESS。",
      '提交后核对指定事项，或用户单独要求回读该事项时，首个 work.operations 调用传 {"projectId":"实际项目 ID","workItemId":"实际事项 ID","responseFormat":"compact"}。传 workItemId 时必须显式传 responseFormat: "compact"。单事项结果包含最新进展与版本，不含 stateFingerprint。其他动作使用完整返回。',
    ].join(" "),
    inputSchema: z.toJSONSchema(workOperationsInput, { io: "input" }),
  },
  {
    name: "work.execute",
    description: [
      '记录进展或执行经用户确认的治理动作。进展的 payload.operation 格式为 {"action":"progress.record","workItemId":"实际事项 ID","note":"进展内容"}。',
      "新命令先读目标项目的 work.operations，用 version 填 expectedVersion，原样复制 stateFingerprint。",
      "多个授权项目时，必须传入用户选定项目的 projectId，从读取结果原样复制。同名事项的目标不明时，先请用户选择项目。只有一个授权项目时，记录进展可省略 projectId，由 MCP 从授权列表定位。",
      "业务请求中的项目编号与授权查询不一致时，说明不匹配，并请用户确认是否选择具体的授权项目，点明查到的项目名称。无候选时请用户核对编号。确认前停止写入。",
      "用户已确认的完整命令按其字段原样传入。若用户明确授权在隔离测试中验证指定命令，先原样提交一次，保留给定编号及其他字段。核实明确拒绝且零写入后，才按用户的条件授权重新查询目标并纠正。",
      "写前说明目标和影响，收到明确确认后才可调用。用户只提出记录请求时，先询问确认。confirmation 填用户的确认原话。requestId 和 correlationId 必须为 UUID。",
      '记录进展可用 responseFormat: "compact" 获取精简回执，成功后按事项回读。结果未知时先核对，重放用完整原命令，保留所有字段和值。方案定稿仅 OWNER、经验发布仅 EXPERT_REVIEWER。',
    ].join(" "),
    inputSchema: z.toJSONSchema(workExecuteInput, { io: "input" }),
  },
  {
    name: "material.verify",
    description:
      "用户核对具体材料内容后，由有 material:verify 权限的 PMC 记录核验或退回。先通过 evidence.bundle 的 materials.items 按材料 ID 取 verification.version 作为 expectedVersion，并展示可读取的内容与来源；兼容工具面也可用 get_material_preview。不能使用项目版本或材料需求可用性版本，不得以 AI 判断冒充人工核验。",
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
      "列出已授权项目的材料 ID、核验状态、最近核验记录与输入缺口。登记材料前按 situationCode 和 requirementId 定位 gaps[].availabilityVersion；它是该需求的登记版本，不能使用项目版本。用户要看预览或摘要时，先用此工具定位 items[].id，再调用 get_material_preview 核对正文可用性。",
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
      "用户要求查看材料预览或摘要时使用。用列表中的 items[].id 作为 materialId，即使列表显示无附件也需查询。只有 bodyAvailable 为 true 时才引用返回的预览，否则说明正文不可读。结果同时带有核验状态和最近核验记录。",
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
      "由具备 material:write 的 PMC 在授权项目与事项中登记首份待核验材料。先查 evidence.bundle 的 materials.gaps，按 situationCode 和 requirementId 取 availabilityVersion 填 expectedVersion；兼容工具面也可用 list_traceable_materials.gaps。0 表示无匹配 ACTIVE 材料，1 表示已有，当前命令不允许重复登记。不得用 work.operations 的项目 version、核验版本或材料数量代替；未取得该字段先停止，不猜版本。不会创建 Evidence、推进事项或确认业务结论。首版不上传文件。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 120 },
        requestId: { type: "string", format: "uuid" },
        expectedVersion: {
          type: "integer",
          minimum: 0,
          description:
            "目标材料需求在 evidence.bundle.materials.gaps 中的 availabilityVersion；不是项目版本。",
        },
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
      "恢复授权的当前项目、阶段、事项、材料缺口和下一动作。事项、证据和材料分别在 workItems、evidence 和 materials 中返回。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "work.context",
    description:
      "读取授权项目的阶段摘要、事项、来源事实和材料缺口。事项细节见 workItems，材料在此仅返回元数据。",
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
      "读取授权项目的事实证据、材料核验、SourceVersion 定位、缺口与证据提案。底稿保留当前和最近确认版本。",
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
