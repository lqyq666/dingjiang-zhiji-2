import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpHandler,
  dingjiangCompatibilityTools,
  dingjiangTools,
  legacyProtocolVersion,
  type IntegrationClient,
  type ToolDescriptor,
} from "./protocol";
import {
  DingjiangIntegrationClient,
  IntegrationClientError,
  IntegrationTransportError,
} from "./client";

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

const locator = {
  sourceObjectId: "SO-1",
  sourceVersionId: "SV-1",
  reference: "fixture.csv#2",
};
const occurredAt = "2026-08-29T04:00:00.000Z";
const sourcePreview = "已核验的材料预览";
const evidenceFixture = {
  id: "E-1",
  sourceObjectId: locator.sourceObjectId,
  sourceVersionId: locator.sourceVersionId,
  sourceFile: "fixture.csv",
  sourceSheet: "Sheet1",
  sourceRow: 2,
  fields: { value: "按时交付" },
  classification: "FACT" as const,
  exactSpan: {
    kind: "TEXT_SPAN" as const,
    start: 0,
    end: 4,
    exactText: "按时交付",
  },
};
const workItemFixture = {
  id: "WI-1",
  projectId: "PRJ-1",
  phaseCode: "BASELINE_FACTS",
  phaseName: "核对事实",
  title: "核对交付记录",
  purpose: "确认交付情况",
  owner: "PMC",
  origin: "LIVE",
  status: "READY",
  inputs: [],
  process: [],
  output: { expected: "交付记录", reference: null, locator: null },
  acceptance: ["核对来源记录"],
  progressUpdate: null,
  completionConfirmation: null,
  completionNote: "",
  completedAt: null,
  sourceRecordedAt: null,
  reopenReason: null,
};
const stageFixture = {
  id: "PHASE-1",
  code: workItemFixture.phaseCode,
  name: workItemFixture.phaseName,
  purpose: "确认当前事实",
  status: "IN_PROGRESS",
  progress: 0,
  completedTaskCount: 0,
  totalTaskCount: 2,
  gate: { status: "OPEN", label: "核对事实", returnedReason: null },
  tasks: [workItemFixture, { ...workItemFixture, id: "WI-2" }],
};
const stateFixture = {
  id: "PRJ-1",
  sourceTaskId: "TASK-1",
  name: "隔离演示项目",
  status: "RUNNING",
  progress: 0,
  currentStage: stageFixture,
  outcome: {
    baseline: 80,
    target: 90,
    current: null,
    status: "NOT_MEASURED",
    conclusion: null,
    evidenceReference: null,
    note: null,
    submittedAt: null,
    acceptedAt: null,
    locator: null,
  },
};
const materialFixture = {
  id: "M-1",
  requirementId: "REQ-1",
  title: "交付记录",
  note: "",
  kind: "UPLOADED_FILE",
  status: "ACTIVE",
  situationCode: "BOM_DELAY",
  locator,
  file: {
    originalName: "fixture.csv",
    mediaType: "text/csv",
    extractionStatus: "EXTRACTED",
    contentPreview: sourcePreview,
    readableByAi: true,
  },
  verification: {
    status: "VERIFIED",
    version: 1,
    note: "PMC 已核验",
    verifiedBy: "human-pmc",
    verifiedAt: occurredAt,
  },
  verificationStatus: "VERIFIED",
  latestVerificationAudit: {
    eventType: "MATERIAL_VERIFIED",
    version: 1,
    actor: "human-pmc",
    note: "PMC 已核验",
    occurredAt,
  },
  verificationEligible: true,
  evidenceProposalVersion: 0,
};
const evidenceListFixture = {
  projectId: stateFixture.id,
  sourceTaskId: stateFixture.sourceTaskId,
  items: [evidenceFixture],
};
const projectContextFixture = {
  project: {
    ...stateFixture,
    phases: [stageFixture],
    experienceSummary: [],
    recentActivities: [],
    latestConfirmedWorkpaper: null,
  },
  sourceTask: {
    id: stateFixture.sourceTaskId,
    status: "DECIDED",
    facts: [
      { label: "交付情况", value: "按时", evidenceId: evidenceFixture.id },
    ],
    evidence: [evidenceFixture],
    materialGaps: [],
    materials: [materialFixture],
  },
};
const confirmedVersion = {
  revision: 1,
  kind: "PMC_CONFIRMED",
  classification: "CONFIRMED_OUTPUT",
  content: {
    problemStatement: "核对交付情况",
    factFindings: [{ evidenceId: evidenceFixture.id, assertion: "核对来源" }],
    materialFindings: [],
    hypotheses: ["来源一致"],
    conclusion: {
      result: "SUPPORTS",
      statement: "已核验",
      limitations: "仅覆盖样本",
      nextChecks: [],
    },
  },
  locator,
  basedOnRevision: null,
  requestedBy: "PMC",
  createdAt: occurredAt,
};
const workpaperFixture = {
  id: "WP-1",
  projectId: stateFixture.id,
  sourceTaskId: stateFixture.sourceTaskId,
  workItem: {
    id: "WI-1",
    title: "核对交付记录",
    status: "DONE",
    acceptanceCriteria: ["核对来源记录"],
  },
  status: "CONFIRMED",
  revision: 1,
  current: confirmedVersion,
  latestConfirmed: confirmedVersion,
  history: [confirmedVersion],
  context: {
    facts: [
      {
        evidenceId: evidenceFixture.id,
        label: "交付情况",
        value: "按时",
        classification: "FACT",
        locator,
      },
    ],
    materials: [
      {
        materialId: materialFixture.id,
        requirementId: materialFixture.requirementId,
        title: materialFixture.title,
        classification: "UNVERIFIED_INPUT",
        extractionStatus: "EXTRACTED",
        readableByAi: true,
        contentPreview: sourcePreview,
        locator,
      },
    ],
    materialGaps: [],
  },
};

