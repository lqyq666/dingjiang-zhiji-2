import type { Project } from "@dingjiang/contracts";

type PhaseCode = Project["phases"][number]["code"];
type WorkItemStatus = Project["phases"][number]["tasks"][number]["status"];

export type NextActionProject = {
  status: Project["status"];
  phases: Array<{
    code: PhaseCode;
    name: string;
    tasks: Array<{
      id: string;
      title: string;
      owner: "PMC" | "OWNER";
      origin: "HISTORICAL" | "LIVE";
      status: WorkItemStatus;
    }>;
  }>;
  experienceCandidate: null | {
    status: "PENDING_REVIEW" | "RETURNED" | "WITHDRAWN" | "APPROVED";
  };
};

export type ProjectNextAction = {
  type:
    | "WORK_ITEM"
    | "SUBMIT_SOLUTION"
    | "WAIT_SOLUTION"
    | "CONFIRM_RESULT"
    | "SUBMIT_EXPERIENCE"
    | "WAIT_EXPERIENCE"
    | "COMPLETED";
  phaseCode: PhaseCode;
  stepNumber: number;
  owner: "PMC" | "OWNER" | "EXPERT_REVIEWER";
  eyebrow: string;
  title: string;
  description: string;
  primaryLabel: string;
  targetId: string;
  href?: string;
  taskId?: string;
};

const activeWorkItem = (
  project: NextActionProject,
  phaseCode: PhaseCode,
): ProjectNextAction | null => {
  const phase = project.phases.find((item) => item.code === phaseCode);
  if (!phase) return null;
  const task = phase.tasks.find(
    (item) =>
      item.owner === "PMC" &&
      item.origin === "LIVE" &&
      ["READY", "IN_PROGRESS", "RETURNED"].includes(item.status),
  );
  if (!task) return null;
  const taskIndex = phase.tasks.findIndex((item) => item.id === task.id) + 1;
  const completionEffect: Record<PhaseCode, string> = {
    PROJECT_SCOPING: "完成后系统会继续定位下一项工作。",
    BASELINE_FACTS: "完成后系统会继续定位下一项工作。",
    ROOT_CAUSE_VALIDATION: "完成后系统会继续定位下一项工作。",
    SOLUTION_APPROVAL:
      "完成后自动定位下一项方案工作；全部备妥后提交企业负责人确认。",
    EXECUTION_CONTROL:
      "完成后自动更新措施进度并定位下一项；最后一项完成后直接进入结果确认。",
    RESULT_ACCEPTANCE: "完成后自动定位下一项；全部完成后由你确认实际经营结果。",
    KNOWLEDGE_CAPTURE:
      "完成后自动定位下一项；全部完成后提交资深专家审核候选经验。",
  };
  return {
    type: "WORK_ITEM",
    phaseCode,
    stepNumber: project.phases.findIndex((item) => item.code === phaseCode) + 1,
    owner: "PMC",
    eyebrow: `当前第 ${taskIndex} / ${phase.tasks.length} 项`,
    title: task.title,
    description: completionEffect[phaseCode],
    primaryLabel:
      task.status === "IN_PROGRESS" ? "继续处理这项工作" : "开始处理这项工作",
    targetId: "task-workspace-title",
    taskId: task.id,
  };
};

const action = (
  project: NextActionProject,
  value: Omit<ProjectNextAction, "stepNumber">,
): ProjectNextAction => ({
  ...value,
  stepNumber:
    project.phases.findIndex((phase) => phase.code === value.phaseCode) + 1,
});

