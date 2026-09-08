import { areWorkItemsConfirmed } from "./phase-gating";
import type {
  DecisionInput,
  Project,
  ProjectSubtaskStatusInput,
} from "@dingjiang/contracts";

// These statements describe the explicit action shown beside the submit button.
// They are audit notes, not generated evidence or claims about file contents.
export const materialConfirmation =
  "我已核对材料来源与当前用途，确认材料可用于后续证据整理。";
export const evidenceConfirmation =
  "我已核对上述结论、来源定位和限制，确认将这条候选证据登记为正式证据。";
export const completionConfirmation =
  "我已核对交付成果，确认满足以上全部完成标准。";

export function materialName(fileName: string, customTitle = "") {
  return (
    customTitle.trim() ||
    fileName.replace(/\.[^.]+$/, "") ||
    fileName
  ).slice(0, 100);
}

export function reviewNote(
  confirmed: boolean,
  note: string,
  statement: string,
) {
  if (confirmed) return statement;
  const reason = note.trim();
  if (reason.length < 5)
    throw new Error("请具体说明需要修订的内容（至少 5 个字）");
  return reason;
}

export function decisionAction(
  type: DecisionInput["type"],
  note: string,
): DecisionInput {
  const explanation = type === "CONFIRMED" ? "" : note.trim();
  if (type !== "CONFIRMED" && !explanation)
    throw new Error("请说明不同判断或缺少的事实");
  return { actor: "PMC", type, note: explanation };
}

export function completionAction(
  output: string,
  acceptance: string[],
): ProjectSubtaskStatusInput {
  if (!output.trim()) throw new Error("请填写交付成果的位置，便于他人核对");
  if (!acceptance.length)
    throw new Error("这项任务缺少完成标准，请先补齐事项定义");
  return {
    actor: "PMC",
    status: "DONE",
    note: completionConfirmation,
    outputReference: output.trim(),
    confirmedAcceptanceCriteria: [...acceptance],
  };
}

export function phaseReadyForHandoff(phase: Project["phases"][number]) {
  const tasks = phase.tasks.filter((task) => task.owner === "PMC");
  return areWorkItemsConfirmed(tasks);
}

export function measuredOutcome(value: string, target: number) {
  const current = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(current) ||
    current < 0 ||
    current > 100
  )
    return null;
  return {
    current,
    conclusion: `本次 OTD 实测为 ${current}%，目标为 ${target}%，${current >= target ? "达到" : "未达到"}目标。`,
  };
}
