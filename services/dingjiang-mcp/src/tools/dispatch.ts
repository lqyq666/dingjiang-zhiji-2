import { z } from "zod";
import {
  workExecutionRequestSchema,
  materialVerificationRequestSchema,
  evidenceConfirmationRequestSchema,
  workpaperProposeRequestSchema,
  materialCreateRequestSchema,
  evidenceProposeRequestSchema,
  integrationExecutionProjectSchema,
  type Project,
} from "@dingjiang/contracts";
import {
  IntegrationClientError,
  IntegrationTransportError,
  type DingjiangIntegrationClient,
} from "../client";
import {
  aggregateOutputFor,
  compactProgressContextSchema,
  compactProgressReceiptDataSchema,
  emptyInput,
  evidenceConfirmInput,
  evidenceInput,
  evidenceProposeInput,
  experienceInput,
  identifierInput,
  materialCreateInput,
  materialInput,
  materialVerifyInput,
  searchInput,
  sourceVersionInput,
  workExecuteInput,
  workOperationsInput,
  workpaperProposeInput,
} from "./schemas";

export type IntegrationClient = Pick<
  DingjiangIntegrationClient,
  | "listEvents"
  | "getExecutionContext"
  | "getProgressReadback"
  | "executeWork"
  | "verifyMaterial"
  | "confirmEvidence"
  | "getEvidenceBundle"
  | "getWorkContext"
  | "getWorkspaceResume"
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

const safeToolError = (error: unknown, tool: string) => {
  if (error instanceof IntegrationClientError) {
    const { failure, retryAfterSeconds, requestCorrelationId } = error;
    let { message } = failure.error;
    if (failure.error.code === "RATE_LIMITED") {
      const wait =
        retryAfterSeconds === undefined
          ? "等待时间未知。"
          : `最早可在 ${retryAfterSeconds} 秒后另行发起。`;
      message = `请求过于频繁。本轮停止调用并告知用户。${wait}`;
    }
    return {
      code: failure.error.code,
      message,
      retryable: failure.error.retryable,
      requiresHuman: failure.error.requiresHuman,
      correlationId: failure.correlationId,
      requestCorrelationId,
      retryAfterSeconds,
    };
  }
  if (error instanceof IntegrationTransportError)
    return {
      code: error.code,
      message:
        tool === "work.execute" && error.code === "INTEGRATION_NETWORK_ERROR"
          ? "写入结果未知。先用只读工具核对目标事项。确需取回回执且用户已确认时，使用相同 requestId 原样提交完整原命令。"
          : error.message,
      correlationId: error.correlationId,
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
  // Arbitrary exceptions can contain internal paths or credentials.
  return {
    code: "TOOL_UNAVAILABLE",
    message: "MCP 工具调用失败。请检查本机 MCP 日志。",
    retryable: false,
    requiresHuman: true,
  };
};

const MAX_AGGREGATE_RESULT_BYTES = 512 * 1024;

const toolResult = (data: unknown, text = JSON.stringify(data)) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: data,
});

const errorResult = (payload: {
  code: string;
  message: string;
  retryable: boolean;
  requiresHuman: boolean;
  correlationId?: string;
  requestCorrelationId?: string;
  retryAfterSeconds?: number;
  limitBytes?: number;
}) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  // The advertised outputSchema describes only a successful result.
  isError: true,
});

/** Each handler validates its input and returns an Integration payload. */
type ToolHandler = (
  client: IntegrationClient,
  input: unknown,
) => Promise<unknown>;

const progressItems = (project: Pick<Project, "phases"> | null) =>
  project?.phases.flatMap((phase) =>
    phase.tasks.map((item) => ({
      id: item.id,
      title: item.title,
      phaseCode: phase.code,
      phaseName: phase.name,
      status: item.status,
      progressUpdate: item.progressUpdate,
    })),
  ) ?? [];

const workHandlers: Record<string, ToolHandler> = {
  "workspace.events": async (client, input) => {
    emptyInput.parse(input);
    return client.listEvents();
  },
  "work.operations": async (client, input) => {
    const { projectId, responseFormat, workItemId } =
      workOperationsInput.parse(input);
    if (workItemId) return client.getProgressReadback(projectId, workItemId);
    const context = await client.getExecutionContext(projectId);
    if (responseFormat !== "compact") return context;
    return compactProgressContextSchema.parse({
      responseFormat,
      projectId,
      projectName: context.project?.name ?? null,
      version: context.version,
      stateFingerprint: context.stateFingerprint,
      allowedActions: context.allowedActions.filter(
        (action) => action === "progress.record",
      ),
      approvalRequiredActions: context.approvalRequiredActions.filter(
        (action) => action === "progress.record",
      ),
      items: progressItems(context.project).filter(
        (item) => item.status !== "DONE" && item.status !== "LOCKED",
      ),
    });
  },
  "work.execute": async (client, input) => {
    const { projectId, responseFormat, ...request } =
      workExecuteInput.parse(input);
    const result = await client.executeWork(
      projectId,
      workExecutionRequestSchema.parse(request),
    );
    const operation = request.payload.operation;
    if (responseFormat !== "compact" || operation.action !== "progress.record")
      return result;
    const project = integrationExecutionProjectSchema.safeParse(
      result.data.project,
    );
    if (!project.success)
      throw new IntegrationTransportError(
        "INTEGRATION_INVALID_RESPONSE",
        "进展回执缺少有效的项目数据",
        { correlationId: result.correlationId },
      );
    return {
      ...result,
      data: compactProgressReceiptDataSchema.parse({
        responseFormat,
        projectId,
        action: operation.action,
        item:
          progressItems(project.data).find(
            (item) => item.id === operation.workItemId,
          ) ?? null,
      }),
    };
  },
  "workspace.resume": async (client, input) => {
    emptyInput.parse(input);
    return client.getWorkspaceResume();
  },
  "work.context": async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getWorkContext(body.projectId);
  },
  "project.next_action": async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getNextAction(body.projectId);
  },
};

