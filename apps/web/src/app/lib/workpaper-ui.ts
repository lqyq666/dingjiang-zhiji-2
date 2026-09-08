import type { Project, ValidationWorkpaperContent } from "@dingjiang/contracts";

type ProjectWorkSelection = {
  phaseCode: Project["phases"][number]["code"];
  taskId: string | null;
};

const actionableWorkItemStatuses = new Set([
  "READY",
  "IN_PROGRESS",
  "RETURNED",
]);

/**
 * Locates the first item the consultant can actually act on. Project.status
 * is intentionally not used: VS16 can hold a DRAFT project at root-cause
 * validation while the solution gate remains locked.
 */
export const initialProjectWorkSelection = (
  project: Pick<Project, "phases">,
): ProjectWorkSelection | null => {
  for (const phase of project.phases) {
    const task = phase.tasks.find(
      (item) =>
        item.owner === "PMC" &&
        item.origin === "LIVE" &&
        actionableWorkItemStatuses.has(item.status),
    );
    if (task) return { phaseCode: phase.code, taskId: task.id };
  }

  for (const phase of project.phases) {
    if (!["READY", "IN_PROGRESS", "RETURNED"].includes(phase.status)) continue;
    const task = phase.tasks.find(
      (item) =>
        item.owner === "PMC" && actionableWorkItemStatuses.has(item.status),
    );
    if (task) return { phaseCode: phase.code, taskId: task.id };
  }

  return null;
};

const chineseDayFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const rawJavaScriptDate =
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]+\))?/g;

/** Keeps immutable fact text intact except for rendering raw Date#toString values concisely. */
export const formatWorkpaperFactValue = (value: string) =>
  value.replace(rawJavaScriptDate, (rawDate) => {
    const parsed = new Date(rawDate);
    return Number.isNaN(parsed.getTime())
      ? rawDate
      : chineseDayFormatter.format(parsed);
  });

/** Stops a second completion request before React has a chance to repaint. */
export const createWorkpaperSingleFlight = () => {
  let active = false;
  return {
    tryStart: () => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: () => {
      active = false;
    },
  };
};

export const canConfirmWorkpaper = (input: {
  content: ValidationWorkpaperContent;
  completionNote: string;
  acceptedCount: number;
  requiredAcceptanceCount: number;
}) =>
  input.content.conclusion.result !== "INSUFFICIENT_INFORMATION" &&
  Boolean(input.content.conclusion.statement.trim()) &&
  Boolean(input.content.conclusion.limitations.trim()) &&
  Boolean(input.completionNote.trim()) &&
  input.requiredAcceptanceCount > 0 &&
  input.acceptedCount === input.requiredAcceptanceCount &&
  input.content.materialFindings.length > 0 &&
  input.content.materialFindings.every(
    (finding) => finding.verificationStatus === "EMPLOYEE_CHECKED",
  ) &&
  input.content.materialFindings.some(
    (finding) => finding.assessment !== "INCONCLUSIVE",
  );

export const workpaperErrorMessage = (error: Error & { code?: string }) => {
  if (error.code === "STALE_WORKPAPER")
    return "底稿已被更新；你填写的内容仍保留，请先重新加载后核对再保存。";
  if (error.code === "DOWNSTREAM_DEPENDENCY")
    return "方案已开始或已提交，不能重新打开该事项。请先处理下游依赖。";
  return error.message || "操作失败；当前填写内容未丢失。";
};
