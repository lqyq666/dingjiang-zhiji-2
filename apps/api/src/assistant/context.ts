import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TaskMaterial } from "@dingjiang/contracts";

import type { AssistantScope, AssistantToolResult } from "./contracts";
import { rejectModelScopeArguments } from "./scope";
import { exposableContentPreview } from "../materials/readable-body";
import { Vs01Service } from "../vs01.service";
import { AssistantStore } from "./store";

const safeMaterial = (material: TaskMaterial) => {
  const verification = material.verification;
  const latestVerificationAudit =
    verification.status === "UNVERIFIED" ||
    !verification.verifiedBy ||
    !verification.verifiedAt
      ? null
      : {
          eventType:
            verification.status === "VERIFIED"
              ? ("MATERIAL_VERIFIED" as const)
              : ("MATERIAL_REVISION_REQUESTED" as const),
          version: verification.version,
          actor: verification.verifiedBy,
          note: verification.note,
          occurredAt: verification.verifiedAt,
        };
  return {
    id: material.id,
    requirementId: material.requirementId,
    title: material.title,
    note: material.note,
    kind: material.kind,
    status: material.status,
    situationCode: material.situationCode,
    locator: material.locator,
    verification,
    verificationStatus: verification.status,
    latestVerificationAudit,
    verificationEligible: material.verificationEligible,
    file: material.file
      ? {
          originalName: material.file.originalName,
          mediaType: material.file.mediaType,
          extractionStatus: material.file.extractionStatus,
          // The only way body text reaches this payload. Both the aggregate
          // context and the single preview rely on it, so the two cannot
          // disagree about what is exposable.
          contentPreview: exposableContentPreview(material.file),
          readableByAi: material.file.readableByAi,
        }
      : null,
  };
};

@Injectable()
export class Vs01ContextAdapter {
  constructor(
    @Inject(Vs01Service) private readonly vs01: Vs01Service,
    @Inject(AssistantStore) private readonly store: AssistantStore,
  ) {}

  private async projectForScope(scope: AssistantScope) {
    const project = await this.vs01.project(scope.projectId);
    if (scope.sourceTaskId && project.sourceTaskId !== scope.sourceTaskId)
      return null;
    return project;
  }

