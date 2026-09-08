import type {
  ExperienceCandidate,
  ExperienceReference,
  Project,
} from "@dingjiang/contracts";

export const candidateStatusLabel = (
  status: ExperienceCandidate["status"],
): string => {
  switch (status) {
    case "PENDING_REVIEW":
      return "待专家审核";
    case "RETURNED":
      return "专家已退回，等待修订重提";
    case "WITHDRAWN":
      return "已撤回，可重新整理";
    case "APPROVED":
      return "已批准并正式发布";
  }
};

export const activeExperienceReferences = (
  references: ExperienceReference[],
): ExperienceReference[] =>
  references.filter((reference) => reference.status === "ACTIVE");

export const blocksAcceptedOutcomeCorrection = (
  project: Pick<Project, "publishedExperienceHistory"> | null,
): boolean => project?.publishedExperienceHistory === true;

export const experienceReferenceEventLabel = (
  eventType: "CITED" | "WITHDRAWN" | "RESTORED",
): string => {
  switch (eventType) {
    case "CITED":
      return "已引用正式经验";
    case "WITHDRAWN":
      return "已撤回候选参考";
    case "RESTORED":
      return "已恢复候选参考";
  }
};
