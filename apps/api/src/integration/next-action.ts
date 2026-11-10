import {
  nextActionSchema,
  type IntegrationCurrentWorkItem,
  type IntegrationProjectContext,
  type NextAction,
  type Project,
} from "@dingjiang/contracts";

/** Derive a proposal from the same inputs for standalone and workspace reads. */
export const deriveNextAction = (
  project: Pick<Project, "id" | "status">,
  item: IntegrationCurrentWorkItem["item"],
  gap:
    IntegrationProjectContext["sourceTask"]["materialGaps"][number] | undefined,
): NextAction => {
  if (item)
    return nextActionSchema.parse({
      kind: "WORK_ITEM",
      projectId: project.id,
      workItemId: item.id,
      title: item.title,
      responsibleRole: item.owner,
      explanation: "当前服务端派生事项优先处理",
      classification: "PROPOSAL",
    });

  if (gap)
    return nextActionSchema.parse({
      kind: "MATERIAL_GAP",
      projectId: project.id,
      requirementId: gap.requirementId,
      title: gap.label,
      explanation: `材料缺口状态为 ${gap.status}`,
      classification: "PROPOSAL",
    });

  return nextActionSchema.parse({
    kind: "HUMAN_GATE_OR_REVIEW",
    projectId: project.id,
    title: "查看当前状态对应的人工 gate 或完成条件",
    explanation: `项目状态为 ${project.status}`,
    classification: "PROPOSAL",
  });
};
