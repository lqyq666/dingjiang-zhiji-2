import type { ProjectAssistantResponse } from "@dingjiang/contracts";

export type ProjectStageCode =
  ProjectAssistantResponse["context"]["stages"][number]["code"];
export type ProjectStageThreadKey = ProjectStageCode | "PROJECT";
export type ProjectStageMessage = {
  role: "user" | "assistant";
  text: string;
};
export type ProjectStageThreads = Partial<
  Record<ProjectStageThreadKey, ProjectStageMessage[]>
>;
export type ProjectStageAnalysisSession = {
  answers: Record<string, string>;
};
export type ProjectStageAnalysisSessions = Partial<
  Record<ProjectStageCode, ProjectStageAnalysisSession>
>;

export function appendProjectStageMessage(
  threads: ProjectStageThreads,
  key: ProjectStageThreadKey,
  message: ProjectStageMessage,
): ProjectStageThreads {
  return {
    ...threads,
    [key]: [...(threads[key] ?? []), message],
  };
}

export function getProjectStageView(
  context: ProjectAssistantResponse["context"],
  code: ProjectStageCode,
) {
  const stage = context.stages.find((item) => item.code === code) ?? null;
  return {
    stage,
    workItems: stage
      ? context.workItems.filter((item) => item.stage === stage.name)
      : [],
    activities: context.recentActivities.filter(
      (activity) => activity.stage === code,
    ),
  };
}

export function canCreateAnalysisPlan(
  clarifications: ProjectAssistantResponse["workflow"]["clarifications"],
  answers: Record<string, string>,
): boolean {
  return clarifications
    .filter((item) => item.required)
    .every((item) => Boolean(answers[item.id]?.trim()));
}

export function setStageClarificationAnswer(
  sessions: ProjectStageAnalysisSessions,
  stageCode: ProjectStageCode,
  questionId: string,
  answer: string,
): ProjectStageAnalysisSessions {
  return {
    ...sessions,
    [stageCode]: {
      answers: {
        ...(sessions[stageCode]?.answers ?? {}),
        [questionId]: answer,
      },
    },
  };
}
