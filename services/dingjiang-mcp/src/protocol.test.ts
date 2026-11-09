import { describe, expect, it, vi } from "vitest";

import {
  createMcpHandler,
  dingjiangCompatibilityTools,
  dingjiangTools,
  latestProtocolVersion,
  type IntegrationClient,
  type ToolDescriptor,
} from "./protocol";
import { IntegrationClientError, IntegrationTransportError } from "./client";

const client = (): IntegrationClient => ({
  listEvents: vi.fn().mockResolvedValue({ items: [] }),
  getExecutionContext: vi
    .fn()
    .mockResolvedValue({ version: 0, allowedActions: [] }),
  executeWork: vi.fn().mockResolvedValue({ version: 1, replayed: false }),
  verifyMaterial: vi.fn().mockResolvedValue({ version: 1 }),
  confirmEvidence: vi.fn().mockResolvedValue({ version: 1 }),
  getEvidenceProposals: vi.fn().mockResolvedValue([]),
  listProjects: vi
    .fn()
    .mockResolvedValue({ items: [], currentProjectId: null }),
  getCurrentProject: vi.fn().mockResolvedValue({ id: "PRJ-1" }),
  getProjectContext: vi.fn().mockResolvedValue({ project: { id: "PRJ-1" } }),
  getProjectState: vi.fn().mockResolvedValue({ id: "PRJ-1" }),
  getCurrentWorkItem: vi
    .fn()
    .mockResolvedValue({ projectId: "PRJ-1", item: null }),
  listProjectWorkItems: vi
    .fn()
    .mockResolvedValue({ projectId: "PRJ-1", items: [] }),
  listEvidence: vi.fn().mockResolvedValue({ items: [] }),
  getEvidence: vi.fn().mockResolvedValue({ item: { id: "E-1" } }),
  listTraceableMaterials: vi.fn().mockResolvedValue({
    items: [
      {
        id: "M-1",
        verification: {
          status: "VERIFIED",
          version: 1,
          note: "PMC 已核验",
          verifiedBy: "human-pmc",
          verifiedAt: "2026-08-29T04:00:00.000Z",
        },
        verificationStatus: "VERIFIED",
        latestVerificationAudit: {
          eventType: "MATERIAL_VERIFIED",
          version: 1,
          actor: "human-pmc",
          note: "PMC 已核验",
          occurredAt: "2026-08-29T04:00:00.000Z",
        },
      },
    ],
    gaps: [],
  }),
  getMaterialPreview: vi.fn().mockResolvedValue({
    material: {
      id: "M-1",
      verificationStatus: "VERIFIED",
      latestVerificationAudit: {
        eventType: "MATERIAL_VERIFIED",
        version: 1,
        actor: "human-pmc",
        note: "PMC 已核验",
        occurredAt: "2026-08-29T04:00:00.000Z",
      },
    },
  }),
  getSourceVersion: vi
    .fn()
    .mockResolvedValue({ locator: { sourceVersionId: "SV-1" } }),
  getValidationWorkpaper: vi.fn().mockResolvedValue({ id: "WP-1" }),
  searchFormalExperiences: vi.fn().mockResolvedValue({ query: "", items: [] }),
  getFormalExperience: vi.fn().mockResolvedValue({ id: "EXP-1" }),
  getExperienceEvidence: vi.fn().mockResolvedValue({ experienceId: "EXP-1" }),
  proposeWorkpaper: vi.fn().mockResolvedValue({
    version: 1,
    replayed: false,
    data: { status: "PROPOSAL" },
  }),
  createMaterial: vi.fn().mockResolvedValue({
    version: 1,
    replayed: false,
    data: { verificationStatus: "UNVERIFIED" },
  }),
  proposeEvidence: vi.fn().mockResolvedValue({
    version: 1,
    replayed: false,
    data: { status: "PROPOSAL", proposalId: "EVP-1" },
  }),
});

