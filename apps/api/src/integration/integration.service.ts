import { WorkExecutionService } from "./work-execution.service";
import { EvidenceConfirmationCommand } from "../evidence/evidence-confirmation-command";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
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
  type IntegrationPrincipal,
  type IntegrationScope,
} from "@dingjiang/contracts";

import { Vs01ContextAdapter } from "../assistant/context";
import type { AssistantScope } from "../assistant/contracts";
import { Vs01Service } from "../vs01.service";
import { WorkpaperProposalCommand } from "../workpapers/workpaper-proposal-command";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { MaterialVerificationCommand } from "../materials/material-verification-command";
import { EvidenceProposalCommand } from "../evidence/evidence-proposal-command";
import { runtimeTenantId } from "../runtime-config";

const requireScope = (
  principal: IntegrationPrincipal,
  required: IntegrationScope,
): void => {
  if (!principal.scopes.includes(required))
    throw new ForbiddenException(`Integration principal 缺少 ${required}`);
  if (principal.tenantId !== runtimeTenantId())
    throw new ForbiddenException("当前 tenant 不在本地 Integration API 范围内");
};

const requireProjectAccess = (
  principal: IntegrationPrincipal,
  projectId: string,
): void => {
  if (
    !principal.projectIds.includes("*") &&
    !principal.projectIds.includes(projectId)
  )
    throw new ForbiddenException("当前身份无权读取该项目");
};

const assistantScope = (
  principal: IntegrationPrincipal,
  projectId: string,
): AssistantScope => ({
  tenantId: principal.tenantId,
  subjectId: principal.subjectId,
  role: principal.role,
  projectId,
  sourceTaskId: null,
  policyVersion: "VS12-1",
});

@Injectable()
export class IntegrationService {
  constructor(
    @Inject(Vs01ContextAdapter)
    private readonly contextAdapter: Vs01ContextAdapter,
    @Inject(Vs01Service) private readonly vs01: Vs01Service,
    @Inject(WorkpaperProposalCommand)
    private readonly workpaperProposal: WorkpaperProposalCommand,
    @Inject(MaterialCreateCommand)
    private readonly materialCreate?: MaterialCreateCommand,
    @Inject(MaterialVerificationCommand)
    private readonly materialVerification?: MaterialVerificationCommand,
    @Inject(EvidenceProposalCommand)
    private readonly evidenceProposal?: EvidenceProposalCommand,
    @Inject(WorkExecutionService)
    private readonly workExecution?: WorkExecutionService,
    @Inject(EvidenceConfirmationCommand)
    private readonly evidenceConfirmation?: EvidenceConfirmationCommand,
  ) {}

  async events(principal: IntegrationPrincipal) {
    requireScope(principal, "project:read");
    if (!this.workExecution) throw new BadRequestException("事件列表不可用");
    return this.workExecution.events(principal);
  }

  async executionContext(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    if (!this.workExecution) throw new BadRequestException("操作上下文不可用");
    return this.workExecution.context(principal, projectId);
  }

  async executeWork(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    if (!this.workExecution) throw new BadRequestException("操作服务不可用");
    return this.workExecution.execute(principal, projectId, input);
  }

  async evidenceProposals(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const project = await this.vs01.project(projectId);
    return this.vs01.evidenceProposals(project.sourceTaskId);
  }

