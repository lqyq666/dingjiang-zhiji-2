import { ForbiddenException } from "@nestjs/common";
import type { IntegrationPrincipal } from "@dingjiang/contracts";
import { describe, expect, it, vi } from "vitest";

import { IntegrationService } from "./integration.service";

const outcome = {
  baseline: 60,
  target: 85,
  current: null,
  status: "NOT_MEASURED" as const,
  conclusion: null,
  evidenceReference: null,
  note: null,
  submittedAt: null,
  acceptedAt: null,
  locator: null,
};

const project = (id: string, status: "RUNNING" | "COMPLETED") => ({
  id,
  sourceTaskId: `SO-${id}`,
  name: `项目 ${id}`,
  status,
  progress: status === "COMPLETED" ? 100 : 25,
  phases: [],
  outcome,
});

const workItem = (
  id: string,
  owner: "PMC" | "OWNER",
  status:
    "LOCKED" | "READY" | "IN_PROGRESS" | "WAITING_REVIEW" | "DONE" | "RETURNED",
) => ({
  id,
  title: `事项 ${id}`,
  purpose: "验证员工身份范围",
  owner,
  origin: "LIVE" as const,
  status,
  inputs: [],
  process: [],
  output: { expected: "形成可追溯输出", reference: null, locator: null },
  acceptance: ["身份与责任角色匹配"],
  progressUpdate: null,
  completionConfirmation: null,
  completionNote: "",
  completedAt: null,
  sourceRecordedAt: null,
  reopenReason: null,
});

const projectWithWork = (id: string, tasks: ReturnType<typeof workItem>[]) => ({
  ...project(id, "RUNNING"),
  phases: [
    {
      id: `${id}-PHASE-1`,
      code: "SOLUTION_APPROVAL" as const,
      name: "方案定稿",
      purpose: "确认方案",
      status: "IN_PROGRESS" as const,
      progress: 0,
      completedTaskCount: 0,
      totalTaskCount: tasks.length,
      gate: { status: "OPEN" as const, label: "执行中", returnedReason: null },
      tasks,
    },
  ],
});

const principal = (
  overrides: Partial<IntegrationPrincipal> = {},
): IntegrationPrincipal => ({
  tenantId: "tenant-demo",
  subjectId: "pmc-1",
  role: "PMC",
  scopes: [
    "project:read",
    "workitem:read",
    "material:read",
    "evidence:read",
    "workpaper:read",
    "experience:read",
  ],
  projectIds: ["PRJ-A"],
  ...overrides,
});

