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
  integrationEvidenceBundleSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationExecutionProjectSchema,
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
  integrationWorkContextSchema,
  integrationWorkItemListSchema,
  integrationWorkspaceResumeSchema,
  projectSchema,
  workExecutionContextSchema,
  type EvidenceProposalReview,
  type IntegrationPrincipal,
  type IntegrationScope,
  type IntegrationWorkItemList,
  type Project,
  type TaskDetail,
  type ValidationWorkpaperVersion,
} from "@dingjiang/contracts";

import {
  currentStageFor,
  hasLiveRootCauseWorkItem,
  materialGapsFor,
  projectContextFor,
  sourceTaskMaterialsFor,
  Vs01ContextAdapter,
} from "../assistant/context";
import { deriveNextAction } from "./next-action";
import type { AssistantScope } from "../assistant/contracts";
import { Vs01Service } from "../vs01.service";
import { WorkpaperProposalCommand } from "../workpapers/workpaper-proposal-command";
import { MaterialCreateCommand } from "../materials/material-create-command";
import { MaterialVerificationCommand } from "../materials/material-verification-command";
import { EvidenceProposalCommand } from "../evidence/evidence-proposal-command";
import {
  hasProjectAccess,
  hasScope,
  requireIntegrationTenant,
  workpaperReadScopes,
} from "./integration-access";
import {
  activityNoteFor,
  canReadExperienceCandidate,
  canReadWorkpaper,
  scopedExecutionProject,
  scopedExecutionSourceTask,
  scopedOutcome,
  scopedStage,
  scopedWorkpaper,
} from "./integration-projection";

const requireScope = (
  principal: IntegrationPrincipal,
  required: IntegrationScope,
): void => {
  if (!hasScope(principal, required))
    throw new ForbiddenException(`Integration principal 缺少 ${required}`);
  requireIntegrationTenant(principal.tenantId);
};

const requireProjectAccess = (
  principal: IntegrationPrincipal,
  projectId: string,
): void => {
  if (!hasProjectAccess(principal, projectId))
    throw new ForbiddenException("当前身份无权读取该项目");
};

const workItemPriority = ["IN_PROGRESS", "RETURNED", "READY", "WAITING_REVIEW"];

const actionableWorkItem = <T extends { status: string }>(
  items: readonly T[],
) => {
  for (const status of workItemPriority) {
    const item = items.find((item) => item.status === status);
    if (item) return item;
  }
  return null;
};

