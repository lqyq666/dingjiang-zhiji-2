export function isPhaseSubmissionUnlocked(
  completedTaskCount: number,
  totalTaskCount: number,
): boolean {
  return totalTaskCount > 0 && completedTaskCount === totalTaskCount;
}

export function areWorkItemsConfirmed(
  tasks: readonly {
    status: string;
    completionConfirmation: unknown | null;
  }[],
): boolean {
  return (
    tasks.length > 0 &&
    tasks.every(
      (task) => task.status === "DONE" && task.completionConfirmation !== null,
    )
  );
}

export function isTaskConfirmationReady(
  note: string,
  outputReference: string,
  reopening: boolean,
): boolean {
  return (
    note.trim().length > 0 && (reopening || outputReference.trim().length > 0)
  );
}

export function areAllAcceptanceCriteriaConfirmed(
  criteria: readonly string[],
  confirmed: readonly string[],
): boolean {
  return (
    criteria.length > 0 &&
    criteria.every((criterion) => confirmed.includes(criterion)) &&
    confirmed.every((criterion) => criteria.includes(criterion))
  );
}

export function isExperienceCandidateResubmission(
  status: string | null | undefined,
): boolean {
  return status === "RETURNED" || status === "WITHDRAWN";
}
