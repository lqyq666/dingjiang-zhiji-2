import { afterEach, describe, expect, it, vi } from "vitest";

import { DingjiangIntegrationClient, IntegrationClientError } from "./client";

const originalBaseUrl = process.env.DINGJIANG_API_BASE_URL;
const originalToken = process.env.DINGJIANG_MCP_API_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBaseUrl === undefined) delete process.env.DINGJIANG_API_BASE_URL;
  else process.env.DINGJIANG_API_BASE_URL = originalBaseUrl;
  if (originalToken === undefined) delete process.env.DINGJIANG_MCP_API_TOKEN;
  else process.env.DINGJIANG_MCP_API_TOKEN = originalToken;
});

describe("dingjiang-mcp Integration client", () => {
  it("treats WorkBuddy's unresolved token placeholder as missing", async () => {
    process.env.DINGJIANG_API_BASE_URL = "http://127.0.0.1:3001/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "${DINGJIANG_MCP_API_TOKEN}";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new DingjiangIntegrationClient().getProjectState("PRJ-1"),
    ).rejects.toThrow("DINGJIANG_MCP_API_TOKEN 未配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cleartext Integration API traffic outside loopback", async () => {
    process.env.DINGJIANG_API_BASE_URL = "http://example.com/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new DingjiangIntegrationClient().getProjectState("PRJ-1"),
    ).rejects.toThrow("仅允许 HTTPS /api，或本机 HTTP /api");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the safe Integration failure without exposing authorization", async () => {
    process.env.DINGJIANG_API_BASE_URL = "http://127.0.0.1:3001/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "local-secret";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "授权范围内未找到该资源",
            retryable: false,
            requiresHuman: false,
          },
          correlationId: "27a2f751-c719-4a81-a16b-fdaa4fc2c6fb",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await new DingjiangIntegrationClient()
      .getProjectState("PRJ-NOT-FOUND")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IntegrationClientError);
    expect(error).toMatchObject({ failure: { error: { code: "NOT_FOUND" } } });
    expect(JSON.stringify(error)).not.toContain("local-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "http://127.0.0.1:3001/api/integration/projects/PRJ-NOT-FOUND/state",
      ),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer local-secret",
        }),
      }),
    );
  });

  it("posts a governed workpaper Proposal with one server-bound token", async () => {
    process.env.DINGJIANG_API_BASE_URL = "http://127.0.0.1:3001/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "local-secret";
    const response = {
      requestId: "10000000-0000-4000-8000-000000000011",
      correlationId: "20000000-0000-4000-8000-000000000011",
      version: 1,
      replayed: false,
      data: {
        workpaperId: "WP-1",
        projectId: "PRJ-1",
        workItemId: "WI-1",
        status: "PROPOSAL",
        classification: "PROPOSAL",
        version: 1,
        locator: {
          sourceObjectId: "SO-1",
          sourceVersionId: "SV-1",
          reference: "根因核验工作底稿 v1",
        },
        createdBy: "pmc-1",
        createdAt: "2026-08-28T13:00:00.000Z",
        audit: {
          requestId: "10000000-0000-4000-8000-000000000011",
          eventType: "WORKPAPER_PROPOSED",
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: response,
          correlationId: response.correlationId,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      requestId: response.requestId,
      expectedVersion: 0,
      reason: "记录根因核验 Proposal",
      correlationId: response.correlationId,
      payload: {
        proposalType: "ROOT_CAUSE_VALIDATION" as const,
        summary: "订单延期可能与产能负荷有关",
        reasoning: "Evidence 与材料提示风险，仍需人工确认。",
        evidenceFindings: [
          { evidenceId: "E-1", assertion: "预测交期晚于承诺交期" },
        ],
        materialFindings: [
          {
            materialId: "M-1",
            assertion: "材料提示负荷风险",
            assessment: "INCONCLUSIVE" as const,
            note: "统计口径待核验",
          },
        ],
        experienceReferences: [],
        assumptions: ["统计周期一致"],
        missingInformation: ["缺少班次工时"],
        limitations: "该 Proposal 不表示根因已确认。",
      },
    };
    await expect(
      new DingjiangIntegrationClient().proposeWorkpaper("PRJ-1", request),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "http://127.0.0.1:3001/api/integration/projects/PRJ-1/workpaper/proposals",
      ),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(
      JSON.stringify(await fetchMock.mock.results[0]?.value),
    ).not.toContain("local-secret");
  });
});
