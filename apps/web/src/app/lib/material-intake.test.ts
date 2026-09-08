import { describe, expect, it } from "vitest";

import {
  createSingleFlightGate,
  materialReadabilityLabel,
  materialVerificationLabel,
} from "./material-intake";

describe("VS15 material intake UI seams", () => {
  it("blocks a second synchronous upload click until the first request finishes", () => {
    const gate = createSingleFlightGate();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it("uses Chinese availability copy without treating a file as a completed task", () => {
    expect(
      materialReadabilityLabel({
        kind: "UPLOADED_FILE",
        status: "ACTIVE",
        readableByAi: true,
      }),
    ).toBe("AI 可读取安全摘要");
    expect(
      materialReadabilityLabel({
        kind: "UPLOADED_FILE",
        status: "ACTIVE",
        readableByAi: false,
      }),
    ).toBe("需人工查看原文件");
    expect(
      materialReadabilityLabel({ kind: "UPLOADED_FILE", status: "WITHDRAWN" }),
    ).toBe("已停用，不参与当前判断");
  });

  it("keeps availability and human verification copy separate", () => {
    expect(materialVerificationLabel("UNVERIFIED")).toBe("待人工核验");
    expect(materialVerificationLabel("VERIFIED")).toBe("已人工核验");
    expect(materialVerificationLabel("NEEDS_REVISION")).toBe("需要修订");
  });
});
