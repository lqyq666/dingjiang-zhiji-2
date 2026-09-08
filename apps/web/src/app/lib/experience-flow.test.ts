import { describe, expect, it } from "vitest";

import {
  activeExperienceReferences,
  blocksAcceptedOutcomeCorrection,
  candidateStatusLabel,
  experienceReferenceEventLabel,
} from "./experience-flow";

describe("VS05 experience UI mapping", () => {
  it("keeps the candidate lifecycle in explicit Chinese business language", () => {
    expect(candidateStatusLabel("RETURNED")).toContain("退回");
    expect(candidateStatusLabel("APPROVED")).toContain("正式发布");
  });

  it("only renders active references as usable candidate references", () => {
    expect(
      activeExperienceReferences([
        { status: "ACTIVE" },
        { status: "WITHDRAWN" },
      ] as never).map((reference) => reference.status),
    ).toEqual(["ACTIVE"]);
  });

  it("permanently blocks source-result correction after any formal publication", () => {
    expect(
      blocksAcceptedOutcomeCorrection({ publishedExperienceHistory: true }),
    ).toBe(true);
    expect(
      blocksAcceptedOutcomeCorrection({ publishedExperienceHistory: false }),
    ).toBe(false);
  });

  it("keeps cited, withdrawn, and restored reference events readable", () => {
    expect(experienceReferenceEventLabel("CITED")).toContain("引用");
    expect(experienceReferenceEventLabel("WITHDRAWN")).toContain("撤回");
    expect(experienceReferenceEventLabel("RESTORED")).toContain("恢复");
  });
});
