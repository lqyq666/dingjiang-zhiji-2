import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const route = (path: string) => new URL(path, import.meta.url);

describe("Owner multipage workspace", () => {
  it("provides dedicated list and detail routes", () => {
    for (const path of [
      "./risks/page.tsx",
      "./projects/page.tsx",
      "./projects/[projectId]/page.tsx",
      "./approvals/page.tsx",
      "./approvals/[projectId]/page.tsx",
      "./data-sources/page.tsx",
    ]) {
      expect(existsSync(route(path))).toBe(true);
    }
  });

  it("keeps the home route focused and removes query-anchor pseudo pages", () => {
    const home = readFileSync(route("./page.tsx"), "utf8");
    expect(home).not.toContain("useSearchParams");
    expect(home).not.toContain('searchParams.get("view")');
    expect(home).not.toContain("#approval");
  });

  it("uses real owner projections and links to shared read-only source records", () => {
    const workspace = readFileSync(route("./owner-workspace.tsx"), "utf8");
    expect(workspace).toContain("dashboard.highRiskOrders");
    expect(workspace).toContain("dashboard.dataSources");
    expect(workspace).toContain("/employee/task/");
    expect(workspace).not.toContain("/project/");
    expect(workspace).not.toContain("/admin/import");
  });
});
