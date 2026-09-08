import { describe, expect, it } from "vitest";

import {
  appendProjectStageMessage,
  canCreateAnalysisPlan,
  setStageClarificationAnswer,
  getProjectStageView,
} from "./project-stage-copilot";

describe("project stage copilot", () => {
  it("keeps conversations isolated by project stage", () => {
    const first = appendProjectStageMessage({}, "SOLUTION_APPROVAL", {
      role: "user",
      text: "方案节点还有什么风险？",
    });
    const second = appendProjectStageMessage(first, "EXECUTION_CONTROL", {
      role: "assistant",
      text: "落实节点仍有一项待完成。",
    });

    expect(second.SOLUTION_APPROVAL).toEqual([
      { role: "user", text: "方案节点还有什么风险？" },
    ]);
    expect(second.EXECUTION_CONTROL).toEqual([
      { role: "assistant", text: "落实节点仍有一项待完成。" },
    ]);
  });

  it("returns only the selected stage work and activities", () => {
    const context = {
      stages: [
        {
          code: "SOLUTION_APPROVAL",
          name: "定下解决方案",
          status: "COMPLETED",
          progress: 100,
          completedItemCount: 3,
          totalItemCount: 3,
        },
        {
          code: "EXECUTION_CONTROL",
          name: "落实解决措施",
          status: "IN_PROGRESS",
          progress: 50,
          completedItemCount: 2,
          totalItemCount: 4,
        },
      ],
      workItems: [
        { id: "S1", stage: "定下解决方案" },
        { id: "E1", stage: "落实解决措施" },
      ],
      recentActivities: [
        { eventType: "PROJECT_APPROVED", stage: "SOLUTION_APPROVAL" },
        { eventType: "TASK_COMPLETED", stage: "EXECUTION_CONTROL" },
      ],
    } as never;

    const selected = getProjectStageView(context, "EXECUTION_CONTROL");
    expect(selected.stage?.name).toBe("落实解决措施");
    expect(selected.workItems.map((item) => item.id)).toEqual(["E1"]);
    expect(selected.activities.map((item) => item.eventType)).toEqual([
      "TASK_COMPLETED",
    ]);
  });

  it("requires every mandatory clarification before planning", () => {
    const clarifications = [
      { id: "A", required: true },
      { id: "B", required: false },
    ] as never;
    expect(canCreateAnalysisPlan(clarifications, {})).toBe(false);
    expect(canCreateAnalysisPlan(clarifications, { A: "已核对" })).toBe(true);
  });

  it("keeps clarification answers isolated by stage", () => {
    const first = setStageClarificationAnswer(
      {},
      "SOLUTION_APPROVAL",
      "SCOPE",
      "比较三套方案",
    );
    const second = setStageClarificationAnswer(
      first,
      "EXECUTION_CONTROL",
      "MATERIAL",
      "使用最新 BOM 表",
    );
    expect(second.SOLUTION_APPROVAL?.answers).toEqual({
      SCOPE: "比较三套方案",
    });
    expect(second.EXECUTION_CONTROL?.answers).toEqual({
      MATERIAL: "使用最新 BOM 表",
    });
  });
});
