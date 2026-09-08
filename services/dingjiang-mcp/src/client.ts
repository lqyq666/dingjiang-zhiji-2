import { validateIntegrationBaseUrl } from "./endpoint-policy";
import {
  workExecutionContextSchema,
  governedCommandResultSchema,
  materialVerificationResultSchema,
  evidenceConfirmationResultSchema,
  evidenceProposalReviewListSchema,
  type WorkExecutionRequest,
  type MaterialVerificationRequest,
  type EvidenceConfirmationRequest,
  integrationCurrentWorkItemSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationExperienceEvidenceSchema,
  integrationExperienceSearchSchema,
  integrationFailureEnvelopeSchema,
  integrationFormalExperienceSchema,
  integrationMaterialListSchema,
  integrationMaterialPreviewSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationProjectStateSchema,
  integrationSourceVersionSchema,
  integrationSuccessEnvelopeSchema,
  integrationValidationWorkpaperSchema,
  integrationWorkItemListSchema,
  workpaperProposeResultSchema,
  materialCreateResultSchema,
  evidenceProposeResultSchema,
  type IntegrationFailureEnvelope,
  type WorkpaperProposeRequest,
  type MaterialCreateRequest,
  type EvidenceProposalPayload,
  type GovernedCommandRequest,
} from "@dingjiang/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export class IntegrationClientError extends Error {
  constructor(readonly failure: IntegrationFailureEnvelope) {
    super(failure.error.message);
    this.name = "IntegrationClientError";
  }
}

const integrationBaseUrl = (): URL =>
  validateIntegrationBaseUrl(
    process.env.DINGJIANG_API_BASE_URL?.trim() || "http://127.0.0.1:3001/api",
  );

const apiToken = (): string => {
  const token = process.env.DINGJIANG_MCP_API_TOKEN?.trim();
  if (!token || /^\$\{[A-Z0-9_]+\}$/.test(token))
    throw new Error("DINGJIANG_MCP_API_TOKEN 未配置");
  return token;
};

export class DingjiangIntegrationClient {
  private async get<T>(path: string, dataSchema: z.ZodType<T>): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), integrationBaseUrl());
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken()}`,
        "x-correlation-id": randomUUID(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = integrationFailureEnvelopeSchema.safeParse(payload);
      if (failure.success) throw new IntegrationClientError(failure.data);
      throw new Error(`Integration API 请求失败（HTTP ${response.status}）`);
    }
    return integrationSuccessEnvelopeSchema(dataSchema).parse(payload).data;
  }

  private async post<T>(
    path: string,
    body: unknown,
    dataSchema: z.ZodType<T>,
    correlationId: string,
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), integrationBaseUrl());
    const response = await fetch(url, {
      redirect: "error",
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiToken()}`,
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = integrationFailureEnvelopeSchema.safeParse(payload);
      if (failure.success) throw new IntegrationClientError(failure.data);
      throw new Error(`Integration API 请求失败（HTTP ${response.status}）`);
    }
    return integrationSuccessEnvelopeSchema(dataSchema).parse(payload).data;
  }

  getProjectContext(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/context`,
      integrationProjectContextSchema,
    );
  }

  listProjects() {
    return this.get("integration/projects", integrationProjectListSchema);
  }

  getCurrentProject() {
    return this.get(
      "integration/projects/current",
      integrationProjectStateSchema,
    );
  }

  getCurrentWorkItem() {
    return this.get(
      "integration/projects/current/work-item",
      integrationCurrentWorkItemSchema,
    );
  }

  listProjectWorkItems(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/work-items`,
      integrationWorkItemListSchema,
    );
  }

  getProjectState(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/state`,
      integrationProjectStateSchema,
    );
  }

  listEvidence(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence`,
      integrationEvidenceListSchema,
    );
  }

  listTraceableMaterials(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/materials`,
      integrationMaterialListSchema,
    );
  }

  getMaterialPreview(projectId: string, materialId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/preview`,
      integrationMaterialPreviewSchema,
    );
  }

  getEvidence(projectId: string, evidenceId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidenceId)}`,
      integrationEvidenceDetailSchema,
    );
  }

  getSourceVersion(projectId: string, sourceVersionId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/source-versions/${encodeURIComponent(sourceVersionId)}`,
      integrationSourceVersionSchema,
    );
  }

  getValidationWorkpaper(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/workpaper`,
      integrationValidationWorkpaperSchema,
    );
  }

  searchFormalExperiences(query: string) {
    const parameters = new URLSearchParams({ query });
    return this.get(
      `integration/experiences/search?${parameters.toString()}`,
      integrationExperienceSearchSchema,
    );
  }

  getFormalExperience(experienceId: string) {
    return this.get(
      `integration/experiences/${encodeURIComponent(experienceId)}`,
      integrationFormalExperienceSchema,
    );
  }

  getExperienceEvidence(experienceId: string) {
    return this.get(
      `integration/experiences/${encodeURIComponent(experienceId)}/evidence`,
      integrationExperienceEvidenceSchema,
    );
  }

  listEvents() {
    return this.get(
      "integration/events",
      z.object({
        items: z.array(
          z.object({
            projectId: z.string(),
            sourceTaskId: z.string(),
            title: z.string(),
            status: z.string(),
          }),
        ),
      }),
    );
  }
  getExecutionContext(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/operations`,
      workExecutionContextSchema,
    );
  }
  executeWork(projectId: string, request: WorkExecutionRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/operations`,
      request,
      governedCommandResultSchema,
      request.correlationId,
    );
  }
  verifyMaterial(projectId: string, request: MaterialVerificationRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(request.payload.materialId)}/verification`,
      request,
      materialVerificationResultSchema,
      request.correlationId,
    );
  }
  confirmEvidence(projectId: string, request: EvidenceConfirmationRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/confirmation`,
      request,
      evidenceConfirmationResultSchema,
      request.correlationId,
    );
  }
  getEvidenceProposals(projectId: string) {
    return this.get(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/proposals`,
      evidenceProposalReviewListSchema,
    );
  }

  proposeWorkpaper(projectId: string, request: WorkpaperProposeRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/workpaper/proposals`,
      request,
      workpaperProposeResultSchema,
      request.correlationId,
    );
  }

  createMaterial(projectId: string, request: MaterialCreateRequest) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/materials`,
      request,
      materialCreateResultSchema,
      request.correlationId,
    );
  }

  proposeEvidence(
    projectId: string,
    request: GovernedCommandRequest & { payload: EvidenceProposalPayload },
  ) {
    return this.post(
      `integration/projects/${encodeURIComponent(projectId)}/evidence/proposals`,
      request,
      evidenceProposeResultSchema,
      request.correlationId,
    );
  }
}
