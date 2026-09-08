import type { Project } from "@dingjiang/contracts";

type ProjectSummary = Pick<Project, "id" | "sourceTaskId" | "status">;

const ownerPriority: Record<Project["status"], number> = {
  PENDING_APPROVAL: 0,
  RETURNED: 1,
  DRAFT: 2,
  RUNNING: 3,
  RESULT_VALIDATION: 4,
  PENDING_RESULT_ACCEPTANCE: 5,
  KNOWLEDGE_CAPTURE: 6,
  COMPLETED: 7,
};

export function projectForSourceTask<T extends ProjectSummary>(
  projects: readonly T[],
  sourceTaskId: string,
): T | null {
  return (
    projects.find((project) => project.sourceTaskId === sourceTaskId) ?? null
  );
}

export function selectOwnerProject<T extends ProjectSummary>(
  projects: readonly T[],
  legacyProject: T | null,
  requestedProjectId: string | null,
): T | null {
  if (requestedProjectId) {
    const requested = projects.find(
      (project) => project.id === requestedProjectId,
    );
    if (requested) return requested;
  }

  return (
    [...projects].sort(
      (left, right) => ownerPriority[left.status] - ownerPriority[right.status],
    )[0] ?? legacyProject
  );
}