describe("dingjiang-mcp protocol", () => {
  it("publishes governed operation tools alongside the read facade", async () => {
    const response = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(dingjiangTools.map((tool) => tool.name)).toEqual([
      "workspace.events",
      "work.operations",
      "work.execute",
      "material.verify",
      "evidence.confirm",
      "workspace.resume",
      "work.context",
      "evidence.bundle",
      "experience.search",
      "project.next_action",
      "workpaper.propose",
      "material.create",
      "evidence.propose",
    ]);
    expect(dingjiangCompatibilityTools).toHaveLength(23);
    expect(
      dingjiangTools.every(
        (tool) => tool.inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(response && "result" in response).toBe(true);
    if (!response || !("result" in response))
      throw new Error("缺少 tools/list 结果");
    expect((response.result as { tools: unknown[] }).tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "workspace.resume" }),
      ]),
    );
    expect(
      JSON.stringify(dingjiangTools.map((tool) => tool.inputSchema)),
    ).not.toMatch(/"(?:sql|shell|filePath|url)"/i);
    expect(
      dingjiangTools.find((tool) => tool.name === "evidence.bundle")
        ?.description,
    ).toContain("SourceVersion");
  });

  it("dispatches an explicit governed action and returns its receipt without retrying", async () => {
    const integration = client();
    const input = {
      projectId: "PRJ-1",
      requestId: "10000000-0000-4000-8000-000000000001",
      correlationId: "20000000-0000-4000-8000-000000000001",
      expectedVersion: 0,
      reason: "按用户要求记录进展",
      payload: {
        stateFingerprint: "a".repeat(64),
        confirmation: "请记录本次处理进展",
        operation: {
          action: "progress.record",
          workItemId: "WI-1",
          note: "已核对原始记录",
          outputReference: "",
        },
      },
    };
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "work.execute", arguments: input },
    });
    const { projectId, ...request } = input;
    expect(integration.executeWork).toHaveBeenCalledExactlyOnceWith(
      projectId,
      request,
    );
    expect(response).toMatchObject({
      result: { structuredContent: { version: 1, replayed: false } },
    });
    const invalid = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "work.execute", arguments: { ...input, role: "OWNER" } },
    });
    expect(invalid).toMatchObject({ result: { isError: true } });
    expect(integration.executeWork).toHaveBeenCalledTimes(1);
  });

  it("aggregates a complete workspace facade without widening write access", async () => {
    const integration = client();
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "workspace-resume",
      method: "tools/call",
      params: { name: "workspace.resume", arguments: {} },
    });
    expect(response).toMatchObject({
      result: {
        structuredContent: {
          projectId: "PRJ-1",
          nextAction: { kind: "HUMAN_GATE_OR_REVIEW" },
        },
      },
    });
    expect(integration.getProjectContext).toHaveBeenCalledWith("PRJ-1");
    expect(integration.listEvidence).toHaveBeenCalledWith("PRJ-1");
    expect(integration.proposeWorkpaper).not.toHaveBeenCalled();
    expect(integration.createMaterial).not.toHaveBeenCalled();
    expect(integration.proposeEvidence).not.toHaveBeenCalled();
  });

  it("exposes individual read tools through compatibility mode", async () => {
    const previous = process.env.DINGJIANG_MCP_TOOL_SURFACE;
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    try {
      const response = await createMcpHandler(client())({
        jsonrpc: "2.0",
        id: "compatibility-list",
        method: "tools/list",
      });
      expect(response && "result" in response).toBe(true);
      if (!response || !("result" in response))
        throw new Error("缺少兼容工具面");
      expect((response.result as { tools: unknown[] }).tools).toHaveLength(23);
    } finally {
      if (previous === undefined) delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
      else process.env.DINGJIANG_MCP_TOOL_SURFACE = previous;
    }
  });

  it("fails closed when current project and current work item drift", async () => {
    const integration = client();
    vi.mocked(integration.getCurrentWorkItem).mockResolvedValue({
      projectId: "PRJ-OTHER",
      item: null,
    });
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "workspace-drift",
      method: "tools/call",
      params: { name: "workspace.resume", arguments: {} },
    });
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining("当前项目与当前事项不一致"),
          }),
        ],
        structuredContent: { code: "CONTEXT_DRIFT" },
      },
    });
  });

  it("does not leak an arbitrary exception message to the host", async () => {
    const integration = client();
    vi.mocked(integration.listEvents).mockRejectedValue(
      new Error("ENOENT: /home/operator/secret/internal-path"),
    );
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "leak-check",
      method: "tools/call",
      params: { name: "workspace.events", arguments: {} },
    });
    const result = (
      response as {
        result: {
          content: Array<{ text: string }>;
          structuredContent?: { code?: string };
        };
      }
    ).result;
    expect(result.content[0]?.text ?? "").not.toContain("/home/operator");
    expect(result.structuredContent?.code).toBe("TOOL_UNAVAILABLE");
  });

  it("returns a structured code when the tool is unknown", async () => {
    const response = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: "unknown-tool",
      method: "tools/call",
      params: { name: "nope.nope", arguments: {} },
    });
    const result = (
      response as {
        result: { isError: boolean; structuredContent?: { code?: string } };
      }
    ).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("UNKNOWN_TOOL");
  });

  it("keeps the first handshake when a client initializes twice", async () => {
    const handler = createMcpHandler(client());
    const revisionOf = (response: unknown) =>
      (response as { result: { protocolVersion: string } }).result
        .protocolVersion;

    const first = await handler({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: latestProtocolVersion },
    });
    const second = await handler({
      jsonrpc: "2.0",
      id: "init-2",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(revisionOf(first)).toBe(latestProtocolVersion);
    // A second handshake must not change what the session was promised.
    expect(revisionOf(second)).toBe(latestProtocolVersion);

    const listed = await handler({
      jsonrpc: "2.0",
      id: "list-after-reinit",
      method: "tools/list",
    });
    const tools = (listed as { result: { tools: ToolDescriptor[] } }).result
      .tools;
    expect(tools.some((tool) => tool.outputSchema)).toBe(true);
  });

  it("routes strict evidence.propose and rejects privilege or locator injection", async () => {
    const integration = client();
    const arguments_ = {
      projectId: "PRJ-1",
      requestId: "50000000-0000-4000-8000-000000000011",
      expectedVersion: 0,
      reason: "登记 Evidence Proposal",
      correlationId: "60000000-0000-4000-8000-000000000011",
      payload: {
        workItemId: "SUB-1",
        materialId: "M-1",
        claim: "fixture 产线负荷率为 82%。",
        evidenceType: "METRIC",
        sourceObjectId: "SRC-M-1",
        sourceVersionId: "SRC-M-1-V1",
        exactSpan: {
          kind: "TEXT_SPAN",
          start: 0,
          end: 13,
          exactText: "测试产线负荷率为 82%。",
        },
        reasoning: "原文直接给出该指标。",
        limitations: "仅用于 NON_PRODUCTION fixture。",
      },
    };
    const handler = createMcpHandler(integration);
    const response = await handler({
      jsonrpc: "2.0",
      id: "evidence-propose-1",
      method: "tools/call",
      params: { name: "evidence.propose", arguments: arguments_ },
    });
    expect(integration.proposeEvidence).toHaveBeenCalledWith(
      "PRJ-1",
      expect.objectContaining({ requestId: arguments_.requestId }),
    );
    expect(response).toMatchObject({
      result: { structuredContent: { data: { status: "PROPOSAL" } } },
    });
    for (const [key, value] of [
      ["tenantId", "tenant-other"],
      ["role", "OWNER"],
      ["scopes", ["*"]],
      ["reference", "C:\\secret.txt"],
      ["url", "https://example.test"],
      ["path", "C:\\secret.txt"],
      ["sql", "select 1"],
      ["shell", "whoami"],
    ] as const) {
      const rejected = await handler({
        jsonrpc: "2.0",
        id: `evidence-inject-${key}`,
        method: "tools/call",
        params: {
          name: "evidence.propose",
          arguments: {
            ...arguments_,
            payload: { ...arguments_.payload, [key]: value },
          },
        },
      });
      expect(rejected).toMatchObject({ result: { isError: true } });
    }
    expect(integration.proposeEvidence).toHaveBeenCalledTimes(1);
  });

  it("returns a machine-readable stale-session error when disk identity changes", async () => {
    const response = await createMcpHandler(client(), {
      startup: "commit-old",
      current: () => "commit-new",
    })({ jsonrpc: "2.0", id: "stale-1", method: "tools/list" });
    expect(response).toMatchObject({
      error: {
        data: {
          code: "SESSION_MCP_PROCESS_STALE",
          startupBuildIdentity: "commit-old",
          deployedBuildIdentity: "commit-new",
        },
      },
    });
  });

  it("routes strict material.create and rejects privilege, path, URL and storage injection", async () => {
    const integration = client();
    const arguments_ = {
      projectId: "PRJ-1",
      requestId: "30000000-0000-4000-8000-000000000011",
      expectedVersion: 0,
      reason: "登记待核验产能材料",
      correlationId: "40000000-0000-4000-8000-000000000011",
      payload: {
        workItemId: "SUB-1",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        materialType: "CONTROLLED_TEXT",
        displayName: "产能负荷说明",
        sourceMetadata: {
          sourceType: "HUMAN_PROVIDED",
          sourceName: "PMC 核验记录",
        },
        safeSummary: "待核验的产能负荷摘要",
        controlledTextContent: "当前统计周期仍需负责人复核。",
      },
    };
    const handler = createMcpHandler(integration);
    const response = await handler({
      jsonrpc: "2.0",
      id: "material-1",
      method: "tools/call",
      params: { name: "material.create", arguments: arguments_ },
    });
    expect(integration.createMaterial).toHaveBeenCalledWith(
      "PRJ-1",
      expect.objectContaining({ requestId: arguments_.requestId }),
    );
    expect(response).toMatchObject({
      result: {
        structuredContent: { data: { verificationStatus: "UNVERIFIED" } },
      },
    });
    for (const [key, value] of [
      ["tenantId", "tenant-other"],
      ["role", "OWNER"],
      ["scopes", ["*"]],
      ["filePath", "C:\\secret.txt"],
      ["url", "https://example.test"],
      ["storageKey", "vault/private"],
      ["rawBytes", "AAEC"],
      ["sql", "select 1"],
      ["shell", "whoami"],
    ] as const) {
      const rejected = await handler({
        jsonrpc: "2.0",
        id: `material-inject-${key}`,
        method: "tools/call",
        params: {
          name: "material.create",
          arguments: { ...arguments_, [key]: value },
        },
      });
      expect(rejected).toMatchObject({ result: { isError: true } });
    }
    expect(integration.createMaterial).toHaveBeenCalledTimes(1);
  });

  it("routes a strict workpaper.propose command without accepting identity or locators", async () => {
    const integration = client();
    const arguments_ = {
      projectId: "PRJ-1",
      requestId: "10000000-0000-4000-8000-000000000011",
      expectedVersion: 0,
      reason: "记录根因核验 Proposal",
      correlationId: "20000000-0000-4000-8000-000000000011",
      payload: {
        proposalType: "ROOT_CAUSE_VALIDATION",
        summary: "订单延期可能与产能负荷有关",
        reasoning: "Evidence 与材料提示风险，仍需人工确认。",
        evidenceFindings: [
          { evidenceId: "E-1", assertion: "预测交期晚于承诺交期" },
        ],
        materialFindings: [
          {
            materialId: "M-1",
            assertion: "材料提示负荷风险",
            assessment: "INCONCLUSIVE",
            note: "统计口径待核验",
          },
        ],
        experienceReferences: [],
        assumptions: ["统计周期一致"],
        missingInformation: ["缺少班次工时"],
        limitations: "该 Proposal 不表示根因已确认。",
      },
    };
    const handler = createMcpHandler(integration);
    const response = await handler({
      jsonrpc: "2.0",
      id: "propose-1",
      method: "tools/call",
      params: { name: "workpaper.propose", arguments: arguments_ },
    });
    expect(integration.proposeWorkpaper).toHaveBeenCalledWith(
      "PRJ-1",
      expect.objectContaining({ requestId: arguments_.requestId }),
    );
    expect(response).toMatchObject({
      result: { structuredContent: { data: { status: "PROPOSAL" } } },
    });

    for (const [key, value] of [
      ["tenantId", "tenant-other"],
      ["role", "OWNER"],
      ["scopes", ["*"]],
      ["locator", { sourceVersionId: "SV-OTHER" }],
      ["sql", "select 1"],
      ["shell", "whoami"],
      ["url", "https://example.test"],
      ["filePath", "C:\\secret.txt"],
    ] as const) {
      const rejected = await handler({
        jsonrpc: "2.0",
        id: `propose-inject-${key}`,
        method: "tools/call",
        params: {
          name: "workpaper.propose",
          arguments: { ...arguments_, [key]: value },
        },
      });
      expect(rejected).toMatchObject({ result: { isError: true } });
    }
    expect(integration.proposeWorkpaper).toHaveBeenCalledTimes(1);
  });

  it("routes a strict project tool call through the Integration client", async () => {
    const integration = client();
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "get_project_state",
        arguments: { projectId: "PRJ-1" },
        _meta: { progressToken: "workbuddy-call-1" },
      },
    });
    expect(integration.getProjectState).toHaveBeenCalledWith("PRJ-1");
    expect(response).toMatchObject({
      result: { structuredContent: { id: "PRJ-1" } },
    });
  });

  it("returns the human verification projection through the existing read tool", async () => {
    const response = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: "material-read-1",
      method: "tools/call",
      params: {
        name: "list_traceable_materials",
        arguments: { projectId: "PRJ-1" },
      },
    });
    expect(response).toMatchObject({
      result: {
        structuredContent: {
          items: [
            expect.objectContaining({
              id: "M-1",
              verification: expect.objectContaining({
                status: "VERIFIED",
                version: 1,
              }),
              verificationStatus: "VERIFIED",
              latestVerificationAudit: expect.objectContaining({
                eventType: "MATERIAL_VERIFIED",
                actor: "human-pmc",
              }),
            }),
          ],
        },
      },
    });
    const preview = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: "material-preview-1",
      method: "tools/call",
      params: {
        name: "get_material_preview",
        arguments: { projectId: "PRJ-1", materialId: "M-1" },
      },
    });
    expect(preview).toMatchObject({
      result: {
        structuredContent: {
          material: {
            verificationStatus: "VERIFIED",
            latestVerificationAudit: {
              eventType: "MATERIAL_VERIFIED",
              actor: "human-pmc",
            },
          },
        },
      },
    });
  });

  it("rejects caller-supplied authorization scope and unknown tools", async () => {
    const integration = client();
    const handler = createMcpHandler(integration);
    const scoped = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_project_context",
        arguments: { projectId: "PRJ-1", tenantId: "tenant-other" },
      },
    });
    const unknown = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_sql", arguments: { sql: "select 1" } },
    });
    expect(scoped).toMatchObject({ result: { isError: true } });
    expect(unknown).toMatchObject({ result: { isError: true } });
    expect(integration.getProjectContext).not.toHaveBeenCalled();
  });

  it.each([
    ["tenantId", "tenant-other"],
    ["subjectId", "owner-1"],
    ["role", "OWNER"],
    ["scopes", ["*"]],
    ["projectIds", ["*"]],
    ["sql", "select 1"],
    ["shell", "whoami"],
    ["url", "https://example.test"],
    ["filePath", "C:\\secret.txt"],
  ])(
    "rejects MCP privilege or capability injection through %s",
    async (key, value) => {
      const integration = client();
      const response = await createMcpHandler(integration)({
        jsonrpc: "2.0",
        id: `inject-${key}`,
        method: "tools/call",
        params: {
          name: "get_project_context",
          arguments: { projectId: "PRJ-1", [key]: value },
        },
      });
      expect(response).toMatchObject({ result: { isError: true } });
      expect(integration.getProjectContext).not.toHaveBeenCalled();
    },
  );
});