const materialsFixture = {
  projectId: stateFixture.id,
  sourceTaskId: stateFixture.sourceTaskId,
  items: [materialFixture],
  gaps: [],
};
const nextActionFixture = {
  kind: "HUMAN_GATE_OR_REVIEW",
  projectId: "PRJ-1",
  title: "查看当前状态对应的人工 gate 或完成条件",
  explanation: "项目状态为 RUNNING",
  classification: "PROPOSAL",
};
const workContextFixture = {
  projectId: stateFixture.id,
  context: projectContextFixture,
  state: stateFixture,
  currentWorkItem: { projectId: stateFixture.id, item: null },
  workItems: { projectId: stateFixture.id, items: [workItemFixture] },
};
const evidenceBundleFixture = {
  projectId: stateFixture.id,
  evidence: evidenceListFixture,
  materials: materialsFixture,
  workpaper: workpaperFixture,
  proposals: [],
};
const workspaceFixture = {
  ...workContextFixture,
  ...evidenceBundleFixture,
  projects: { items: [stateFixture], currentProjectId: stateFixture.id },
  nextAction: nextActionFixture,
};

const client = (): IntegrationClient => ({
  listEvents: vi.fn().mockResolvedValue({ items: [] }),
  getExecutionContext: vi
    .fn()
    .mockResolvedValue({ version: 0, allowedActions: [] }),
  executeWork: vi.fn().mockResolvedValue({ version: 1, replayed: false }),
  verifyMaterial: vi.fn().mockResolvedValue({ version: 1 }),
  confirmEvidence: vi.fn().mockResolvedValue({ version: 1 }),
  getEvidenceBundle: vi.fn().mockResolvedValue(evidenceBundleFixture),
  getWorkContext: vi.fn().mockResolvedValue(workContextFixture),
  getWorkspaceResume: vi.fn().mockResolvedValue(workspaceFixture),
  listProjects: vi
    .fn()
    .mockResolvedValue({ items: [stateFixture], currentProjectId: "PRJ-1" }),
  getCurrentProject: vi.fn().mockResolvedValue(stateFixture),
  getProjectContext: vi.fn().mockResolvedValue(projectContextFixture),
  getNextAction: vi.fn().mockResolvedValue(nextActionFixture),
  getProjectState: vi.fn().mockResolvedValue(stateFixture),
  getCurrentWorkItem: vi
    .fn()
    .mockResolvedValue({ projectId: "PRJ-1", item: null }),
  listProjectWorkItems: vi
    .fn()
    .mockResolvedValue({ projectId: "PRJ-1", items: [workItemFixture] }),
  listEvidence: vi.fn().mockResolvedValue(evidenceListFixture),
  getEvidence: vi.fn().mockResolvedValue({ item: { id: "E-1" } }),
  listTraceableMaterials: vi.fn().mockResolvedValue(materialsFixture),
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
  getValidationWorkpaper: vi.fn().mockResolvedValue(workpaperFixture),
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

const callFixtureTool = async (
  name: string,
  integration: IntegrationClient = client(),
  _meta?: typeof modernMeta,
) => {
  const response = await createMcpHandler(integration)({
    jsonrpc: "2.0",
    id: "aggregate-fixture",
    method: "tools/call",
    params: {
      name,
      arguments: name === "workspace.resume" ? {} : { projectId: "PRJ-1" },
      _meta,
    },
  });
  if (!response || !("result" in response))
    throw new Error("Missing tool result");
  return response.result as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

describe("HTTP failures delivered to the host", () => {
  it.each([
    { revision: "legacy", meta: undefined, retryAfter: "45", seconds: 45 },
    { revision: "modern", meta: modernMeta, retryAfter: "45", seconds: 45 },
    { revision: "modern", meta: modernMeta, retryAfter: "0", seconds: 0 },
    { revision: "modern", meta: modernMeta, retryAfter: "45 seconds" },
  ])(
    "$revision delivers a real 429 with Retry-After $retryAfter as error content",
    async ({ meta, retryAfter, seconds }) => {
      const serverCorrelationId = "6f1c2f7e-1111-4222-8333-444455556666";
      const requestIds: unknown[] = [];
      const server = createServer((request, response) => {
        requestIds.push(request.headers["x-correlation-id"]);
        response.writeHead(429, {
          "content-type": "application/json",
          "Retry-After": retryAfter,
        });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "请求过于频繁，请按 Retry-After 重试",
              retryable: true,
              requiresHuman: false,
            },
            correlationId: serverCorrelationId,
          }),
        );
      });
      try {
        await new Promise<void>((resolve, reject) =>
          server.once("error", reject).listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No test port");
        vi.stubEnv(
          "DINGJIANG_API_BASE_URL",
          `http://127.0.0.1:${address.port}/api`,
        );

        const result = await callFixtureTool(
          "workspace.resume",
          new DingjiangIntegrationClient(undefined, "fixture-token"),
          meta,
        );
        expect(requestIds).toEqual([expect.stringMatching(/^[\da-f-]{36}$/i)]);
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty("structuredContent");
        const failure = JSON.parse(result.content[0]!.text);
        expect(failure).toMatchObject({
          code: "RATE_LIMITED",
          retryable: true,
          correlationId: serverCorrelationId,
          requestCorrelationId: requestIds[0],
        });
        expect(failure.message).toContain("本轮停止调用");
        if (seconds === undefined) {
          expect(failure).not.toHaveProperty("retryAfterSeconds");
          expect(failure.message).toContain("等待时间未知");
        } else {
          expect(failure.retryAfterSeconds).toBe(seconds);
          expect(failure.message).toContain(`${seconds} 秒`);
        }
        expect(JSON.stringify(result)).not.toContain("fixture-token");
      } finally {
        vi.unstubAllEnvs();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("aggregate tool outputs", () => {
  it("keeps work items and traceable evidence while removing duplicate workspace fields", async () => {
    const result = await callFixtureTool("workspace.resume");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      projects: {
        items: [{ id: "PRJ-1", currentStage: { code: "BASELINE_FACTS" } }],
      },
      state: { currentStage: { code: "BASELINE_FACTS" } },
      context: {
        sourceTask: { facts: [{ evidenceId: "E-1" }], materialGaps: [] },
      },
      workItems: { items: [{ id: "WI-1", owner: "PMC" }] },
      evidence: { items: [evidenceFixture] },
      materials: { items: [{ file: { contentPreview: sourcePreview } }] },
      workpaper: { latestConfirmed: { revision: 1, locator } },
      nextAction: { classification: "PROPOSAL" },
    });
    for (const field of [
      "projects.items.0.currentStage.tasks",
      "state.currentStage.tasks",
      "context.project.currentStage.tasks",
      "context.project.phases.0.tasks",
      "context.sourceTask.evidence",
      "context.sourceTask.materials",
      "workpaper.history",
      "workpaper.context.materials.0.contentPreview",
    ])
      expect(result.structuredContent).not.toHaveProperty(field);
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
  });

  it("retains material metadata and evidence in work.context", async () => {
    const integration = client();
    const result = await callFixtureTool("work.context", integration);
    expect(result.isError).toBeUndefined();
    expect(integration.getWorkContext).toHaveBeenCalledExactlyOnceWith("PRJ-1");
    expect(integration.getProjectContext).not.toHaveBeenCalled();
    expect(integration.getCurrentWorkItem).not.toHaveBeenCalled();
    expect(integration.listProjectWorkItems).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      state: {
        id: "PRJ-1",
        sourceTaskId: "TASK-1",
        currentStage: { code: "BASELINE_FACTS" },
      },
      context: {
        sourceTask: {
          evidence: [evidenceFixture],
          materials: [{ id: "M-1", locator, file: { readableByAi: true } }],
        },
      },
    });
    expect(result.structuredContent).not.toHaveProperty(
      "context.sourceTask.materials.0.file.contentPreview",
    );

    const detail = await callFixtureTool("get_project_context");
    expect(detail.structuredContent).toHaveProperty(
      "sourceTask.materials.0.file.contentPreview",
      sourcePreview,
    );
    expect(detail.structuredContent).toHaveProperty("project.phases.0.tasks");
  });

  it.each(["workspace.resume", "work.context", "evidence.bundle"])(
    "bounds the full UTF-8 result for %s",
    async (name) => {
      const integration = client();
      const withValue = (characters: number) => ({
        ...evidenceFixture,
        fields: { value: "汉".repeat(characters) },
      });
      const largeEvidence = {
        ...evidenceListFixture,
        items: [withValue(90_000)],
      };
      integration.getEvidenceBundle = vi.fn().mockResolvedValue({
        ...evidenceBundleFixture,
        evidence: largeEvidence,
      });
      integration.getWorkspaceResume = vi.fn().mockResolvedValue({
        ...workspaceFixture,
        evidence: largeEvidence,
      });
      integration.getWorkContext = vi.fn().mockResolvedValue({
        ...workContextFixture,
        context: {
          ...projectContextFixture,
          sourceTask: {
            ...projectContextFixture.sourceTask,
            evidence: [withValue(90_000)],
          },
        },
      });
      const result = await callFixtureTool(name, integration);

      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        code: "AGGREGATE_RESULT_TOO_LARGE",
        limitBytes: 512 * 1024,
        retryable: false,
        requiresHuman: false,
      });
      expect(result.content[0]!.text).not.toContain("汉汉汉");
    },
  );

  it("counts JSON escaping in the text copy of a bounded result", async () => {
    const integration = client();
    integration.getEvidenceBundle = vi.fn().mockResolvedValue({
      ...evidenceBundleFixture,
      evidence: {
        ...evidenceListFixture,
        items: [{ ...evidenceFixture, fields: { value: '"'.repeat(100_000) } }],
      },
    });

    const result = await callFixtureTool("evidence.bundle", integration);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: "AGGREGATE_RESULT_TOO_LARGE",
    });
  });

  it("keeps an intact evidence value below the response limit", async () => {
    const integration = client();
    const value = "汉".repeat(80_000);
    integration.getEvidenceBundle = vi.fn().mockResolvedValue({
      ...evidenceBundleFixture,
      evidence: {
        ...evidenceListFixture,
        items: [{ ...evidenceFixture, fields: { value } }],
      },
    });

    const result = await callFixtureTool("evidence.bundle", integration);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      evidence: { items: [{ fields: { value } }] },
    });
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(512 * 1024);
  });
  it("counts the modern envelope in the same 512 KiB result limit", async () => {
    const integration = client();
    const setEvidenceValue = (value: string) => {
      integration.getEvidenceBundle = vi.fn().mockResolvedValue({
        ...evidenceBundleFixture,
        evidence: {
          ...evidenceListFixture,
          items: [{ ...evidenceFixture, fields: { value } }],
        },
      });
    };
    const limit = 512 * 1024;
    setEvidenceValue("");
    const baseline = await callFixtureTool("evidence.bundle", integration);
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");
    // Each ASCII character appears once in structuredContent and once in text.
    setEvidenceValue("x".repeat(Math.floor((limit - baselineBytes) / 2)));

    const legacy = await callFixtureTool("evidence.bundle", integration);
    expect(legacy.isError).toBeUndefined();
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), "utf8");
    expect(legacyBytes).toBeGreaterThan(limit - 2);
    expect(legacyBytes).toBeLessThanOrEqual(limit);

    const modern = await callFixtureTool(
      "evidence.bundle",
      integration,
      modernMeta,
    );
    expect(modern.isError).toBe(true);
    expect(JSON.parse(modern.content[0]!.text)).toMatchObject({
      code: "AGGREGATE_RESULT_TOO_LARGE",
      limitBytes: limit,
    });
  });
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

  it("reads the workspace through one Integration call", async () => {
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
    expect(integration.getWorkspaceResume).toHaveBeenCalledExactlyOnceWith();
    expect(integration.listProjects).not.toHaveBeenCalled();
    expect(integration.getCurrentWorkItem).not.toHaveBeenCalled();
    expect(integration.getProjectContext).not.toHaveBeenCalled();
    expect(integration.listEvidence).not.toHaveBeenCalled();
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

  it.each([
    { surface: "business", tools: dingjiangTools, readCount: 7 },
    {
      surface: "compatibility",
      tools: dingjiangCompatibilityTools,
      readCount: 17,
    },
  ])(
    "exposes only reads and rejects direct writes in the $surface read-only session",
    async ({ surface, tools, readCount }) => {
      vi.stubEnv("DINGJIANG_MCP_TOOL_SURFACE", surface);
      vi.stubEnv("DINGJIANG_MCP_READ_ONLY", "1");
      const integration = client();
      const clientForRead = vi.fn(() => integration);
      const signal = new AbortController().signal;
      try {
        const handler = createMcpHandler(integration, undefined, clientForRead);
        // Even the first handshake must use the startup policy.
        vi.stubEnv("DINGJIANG_MCP_READ_ONLY", "0");
        const initialized = await handler({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: { protocolVersion: legacyProtocolVersion },
        });
        const { instructions } = (
          initialized as {
            result: { instructions: string };
          }
        ).result;
        expect(instructions).toContain("只读");
        expect(instructions).toContain("PROPOSAL");
        expect(instructions).toContain("RATE_LIMITED");
        expect(instructions).not.toContain("work.execute");

        const listed = await handler({
          jsonrpc: "2.0",
          id: "list",
          method: "tools/list",
        });
        const expectedReads = tools.filter(
          (tool) => tool.annotations.readOnlyHint,
        );
        expect(expectedReads).toHaveLength(readCount);
        expect(listed).toMatchObject({ result: { tools: expectedReads } });

        for (const { name } of dingjiangTools.filter(
          (tool) => !tool.annotations.readOnlyHint,
        )) {
          const denied = await handler(
            {
              jsonrpc: "2.0",
              id: name,
              method: "tools/call",
              params: { name, arguments: {} },
            },
            signal,
          );
          expect(denied, name).toMatchObject({
            error: { code: -32602, data: { code: "UNKNOWN_TOOL", tool: name } },
          });
        }
        expect(clientForRead).not.toHaveBeenCalled();

        const read = await handler(
          {
            jsonrpc: "2.0",
            id: "read",
            method: "tools/call",
            params: { name: "workspace.events", arguments: {} },
          },
          signal,
        );
        expect(read).toMatchObject({
          result: { structuredContent: { items: [] } },
        });
        expect(clientForRead).toHaveBeenCalledExactlyOnceWith(signal);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("advertises the modern tool capability and governance instructions", async () => {
    const handler = createMcpHandler(client());
    const _meta = modernMeta;
    const discovered = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta },
    });
    expect(discovered).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions: expect.stringContaining("PROPOSAL"),
        ttlMs: 0,
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "dingjiang-mcp",
            version: expect.any(String),
          },
        },
      },
    });

    const listed = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta },
    });
    expect(listed).toMatchObject({
      result: { resultType: "complete", tools: dingjiangTools, ttlMs: 0 },
    });
  });

  it("serves a modern tool call directly and requires metadata on later calls", async () => {
    const integration = client();
    const handler = createMcpHandler(integration);
    const result = await handler({
      jsonrpc: "2.0",
      id: "direct",
      method: "tools/call",
      params: {
        name: "workspace.events",
        arguments: {},
        _meta: modernMeta,
      },
    });
    expect(result).toMatchObject({
      result: {
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "dingjiang-mcp" },
        },
        structuredContent: { items: [] },
      },
    });

    const missing = await handler({
      jsonrpc: "2.0",
      id: "missing",
      method: "tools/call",
      params: { name: "workspace.events" },
    });
    expect(missing).toMatchObject({ error: { code: -32602 } });
    expect(integration.listEvents).toHaveBeenCalledTimes(1);
  });

  it.each([
    { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    { "io.modelcontextprotocol/clientCapabilities": {} },
    {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": [],
    },
  ])("rejects malformed modern metadata before dispatch", async (_meta) => {
    const integration = client();
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "workspace.events", _meta },
    });
    expect(response).toMatchObject({ error: { code: -32602 } });
    expect(integration.listEvents).not.toHaveBeenCalled();
  });

  it("reports unsupported request versions without dispatching the tool", async () => {
    const integration = client();
    const response = await createMcpHandler(integration)({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "workspace.events",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: ["2026-07-28"], requested: "2099-01-01" },
      },
    });
    expect(integration.listEvents).not.toHaveBeenCalled();
  });

  it("allows a legacy handshake after a modern discovery probe", async () => {
    const handler = createMcpHandler(client());
    await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "server/discover",
      params: { _meta: modernMeta },
    });
    const initialized = await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialized).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
    expect(initialized).not.toHaveProperty("result.resultType");
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
    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: "TOOL_UNAVAILABLE",
    });
  });

  it.each(["nope.nope", "__proto__", "constructor"])(
    "rejects the unknown tool %s as a protocol parameter error",
    async (name) => {
      const response = await createMcpHandler(client())({
        jsonrpc: "2.0",
        id: "unknown-tool",
        method: "tools/call",
        params: { name, arguments: {} },
      });
      expect(response).toMatchObject({
        error: {
          code: -32602,
          data: { code: "UNKNOWN_TOOL", tool: name },
        },
      });
    },
  );

  it.each([
    ["a non-object payload", null],
    ["an array payload", []],
    ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["a non-string method", { jsonrpc: "2.0", id: 1, method: 42 }],
  ])("rejects %s as a protocol error", async (_label, payload) => {
    const response = await createMcpHandler(client())(payload as never);
    expect(response).toMatchObject({ error: { code: -32600 } });
  });

  it("rejects a non-scalar request id without echoing it", async () => {
    const response = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: { nested: true } as never,
      method: "ping",
    });
    expect(response).toMatchObject({
      id: null,
      error: { code: -32600, data: { code: "INVALID_ID" } },
    });
  });

  it("rejects array params as invalid params", async () => {
    const response = await createMcpHandler(client())({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: [] as never,
    });
    expect(response).toMatchObject({
      error: { code: -32602, data: { code: "INVALID_PARAMS" } },
    });
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
      params: { protocolVersion: legacyProtocolVersion },
    });
    const second = await handler({
      jsonrpc: "2.0",
      id: "init-2",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(revisionOf(first)).toBe(legacyProtocolVersion);
    // A second handshake must not change what the session was promised.
    expect(revisionOf(second)).toBe(legacyProtocolVersion);

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
    expect(unknown).toMatchObject({
      error: { code: -32602, data: { code: "UNKNOWN_TOOL" } },
    });
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
    const correlationId = "6f1c2f7e-1111-4222-8333-444455556666";
    integration.getProjectState = vi.fn().mockRejectedValue(
      new IntegrationTransportError(
        "INTEGRATION_TIMEOUT",
        "Integration API 请求超时。不得改 requestId 重试",
        {
          correlationId,
          cause: new Error(
            "Bearer fixture-token; /internal/path; synthetic-material",
          ),
        },
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
      correlationId,
      retryable: false,
      requiresHuman: true,
    });
    const text = JSON.stringify(response);
    expect(text).not.toContain("TOOL_UNAVAILABLE");
    expect(text).not.toContain("INVALID_REQUEST");
    expect(text).not.toMatch(
      /fixture-token|\/internal\/path|synthetic-material/,
    );
    expect(result).not.toHaveProperty("structuredContent");
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

  it.each(["NOT_FOUND", "FORBIDDEN"] as const)(
    "passes a workspace %s through without fallback requests",
    async (code) => {
      const integration = client();
      vi.mocked(integration.getWorkspaceResume).mockRejectedValue(
        new IntegrationClientError(failure(code)),
      );
      const result = await callFixtureTool("workspace.resume", integration);
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code });
      expect(integration.listProjects).not.toHaveBeenCalled();
    },
  );

  it("includes an empty workpaper for an authorized workspace snapshot", async () => {
    const integration = client();
    integration.getWorkspaceResume = vi.fn().mockResolvedValue({
      ...workspaceFixture,
      workpaper: null,
    });
    const result = await callFixtureTool("workspace.resume", integration);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      projectId: "PRJ-1",
      workpaper: null,
    });
  });

  it("reads a nullable workpaper as part of one evidence bundle", async () => {
    const integration = client();
    integration.getEvidenceBundle = vi.fn().mockResolvedValue({
      ...evidenceBundleFixture,
      workpaper: null,
    });
    const result = await callFixtureTool("evidence.bundle", integration);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ workpaper: null });
    expect(integration.getEvidenceBundle).toHaveBeenCalledExactlyOnceWith(
      "PRJ-1",
    );
    expect(integration.listEvidence).not.toHaveBeenCalled();
    expect(integration.listTraceableMaterials).not.toHaveBeenCalled();
    expect(integration.getValidationWorkpaper).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "FORBIDDEN"] as const)(
    "passes a project evidence bundle %s through without fallback reads",
    async (code) => {
      const integration = client();
      vi.mocked(integration.getEvidenceBundle).mockRejectedValue(
        new IntegrationClientError(failure(code)),
      );
      const result = await callFixtureTool("evidence.bundle", integration);
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code });
      expect(integration.getValidationWorkpaper).not.toHaveBeenCalled();
    },
  );
});
