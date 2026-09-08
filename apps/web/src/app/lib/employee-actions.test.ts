import { describe, expect, it } from "vitest";
import {
  decisionInputSchema,
  projectSubtaskStatusInputSchema,
  type Project,
} from "@dingjiang/contracts";
import {
  completionAction,
  completionConfirmation,
  decisionAction,
  materialConfirmation,
  materialName,
  measuredOutcome,
  phaseReadyForHandoff,
  reviewNote,
} from "./employee-actions";

describe("minimum employee actions", () => {
  it("uses the file name without requiring a duplicate title and bounds long names", () => {
    expect(materialName("订单产能.csv")).toBe("订单产能");
    expect(materialName("订单.csv", "  工时核对  ")).toBe("工时核对");
    expect(materialName("a".repeat(130) + ".csv")).toHaveLength(100);
  });
  it("records the visible positive attestation but requires a real exception reason", () => {
    expect(reviewNote(true, "上一次退回理由", materialConfirmation)).toBe(
      materialConfirmation,
    );
    expect(() => reviewNote(false, "  ", materialConfirmation)).toThrow();
    expect(reviewNote(false, "  请补充记录日期  ", materialConfirmation)).toBe(
      "请补充记录日期",
    );
  });
  it("does not carry stale negative explanations into a positive decision", () => {
    expect(
      decisionInputSchema.parse(decisionAction("CONFIRMED", "旧理由")).note,
    ).toBe("");
    expect(() => decisionAction("MODIFIED", "")).toThrow();
    expect(() => decisionAction("INSUFFICIENT_INFORMATION", " ")).toThrow();
    expect(decisionAction("MODIFIED", "  主要是排产问题  ").note).toBe(
      "主要是排产问题",
    );
  });
  it("keeps output and every acceptance criterion in one explicit completion command", () => {
    const criteria = ["有来源", "已核对影响"];
    const result = projectSubtaskStatusInputSchema.parse(
      completionAction("  成果清单第 4 行  ", criteria),
    );
    expect(result).toMatchObject({
      status: "DONE",
      outputReference: "成果清单第 4 行",
      note: completionConfirmation,
      confirmedAcceptanceCriteria: criteria,
    });
    criteria.push("后来新增的标准");
    expect(result).toHaveProperty("confirmedAcceptanceCriteria", [
      "有来源",
      "已核对影响",
    ]);
    expect(() => completionAction(" ", ["有来源"])).toThrow();
    expect(() => completionAction("文件", [])).toThrow();
  });
  it("does not turn a blank or invalid measurement into an actual result", () => {
    for (const value of ["", " ", "NaN", "Infinity", "-1", "101"])
      expect(measuredOutcome(value, 90)).toBeNull();
    expect(measuredOutcome("0", 90)?.current).toBe(0);
    expect(measuredOutcome("90", 90)?.conclusion).toContain("达到目标");
    expect(measuredOutcome("89.5", 90)?.conclusion).toContain("未达到目标");
  });
  it("requires confirmed employee work before handing off without impersonating the owner", () => {
    const phase = {
      tasks: [
        { owner: "PMC", status: "DONE", completionConfirmation: {} },
        { owner: "OWNER", status: "LOCKED", completionConfirmation: null },
      ],
    } as unknown as Project["phases"][number];
    expect(phaseReadyForHandoff(phase)).toBe(true);
    phase.tasks[0]!.completionConfirmation = null;
    expect(phaseReadyForHandoff(phase)).toBe(false);
    expect(phaseReadyForHandoff({ ...phase, tasks: [] })).toBe(false);
  });
});
