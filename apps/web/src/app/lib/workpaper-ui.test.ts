import { describe, expect, it } from "vitest";
import type { Project, ValidationWorkpaperContent } from "@dingjiang/contracts";

import {
  canConfirmWorkpaper,
  createWorkpaperSingleFlight,
  formatWorkpaperFactValue,
  initialProjectWorkSelection,
  workpaperErrorMessage,
} from "./workpaper-ui";

const content = (
  result: "SUPPORTS" | "INSUFFICIENT_INFORMATION",
): ValidationWorkpaperContent => ({
  problemStatement: "验证产能风险",
  factFindings: [{ evidenceId: "E-1", assertion: "负荷超过阈值" }],
  materialFindings: [
    {
      materialId: "M-1",
      assertion: "班次负荷 92%",
      assessment: "SUPPORTS",
      verificationStatus: "EMPLOYEE_CHECKED",
      note: "",
    },
  ],
  hypotheses: ["产能负荷超出安全区间"],
  conclusion: {
    result,
    statement: "结论说明",
    limitations: "样本范围",
    nextChecks: [],
  },
});

describe("VS16 workpaper UI guards", () => {
  it("opens the first live consultant action instead of a later locked phase", () => {
    const project = {
      phases: [
        { code: "PROJECT_SCOPING", status: "COMPLETED", tasks: [] },
        { code: "BASELINE_FACTS", status: "COMPLETED", tasks: [] },
        {
          code: "ROOT_CAUSE_VALIDATION",
          status: "IN_PROGRESS",
          tasks: [
            {
              id: "history",
              owner: "PMC",
              origin: "HISTORICAL",
              status: "DONE",
            },
            { id: "root-live", owner: "PMC", origin: "LIVE", status: "READY" },
          ],
        },
        {
          code: "SOLUTION_APPROVAL",
          status: "LOCKED",
          tasks: [
            { id: "solution", owner: "PMC", origin: "LIVE", status: "LOCKED" },
          ],
        },
      ],
    } as unknown as Pick<Project, "phases">;

    expect(initialProjectWorkSelection(project)).toEqual({
      phaseCode: "ROOT_CAUSE_VALIDATION",
      taskId: "root-live",
    });
  });

  it("renders raw JavaScript fact dates as concise Chinese dates", () => {
    expect(
      formatWorkpaperFactValue(
        "Tue Aug 18 2026 00:00:00 GMT+0800 (China Standard Time) 对比承诺 Tue Aug 25 2026 00:00:00 GMT+0800 (China Standard Time)",
      ),
    ).toBe("2026/8/18 对比承诺 2026/8/25");
  });

  it("does not allow information-insufficient content to complete", () => {
    expect(
      canConfirmWorkpaper({
        content: content("INSUFFICIENT_INFORMATION"),
        completionNote: "已核验",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(false);
  });

  it("requires the employee note and every current acceptance item", () => {
    expect(
      canConfirmWorkpaper({
        content: content("SUPPORTS"),
        completionNote: "",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(false);
    expect(
      canConfirmWorkpaper({
        content: content("SUPPORTS"),
        completionNote: "已核验",
        acceptedCount: 1,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(false);
    expect(
      canConfirmWorkpaper({
        content: content("SUPPORTS"),
        completionNote: "已核验",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(true);
  });

  it("requires actual employee verification of every cited material", () => {
    const checked = content("SUPPORTS");
    checked.materialFindings[0]!.verificationStatus = "UNVERIFIED_INPUT";
    expect(
      canConfirmWorkpaper({
        content: checked,
        completionNote: "已核验",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(false);
    checked.materialFindings[0]!.verificationStatus = "EMPLOYEE_CHECKED";
    expect(
      canConfirmWorkpaper({
        content: checked,
        completionNote: "已核验",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(true);
    checked.materialFindings[0]!.assessment = "INCONCLUSIVE";
    expect(
      canConfirmWorkpaper({
        content: checked,
        completionNote: "已核验",
        acceptedCount: 2,
        requiredAcceptanceCount: 2,
      }),
    ).toBe(false);
  });

  it("ignores the second synchronous completion click", () => {
    const gate = createWorkpaperSingleFlight();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it("keeps stale and downstream failures actionable without clearing the form", () => {
    expect(
      workpaperErrorMessage(
        Object.assign(new Error("old"), { code: "STALE_WORKPAPER" }),
      ),
    ).toContain("填写的内容仍保留");
    expect(
      workpaperErrorMessage(
        Object.assign(new Error("old"), { code: "DOWNSTREAM_DEPENDENCY" }),
      ),
    ).toContain("不能重新打开");
  });
});
