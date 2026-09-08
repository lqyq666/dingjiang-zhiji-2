import { describe, expect, it } from "vitest";

import { taskAssistantCoverageSummary } from "./task-assistant-copy";

describe("task assistant coverage copy", () => {
  it("keeps diagnosis context counts explicit and in Chinese", () => {
    expect(
      taskAssistantCoverageSummary({
        evidenceCount: 3,
        materialCount: 2,
        materialGapCount: 1,
      }),
    ).toBe("已读取 3 条证据 · 2 项材料 · 1 项材料缺口");
  });
});