const evidenceHandlers: Record<string, ToolHandler> = {
  "evidence.bundle": async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getEvidenceBundle(body.projectId);
  },
  "material.verify": async (client, input) => {
    const { projectId, ...request } = materialVerifyInput.parse(input);
    return client.verifyMaterial(
      projectId,
      materialVerificationRequestSchema.parse(request),
    );
  },
  "evidence.confirm": async (client, input) => {
    const { projectId, ...request } = evidenceConfirmInput.parse(input);
    return client.confirmEvidence(
      projectId,
      evidenceConfirmationRequestSchema.parse(request),
    );
  },
  "workpaper.propose": async (client, input) => {
    const { projectId, ...request } = workpaperProposeInput.parse(input);
    return client.proposeWorkpaper(
      projectId,
      workpaperProposeRequestSchema.parse(request),
    );
  },
  "material.create": async (client, input) => {
    const { projectId, ...request } = materialCreateInput.parse(input);
    return client.createMaterial(
      projectId,
      materialCreateRequestSchema.parse(request),
    );
  },
  "evidence.propose": async (client, input) => {
    const { projectId, ...request } = evidenceProposeInput.parse(input);
    return client.proposeEvidence(
      projectId,
      evidenceProposeRequestSchema.parse(request),
    );
  },
};

const experienceHandlers: Record<string, ToolHandler> = {
  "experience.search": async (client, input) => {
    const body = searchInput.parse(input);
    return client.searchFormalExperiences(body.query);
  },
  search_formal_experiences: async (client, input) => {
    const body = searchInput.parse(input);
    return client.searchFormalExperiences(body.query);
  },
  get_formal_experience: async (client, input) => {
    const body = experienceInput.parse(input);
    return client.getFormalExperience(body.experienceId);
  },
  get_experience_evidence: async (client, input) => {
    const body = experienceInput.parse(input);
    return client.getExperienceEvidence(body.experienceId);
  },
};

const readHandlers: Record<string, ToolHandler> = {
  list_projects: async (client, input) => {
    emptyInput.parse(input);
    return client.listProjects();
  },
  get_current_project: async (client, input) => {
    emptyInput.parse(input);
    return client.getCurrentProject();
  },
  get_project_context: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getProjectContext(body.projectId);
  },
  get_project_state: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getProjectState(body.projectId);
  },
  get_current_work_item: async (client, input) => {
    emptyInput.parse(input);
    return client.getCurrentWorkItem();
  },
  list_project_work_items: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.listProjectWorkItems(body.projectId);
  },
  list_evidence: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.listEvidence(body.projectId);
  },
  list_traceable_materials: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.listTraceableMaterials(body.projectId);
  },
  get_material_preview: async (client, input) => {
    const body = materialInput.parse(input);
    return client.getMaterialPreview(body.projectId, body.materialId);
  },
  get_evidence: async (client, input) => {
    const body = evidenceInput.parse(input);
    return client.getEvidence(body.projectId, body.evidenceId);
  },
  get_source_version: async (client, input) => {
    const body = sourceVersionInput.parse(input);
    return client.getSourceVersion(body.projectId, body.sourceVersionId);
  },
  get_validation_workpaper: async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getValidationWorkpaper(body.projectId);
  },
};

/**
 * The implementation side of the tool surface. Exported so a test can compare
 * it with the declared set: a handler without a declaration, or the reverse, is
 * a drift the switch used to hide behind its default branch.
 */
const toolHandlers: Record<string, ToolHandler> = {
  ...workHandlers,
  ...evidenceHandlers,
  ...experienceHandlers,
  ...readHandlers,
};

export const registeredToolNames: ReadonlySet<string> = new Set(
  Object.keys(toolHandlers),
);

export const callTool = async (
  client: IntegrationClient,
  name: string,
  input: unknown,
  resultOverheadBytes = 0,
) => {
  // Only own entries are tool handlers.
  const handler = Object.hasOwn(toolHandlers, name)
    ? toolHandlers[name]
    : undefined;
  if (!handler) return undefined;

  try {
    const data = await handler(client, input ?? {});
    const schema = aggregateOutputFor(name);
    if (!schema) return toolResult(data);

    const projection = schema.safeParse(data);
    if (!projection.success)
      throw new IntegrationTransportError(
        "INTEGRATION_INVALID_RESPONSE",
        "聚合结果与 MCP 输出契约不一致；请检查服务端与 MCP 的版本是否匹配",
        { cause: projection.error },
      );

    const text = JSON.stringify(projection.data);
    const result = toolResult(projection.data, text);
    // The result carries both structured JSON and escaped text, plus wire metadata.
    const payloadBudget = MAX_AGGREGATE_RESULT_BYTES - resultOverheadBytes;
    if (
      Buffer.byteLength(text, "utf8") * 2 <= payloadBudget &&
      Buffer.byteLength(JSON.stringify(result), "utf8") <= payloadBudget
    )
      return result;

    return errorResult({
      code: "AGGREGATE_RESULT_TOO_LARGE",
      message: "聚合结果超过 512 KiB。请改用范围更小的只读工具查询所需部分。",
      limitBytes: MAX_AGGREGATE_RESULT_BYTES,
      retryable: false,
      requiresHuman: false,
    });
  } catch (error) {
    return errorResult(safeToolError(error, name));
  }
};
