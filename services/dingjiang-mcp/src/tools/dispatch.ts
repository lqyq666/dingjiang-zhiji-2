import { z } from "zod";
import {
  workExecutionRequestSchema,
  materialVerificationRequestSchema,
  evidenceConfirmationRequestSchema,
  workpaperProposeRequestSchema,
  materialCreateRequestSchema,
  evidenceProposeRequestSchema,
} from "@dingjiang/contracts";
import {
  IntegrationClientError,
  IntegrationTransportError,
  type DingjiangIntegrationClient,
} from "../client";
import {
  aggregateOutputFor,
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
  workpaperProposeInput,
} from "./schemas";

export type IntegrationClient = Pick<
  DingjiangIntegrationClient,
  | "listEvents"
  | "getExecutionContext"
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
  limitBytes?: number;
}) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  structuredContent: payload,
  isError: true,
});

/** Each handler validates its input and returns an Integration payload. */
type ToolHandler = (
  client: IntegrationClient,
  input: unknown,
) => Promise<unknown>;

const workHandlers: Record<string, ToolHandler> = {
  "workspace.events": async (client, input) => {
    emptyInput.parse(input);
    return client.listEvents();
  },
  "work.operations": async (client, input) => {
    const body = identifierInput.parse(input);
    return client.getExecutionContext(body.projectId);
  },
  "work.execute": async (client, input) => {
    const { projectId, ...request } = workExecuteInput.parse(input);
    return client.executeWork(
      projectId,
      workExecutionRequestSchema.parse(request),
    );
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

    // Hosts validate structuredContent against the success schema even on errors.
    const { content, isError } = errorResult({
      code: "AGGREGATE_RESULT_TOO_LARGE",
      message: "聚合结果超过 512 KiB。请改用范围更小的只读工具查询所需部分。",
      limitBytes: MAX_AGGREGATE_RESULT_BYTES,
      retryable: false,
      requiresHuman: false,
    });
    return { content, isError };
  } catch (error) {
    return errorResult(safeToolError(error));
  }
};