export function getProjectNextAction(
  project: NextActionProject,
): ProjectNextAction {
  if (project.status === "COMPLETED")
    return action(project, {
      type: "COMPLETED",
      phaseCode: "KNOWLEDGE_CAPTURE",
      owner: "PMC",
      eyebrow: "咨询任务已完成",
      title: "查看最终结果和正式经验",
      description: "七个步骤已经完成；你仍可回看事项、结果、证据和操作记录。",
      primaryLabel: "查看最终成果",
      targetId: "project-results",
    });

  if (project.status === "PENDING_APPROVAL")
    return action(project, {
      type: "WAIT_SOLUTION",
      phaseCode: "SOLUTION_APPROVAL",
      owner: "OWNER",
      eyebrow: "已交接 · 第一道人工作业审批",
      title: "等待企业负责人确认解决方案",
      description:
        "企业负责人在老板驾驶舱的“我的待办”中批准或退回；员工此时无需重复提交。",
      primaryLabel: "查看方案审批位置",
      targetId: "approval-submit",
      href: "/boss/approvals",
    });

  if (project.status === "DRAFT" || project.status === "RETURNED") {
    const work = activeWorkItem(project, "SOLUTION_APPROVAL");
    if (work) return work;
    return action(project, {
      type: "SUBMIT_SOLUTION",
      phaseCode: "SOLUTION_APPROVAL",
      owner: "PMC",
      eyebrow: "方案事项已备妥",
      title:
        project.status === "RETURNED"
          ? "按退回意见修订并重新提交方案"
          : "提交企业负责人确认解决方案",
      description:
        "这是本咨询任务第一道审批；负责人批准后，落实措施会自动解锁。",
      primaryLabel:
        project.status === "RETURNED" ? "重新提交解决方案" : "提交解决方案",
      targetId: "approval-submit",
    });
  }

  if (project.status === "RUNNING")
    return (
      activeWorkItem(project, "EXECUTION_CONTROL") ??
      action(project, {
        type: "CONFIRM_RESULT",
        phaseCode: "RESULT_ACCEPTANCE",
        owner: "PMC",
        eyebrow: "落实事项已完成",
        title: "进入结果确认",
        description: "系统正在根据最新事项完成事实打开结果确认，无需他人复核。",
        primaryLabel: "去确认实际结果",
        targetId: "outcome-submit",
      })
    );

  if (
    project.status === "RESULT_VALIDATION" ||
    project.status === "PENDING_RESULT_ACCEPTANCE"
  )
    return (
      activeWorkItem(project, "RESULT_ACCEPTANCE") ??
      action(project, {
        type: "CONFIRM_RESULT",
        phaseCode: "RESULT_ACCEPTANCE",
        owner: "PMC",
        eyebrow: "结果核对事项已完成",
        title: "确认实际经营结果",
        description:
          "核对 Before / Current / Target 与来源后，由你确认结果；确认后进入经验整理。",
        primaryLabel:
          project.status === "PENDING_RESULT_ACCEPTANCE"
            ? "重新确认实际结果"
            : "确认实际结果",
        targetId:
          project.status === "PENDING_RESULT_ACCEPTANCE"
            ? "outcome-reopen"
            : "outcome-submit",
      })
    );

  if (project.status === "KNOWLEDGE_CAPTURE") {
    if (project.experienceCandidate?.status === "PENDING_REVIEW")
      return action(project, {
        type: "WAIT_EXPERIENCE",
        phaseCode: "KNOWLEDGE_CAPTURE",
        owner: "EXPERT_REVIEWER",
        eyebrow: "已交接 · 第二道人工作业审批",
        title: "等待资深专家审核候选经验",
        description:
          "资深专家在专家审核页批准发布或退回修订；批准后咨询任务才正式完成。",
        primaryLabel: "查看专家审核位置",
        targetId: "experience-submit",
        href: "/expert",
      });
    const work = activeWorkItem(project, "KNOWLEDGE_CAPTURE");
    if (work) return work;
    return action(project, {
      type: "SUBMIT_EXPERIENCE",
      phaseCode: "KNOWLEDGE_CAPTURE",
      owner: "PMC",
      eyebrow:
        project.experienceCandidate?.status === "RETURNED"
          ? "专家已退回候选经验"
          : "经验整理事项已完成",
      title:
        project.experienceCandidate?.status === "RETURNED"
          ? "根据专家意见修订并重新提交"
          : "提交候选经验给资深专家审核",
      description:
        "这是本咨询任务第二道也是最后一道审批；未经专家批准不能成为正式经验。",
      primaryLabel:
        project.experienceCandidate?.status === "RETURNED"
          ? "修订并重新提交"
          : "提交候选经验",
      targetId: "experience-submit",
    });
  }

  return action(project, {
    type: "COMPLETED",
    phaseCode: "KNOWLEDGE_CAPTURE",
    owner: "PMC",
    eyebrow: "当前状态已保留",
    title: "查看咨询任务状态",
    description: "系统已保留当前状态和完整操作记录。",
    primaryLabel: "查看任务总结",
    targetId: "project-results",
  });
}
