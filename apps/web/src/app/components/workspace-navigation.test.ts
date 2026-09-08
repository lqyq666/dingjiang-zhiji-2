import { describe, expect, it } from "vitest";

import {
  ownerApprovalHref,
  ownerProjectHref,
  workspaceHrefFor,
} from "./workspace-navigation";

describe("workspaceHrefFor", () => {
  it("routes owner navigation to real list pages", () => {
    expect(workspaceHrefFor("risks", "OWNER")).toBe("/boss/risks");
    expect(workspaceHrefFor("projects", "OWNER", "PRJ-1")).toBe(
      "/boss/projects",
    );
    expect(workspaceHrefFor("approval", "OWNER", "PRJ-1")).toBe(
      "/boss/approvals",
    );
    expect(workspaceHrefFor("dataSources", "OWNER")).toBe("/boss/data-sources");
  });

  it("builds owner detail links without changing role", () => {
    expect(ownerProjectHref("PRJ A/B")).toBe("/boss/projects/PRJ%20A%2FB");
    expect(ownerApprovalHref("PRJ-1")).toBe("/boss/approvals/PRJ-1");
  });

  it("keeps owner list pages available before a project is selected", () => {
    expect(workspaceHrefFor("projects", "OWNER")).toBe("/boss/projects");
    expect(workspaceHrefFor("approval", "OWNER")).toBe("/boss/approvals");
  });

  it("routes every PMC collection to a stable list page", () => {
    expect(workspaceHrefFor("diagnosis", "PMC")).toBe(
      "/employee/confirmations",
    );
    expect(workspaceHrefFor("risks", "PMC")).toBe("/employee/risks");
    expect(workspaceHrefFor("projects", "PMC")).toBe("/employee/projects");
    expect(workspaceHrefFor("projects", "PMC", "PRJ-1")).toBe(
      "/employee/projects",
    );
    expect(workspaceHrefFor("diagnosis", "OWNER", "PRJ-1")).toBeNull();
    expect(workspaceHrefFor("projects", "EXPERT_REVIEWER", "PRJ-1")).toBeNull();
  });

  it("only exposes administration destinations to the PMC workspace", () => {
    expect(workspaceHrefFor("organization", "PMC")).toBe("/admin/organization");
    expect(workspaceHrefFor("data", "PMC")).toBe("/admin/import");
    expect(workspaceHrefFor("settings", "OWNER")).toBeNull();
    expect(workspaceHrefFor("audit", "EXPERT_REVIEWER")).toBeNull();
  });
});