const proposalVersionsFor = (proposals: readonly EvidenceProposalReview[]) => {
  const versions = new Map<string, number>();
  for (const { locator } of proposals) {
    const id = locator.sourceVersionId;
    versions.set(id, (versions.get(id) ?? 0) + 1);
  }
  return versions;
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
    const { project, sourceTask, ...context } =
      await this.workExecution.context(principal, projectId);
    return workExecutionContextSchema.parse({
      ...context,
      project: project && scopedExecutionProject(principal, project),
      sourceTask:
        sourceTask && scopedExecutionSourceTask(principal, sourceTask),
    });
  }

  async executeWork(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    if (!this.workExecution) throw new BadRequestException("操作服务不可用");
    const result = await this.workExecution.execute(
      principal,
      projectId,
      input,
    );
    const project = projectSchema.parse(result.data.project);
    return {
      ...result,
      data: {
        ...result.data,
        project: integrationExecutionProjectSchema.parse(
          scopedExecutionProject(principal, project),
        ),
      },
    };
  }

  async evidenceProposals(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const reader = this.vs01.readModel;
    await reader.projectSourceTaskId(projectId);
    return reader.evidenceProposals(projectId);
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

  private stateFor(principal: IntegrationPrincipal, project: Project) {
    const stage = currentStageFor(project);
    return integrationProjectStateSchema.parse({
      id: project.id,
      sourceTaskId: project.sourceTaskId,
      name: project.name,
      status: project.status,
      progress: project.progress,
      currentStage: stage && scopedStage(principal, stage),
      outcome: scopedOutcome(principal, project.outcome),
    });
  }

  private async selectProjects(
    principal: IntegrationPrincipal,
    reader: Pick<Vs01Service, "projectList"> = this.vs01,
  ) {
    const projectIds = principal.projectIds.includes("*")
      ? undefined
      : principal.projectIds;
    const projects = (await reader.projectList(projectIds)).filter((project) =>
      hasProjectAccess(principal, project.id),
    );
    const roleWork = hasScope(principal, "workitem:read")
      ? projects.map((project) => ({
          project,
          item: actionableWorkItem(
            project.phases.flatMap((phase) =>
              phase.tasks.filter((item) => item.owner === principal.role),
            ),
          ),
        }))
      : [];
    for (const status of workItemPriority) {
      const current = roleWork.find(
        ({ item }) => item?.status === status,
      )?.project;
      if (current) return { projects, current };
    }
    const current =
      projects.find((project) => project.status === "PENDING_APPROVAL") ??
      projects.find((project) => project.status !== "COMPLETED") ??
      projects[0] ??
      null;
    return { projects, current };
  }

  private projectListFor(
    principal: IntegrationPrincipal,
    projects: Project[],
    current: Project | null,
  ) {
    return integrationProjectListSchema.parse({
      items: projects.map((project) => this.stateFor(principal, project)),
      currentProjectId: current?.id ?? null,
    });
  }

  async projects(principal: IntegrationPrincipal) {
    requireScope(principal, "project:read");
    const { projects, current } = await this.selectProjects(principal);
    return this.projectListFor(principal, projects, current);
  }

  private async optionalWorkpaper(
    reader: Pick<Vs01Service, "rootCauseWorkpaper">,
    projectId: string,
  ) {
    try {
      return await reader.rootCauseWorkpaper(projectId);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  async workspaceResume(principal: IntegrationPrincipal) {
    for (const scope of [
      "project:read",
      "workitem:read",
      ...workpaperReadScopes,
    ] as const)
      requireScope(principal, scope);

    const { projects, project, sourceTask, workpaper, proposals } =
      await this.vs01.readSnapshot(async (reader) => {
        const { projects, current: project } = await this.selectProjects(
          principal,
          reader,
        );
        if (!project) throw new NotFoundException("没有授权项目");
        requireProjectAccess(principal, project.id);
        const sourceTask = await reader.task(project.sourceTaskId);
        const workpaper = await this.optionalWorkpaper(reader, project.id);
        const proposals = await reader.evidenceProposals(project.id);
        return { projects, project, sourceTask, workpaper, proposals };
      });

    const context = integrationProjectContextSchema.parse(
      this.contextFor(
        principal,
        project,
        sourceTask,
        workpaper?.latestConfirmed ?? null,
      ),
    );
    const workItems = this.workItemsFor(project, principal);
    const currentWorkItem = this.currentWorkItemFor(workItems);
    return integrationWorkspaceResumeSchema.parse({
      projectId: project.id,
      projects: this.projectListFor(principal, projects, project),
      context,
      state: this.stateFor(principal, project),
      currentWorkItem,
      workItems,
      evidence: {
        projectId: project.id,
        sourceTaskId: sourceTask.id,
        items: context.sourceTask.evidence,
      },
      materials: this.materialsFor(
        project.id,
        context.sourceTask,
        proposalVersionsFor(proposals),
      ),
      workpaper: scopedWorkpaper(principal, workpaper),
      proposals,
      nextAction: deriveNextAction(
        project,
        currentWorkItem.item,
        context.sourceTask.materialGaps[0],
      ),
    });
  }

  private async loadCurrentProject(principal: IntegrationPrincipal) {
    requireScope(principal, "project:read");
    const { current } = await this.selectProjects(principal);
    if (!current) throw new NotFoundException("没有授权项目");
    return current;
  }

  async currentProject(principal: IntegrationPrincipal) {
    return this.stateFor(principal, await this.loadCurrentProject(principal));
  }

  async projectContext(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    const reader = this.vs01.readModel;
    const project = await reader.project(projectId);
    const sourceTask = await reader.task(project.sourceTaskId);
    const workpaper =
      canReadWorkpaper(principal) && hasLiveRootCauseWorkItem(project)
        ? await this.optionalWorkpaper(reader, projectId)
        : null;
    return integrationProjectContextSchema.parse(
      this.contextFor(
        principal,
        project,
        sourceTask,
        workpaper?.latestConfirmed ?? null,
      ),
    );
  }

  private contextFor(
    principal: IntegrationPrincipal,
    project: Project,
    sourceTask: TaskDetail,
    workpaper: ValidationWorkpaperVersion | null,
  ) {
    const evidence = hasScope(principal, "evidence:read");
    const materials = hasScope(principal, "material:read");
    const context = projectContextFor(
      project,
      {
        ...sourceTask,
        facts: evidence ? sourceTask.facts : [],
        evidence: evidence ? sourceTask.evidence : [],
        materials: materials ? sourceTask.materials : [],
        situations: materials ? sourceTask.situations : [],
      },
      workpaper,
    );
    const stage = context.project.currentStage;
    return {
      ...context,
      project: {
        ...context.project,
        currentStage: stage && scopedStage(principal, stage),
        phases: context.project.phases.map((phase) =>
          scopedStage(principal, phase),
        ),
        outcome: scopedOutcome(principal, context.project.outcome),
        experienceSummary: canReadExperienceCandidate(principal)
          ? context.project.experienceSummary
          : [],
        recentActivities: context.project.recentActivities.map((activity) => ({
          ...activity,
          note: activityNoteFor(principal, activity),
        })),
      },
    };
  }

  async projectState(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    const reader = this.vs01.readModel;
    const project = await reader.project(projectId);
    await reader.assertTaskFactsAvailable(project.sourceTaskId);
    return this.stateFor(principal, project);
  }

  private async readProjectWork(
    principal: IntegrationPrincipal,
    projectId: string,
    includeConfirmedWorkpaper: boolean,
  ) {
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    requireScope(principal, "workitem:read");
    const { project, sourceTask, workpaper, current } =
      await this.vs01.readSnapshot(async (reader) => {
        const { projects, current } = await this.selectProjects(
          principal,
          reader,
        );
        const project = projects.find(
          (candidate) => candidate.id === projectId,
        );
        if (!project) throw new NotFoundException("项目不存在");
        const sourceTask = await reader.task(project.sourceTaskId);
        const workpaper =
          includeConfirmedWorkpaper &&
          canReadWorkpaper(principal) &&
          hasLiveRootCauseWorkItem(project)
            ? await this.optionalWorkpaper(reader, project.id)
            : null;
        return { project, sourceTask, workpaper, current };
      });

    const workItems = this.workItemsFor(project, principal);
    const fallbackStage =
      current?.id === projectId
        ? undefined
        : (currentStageFor(project)?.code ?? null);
    const currentWorkItem = this.currentWorkItemFor(workItems, fallbackStage);
    return { project, sourceTask, workpaper, workItems, currentWorkItem };
  }

  async workContext(principal: IntegrationPrincipal, projectId: string) {
    const { project, sourceTask, workpaper, workItems, currentWorkItem } =
      await this.readProjectWork(principal, projectId, true);
    return integrationWorkContextSchema.parse({
      projectId,
      context: this.contextFor(
        principal,
        project,
        sourceTask,
        workpaper?.latestConfirmed ?? null,
      ),
      state: this.stateFor(principal, project),
      currentWorkItem,
      workItems,
    });
  }

  async nextAction(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "material:read");
    const { project, sourceTask, currentWorkItem } = await this.readProjectWork(
      principal,
      projectId,
      false,
    );
    return deriveNextAction(
      project,
      currentWorkItem.item,
      materialGapsFor(sourceTask)[0],
    );
  }

  private workItemsFor(project: Project, principal: IntegrationPrincipal) {
    return integrationWorkItemListSchema.parse({
      projectId: project.id,
      items: project.phases.flatMap((phase) =>
        scopedStage(principal, phase).tasks.map((item) => ({
          ...item,
          projectId: project.id,
          phaseCode: phase.code,
          phaseName: phase.name,
        })),
      ),
    });
  }

  async workItems(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "workitem:read");
    requireProjectAccess(principal, projectId);
    return this.workItemsFor(await this.vs01.project(projectId), principal);
  }

  private currentWorkItemFor(
    workItems: IntegrationWorkItemList,
    fallbackStage?: Project["phases"][number]["code"] | null,
  ) {
    // Requests for another project use the first live item of that project's active stage.
    const item =
      fallbackStage === undefined
        ? actionableWorkItem(workItems.items)
        : (workItems.items.find(
            (item) =>
              item.phaseCode === fallbackStage &&
              item.origin === "LIVE" &&
              workItemPriority.includes(item.status),
          ) ?? null);
    return integrationCurrentWorkItemSchema.parse({
      projectId: workItems.projectId,
      item,
    });
  }

  async currentWorkItem(principal: IntegrationPrincipal) {
    const project = await this.loadCurrentProject(principal);
    requireScope(principal, "workitem:read");
    return this.currentWorkItemFor(this.workItemsFor(project, principal));
  }

  async evidence(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    const result = await this.contextAdapter.evidence(
      assistantScope(principal, projectId),
    );
    if (result.status === "FORBIDDEN") throw new ForbiddenException();
    if (result.status !== "OK") throw new BadRequestException("项目证据不可用");
    requireScope(principal, "project:read");
    return integrationEvidenceListSchema.parse({
      projectId,
      sourceTaskId: result.sourceTaskId,
      items: result.data.evidence,
    });
  }

  async materials(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "material:read");
    requireProjectAccess(principal, projectId);
    requireScope(principal, "project:read");
    const { sourceTask, proposalVersions } = await this.vs01.readSnapshot(
      async (reader) => {
        const sourceTaskId = await reader.projectSourceTaskId(projectId);
        const sourceTask = await reader.taskMaterials(sourceTaskId);
        const proposalVersions =
          await reader.evidenceProposalVersions(projectId);
        return { sourceTask, proposalVersions };
      },
    );
    return this.materialsFor(
      projectId,
      sourceTaskMaterialsFor(sourceTask),
      proposalVersions,
    );
  }

  private materialsFor(
    projectId: string,
    sourceTask: ReturnType<typeof sourceTaskMaterialsFor>,
    proposalVersions: ReadonlyMap<string, number>,
  ) {
    return integrationMaterialListSchema.parse({
      projectId,
      sourceTaskId: sourceTask.id,
      items: sourceTask.materials.map((material) => ({
        ...material,
        evidenceProposalVersion: material.locator
          ? (proposalVersions.get(material.locator.sourceVersionId) ?? 0)
          : 0,
      })),
      gaps: sourceTask.materialGaps,
    });
  }

  async evidenceBundle(principal: IntegrationPrincipal, projectId: string) {
    requireScope(principal, "evidence:read");
    requireProjectAccess(principal, projectId);
    requireScope(principal, "project:read");
    requireScope(principal, "material:read");
    requireScope(principal, "workpaper:read");
    const { sourceTask, workpaper, proposals } = await this.vs01.readSnapshot(
      async (reader) => {
        const sourceTaskId = await reader.projectSourceTaskId(projectId);
        const sourceTask = await reader.task(sourceTaskId);
        const workpaper = await this.optionalWorkpaper(reader, projectId);
        const proposals = await reader.evidenceProposals(projectId);
        return { sourceTask, workpaper, proposals };
      },
    );
    return integrationEvidenceBundleSchema.parse({
      projectId,
      evidence: {
        projectId,
        sourceTaskId: sourceTask.id,
        items: sourceTask.evidence,
      },
      materials: this.materialsFor(
        projectId,
        sourceTaskMaterialsFor(sourceTask),
        proposalVersionsFor(proposals),
      ),
      workpaper: scopedWorkpaper(principal, workpaper),
      proposals,
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
    if (result.status === "NOT_FOUND")
      throw new NotFoundException("材料不存在");
    requireScope(principal, "project:read");
    const { material } = result.data;
    const sourceVersionId = material.locator?.sourceVersionId;
    const evidenceProposalVersion = sourceVersionId
      ? ((
          await this.vs01.readModel.evidenceProposalVersions(
            projectId,
            sourceVersionId,
          )
        ).get(sourceVersionId) ?? 0)
      : 0;
    return integrationMaterialPreviewSchema.parse({
      projectId,
      sourceTaskId: result.sourceTaskId,
      bodyAvailable: result.status === "OK",
      material: { ...material, evidenceProposalVersion },
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
    if (result.status !== "OK") throw new NotFoundException("证据不存在");
    requireScope(principal, "project:read");
    return integrationEvidenceDetailSchema.parse({
      projectId,
      sourceTaskId: result.sourceTaskId,
      item: result.data.evidence[0],
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
    requireScope(principal, "project:read");
    requireProjectAccess(principal, projectId);
    for (const scope of workpaperReadScopes) requireScope(principal, scope);
    const workpaper = await this.vs01.readSnapshot(async (reader) => {
      await reader.projectSourceTaskId(projectId);
      return reader.rootCauseWorkpaper(projectId);
    });
    return integrationValidationWorkpaperSchema.parse(
      scopedWorkpaper(principal, workpaper),
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
