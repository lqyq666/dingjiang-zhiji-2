import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workspace = readFileSync(
  new URL("./owner-workspace.tsx", import.meta.url),
  "utf8",
);

describe("Boss project overview table", () => {
  it("shows business status and measured results without web decision forms", () => {
    expect(workspace).toContain("当前阶段");
    expect(workspace).toContain("责任人");
    expect(workspace).toContain("实际结果 / 目标");
    expect(workspace).not.toContain("approveProject");
    expect(workspace).not.toContain("returnProject");
    expect(workspace).not.toContain("<form");
  });
});
