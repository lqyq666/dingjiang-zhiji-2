import { describe, expect, it } from "vitest";

import {
  projectForSourceTask,
  selectOwnerProject,
} from "./dashboard-project-selection";

const projects = [
  {
    id: "PRJ-COMPLETE",
    sourceTaskId: "SO-202608128",
    status: "COMPLETED" as const,
  },
  {
    id: "PRJ-APPROVAL",
    sourceTaskId: "SO-202608136",
    status: "PENDING_APPROVAL" as const,
  },
  {
    id: "PRJ-RUNNING",
    sourceTaskId: "SO-202608140",
    status: "RUNNING" as const,
  },
];

describe("dashboard project selection", () => {
  it("finds the project connected to the task being viewed", () => {
    expect(projectForSourceTask(projects, "SO-202608136")?.id).toBe(
      "PRJ-APPROVAL",
    );
    expect(projectForSourceTask(projects, "SO-MISSING")).toBeNull();
  });

  it("uses a valid owner query selection before the default", () => {
    expect(selectOwnerProject(projects, projects[1]!, "PRJ-RUNNING")?.id).toBe(
      "PRJ-RUNNING",
    );
  });

  it("defaults the owner to a solution waiting for approval", () => {
    expect(selectOwnerProject(projects, projects[0]!, null)?.id).toBe(
      "PRJ-APPROVAL",
    );
  });

  it("keeps the legacy projection when no projects are available", () => {
    expect(selectOwnerProject([], projects[0]!, null)?.id).toBe("PRJ-COMPLETE");
  });
});