  async confirmEvidence(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "evidence:confirm");
    requireProjectAccess(principal, projectId);
    if (!this.evidenceConfirmation)
      throw new BadRequestException("证据确认不可用");
    return this.evidenceConfirmation.execute(principal, projectId, input);
  }

  async proposeEvidence(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "evidence:write");
    requireProjectAccess(principal, projectId);
    if (!this.evidenceProposal)
      throw new BadRequestException("evidence.propose 命令不可用");
    return this.evidenceProposal.execute(
      {
        tenantId: principal.tenantId,
        subjectId: principal.subjectId,
        credentialId: principal.credentialId,
        role: principal.role,
        scopes: principal.scopes,
        projectIds: principal.projectIds,
      },
      projectId,
      input,
    );
  }

  async verifyMaterial(
    principal: IntegrationPrincipal,
    projectId: string,
    materialId: string,
    input: unknown,
  ) {
    requireScope(principal, "material:verify");
    requireProjectAccess(principal, projectId);
    if (!this.materialVerification)
      throw new BadRequestException("material.verify 命令不可用");
    if (
      !input ||
      typeof input !== "object" ||
      !("payload" in input) ||
      !input.payload ||
      typeof input.payload !== "object" ||
      !("materialId" in input.payload) ||
      input.payload.materialId !== materialId
    )
      throw new BadRequestException("材料路径与命令 payload 不一致");
    return this.materialVerification.execute(
      {
        tenantId: principal.tenantId,
        subjectId: principal.subjectId,
        credentialId: principal.credentialId,
        role: principal.role,
        scopes: principal.scopes,
        projectIds: principal.projectIds,
      },
      projectId,
      input,
    );
  }

  async createMaterial(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "material:write");
    requireProjectAccess(principal, projectId);
    if (!this.materialCreate)
      throw new BadRequestException("material.create 命令不可用");
    return this.materialCreate.execute(
      {
        tenantId: principal.tenantId,
        subjectId: principal.subjectId,
        credentialId: principal.credentialId,
        role: principal.role,
        scopes: principal.scopes,
        projectIds: principal.projectIds,
      },
      projectId,
      input,
    );
  }

  async proposeWorkpaper(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "workpaper:write");
    requireProjectAccess(principal, projectId);
    return this.workpaperProposal.execute(
      {
        tenantId: principal.tenantId,
        subjectId: principal.subjectId,
        credentialId: principal.credentialId,
        role: principal.role,
        scopes: principal.scopes,
        projectIds: principal.projectIds,
      },
      projectId,
      input,
    );
  }

  private stateFor(project: Awaited<ReturnType<Vs01Service["project"]>>) {
    const currentStage =
      project.phases.find((phase) =>
        ["READY", "IN_PROGRESS", "RETURNED", "WAITING_REVIEW"].includes(
          phase.status,
        ),
      ) ??
      project.phases.at(-1) ??
      null;
    return integrationProjectStateSchema.parse({
      id: project.id,
      sourceTaskId: project.sourceTaskId,
      name: project.name,
      status: project.status,
      progress: project.progress,
      currentStage,
      outcome: project.outcome,
    });
  }

  private actionableWorkItemFor(
    project: Awaited<ReturnType<Vs01Service["project"]>>,
    principal: IntegrationPrincipal,
  ) {
    const items = project.phases.flatMap((phase) =>
      phase.tasks.filter((item) => item.owner === principal.role),
    );
    return (
      items.find((item) => item.status === "IN_PROGRESS") ??
      items.find((item) => item.status === "RETURNED") ??
      items.find((item) => item.status === "READY") ??
      items.find((item) => item.status === "WAITING_REVIEW") ??
      null
    );
  }

  async projects(principal: IntegrationPrincipal) {
    requireScope(principal, "project:read");
    const projects = (await this.vs01.projectList()).filter(
      (project) =>
        principal.projectIds.includes("*") ||
        principal.projectIds.includes(project.id),
    );
    const roleWork = projects.map((project) => ({
      project,
      item: this.actionableWorkItemFor(project, principal),
    }));
    const current =
      roleWork.find(({ item }) => item?.status === "IN_PROGRESS")?.project ??
      roleWork.find(({ item }) => item?.status === "RETURNED")?.project ??
      roleWork.find(({ item }) => item?.status === "READY")?.project ??
      roleWork.find(({ item }) => item?.status === "WAITING_REVIEW")?.project ??
      projects.find((project) => project.status === "PENDING_APPROVAL") ??
      projects.find((project) => project.status !== "COMPLETED") ??
      projects[0] ??
      null;
    return integrationProjectListSchema.parse({
      items: projects.map((project) => this.stateFor(project)),
      currentProjectId: current?.id ?? null,
    });
  }

  async currentProject(principal: IntegrationPrincipal) {
    const list = await this.projects(principal);
    if (!list.currentProjectId) throw new NotFoundException("没有授权项目");
    return (
      list.items.find((project) => project.id === list.currentProjectId) ??
      (() => {
        throw new NotFoundException("当前项目不存在");
      })()
    );
  }

  async projectContext(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    const result = await this.contextAdapter.currentWorkContext(
      assistantScope(principal, projectId),
    );
    if (result.status === "FORBIDDEN") throw new ForbiddenException();
    if (result.status !== "OK" || !result.data)
      throw new BadRequestException("项目上下文不可用");
    return integrationProjectContextSchema.parse(result.data);
  }

  async projectState(principal: IntegrationPrincipal, projectId: string) {
    const context = await this.projectContext(principal, projectId);
    return integrationProjectStateSchema.parse({
      id: context.project.id,
      sourceTaskId: context.sourceTask.id,
      name: context.project.name,
      status: context.project.status,
      progress: context.project.progress,
      currentStage: context.project.currentStage,
      outcome: context.project.outcome,
    });
  }

  async workItems(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "workitem:read");
    requireProjectAccess(principal, projectId);
    const project = await this.vs01.project(projectId);
    return integrationWorkItemListSchema.parse({
      projectId,
      items: project.phases.flatMap((phase) =>
        phase.tasks
          .filter((item) => item.owner === principal.role)
          .map((item) => ({
            ...item,
            projectId,
            phaseCode: phase.code,
            phaseName: phase.name,
          })),
      ),
    });
  }

  async currentWorkItem(principal: IntegrationPrincipal) {
    const project = await this.currentProject(principal);
    const workItems = await this.workItems(principal, project.id);
    const item =
      workItems.items.find((candidate) => candidate.status === "IN_PROGRESS") ??
      workItems.items.find((candidate) => candidate.status === "RETURNED") ??
      workItems.items.find((candidate) => candidate.status === "READY") ??
      workItems.items.find(
        (candidate) => candidate.status === "WAITING_REVIEW",
      ) ??
      null;
    return integrationCurrentWorkItemSchema.parse({
      projectId: project.id,
      item,
    });
  }

  async evidence(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const result = await this.contextAdapter.evidence(
      assistantScope(principal, projectId),
    );
    if (result.status === "FORBIDDEN") throw new ForbiddenException();
    if (result.status !== "OK" || !result.data)
      throw new BadRequestException("项目证据不可用");
    const context = await this.projectContext(principal, projectId);
    return integrationEvidenceListSchema.parse({
      projectId,
      sourceTaskId: context.sourceTask.id,
      items: result.data.evidence,
    });
  }

  async materials(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "material:read");
    requireProjectAccess(principal, projectId);
    const context = await this.projectContext(principal, projectId);
    const proposals = await this.vs01.evidenceProposals(projectId);
    return integrationMaterialListSchema.parse({
      projectId,
      sourceTaskId: context.sourceTask.id,
      items: context.sourceTask.materials.map((material) => ({
        ...material,
        evidenceProposalVersion: material.locator
          ? proposals.filter(
              (proposal) =>
                proposal.locator.sourceVersionId ===
                material.locator?.sourceVersionId,
            ).length
          : 0,
      })),
      gaps: context.sourceTask.materialGaps,
    });
  }

  async materialPreview(
    principal: IntegrationPrincipal,
    projectId: string,
    materialId: string,
  ) {
    requireScope(principal, "material:read");
    requireProjectAccess(principal, projectId);
    const result = await this.contextAdapter.materialPreview(
      assistantScope(principal, projectId),
      { materialId },
    );
    if (result.status === "FORBIDDEN") throw new ForbiddenException();
    if (result.status === "NOT_FOUND" || !result.data)
      throw new NotFoundException("材料不存在");
    const context = await this.projectContext(principal, projectId);
    const material = (
      result.data as {
        material?: { locator?: { sourceVersionId?: string } | null };
      }
    ).material;
    const proposals = await this.vs01.evidenceProposals(projectId);
    return integrationMaterialPreviewSchema.parse({
      projectId,
      sourceTaskId: context.sourceTask.id,
      bodyAvailable: result.status === "OK",
      material: material
        ? {
            ...material,
            evidenceProposalVersion: material.locator?.sourceVersionId
              ? proposals.filter(
                  (proposal) =>
                    proposal.locator.sourceVersionId ===
                    material.locator?.sourceVersionId,
                ).length
              : 0,
          }
        : material,
    });
  }

  async evidenceDetail(
    principal: IntegrationPrincipal,
    projectId: string,
    evidenceId: string,
  ) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const result = await this.contextAdapter.evidence(
      assistantScope(principal, projectId),
      { evidenceId },
    );
    if (result.status === "FORBIDDEN") throw new ForbiddenException();
    if (result.status !== "OK" || !result.data)
      throw new NotFoundException("证据不存在");
    const context = await this.projectContext(principal, projectId);
    const items = (result.data as { evidence?: unknown[] }).evidence ?? [];
    return integrationEvidenceDetailSchema.parse({
      projectId,
      sourceTaskId: context.sourceTask.id,
      item: items[0],
    });
  }

  async sourceVersion(
    principal: IntegrationPrincipal,
    projectId: string,
    sourceVersionId: string,
  ) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const context = await this.projectContext(principal, projectId);
    const candidates = [
      ...context.sourceTask.evidence.map((item) => ({
        locator: {
          sourceObjectId: item.sourceObjectId,
          sourceVersionId: item.sourceVersionId,
          reference: `${item.sourceFile} · ${item.sourceSheet} · row ${item.sourceRow}`,
        },
        foundIn: "EVIDENCE" as const,
      })),
      ...context.sourceTask.materials.flatMap((item) =>
        item.locator
          ? [{ locator: item.locator, foundIn: "MATERIAL" as const }]
          : [],
      ),
      ...context.project.phases.flatMap((phase) =>
        phase.tasks.flatMap((item) =>
          item.output.locator
            ? [
                {
                  locator: item.output.locator,
                  foundIn: "WORK_ITEM_OUTPUT" as const,
                },
              ]
            : [],
        ),
      ),
      ...(context.project.outcome.locator
        ? [
            {
              locator: context.project.outcome.locator,
              foundIn: "OUTCOME" as const,
            },
          ]
        : []),
      ...(context.project.latestConfirmedWorkpaper
        ? [
            {
              locator: context.project.latestConfirmedWorkpaper.locator,
              foundIn: "WORKPAPER" as const,
            },
          ]
        : []),
    ];
    const match = candidates.find(
      (candidate) => candidate.locator.sourceVersionId === sourceVersionId,
    );
    if (!match) throw new NotFoundException("版本不在授权项目范围内");
    return integrationSourceVersionSchema.parse({ projectId, ...match });
  }

  async validationWorkpaper(
    principal: IntegrationPrincipal,
    projectId: string,
  ) {
    requireScope(principal, "workpaper:read");
    requireProjectAccess(principal, projectId);
    await this.projectContext(principal, projectId);
    return integrationValidationWorkpaperSchema.parse(
      await this.vs01.rootCauseWorkpaper(projectId),
    );
  }

  async searchExperiences(principal: IntegrationPrincipal, query: unknown) {
    requireScope(principal, "experience:read");
    const parsed = typeof query === "string" ? query.trim() : "";
    if (parsed.length > 200) throw new BadRequestException("检索词过长");
    return integrationExperienceSearchSchema.parse(
      await this.vs01.experiences(parsed),
    );
  }

  async formalExperience(
    principal: IntegrationPrincipal,
    experienceId: string,
  ) {
    requireScope(principal, "experience:read");
    return integrationFormalExperienceSchema.parse(
      await this.vs01.experience(experienceId),
    );
  }

  async experienceEvidence(
    principal: IntegrationPrincipal,
    experienceId: string,
  ) {
    const experience = await this.formalExperience(principal, experienceId);
    return integrationExperienceEvidenceSchema.parse({
      experienceId: experience.id,
      sourceProjectId: experience.sourceProjectId,
      sourceTaskId: experience.sourceTaskId,
      locator: experience.evidenceLocator,
    });
  }
}