describe("IntegrationService authorization and current-project derivation", () => {
  it("propagates a controlled-body read failure rather than claiming the body is unavailable", async () => {
    const adapter = {
      materialPreview: vi.fn().mockResolvedValue({
        status: "BODY_NOT_AVAILABLE",
        sourceTaskId: "SO-A",
        data: {
          material: {
            kind: "MANUAL_REFERENCE",
            locator: { sourceVersionId: "SV-1" },
            file: null,
          },
        },
      }),
    };
    const readModel = {
      controlledMaterialText: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
    };
    const service = new IntegrationService(
      adapter as never,
      { readModel } as never,
      {} as never,
    );
    await expect(
      service.materialPreview(principal(), "PRJ-A", "1"),
    ).rejects.toThrow("database unavailable");
    expect(readModel.controlledMaterialText).toHaveBeenCalledExactlyOnceWith(
      "PRJ-A",
      "1",
      "SV-1",
    );
  });

  it.each([
    [null, "CAPACITY_RISK", "ACTIVE", 0],
    ["REQ-CAPACITY-LOAD", "CAPACITY_RISK", "INACTIVE", 0],
    ["REQ-OTHER", "CAPACITY_RISK", "ACTIVE", 0],
    ["REQ-CAPACITY-LOAD", "BOM_DELAY", "ACTIVE", 0],
    ["REQ-CAPACITY-LOAD", "CAPACITY_RISK", "ACTIVE", 1],
  ])(
    "returns the requirement version for %s / %s / %s",
    async (requirementId, situationCode, status, version) => {
      const reader = {
        projectSourceTaskId: vi.fn().mockResolvedValue("SO-A"),
        evidenceProposalVersions: vi.fn().mockResolvedValue(new Map()),
        taskMaterials: vi.fn().mockResolvedValue({
          id: "SO-A",
          situations: [
            {
              code: "CAPACITY_RISK",
              state: "UNVERIFIED",
              requirements: [
                {
                  id: "REQ-CAPACITY-LOAD",
                  label: "工时记录",
                  fulfilled: false,
                },
              ],
            },
          ],
          materials: [
            {
              id: "M-1",
              requirementId,
              situationCode,
              status,
              title: "合成材料",
              note: "未核验",
              kind: "MANUAL_REFERENCE",
              locator: null,
              file: null,
              verification: {
                status: "UNVERIFIED",
                version: 0,
                verifiedBy: null,
                verifiedAt: null,
                note: "",
              },
              verificationEligible: false,
            },
          ],
        }),
      };
      const service = new IntegrationService(
        {} as never,
        {
          readSnapshot: (read: (value: typeof reader) => unknown) =>
            read(reader),
        } as never,
        {} as never,
      );
      const result = await service.materials(principal(), "PRJ-A");
      expect(result.gaps[0]).toMatchObject({
        requirementId: "REQ-CAPACITY-LOAD",
        availabilityVersion: version,
      });
      expect(reader.taskMaterials).toHaveBeenCalledTimes(1);
    },
  );

  it("filters the project list by the token-bound project allowlist", async () => {
    const vs01 = {
      projectList: vi
        .fn()
        .mockResolvedValue([
          project("PRJ-B", "RUNNING"),
          project("PRJ-A", "RUNNING"),
        ]),
    };
    const service = new IntegrationService(
      {} as never,
      vs01 as never,
      {} as never,
    );

    const result = await service.projects(principal());

    expect(result.items.map((item) => item.id)).toEqual(["PRJ-A"]);
    expect(result.currentProjectId).toBe("PRJ-A");
  });

  it("rejects an unlisted project before calling the context seam", async () => {
    const context = { currentWorkContext: vi.fn() };
    const service = new IntegrationService(
      context as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.projectContext(principal(), "PRJ-B"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(context.currentWorkContext).not.toHaveBeenCalled();
  });

  it("rejects tenant and missing workpaper scope before reading the workpaper", async () => {
    const vs01 = { rootCauseWorkpaper: vi.fn() };
    const service = new IntegrationService(
      {} as never,
      vs01 as never,
      {} as never,
    );
    await expect(
      service.validationWorkpaper(
        principal({ tenantId: "tenant-other" }),
        "PRJ-A",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.validationWorkpaper(
        principal({ scopes: ["project:read"] }),
        "PRJ-A",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(vs01.rootCauseWorkpaper).not.toHaveBeenCalled();
  });

  it("returns only work items owned by the authenticated employee role", async () => {
    const scopedProject = projectWithWork("PRJ-A", [
      workItem("PMC-READY", "PMC", "READY"),
      workItem("OWNER-REVIEW", "OWNER", "WAITING_REVIEW"),
    ]);
    const vs01 = { project: vi.fn().mockResolvedValue(scopedProject) };
    const service = new IntegrationService(
      {} as never,
      vs01 as never,
      {} as never,
    );

    const pmc = await service.workItems(principal(), "PRJ-A");
    const owner = await service.workItems(
      principal({ subjectId: "owner-1", role: "OWNER" }),
      "PRJ-A",
    );

    expect(pmc.items.map((item) => item.id)).toEqual(["PMC-READY"]);
    expect(owner.items.map((item) => item.id)).toEqual(["OWNER-REVIEW"]);
  });

  it("derives current project and work item from role-owned actionable work", async () => {
    const projects = [
      projectWithWork("PRJ-A", [
        workItem("OWNER-REVIEW", "OWNER", "WAITING_REVIEW"),
        workItem("OWNER-DONE", "OWNER", "DONE"),
      ]),
      projectWithWork("PRJ-B", [
        workItem("PMC-IN-PROGRESS", "PMC", "IN_PROGRESS"),
        workItem("PMC-DONE", "PMC", "DONE"),
      ]),
    ];
    const vs01 = {
      projectList: vi.fn().mockResolvedValue(projects),
      project: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(projects.find((item) => item.id === id)),
        ),
    };
    const service = new IntegrationService(
      {} as never,
      vs01 as never,
      {} as never,
    );
    const employee = principal({ projectIds: ["PRJ-A", "PRJ-B"] });

    const projectList = await service.projects(employee);
    const current = await service.currentWorkItem(employee);

    expect(projectList.currentProjectId).toBe("PRJ-B");
    expect(current).toMatchObject({
      projectId: "PRJ-B",
      item: { id: "PMC-IN-PROGRESS", owner: "PMC" },
    });
  });
});
