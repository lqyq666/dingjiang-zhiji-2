import {
  type TaskMaterial,
  type BossDashboard,
  type AssistantFeedbackReceipt,
  type AssistantFeedbackRecord,
  type EmployeeDashboard,
  type ExperienceLibrary,
  type EvidenceProposalReview,
  type ExperienceLifecycleHistoryList,
  type ExpertDashboard,
  type FormalExperience,
  type Project,
  type ProjectAssistantResponse,
  type TaskDetail,
  type TaskAssistantResponse,
} from "@dingjiang/contracts";
import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {} from "./assistant/guided-analysis";
import {
  assertDatabaseReady,
  createPool,
  migrate,
  resetAndSeed,
} from "./vs01-db";
import { isProduction, runtimeTenantId } from "./runtime-config";
import { ProjectLifecycleService } from "./projects/project-lifecycle-service";
import { ExperienceService } from "./experience/experience-service";
import { assertProjectAction } from "./projects/project-primitives";
import { ReadModelService } from "./read-model/read-model-service";
import { AssistantService } from "./assistant/assistant-service";
import { TaskDecisionService } from "./tasks/task-decision-service";
import {} from "./intake/source-facts";
import {} from "./projects/production-lifecycle";
import {
  MaterialContentVault,
  type MaterialContentStore,
  type UploadedMaterialFile,
} from "./materials/content-vault";
import { MaterialService } from "./materials/material-service";
import type { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";

const tenantId = runtimeTenantId();

@Injectable()
export class Vs01Service implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private get database() {
    return this.commandTransaction ?? this.pool;
  }
  private workpapers: RootCauseWorkpaperService | undefined;
  private readonly materials: MaterialService;
  private readonly readModel: ReadModelService;
  private readonly lifecycle: ProjectLifecycleService;
  private readonly experienceService: ExperienceService;
  private readonly assistant: AssistantService;
  private readonly decisions: TaskDecisionService;

  constructor(
    private readonly materialVault: MaterialContentStore = new MaterialContentVault(),
    workpapers?: RootCauseWorkpaperService,
    transactionScope?: { pool: Pool; client: PoolClient },
  ) {
    this.workpapers = workpapers;
    this.pool = transactionScope?.pool ?? createPool();
    this.commandTransaction = transactionScope?.client;
    this.materials = new MaterialService(
      this.pool,
      this.materialVault,
      tenantId,
      this.commandTransaction,
    );
    this.readModel = new ReadModelService(
      this.pool,
      tenantId,
      this.commandTransaction,
    );
    this.lifecycle = new ProjectLifecycleService(
      this.pool,
      tenantId,
      this.readModel,
      this.commandTransaction,
    );
    this.experienceService = new ExperienceService(
      this.pool,
      tenantId,
      this.readModel,
      this.commandTransaction,
    );
    this.assistant = new AssistantService(
      this.pool,
      tenantId,
      this.readModel,
      this.commandTransaction,
    );
    this.decisions = new TaskDecisionService(
      this.pool,
      tenantId,
      this.readModel,
      this.commandTransaction,
    );
  }

  /** Bind existing domain operations and their reads to the command kernel's transaction.
   * The bound instance never commits, rolls back or releases its caller's client. */
  inCommandTransaction<T>(
    client: PoolClient,
    run: (domain: Vs01Service) => Promise<T>,
  ): Promise<T> {
    return run(
      new Vs01Service(this.materialVault, this.workpapers, {
        pool: this.pool,
        client,
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    if (isProduction()) {
      await assertDatabaseReady(this.pool);
      return;
    }
    await migrate(this.pool);
    const result = await this.database.query(
      "SELECT count(*)::int AS count FROM vs01_orders WHERE tenant_id = $1",
      [tenantId],
    );
    if (Number(result.rows[0]?.count ?? 0) === 0) await resetAndSeed(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async employee(): Promise<EmployeeDashboard> {
    return this.readModel.employee();
  }

  async boss(): Promise<BossDashboard> {
    return this.readModel.boss();
  }

  async task(id: string): Promise<TaskDetail> {
    return this.readModel.task(id);
  }

  async evidenceProposals(
    projectId: string,
  ): Promise<EvidenceProposalReview[]> {
    return this.readModel.evidenceProposals(projectId);
  }

  async assistTask(id: string, input: unknown): Promise<TaskAssistantResponse> {
    return this.assistant.assistTask(id, input);
  }

  async addTaskMaterial(id: string, input: unknown): Promise<TaskDetail> {
    await this.materials.addTaskMaterial(id, input);
    return this.task(id);
  }

  async importTaskMaterial(
    id: string,
    input: unknown,
    file: UploadedMaterialFile | undefined,
  ): Promise<TaskMaterial> {
    return this.materials.importTaskMaterial(id, input, file);
  }

  async withdrawTaskMaterial(
    id: string,
    materialId: string,
    input: unknown,
  ): Promise<TaskMaterial> {
    return this.materials.withdrawTaskMaterial(id, materialId, input);
  }

  async taskMaterialContent(id: string, materialId: string) {
    return this.materials.taskMaterialContent(id, materialId);
  }

  async decideTask(id: string, input: unknown): Promise<TaskDetail> {
    return this.decisions.decideTask(id, input);
  }

  async revertTaskDecision(id: string, input: unknown): Promise<TaskDetail> {
    return this.decisions.revertTaskDecision(id, input);
  }

  async createProject(
    input: unknown,
    reservedProjectId?: string,
  ): Promise<Project> {
    return this.lifecycle.createProject(input, reservedProjectId);
  }

  async submitProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.submitProject(id, input);
  }

  async approveProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.approveProject(id, input);
  }

  async returnProject(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.returnProject(id, input);
  }

  async project(id: string): Promise<Project> {
    return this.readModel.project(id);
  }

  /** Stable read seam for authorized Integration API projections. */
  async projectList(): Promise<Project[]> {
    return this.readModel.projectList();
  }

  /** Safe, contract-shaped projection used by the read-only project assistant. */
  async rootCauseWorkpaper(id: string) {
    return this.readModel.rootCauseWorkpaper(id);
  }

  async assistProject(
    id: string,
    input: unknown,
  ): Promise<ProjectAssistantResponse> {
    return this.assistant.assistProject(id, input);
  }

  async createAssistantFeedback(
    id: string,
    input: unknown,
  ): Promise<AssistantFeedbackReceipt> {
    return this.assistant.createAssistantFeedback(id, input);
  }

  async assistantFeedback(
    projectIdValue: string,
  ): Promise<AssistantFeedbackRecord[]> {
    return this.readModel.assistantFeedback(projectIdValue);
  }

  async withdrawAssistantFeedback(
    projectIdValue: string,
    feedbackId: string,
    input: unknown,
  ): Promise<AssistantFeedbackReceipt> {
    return this.assistant.withdrawAssistantFeedback(
      projectIdValue,
      feedbackId,
      input,
    );
  }

  async updateSubtask(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.updateSubtask(id, input);
  }

  async reviewExecutionPhase(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.reviewExecutionPhase(id, input);
  }

  async submitOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.submitOutcome(id, input);
  }

  async approveOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.approveOutcome(id, input);
  }

  async returnOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.returnOutcome(id, input);
  }

  async reopenOutcome(id: string, input: unknown): Promise<Project> {
    return this.lifecycle.reopenOutcome(id, input);
  }

  async createExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    return this.experienceService.createExperienceCandidate(id, input);
  }

  async withdrawExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    return this.experienceService.withdrawExperienceCandidate(id, input);
  }

  async resubmitExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    return this.experienceService.resubmitExperienceCandidate(id, input);
  }

  async expertExperienceReviews(): Promise<ExpertDashboard> {
    return this.readModel.expertExperienceReviews();
  }

  async approveExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<FormalExperience> {
    return this.experienceService.approveExperienceCandidate(id, input);
  }

  /** VS17 integration read model; it exposes only the current pending projection. */
  async pendingExperienceCandidate(candidateId: string) {
    return this.readModel.pendingExperienceCandidate(candidateId);
  }

  async recordFeishuCandidateSync(
    candidateId: string,
    expectedCandidateVersionId: string,
    recordId: string,
  ): Promise<void> {
    return this.experienceService.recordFeishuCandidateSync(
      candidateId,
      expectedCandidateVersionId,
      recordId,
    );
  }

  async recordFeishuCandidateSyncFailure(
    candidateId: string,
    expectedCandidateVersionId: string,
  ): Promise<void> {
    return this.experienceService.recordFeishuCandidateSyncFailure(
      candidateId,
      expectedCandidateVersionId,
    );
  }

  /** Integration-only serialization; it does not alter candidate business facts. */
  async withFeishuCandidatePushLock<T>(
    candidateId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.experienceService.withFeishuCandidatePushLock(
      candidateId,
      action,
    );
  }

  /** Minimal VS17 review lookup: terminal decisions remain re-readable for idempotent Feishu pulls. */
  async feishuReviewCandidate(candidateId: string): Promise<{
    status: "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "WITHDRAWN";
    candidateVersionId: string;
  }> {
    return this.experienceService.feishuReviewCandidate(candidateId);
  }

  async recordFormalExperienceIndex(
    experienceId: string,
    status: "INDEX_PENDING" | "INDEXED" | "INDEX_FAILED",
    execution?: { executeId: string | null; debugUrl: string | null },
  ): Promise<void> {
    return this.experienceService.recordFormalExperienceIndex(
      experienceId,
      status,
      execution,
    );
  }

  async returnExperienceCandidate(
    id: string,
    input: unknown,
  ): Promise<Project> {
    return this.experienceService.returnExperienceCandidate(id, input);
  }

  async experiences(query = ""): Promise<ExperienceLibrary> {
    return this.readModel.experiences(query);
  }

  async expertExperienceHistory(): Promise<ExperienceLifecycleHistoryList> {
    return this.readModel.expertExperienceHistory();
  }

  async experience(id: string): Promise<FormalExperience> {
    return this.readModel.experience(id);
  }

  async citeExperience(taskId: string, input: unknown): Promise<TaskDetail> {
    return this.experienceService.citeExperience(taskId, input);
  }

  async withdrawExperienceReference(
    taskId: string,
    referenceId: string,
    input: unknown,
  ): Promise<TaskDetail> {
    return this.experienceService.withdrawExperienceReference(
      taskId,
      referenceId,
      input,
    );
  }

  async retractExperience(
    id: string,
    input: unknown,
  ): Promise<FormalExperience> {
    return this.experienceService.retractExperience(id, input);
  }

  async reset(input: unknown): Promise<EmployeeDashboard> {
    assertProjectAction(input, "PMC");
    await resetAndSeed(this.pool);
    return this.employee();
  }

  private sourceTaskSuffix(sourceTaskId: string): string {
    return sourceTaskId.replace(/^SO-/, "");
  }
}
