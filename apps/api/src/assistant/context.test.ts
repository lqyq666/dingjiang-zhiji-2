import { describe, expect, it, vi } from "vitest";

import { Vs01ContextAdapter } from "./context";

const scope = {
  tenantId: "tenant-demo",
  subjectId: "demo-pmc",
  role: "PMC" as const,
  projectId: "PRJ-OTD-001",
  sourceTaskId: "SO-202608136",
  policyVersion: "VS12-1" as const,
};

const project = {
  id: "PRJ-OTD-001",
  sourceTaskId: "SO-202608136",
  name: "交付改善",
  status: "RUNNING",
  progress: 29,
  phases: [
    {
      code: "ROOT_CAUSE_VALIDATION",
      status: "IN_PROGRESS",
      tasks: [{ origin: "LIVE", owner: "PMC" }],
    },
  ],
  outcome: {},
  experienceCandidate: null,
  auditTrail: [],
};

const task = {
  id: "SO-202608136",
  status: "DECIDED",
  facts: [{ label: "产能负荷", value: "92%", evidenceId: "E-CAPACITY" }],
  evidence: [{ id: "E-CAPACITY", classification: "FACT" }],
  situations: [
    {
      code: "CAPACITY_RISK",
      state: "UNVERIFIED",
      requirements: [
        {
          id: "REQ-CAPACITY-LOAD",
          label: "产能负荷与工时记录",
          fulfilled: false,
        },
      ],
    },
  ],
  materials: [
    {
      id: "MAT-PDF",
      status: "ACTIVE",
      title: "产能负荷报告",
      requirementId: "REQ-CAPACITY-LOAD",
      verification: {
        status: "NEEDS_REVISION",
        version: 1,
        note: "需补充产能负荷记录",
        verifiedBy: "human-pmc-web",
        verifiedAt: "2026-08-29T04:31:00.000Z",
      },
      verificationEligible: true,
      file: {
        extractionStatus: "NEEDS_REVIEW",
        readableByAi: false,
        contentPreview: null,
      },
    },
  ],
};

