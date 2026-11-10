import type {
  IntegrationPrincipal,
  Project,
  TaskDetail,
  ValidationWorkpaperVersion,
  ValidationWorkpaperView,
} from "@dingjiang/contracts";
import { sourceTaskMaterialsFor } from "../assistant/context";
import { hasScope, workpaperReadScopes } from "./integration-access";

type Stage = Project["phases"][number];

export const canReadWorkpaper = (principal: IntegrationPrincipal) =>
  workpaperReadScopes.every((scope) => hasScope(principal, scope));

export const canReadExperienceCandidate = (principal: IntegrationPrincipal) =>
  hasScope(principal, "evidence:read") &&
  (hasScope(principal, "experience:read") ||
    hasScope(principal, "experience:publish"));

export const scopedStage = (
  principal: IntegrationPrincipal,
  stage: Stage,
): Stage => {
  const tasks = hasScope(principal, "workitem:read")
    ? stage.tasks.filter((item) => item.owner === principal.role)
    : [];
  // Input references can point to facts, material, or a confirmed workpaper.
  return {
    ...stage,
    tasks: canReadWorkpaper(principal)
      ? tasks
      : tasks.map((item) => ({
          ...item,
          inputs: item.inputs.map((input) => ({ ...input, reference: null })),
          ...(stage.code === "ROOT_CAUSE_VALIDATION"
            ? {
                output: { ...item.output, reference: null, locator: null },
                completionNote: "",
                reopenReason: null,
              }
            : {}),
        })),
  };
};

export const scopedOutcome = (
  principal: IntegrationPrincipal,
  outcome: Project["outcome"],
) =>
  hasScope(principal, "evidence:read")
    ? outcome
    : { ...outcome, evidenceReference: null, locator: null };

export const activityNoteFor = (
  principal: IntegrationPrincipal,
  activity: Pick<Project["auditTrail"][number], "actor" | "note">,
) =>
  activity.actor === principal.role &&
  hasScope(principal, "workitem:read") &&
  canReadWorkpaper(principal)
    ? activity.note
    : "";

export const scopedExecutionProject = (
  principal: IntegrationPrincipal,
  project: Project,
) => {
  const phases = project.phases.map((stage) => scopedStage(principal, stage));
  const workItemIds = new Set(
    phases.flatMap((stage) => stage.tasks.map((item) => item.id)),
  );
  return {
    ...project,
    phases,
    outcome: scopedOutcome(principal, project.outcome),
    experienceCandidate: canReadExperienceCandidate(principal)
      ? project.experienceCandidate
      : null,
    experienceReferences: hasScope(principal, "experience:read")
      ? project.experienceReferences
      : [],
    node: {
      ...project.node,
      latestUpdate: activityNoteFor(principal, {
        actor: "PMC",
        note: project.node.latestUpdate,
      }),
      subtasks: project.node.subtasks.filter((item) =>
        workItemIds.has(item.id),
      ),
    },
    auditTrail: project.auditTrail.map((event) => ({
      ...event,
      note: activityNoteFor(principal, event),
      snapshot: {},
    })),
  };
};

export const scopedExecutionSourceTask = (
  principal: IntegrationPrincipal,
  task: TaskDetail,
) => {
  const evidence = hasScope(principal, "evidence:read");
  const materials = hasScope(principal, "material:read");
  const experience = hasScope(principal, "experience:read");
  return {
    id: task.id,
    status: task.status,
    order: evidence ? task.order : undefined,
    analysis: evidence ? task.analysis : undefined,
    facts: evidence ? task.facts : [],
    evidence: evidence ? task.evidence : [],
    situations: evidence && materials ? task.situations : [],
    materials: materials ? sourceTaskMaterialsFor(task).materials : [],
    experienceReferences: experience ? task.experienceReferences : [],
    experienceReferenceAuditTrail: experience
      ? task.experienceReferenceAuditTrail
      : [],
    decision: evidence ? task.decision : null,
  };
};

export const scopedWorkpaper = (
  principal: IntegrationPrincipal,
  workpaper: ValidationWorkpaperView | null,
) => {
  if (!workpaper) return null;
  const experience = hasScope(principal, "experience:read");
  const versionFor = (version: ValidationWorkpaperVersion) =>
    !experience && version.proposalContext
      ? {
          ...version,
          proposalContext: {
            ...version.proposalContext,
            experienceReferences: [],
          },
        }
      : version;
  return {
    ...workpaper,
    workItem:
      principal.role === "PMC" && hasScope(principal, "workitem:read")
        ? workpaper.workItem
        : null,
    current: workpaper.current && versionFor(workpaper.current),
    latestConfirmed:
      workpaper.latestConfirmed && versionFor(workpaper.latestConfirmed),
    history: workpaper.history.map(versionFor),
  };
};
