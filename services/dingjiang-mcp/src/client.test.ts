import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  DingjiangIntegrationClient,
  IntegrationClientError,
  IntegrationTransportError,
  resolveTimeoutMs,
} from "./client";

const originalBaseUrl = process.env.DINGJIANG_API_BASE_URL;
const originalToken = process.env.DINGJIANG_MCP_API_TOKEN;
const originalAllowedHosts = process.env.DINGJIANG_API_ALLOWED_HOSTS;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBaseUrl === undefined) delete process.env.DINGJIANG_API_BASE_URL;
  else process.env.DINGJIANG_API_BASE_URL = originalBaseUrl;
  if (originalToken === undefined) delete process.env.DINGJIANG_MCP_API_TOKEN;
  else process.env.DINGJIANG_MCP_API_TOKEN = originalToken;
  if (originalAllowedHosts === undefined)
    delete process.env.DINGJIANG_API_ALLOWED_HOSTS;
  else process.env.DINGJIANG_API_ALLOWED_HOSTS = originalAllowedHosts;
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

  it("revalidates when the host allowlist narrows without a URL change", async () => {
    process.env.DINGJIANG_API_BASE_URL = "https://api.example.com/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "local-secret";
    delete process.env.DINGJIANG_API_ALLOWED_HOSTS;
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
    const client = new DingjiangIntegrationClient();

    // Empty allowlist: the URL passes validation and is cached.
    await expect(client.getProjectState("PRJ-1")).rejects.toBeInstanceOf(
      IntegrationClientError,
    );

    // The URL did not change, but the allowed host did. Reusing the cached
    // result would keep sending the bearer token to a host that is no longer
    // allowed.
    process.env.DINGJIANG_API_ALLOWED_HOSTS = "other.example.com";
    await expect(client.getProjectState("PRJ-1")).rejects.toThrow(
      "不在 DINGJIANG_API_ALLOWED_HOSTS 白名单内",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("dingjiang-mcp transport classification", () => {
  const originalTimeout = process.env.DINGJIANG_MCP_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined)
      delete process.env.DINGJIANG_MCP_TIMEOUT_MS;
    else process.env.DINGJIANG_MCP_TIMEOUT_MS = originalTimeout;
  });

  const useLoopback = () => {
    process.env.DINGJIANG_API_BASE_URL = "http://127.0.0.1:3001/api";
    process.env.DINGJIANG_MCP_API_TOKEN = "local-secret";
  };

  it("classifies timeouts and forbids requestId-swapped retries", async () => {
    useLoopback();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("timed out"), { name: "TimeoutError" }),
        ),
    );
    const error = await new DingjiangIntegrationClient()
      .getProjectState("PRJ-1")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IntegrationTransportError);
    expect(error).toMatchObject({ code: "INTEGRATION_TIMEOUT" });
    expect((error as Error).message).toContain("不得改 requestId 重试");
    expect(JSON.stringify(error)).not.toContain("local-secret");
  });

  it("classifies an unreachable API as a network error", async () => {
    useLoopback();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      new DingjiangIntegrationClient().getProjectState("PRJ-1"),
    ).rejects.toMatchObject({
      name: "IntegrationTransportError",
      code: "INTEGRATION_NETWORK_ERROR",
    });
  });

  it("rejects non-JSON gateway responses with their HTTP status", async () => {
    useLoopback();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>bad gateway</html>", { status: 502 }),
        ),
    );
    const error = await new DingjiangIntegrationClient()
      .getProjectState("PRJ-1")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IntegrationTransportError);
    expect(error).toMatchObject({ code: "INTEGRATION_INVALID_RESPONSE" });
    expect((error as Error).message).toContain("502");
  });

  it("does not mistake a contract-mismatched success payload for invalid caller input", async () => {
    useLoopback();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { unexpected: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const error = await new DingjiangIntegrationClient()
      .getProjectState("PRJ-1")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IntegrationTransportError);
    expect(error).toMatchObject({ code: "INTEGRATION_INVALID_RESPONSE" });
  });

  it("revalidates the base URL when the environment changes", async () => {
    useLoopback();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
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
      ),
    );
    await expect(
      new DingjiangIntegrationClient().getProjectState("PRJ-1"),
    ).rejects.toBeInstanceOf(IntegrationClientError);

    process.env.DINGJIANG_API_BASE_URL = "http://example.com/api";
    await expect(
      new DingjiangIntegrationClient().getProjectState("PRJ-1"),
    ).rejects.toThrow("仅允许 HTTPS /api");
  });
});

describe("resolveTimeoutMs", () => {
  it("keeps the default for missing or invalid values and clamps configuration", () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("abc")).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("-5")).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs("250")).toBe(250);
    expect(resolveTimeoutMs("1")).toBe(100);
    expect(resolveTimeoutMs("999999")).toBe(120_000);
  });
});