describe("dingjiang-mcp transport error surface", () => {
  it("classifies transport failures separately from caller input errors", async () => {
    const integration = client();
    integration.getProjectState = vi
      .fn()
      .mockRejectedValue(
        new IntegrationTransportError(
          "INTEGRATION_TIMEOUT",
          "Integration API 请求超时；不得改 requestId 重试",
        ),
      );
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "transport-timeout",
      method: "tools/call",
      params: { name: "get_project_state", arguments: { projectId: "PRJ-1" } },
    });
    expect(response).toMatchObject({ result: { isError: true } });
    const result = (
      response as { result?: { content?: Array<{ text?: string }> } }
    ).result;
    const payload = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      code: "INTEGRATION_TIMEOUT",
      retryable: false,
      requiresHuman: true,
    });
    const text = JSON.stringify(response);
    expect(text).not.toContain("TOOL_UNAVAILABLE");
    expect(text).not.toContain("INVALID_REQUEST");
  });
});

describe("dingjiang-mcp optional constituents", () => {
  const failure = (code: "NOT_FOUND" | "FORBIDDEN") => ({
    ok: false as const,
    error: {
      code,
      message: "授权范围内未找到该资源",
      retryable: false,
      requiresHuman: false,
    },
    correlationId: "6f1c2f7e-1111-4222-8333-444455556666",
  });

  const callResume = async (integration: IntegrationClient) => {
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: "resume",
      method: "tools/call",
      params: { name: "workspace.resume", arguments: {} },
    });
    const result = (
      response as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }
    ).result;
    return {
      isError: Boolean(result?.isError),
      payload: JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<
        string,
        unknown
      >,
    };
  };

  it("resumes a project that has no workpaper yet instead of failing", async () => {
    const integration = client();
    integration.getValidationWorkpaper = vi
      .fn()
      .mockRejectedValue(new IntegrationClientError(failure("NOT_FOUND")));
    const resumed = await callResume(integration);
    // A freshly created project has no workpaper. The aggregate must report
    // its absence, not collapse: resume is needed most at that moment.
    expect(resumed.isError).toBe(false);
    expect(resumed.payload.workpaper).toBeNull();
    expect(resumed.payload.projectId).toBe("PRJ-1");
  });

  it("still fails closed when the constituent is forbidden", async () => {
    const integration = client();
    integration.getValidationWorkpaper = vi
      .fn()
      .mockRejectedValue(new IntegrationClientError(failure("FORBIDDEN")));
    const resumed = await callResume(integration);
    // A missing scope must not be reported as "no workpaper yet".
    expect(resumed.isError).toBe(true);
    expect(resumed.payload.code).toBe("FORBIDDEN");
  });
});
