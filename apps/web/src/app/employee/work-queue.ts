import type { EmployeeDashboard, Project } from "@dingjiang/contracts";
import { initialProjectWorkSelection } from "../lib/workpaper-ui";

export const projectAction: Record<Project["status"], string> = {
  DRAFT: "完善方案",
  PENDING_APPROVAL: "查看审批进度",
  RETURNED: "修改方案",
  RUNNING: "落实措施",
  RESULT_VALIDATION: "核对结果",
  PENDING_RESULT_ACCEPTANCE: "查看结果确认",
  KNOWLEDGE_CAPTURE: "整理经验",
  COMPLETED: "查看成果",
};
export const projectStatus: Record<Project["status"], string> = {
  DRAFT: "准备方案",
  PENDING_APPROVAL: "待负责人审批",
  RETURNED: "需要修改",
  RUNNING: "执行中",
  RESULT_VALIDATION: "核对结果",
  PENDING_RESULT_ACCEPTANCE: "待结果确认",
  KNOWLEDGE_CAPTURE: "整理经验",
  COMPLETED: "已完成",
};
export type WorkRow = {
  id: string;
  title: string;
  context: string;
  type: string;
  status: string;
  detail: string;
  action: string;
  href: string;
  pending: boolean;
  completed: boolean;
  progress?: number;
};
export type WorkView = "home" | "risks" | "projects" | "confirmations";
export function workRows(
  dashboard: EmployeeDashboard,
  view: WorkView,
): WorkRow[] {
  const pending = new Set(dashboard.pendingTaskIds);
  const projects = dashboard.projects.map((project): WorkRow => {
    const selected = project.phases?.length
      ? initialProjectWorkSelection(project)
      : null;
    const phase = project.phases?.find(
      (item) => item.code === selected?.phaseCode,
    );
    const task = phase?.tasks.find((item) => item.id === selected?.taskId);
    const actions = {
      PROJECT_SCOPING: "明确问题",
      BASELINE_FACTS: "核对事实",
      ROOT_CAUSE_VALIDATION: "核验原因",
      SOLUTION_APPROVAL: "完善方案",
      EXECUTION_CONTROL: "落实措施",
      RESULT_ACCEPTANCE: "核对结果",
      KNOWLEDGE_CAPTURE: "整理经验",
    };
    const action = selected
      ? actions[selected.phaseCode]
      : projectAction[project.status];
    return {
      id: project.id,
      title: project.name,
      context: `${dashboard.highRiskOrders.find((order) => order.orderId === project.sourceTaskId)?.customer ?? "来源订单"} · ${project.sourceTaskId}`,
      type: "咨询任务",
      status:
        selected?.phaseCode === "ROOT_CAUSE_VALIDATION"
          ? "核验原因"
          : projectStatus[project.status],
      detail: task?.title ?? action,
      action,
      href: `/project/${encodeURIComponent(project.id)}`,
      pending: project.status !== "COMPLETED",
      completed: project.status === "COMPLETED",
      progress: ["RUNNING", "COMPLETED"].includes(project.status)
        ? project.progress
        : undefined,
    };
  });
  const sourceIds =
    view === "confirmations"
      ? [...pending]
      : dashboard.highRiskOrders.map((order) => order.orderId);
  const orders = sourceIds.map((id): WorkRow => {
    const order = dashboard.highRiskOrders.find((item) => item.orderId === id);
    return {
      id,
      title: order ? `${order.customer} · ${order.primaryException}` : id,
      context: order ? `${id} · 承诺 ${order.promisedDate}` : "来源任务",
      type: "经营异常",
      status: pending.has(id) ? "待人工判断" : "已记录判断",
      detail: order
        ? `预计延期 ${order.delayDays} 天 · ${order.forecastDate}`
        : "核对来源与材料",
      action: pending.has(id) ? "核对并判断" : "查看处理记录",
      href: `/employee/task/${encodeURIComponent(id)}`,
      pending: pending.has(id),
      completed: false,
    };
  });
  if (view === "projects") return projects;
  if (view === "risks" || view === "confirmations") return orders;
  const projectSources = new Set(
    dashboard.projects.map((project) => project.sourceTaskId),
  );
  // Missing high-risk summaries must not hide pending work.
  const missing = workRows(dashboard, "confirmations").filter(
    (row) => !orders.some((order) => order.id === row.id),
  );
  return [...orders, ...missing]
    .filter((row) => !projectSources.has(row.id))
    .concat(projects);
}
export function filterWorkRows(
  rows: WorkRow[],
  query: string,
  scope: "active" | "all",
) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (scope === "all" || !row.completed) &&
      `${row.title} ${row.context} ${row.status} ${row.type}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}