describe("VS16 assistant context material seam", () => {
  it("adds the current task's facts, material gaps, and latest confirmed workpaper without writing state", async () => {
    const vs01 = {
      project: vi.fn().mockResolvedValue(project),
      task: vi.fn().mockResolvedValue(task),
      rootCauseWorkpaper: vi.fn().mockResolvedValue({
        latestConfirmed: {
          revision: 3,
          content: {
            conclusion: { result: "SUPPORTS", statement: "产能负荷影响交期" },
          },
          locator: {
            sourceObjectId: "SRC-WP",
            sourceVersionId: "SRC-WP-V3",
            reference: "根因核验工作底稿 v3",
          },
          createdAt: "2026-08-21T00:00:00.000Z",
          requestedBy: "PMC",
        },
      }),
    };
    const adapter = new Vs01ContextAdapter(vs01 as never, {} as never);

    const result = await adapter.currentWorkContext(scope);

    expect(result).toMatchObject({
      status: "OK",
      data: {
        sourceTask: {
          facts: [{ evidenceId: "E-CAPACITY" }],
          materialGaps: [{ requirementId: "REQ-CAPACITY-LOAD" }],
          materials: [
            expect.objectContaining({
              id: "MAT-PDF",
              verificationStatus: "NEEDS_REVISION",
              latestVerificationAudit: {
                eventType: "MATERIAL_REVISION_REQUESTED",
                version: 1,
                actor: "human-pmc-web",
                note: "需补充产能负荷记录",
                occurredAt: "2026-08-29T04:31:00.000Z",
              },
            }),
          ],
        },
        project: {
          currentStage: { code: "ROOT_CAUSE_VALIDATION" },
          latestConfirmedWorkpaper: {
            revision: 3,
            conclusion: { result: "SUPPORTS" },
          },
        },
      },
    });
    expect(vs01.rootCauseWorkpaper).toHaveBeenCalledWith("PRJ-OTD-001");
  });

  it("withholds material bodies that are not readable or not extracted", async () => {
    const previewOf = async (
      readableByAi: boolean,
      extractionStatus: "EXTRACTED" | "NEEDS_REVIEW",
      contentPreview: string | null,
    ) => {
      const first = task.materials[0]!;
      const vs01 = {
        project: vi.fn().mockResolvedValue(project),
        task: vi.fn().mockResolvedValue({
          ...task,
          materials: [
            {
              ...first,
              file: {
                ...(first.file ?? {}),
                extractionStatus,
                readableByAi,
                contentPreview,
              },
            },
          ],
        }),
        rootCauseWorkpaper: vi
          .fn()
          .mockResolvedValue({ latestConfirmed: null }),
      };
      const result = await new Vs01ContextAdapter(
        vs01 as never,
        {} as never,
      ).currentWorkContext(scope);
      return (
        result as {
          data?: {
            sourceTask?: {
              materials?: Array<{ file?: { contentPreview?: string | null } }>;
            };
          };
        }
      ).data?.sourceTask?.materials?.[0]?.file?.contentPreview;
    };

    // A body must not leak just because extraction produced text.
    expect(await previewOf(false, "EXTRACTED", "不应外泄的正文")).toBeNull();
    // Readable but still under review: still no body.
    expect(await previewOf(true, "NEEDS_REVIEW", "尚未核验的正文")).toBeNull();
    // Readable and extracted: this is the only case that returns a body.
    expect(await previewOf(true, "EXTRACTED", "已核验正文")).toBe("已核验正文");
    // Blank text is not a body.
    expect(await previewOf(true, "EXTRACTED", "   ")).toBeNull();
  });

  it("does not disguise a live workpaper runtime failure as an absent workpaper", async () => {
    const vs01 = {
      project: vi.fn().mockResolvedValue(project),
      task: vi.fn().mockResolvedValue(task),
      rootCauseWorkpaper: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
    };
    const adapter = new Vs01ContextAdapter(vs01 as never, {} as never);

    await expect(adapter.currentWorkContext(scope)).rejects.toThrow(
      "database unavailable",
    );
  });

  it("returns BODY_NOT_AVAILABLE for an active material whose body was not parsed", async () => {
    const readModel = {
      projectSourceTaskId: vi.fn().mockResolvedValue(project.sourceTaskId),
      taskMaterials: vi.fn().mockResolvedValue(task),
    };
    const adapter = new Vs01ContextAdapter({ readModel } as never, {} as never);

    const result = await adapter.materialPreview(scope, {
      materialId: "MAT-PDF",
    });

    expect(result).toMatchObject({
      status: "BODY_NOT_AVAILABLE",
      data: {
        material: {
          id: "MAT-PDF",
          verificationStatus: "NEEDS_REVISION",
          latestVerificationAudit: {
            eventType: "MATERIAL_REVISION_REQUESTED",
            actor: "human-pmc-web",
          },
          file: { contentPreview: null },
        },
      },
    });
    expect(readModel.projectSourceTaskId).toHaveBeenCalledWith("PRJ-OTD-001");
    expect(readModel.taskMaterials).toHaveBeenCalledWith("SO-202608136");
  });

  it("returns a null latest audit for an unverified material", async () => {
    const unverifiedTask = {
      ...task,
      materials: [
        {
          ...task.materials[0],
          verification: {
            status: "UNVERIFIED",
            version: 0,
            note: "",
            verifiedBy: null,
            verifiedAt: null,
          },
        },
      ],
    };
    const adapter = new Vs01ContextAdapter(
      {
        readModel: {
          projectSourceTaskId: vi.fn().mockResolvedValue(project.sourceTaskId),
          taskMaterials: vi.fn().mockResolvedValue(unverifiedTask),
        },
      } as never,
      {} as never,
    );

    const result = await adapter.materialPreview(scope, {
      materialId: "MAT-PDF",
    });

    expect(result).toMatchObject({
      data: {
        material: {
          verificationStatus: "UNVERIFIED",
          latestVerificationAudit: null,
        },
      },
    });
  });

  it("refuses a scope whose source task does not match before reading materials", async () => {
    const readModel = {
      projectSourceTaskId: vi.fn().mockResolvedValue(project.sourceTaskId),
      taskMaterials: vi.fn(),
    };
    const adapter = new Vs01ContextAdapter({ readModel } as never, {} as never);

    const result = await adapter.materialPreview(
      { ...scope, sourceTaskId: "SO-OTHER" },
      { materialId: "MAT-PDF" },
    );

    expect(result).toEqual({ status: "FORBIDDEN" });
    expect(readModel.taskMaterials).not.toHaveBeenCalled();
  });
});
