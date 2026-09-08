import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadTaskMaterial,
  reviewEvidenceProposal,
  taskMaterialImportFormData,
  verifyTaskMaterial,
} from "./vs01-api";

describe("VS15 material import request seam", () => {
  it("sends only frozen multipart fields and the file body", () => {
    const file = new File(["订单号,负荷\nSO-136,92%"], "产线负荷.csv", {
      type: "text/csv",
    });
    const body = taskMaterialImportFormData(
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "关键产线负荷记录",
        note: "8 月 12 日至 15 日的班次负荷",
        requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
      },
      file,
    );

    expect([...body.keys()].sort()).toEqual(
      [
        "actor",
        "file",
        "note",
        "requestId",
        "requirementId",
        "situationCode",
        "title",
      ].sort(),
    );
    expect(body.get("requestId")).toBe("3b241101-e2bb-4255-8caf-4136c566a962");
    expect((body.get("file") as File).name).toBe("产线负荷.csv");
  });

  it("rejects client-controlled scope fields before the request is sent", () => {
    expect(() =>
      taskMaterialImportFormData(
        {
          actor: "PMC",
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          title: "关键产线负荷记录",
          note: "",
          requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
          tenantId: "tenant-other",
        } as never,
        new File(["x"], "test.txt", { type: "text/plain" }),
      ),
    ).toThrow();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("downloads through the role-authorized blob seam without a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("csv bytes", {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="load.csv"' },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const download = await downloadTaskMaterial("SO-202608136", "MAT-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/vs01/tasks/SO-202608136/materials/MAT-1/content",
      ),
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-vs01-role": "PMC" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(download.fileName).toBe("load.csv");
    expect(download.blob.size).toBeGreaterThan(0);
  });

  it("surfaces a non-200 download response as an actionable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "材料已停用，无法下载" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(downloadTaskMaterial("SO-202608136", "MAT-1")).rejects.toThrow(
      "材料已停用，无法下载",
    );
  });

  it("submits one strict PMC human verification command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "SO-1",
          status: "DECIDED",
          order: {},
          facts: [],
          analysis: {},
          evidence: [],
          situations: [],
          materials: [],
          experienceReferences: [],
          experienceReferenceAuditTrail: [],
          decision: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      verifyTaskMaterial("PRJ-1", "42", {
        requestId: "50000000-0000-4000-8000-000000000001",
        expectedVersion: 0,
        reason: "PMC 人工核验材料来源与用途",
        correlationId: "60000000-0000-4000-8000-000000000001",
        payload: {
          materialId: "42",
          decision: "VERIFIED",
          verificationNote: "已核对原始记录，当前版本可进入后续证据流程。",
        },
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs01/projects/PRJ-1/materials/42/verification"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-vs01-role": "PMC" }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toMatch(
      /tenantId|actor|subjectId|scope|filePath|storageKey/,
    );
  });

  it("submits Evidence confirmation through the human-only Web seam", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: "71000000-0000-4000-8000-000000000001",
          correlationId: "72000000-0000-4000-8000-000000000001",
          version: 1,
          replayed: false,
          data: {
            proposalId: "EVP-1",
            evidenceId: "E-MATERIAL-1",
            projectId: "PRJ-1",
            decision: "CONFIRMED",
            version: 1,
            reviewedBy: "human-pmc-web",
            reviewedAt: "2026-08-29T06:00:00.000Z",
            audit: {
              requestId: "71000000-0000-4000-8000-000000000001",
              eventType: "EVIDENCE_CONFIRMED",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await reviewEvidenceProposal("PRJ-1", "EVP-1", {
      requestId: "71000000-0000-4000-8000-000000000001",
      expectedVersion: 0,
      reason: "PMC 核对 claim、来源与限制",
      correlationId: "72000000-0000-4000-8000-000000000001",
      payload: {
        proposalId: "EVP-1",
        decision: "CONFIRMED",
        reviewNote: "已逐字核对 exact span 与不可覆盖来源版本。",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/vs01/projects/PRJ-1/evidence/proposals/EVP-1/review",
      ),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-vs01-role": "PMC" }),
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toMatch(
      /tenantId|actor|subjectId|scope|filePath|storageKey/,
    );
  });
});
