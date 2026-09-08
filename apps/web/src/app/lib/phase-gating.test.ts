import { describe, expect, it } from "vitest";

import {
  areAllAcceptanceCriteriaConfirmed,
  areWorkItemsConfirmed,
  isExperienceCandidateResubmission,
  isPhaseSubmissionUnlocked,
  isTaskConfirmationReady,
} from "./phase-gating";

describe("isPhaseSubmissionUnlocked", () => {
  it("only unlocks submission after every required task is done", () => {
    expect(isPhaseSubmissionUnlocked(2, 3)).toBe(false);
    expect(isPhaseSubmissionUnlocked(3, 3)).toBe(true);
  });

  it("does not unlock an empty or invalid task set", () => {
    expect(isPhaseSubmissionUnlocked(0, 0)).toBe(false);
    expect(isPhaseSubmissionUnlocked(4, 3)).toBe(false);
  });
});

describe("areWorkItemsConfirmed", () => {
  it("does not treat a bare DONE status as an accountable completion", () => {
    expect(
      areWorkItemsConfirmed([{ status: "DONE", completionConfirmation: null }]),
    ).toBe(false);
    expect(
      areWorkItemsConfirmed([
        { status: "DONE", completionConfirmation: { confirmedBy: "PMC" } },
      ]),
    ).toBe(true);
  });
});

describe("areAllAcceptanceCriteriaConfirmed", () => {
  it("requires every, and only, the current work item's criteria", () => {
    expect(
      areAllAcceptanceCriteriaConfirmed(
        ["来源可追溯", "范围明确"],
        ["来源可追溯"],
      ),
    ).toBe(false);
    expect(
      areAllAcceptanceCriteriaConfirmed(
        ["来源可追溯", "范围明确"],
        ["来源可追溯", "范围明确"],
      ),
    ).toBe(true);
    expect(
      areAllAcceptanceCriteriaConfirmed(
        ["来源可追溯"],
        ["来源可追溯", "旧标准"],
      ),
    ).toBe(false);
  });
});

describe("isTaskConfirmationReady", () => {
  it("requires both a completion note and an output reference", () => {
    expect(isTaskConfirmationReady("完成", "", false)).toBe(false);
    expect(isTaskConfirmationReady("", "清单 V1", false)).toBe(false);
    expect(isTaskConfirmationReady("完成", "清单 V1", false)).toBe(true);
  });

  it("requires a reason, but not an output reference, when reopening", () => {
    expect(isTaskConfirmationReady("", "", true)).toBe(false);
    expect(isTaskConfirmationReady("发现遗漏", "", true)).toBe(true);
  });
});

describe("isExperienceCandidateResubmission", () => {
  it("resubmits both expert-returned and employee-withdrawn candidates", () => {
    expect(isExperienceCandidateResubmission("RETURNED")).toBe(true);
    expect(isExperienceCandidateResubmission("WITHDRAWN")).toBe(true);
    expect(isExperienceCandidateResubmission("PENDING_REVIEW")).toBe(false);
    expect(isExperienceCandidateResubmission(null)).toBe(false);
  });
});
