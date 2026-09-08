import { describe, expect, it } from "vitest";

import {
  getProjectNextAction,
  type NextActionProject,
} from "./project-next-action";

const project = (
  status: NextActionProject["status"],
  phaseCode: NextActionProject["phases"][number]["code"],
  taskStatus: NextActionProject["phases"][number]["tasks"][number]["status"],
  candidate: NextActionProject["experienceCandidate"] = null,
): NextActionProject => ({
  status,
  experienceCandidate: candidate,
  phases: [
    {
      code: phaseCode,
      name: "当前步骤",
      tasks: [
        {
          id: "TASK-1",
          title: "完成当前工作",
          owner: "PMC",
          origin: "LIVE",
          status: taskStatus,
        },
      ],
    },
  ],
});

describe("getProjectNextAction", () => {
  it("points the employee at the next unfinished work item", () => {
    const next = getProjectNextAction(
      project("RUNNING", "EXECUTION_CONTROL", "READY"),
    );
    expect(next.type).toBe("WORK_ITEM");
    expect(next.taskId).toBe("TASK-1");
    expect(next.primaryLabel).toBe("开始处理这项工作");
  });

  it("moves from completed execution work directly to employee result confirmation", () => {
    const next = getProjectNextAction(
      project("RUNNING", "EXECUTION_CONTROL", "DONE"),
    );
    expect(next.type).toBe("CONFIRM_RESULT");
    expect(next.owner).toBe("PMC");
    expect(next.description).toContain("无需他人复核");
  });

  it("uses only the owner solution approval gate", () => {
    const prepared = getProjectNextAction(
      project("DRAFT", "SOLUTION_APPROVAL", "DONE"),
    );
    expect(prepared.type).toBe("SUBMIT_SOLUTION");
    const waiting = getProjectNextAction(
      project("PENDING_APPROVAL", "SOLUTION_APPROVAL", "WAITING_REVIEW"),
    );
    expect(waiting.type).toBe("WAIT_SOLUTION");
    expect(waiting.owner).toBe("OWNER");
    expect(waiting.href).toBe("/boss/approvals");
  });

  it("asks the employee to confirm the result after result work items are done", () => {
    const next = getProjectNextAction(
      project("RESULT_VALIDATION", "RESULT_ACCEPTANCE", "DONE"),
    );
    expect(next.type).toBe("CONFIRM_RESULT");
    expect(next.owner).toBe("PMC");
  });

  it("uses only the expert approval gate after experience submission", () => {
    const ready = getProjectNextAction(
      project("KNOWLEDGE_CAPTURE", "KNOWLEDGE_CAPTURE", "DONE"),
    );
    expect(ready.type).toBe("SUBMIT_EXPERIENCE");
    const waiting = getProjectNextAction(
      project("KNOWLEDGE_CAPTURE", "KNOWLEDGE_CAPTURE", "DONE", {
        status: "PENDING_REVIEW",
      }),
    );
    expect(waiting.type).toBe("WAIT_EXPERIENCE");
    expect(waiting.owner).toBe("EXPERT_REVIEWER");
  });

  it("turns the final state into a results review action", () => {
    const next = getProjectNextAction(
      project("COMPLETED", "KNOWLEDGE_CAPTURE", "DONE", {
        status: "APPROVED",
      }),
    );
    expect(next.type).toBe("COMPLETED");
    expect(next.primaryLabel).toBe("查看最终成果");
  });
});