  private async latestConfirmedWorkpaper(projectId: string) {
    try {
      const workpaper = await this.vs01.rootCauseWorkpaper(projectId);
      const version = workpaper.latestConfirmed;
      return version
        ? {
            revision: version.revision,
            conclusion: version.content.conclusion,
            locator: version.locator,
            confirmedAt: version.createdAt,
            confirmedBy: version.requestedBy,
          }
        : null;
    } catch (error) {
      // The workpaper is optional outside the one live VS16 root-cause task.
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  async currentWorkContext(
    scope: AssistantScope,
    input: unknown = {},
  ): Promise<AssistantToolResult> {
    rejectModelScopeArguments(input);
    const project = await this.projectForScope(scope);
    if (!project) return { status: "FORBIDDEN" };
    const sourceTask = await this.vs01.task(project.sourceTaskId);
    const hasLiveRootCauseWorkItem = project.phases.some(
      (phase) =>
        phase.code === "ROOT_CAUSE_VALIDATION" &&
        phase.tasks.some(
          (item) => item.origin === "LIVE" && item.owner === "PMC",
        ),
    );
    const latestConfirmedWorkpaper = hasLiveRootCauseWorkItem
      ? await this.latestConfirmedWorkpaper(project.id)
      : null;
    const materialGaps = sourceTask.situations.flatMap((situation) =>
      situation.requirements
        .filter((requirement) => !requirement.fulfilled)
        .map((requirement) => ({
          situationCode: situation.code,
          requirementId: requirement.id,
          label: requirement.label,
          status: situation.state === "UNVERIFIED" ? "UNVERIFIED" : "MISSING",
        })),
    );
    return {
      status: "OK",
      evidenceIds: sourceTask.evidence.map((item) => item.id),
      data: {
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          currentStage:
            project.phases.find((phase) =>
              ["READY", "IN_PROGRESS", "RETURNED", "WAITING_REVIEW"].includes(
                phase.status,
              ),
            ) ??
            project.phases.at(-1) ??
            null,
          progress: project.progress,
          phases: project.phases,
          outcome: project.outcome,
          experienceSummary: project.experienceCandidate
            ? [
                {
                  id: project.experienceCandidate.id,
                  title: project.experienceCandidate.title,
                  status: project.experienceCandidate.status,
                  locator: project.experienceCandidate.candidateLocator,
                },
              ]
            : [],
          recentActivities: project.auditTrail.slice(-20).map((event) => ({
            eventType: event.eventType,
            phaseCode: event.phaseCode,
            note: event.note,
            actor: event.actor,
            createdAt: event.createdAt,
          })),
          latestConfirmedWorkpaper,
        },
        sourceTask: {
          id: sourceTask.id,
          status: sourceTask.status,
          facts: sourceTask.facts,
          evidence: sourceTask.evidence,
          materialGaps,
          materials: sourceTask.materials
            .filter((material) => material.status === "ACTIVE")
            .map((material) => safeMaterial(material)),
        },
      },
    };
  }

  /** Material identity is resolved inside the already-authorized source task. */
  async materialPreview(
    scope: AssistantScope,
    input: unknown = {},
  ): Promise<AssistantToolResult> {
    rejectModelScopeArguments(input);
    const project = await this.projectForScope(scope);
    if (!project) return { status: "FORBIDDEN" };
    const materialId =
      input && typeof input === "object" && "materialId" in input
        ? String((input as { materialId: unknown }).materialId)
        : "";
    if (!materialId) return { status: "NOT_FOUND" };
    const sourceTask = await this.vs01.task(project.sourceTaskId);
    const material = sourceTask.materials.find(
      (candidate) =>
        candidate.id === materialId && candidate.status === "ACTIVE",
    );
    if (!material) return { status: "NOT_FOUND" };
    const file = material.file;
    if (
      !file ||
      !file.readableByAi ||
      file.extractionStatus !== "EXTRACTED" ||
      !file.contentPreview?.trim()
    ) {
      return {
        status: "BODY_NOT_AVAILABLE",
        data: { material: safeMaterial(material) },
      };
    }
    return {
      status: "OK",
      data: { material: safeMaterial(material) },
    };
  }

  async evidence(
    scope: AssistantScope,
    input: unknown = {},
  ): Promise<AssistantToolResult> {
    rejectModelScopeArguments(input);
    const project = await this.projectForScope(scope);
    if (!project) return { status: "FORBIDDEN" };
    const task = await this.vs01.task(project.sourceTaskId);
    const requested =
      input && typeof input === "object" && "evidenceId" in input
        ? String((input as { evidenceId: unknown }).evidenceId)
        : undefined;
    const evidence = requested
      ? task.evidence.filter((item) => item.id === requested)
      : task.evidence;
    if (requested && evidence.length === 0) return { status: "NOT_FOUND" };
    return {
      status: "OK",
      evidenceIds: evidence.map((item) => item.id),
      data: { evidence },
    };
  }

  async recentWorkEvents(
    scope: AssistantScope,
    input: unknown = {},
  ): Promise<AssistantToolResult> {
    rejectModelScopeArguments(input);
    const project = await this.projectForScope(scope);
    if (!project) return { status: "FORBIDDEN" };
    const events = await this.store.recentWorkEvents({
      ...scope,
      sourceTaskId: project.sourceTaskId,
    });
    return {
      status: "OK",
      evidenceIds: events.flatMap((event) =>
        Array.isArray(event.payload.evidenceIds)
          ? event.payload.evidenceIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      ),
      data: { events },
    };
  }
}
