import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const workspace = readFileSync(
  new URL("./employee-workspace.tsx", import.meta.url),
  "utf8",
);

describe("Employee workspace information architecture", () => {
  it("keeps the home page focused on one event ledger", () => {
    expect(page).toContain('view="home"');
  });

  it("does not repeat decorative or administrative dashboard sections", () => {
    expect(workspace).not.toContain("风险累积示意");
    expect(workspace).not.toContain("数据来源状态");
    expect(workspace).not.toContain("等待人工确认");
    expect(workspace).toContain("事件台账");
    expect(workspace).toContain("异常列表");
    expect(workspace).toContain("任务列表");
    expect(workspace).toContain("确认队列");
  });
});
