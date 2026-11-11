import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  governedCommandResultSchema,
  integrationEvidenceBundleSchema,
  integrationWorkContextSchema,
  integrationWorkspaceResumeSchema,
  workExecutionContextSchema,
  workProgressReadbackSchema,
} from "@dingjiang/contracts";
import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
import {
  oauthRead,
  oauthWrite,
  obtainOAuthToken,
  startOAuthTestIssuer,
} from "../testing/oauth-test-issuer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";

/**
 * Real end-to-end run: a real API process, a real MCP process, a real
 * PostgreSQL database, wired exactly as they are wired in production (HTTP +
 * bearer token + stdio JSON-RPC). Nothing is stubbed.
 *
 * The other integration suites boot NestJS in-process, which proves the
 * services work but not that the packaged entrypoints, the stdio bootstrap, the
 * bearer authentication and the JSON-RPC framing work together.
 *
 * Enable with REAL_E2E=1. The run owns a throwaway database and drops it.
 */
const run = process.env.REAL_E2E === "1";
const demoDirectory = process.env.REAL_E2E_DEMO_DIRECTORY;

const repoRoot = resolve(process.cwd(), "../..");
const apiEntry = resolve(process.cwd(), "dist/main.js");
const mcpEntry = resolve(repoRoot, "services/dingjiang-mcp/dist/server.js");
const mcpHttpEntry = resolve(
  repoRoot,
  "services/dingjiang-mcp/dist/server-http.js",
);

const pmcToken = `real-e2e-pmc-${randomUUID()}`;
const readOnlyToken = `real-e2e-readonly-${randomUUID()}`;
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "real-e2e", version: "1" },
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

class McpProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    string,
    (value: JsonRpcResponse) => void
  >();
  private readonly stderr: string[] = [];

  constructor(
    token: string,
    baseUrl: string,
    private readonly options: { readOnly?: boolean; modern?: boolean } = {},
  ) {
    this.child = spawn(process.execPath, [mcpEntry], {
      env: {
        ...process.env,
        DINGJIANG_API_BASE_URL: baseUrl,
        DINGJIANG_MCP_API_TOKEN: token,
        DINGJIANG_MCP_TOOL_SURFACE: "",
        DINGJIANG_MCP_READ_ONLY: this.options.readOnly ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) =>
      this.stderr.push(chunk.toString("utf8")),
    );
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const response = JSON.parse(trimmed) as JsonRpcResponse;
      const id = String(response.id);
      this.pending.get(id)?.(response);
    });
  }

  get errorOutput(): string {
    return this.stderr.join("");
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<JsonRpcResponse> {
    const id = randomUUID();
    const settled = new Promise<JsonRpcResponse>((resolvePromise, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.child.off("exit", onExit);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`MCP exited with ${code} during ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, (value) => {
        cleanup();
        resolvePromise(value);
      });
      this.child.once("exit", onExit);
    });
    const wireParams = this.options.modern
      ? { ...params, _meta: modernMeta }
      : params;
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: wireParams })}\n`,
    );
    return settled;
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    data?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    isError: boolean;
    textBytes: number;
    resultBytes: number;
  }> {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (response.error)
      throw new Error(`tools/call ${name} failed: ${response.error.message}`);
    const result = response.result as {
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const payload = JSON.parse(result.content[0]!.text) as Record<
      string,
      unknown
    >;
    const isError = Boolean(result.isError);
    if (isError) expect(result).not.toHaveProperty("structuredContent");
    const sizes = {
      textBytes: Buffer.byteLength(result.content[0]!.text, "utf8"),
      resultBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    };
    return isError
      ? { failure: payload, isError, ...sizes }
      : { data: result.structuredContent, isError, ...sizes };
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolvePromise) =>
      this.child.once("exit", () => resolvePromise()),
    );
    this.child.kill();
    await exited;
  }
}

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`API did not become ready: ${lastError}`);
};

describe.skipIf(!run)(
  "real end-to-end: MCP process → HTTP API → PostgreSQL",
  () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const database = `dingjiang_real_e2e_${suffix}`;
    const port = 31_000 + Math.floor(Math.random() * 3_000);
    const baseUrl = `http://127.0.0.1:${port}/api`;

    let admin: Pool;
    let pool: Pool;
    let api: ChildProcess;
    let mcp: McpProcess;
    let modernMcp: McpProcess;
    let readOnlyMcp: McpProcess;
    let projectId: string;
    let version: number;
    let stateFingerprint: string;
    let workItemId: string;
    const trace: Array<{
      title: string;
      result: Record<string, string | number | boolean | null>;
    }> = [];
    const record = (
      title: string,
      result: (typeof trace)[number]["result"],
    ) => {
      if (demoDirectory) trace.push({ title, result });
    };
    const original = {
      DATABASE_URL: process.env.DATABASE_URL,
      PORT: process.env.PORT,
      DINGJIANG_MCP_API_TOKEN: process.env.DINGJIANG_MCP_API_TOKEN,
      DINGJIANG_MCP_TOKEN_BINDINGS_JSON:
        process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON,
    };

    beforeAll(async () => {
      const base = new URL(databaseUrl());
      base.pathname = "/postgres";
      admin = createTestPool(base.toString());
      await admin.query(`CREATE DATABASE ${database}`);
      base.pathname = `/${database}`;
      process.env.DATABASE_URL = base.toString();
      pool = createTestPool(base.toString());
      await migrate(pool);
      await resetAndSeed(pool);

      const domain = new Vs01Service();
      await domain.onModuleInit();
      try {
        await domain.decideTask("SO-202608128", {
          actor: "PMC",
          type: "CONFIRMED",
          note: "真实端到端测试确认来源任务",
        });
        projectId = (
          await domain.createProject({
            actor: "PMC",
            sourceTaskId: "SO-202608128",
          })
        ).id;
      } finally {
        await domain.onModuleDestroy();
      }

      expect(existsSync(mcpEntry)).toBe(true);
      expect(existsSync(mcpHttpEntry)).toBe(true);
      expect(existsSync(apiEntry)).toBe(true);

      process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
        {
          token: pmcToken,
          tenantId: "tenant-demo",
          subjectId: "real-e2e-pmc",
          role: "PMC",
          scopes: [
            "project:read",
            "workitem:read",
            "workitem:write",
            "material:read",
            "evidence:read",
            "workpaper:read",
            "experience:read",
          ],
          projectIds: [projectId],
        },
        {
          token: readOnlyToken,
          tenantId: "tenant-demo",
          subjectId: "real-e2e-readonly",
          role: "PMC",
          scopes: ["project:read", "workitem:read"],
          projectIds: [projectId],
        },
      ]);

      api = spawn(process.execPath, [apiEntry], {
        cwd: demoDirectory,
        env: {
          ...process.env,
          PORT: String(port),
          API_HOST: "127.0.0.1",
          VS15_MATERIAL_VAULT_ROOT: resolve(
            demoDirectory ?? process.cwd(),
            ".data/real-e2e-vault",
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const apiErrors: string[] = [];
      api.stderr?.on("data", (chunk: Buffer) =>
        apiErrors.push(chunk.toString("utf8")),
      );
      api.once("exit", (code) => {
        if (code !== 0) apiErrors.push(`API exited early with code ${code}`);
      });
      await waitForHealth(`${baseUrl}/health`);

      mcp = new McpProcess(pmcToken, baseUrl);
      modernMcp = new McpProcess(pmcToken, baseUrl, { modern: true });
      readOnlyMcp = new McpProcess(readOnlyToken, baseUrl);
    }, 180_000);

    afterAll(async () => {
      await mcp?.stop();
      await modernMcp?.stop();
      await readOnlyMcp?.stop();
      if (api && api.exitCode === null) {
        const exited = new Promise<void>((resolvePromise) =>
          api.once("exit", () => resolvePromise()),
        );
        api.kill();
        await exited;
      }
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.end();
      }
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (demoDirectory)
        await writeFile(
          resolve(demoDirectory, "trace.json"),
          JSON.stringify(trace, null, 2),
          { flag: "wx" },
        );
    }, 120_000);

    it("publishes the same governed surface over both stdio protocols", async () => {
      const initialize = await mcp.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "real-e2e", version: "1" },
      });
      const result = initialize.result as {
        protocolVersion: string;
        instructions: string;
        serverInfo: { name: string };
      };
      expect(result.protocolVersion).toBe("2025-06-18");
      expect(result.serverInfo.name).toBe("dingjiang-mcp");
      expect(result.instructions).toContain("PROPOSAL");

      const listed = await mcp.request("tools/list", {});
      const tools = (listed.result as { tools: Array<Record<string, unknown>> })
        .tools;
      expect(tools).toHaveLength(13);
      const execute = tools.find((tool) => tool.name === "work.execute") as {
        annotations: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      };
      expect(execute.annotations.readOnlyHint).toBe(false);
      expect(execute.annotations.destructiveHint).toBe(true);
      expect(execute.outputSchema?.type).toBe("object");

      const discovered = await modernMcp.request("server/discover");
      expect(discovered.result).toMatchObject({
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions: expect.stringContaining("PROPOSAL"),
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "dingjiang-mcp" },
        },
      });
      const modernList = await modernMcp.request("tools/list");
      expect(modernList.result?.tools).toEqual(tools);
      record("连接自定义 MCP Server", {
        协议版本: result.protocolVersion,
        新版发现: "2026-07-28",
        工具数量: tools.length,
        "work.execute 只读": execute.annotations.readOnlyHint === true,
      });
    });

    it("authenticates the bearer token against the real HTTP API", async () => {
      const anonymous = await fetch(`${baseUrl}/integration/projects`);
      expect(anonymous.status).toBe(401);
      const authorized = await fetch(`${baseUrl}/integration/projects`, {
        headers: { authorization: `Bearer ${pmcToken}` },
      });
      expect(authorized.status).toBe(200);
      const body = (await authorized.json()) as {
        ok: boolean;
        data: { currentProjectId: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.currentProjectId).toBe(projectId);
      record("用真实 HTTP 验证身份", {
        匿名请求: anonymous.status,
        授权请求: authorized.status,
        当前项目: body.data.currentProjectId,
      });
    });

    it("reads the workspace and derives a PROPOSAL next action", async () => {
      const resumed = await mcp.call("workspace.resume");
      expect(resumed.isError).toBe(false);
      const snapshot = integrationWorkspaceResumeSchema.parse(resumed.data);
      const { nextAction } = snapshot;
      expect(nextAction.projectId).toBe(projectId);
      // The derived classification is the product invariant: never FACT.
      expect(nextAction.classification).toBe("PROPOSAL");
      // A freshly created project has no workpaper. The composite must report the
      // absence rather than collapsing; this is the regression the real run found.
      expect(snapshot.workpaper).toBeNull();
      const [evidence] = snapshot.evidence.items;
      expect(evidence?.classification).toBe("FACT");
      record("恢复延期项目并读取证据", {
        项目: snapshot.state.name,
        工单: snapshot.context.sourceTask.id,
        阶段: snapshot.state.currentStage?.name ?? null,
        下一动作: nextAction.title,
        动作分类: nextAction.classification,
        来源版本: evidence!.sourceVersionId,
        来源位置: `${evidence!.sourceFile} · ${evidence!.sourceSheet} · row ${evidence!.sourceRow}`,
      });

      const operations = await mcp.call("work.operations", { projectId });
      expect(operations.isError).toBe(false);
      const context = operations.data as {
        version: number;
        stateFingerprint: string;
        allowedActions: string[];
        project: {
          phases: Array<{
            code: string;
            tasks: Array<{ id: string; owner: string; status: string }>;
          }>;
        };
      };
      version = context.version;
      stateFingerprint = context.stateFingerprint;
      expect(context.allowedActions.length).toBeGreaterThan(0);
      const task = context.project.phases
        .flatMap((phase) => phase.tasks)
        .find((item) => item.owner === "PMC" && item.status !== "DONE");
      expect(task).toBeDefined();
      workItemId = task!.id;
    });

    it("rejects a governed write from a read-only identity", async () => {
      const requestId = randomUUID();
      const correlationId = randomUUID();
      const denied = await readOnlyMcp.call("work.execute", {
        projectId,
        requestId,
        correlationId,
        expectedVersion: version,
        reason: "真实端到端测试越权尝试",
        payload: {
          stateFingerprint,
          confirmation: "这条请求应当被服务端拒绝",
          operation: {
            action: "progress.record",
            workItemId,
            note: "越权尝试不应写入",
          },
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.failure).toMatchObject({
        code: "PERMISSION_DENIED",
        correlationId,
      });
      const rejectedReceipts = await pool.query(
        "SELECT 1 FROM governed_command_receipts WHERE request_id = $1",
        [requestId],
      );
      expect(rejectedReceipts.rowCount).toBe(0);
      // A permission denial is not something the model may retry its way out of.
      expect(denied.failure?.retryable).toBe(false);
      expect(denied.failure?.requiresHuman).toBe(true);
      record("只读身份提交进度", {
        结果: String(denied.failure?.code),
        可重试: denied.failure?.retryable === true,
        需人工介入: denied.failure?.requiresHuman === true,
      });
    });

    it("blocks read-only writes and replays a committed write whose response was lost", async () => {
      const requestId = randomUUID();
      const command = {
        projectId,
        requestId,
        correlationId: randomUUID(),
        expectedVersion: version,
        reason: "真实端到端测试记录进展",
        payload: {
          stateFingerprint,
          confirmation: "真实端到端测试中用户明确确认记录本次进展",
          operation: {
            action: "progress.record",
            workItemId,
            note: "已核对订单预计交期，准备与采购复核到料时间。",
          },
        },
      };

      const readOnlyProcess = new McpProcess(pmcToken, baseUrl, {
        modern: true,
        readOnly: true,
      });
      try {
        const discovered = await readOnlyProcess.request("server/discover");
        expect(discovered.result?.instructions).toContain("只读");
        const listed = await readOnlyProcess.request("tools/list");
        expect(listed.result?.tools).toHaveLength(7);
        expect(await readOnlyProcess.call("workspace.resume")).toMatchObject({
          isError: false,
          data: { projectId },
        });
        expect(
          await readOnlyProcess.request("tools/call", {
            name: "work.execute",
            arguments: command,
          }),
        ).toMatchObject({
          error: { code: -32602, data: { code: "UNKNOWN_TOOL" } },
        });
      } finally {
        await readOnlyProcess.stop();
      }

      // The test-only loopback relay forwards the original command and drops
      // the response only after receiving the committed receipt from the API.
      let deliveredToRelay: unknown;
      const relay = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const upstream = await fetch(
            `${baseUrl}/integration/projects/${encodeURIComponent(projectId)}/operations`,
            {
              method: "POST",
              headers: {
                authorization: request.headers.authorization ?? "",
                "content-type": "application/json",
                "x-correlation-id": String(request.headers["x-correlation-id"]),
              },
              body: Buffer.concat(chunks),
            },
          );
          deliveredToRelay = await upstream.json();
          response.destroy();
        } catch {
          response.writeHead(502).end();
        }
      });
      await new Promise<void>((resolve, reject) =>
        relay.once("error", reject).listen(0, "127.0.0.1", resolve),
      );
      let lossyMcp: McpProcess | undefined;
      try {
        const address = relay.address();
        if (!address || typeof address === "string")
          throw new Error("No relay port");
        lossyMcp = new McpProcess(
          pmcToken,
          `http://127.0.0.1:${address.port}/api`,
          {
            modern: true,
          },
        );
        const lost = await lossyMcp.call("work.execute", command);
        expect(lost.isError).toBe(true);
        expect(lost.failure).toMatchObject({
          code: "INTEGRATION_NETWORK_ERROR",
          message: expect.stringContaining("写入结果未知"),
          correlationId: command.correlationId,
          retryable: false,
        });
        expect(deliveredToRelay).toMatchObject({
          ok: true,
          data: { requestId, version: version + 1, replayed: false },
        });
        const committed = await pool.query(
          "SELECT result_version FROM governed_command_receipts WHERE request_id = $1",
          [requestId],
        );
        expect(committed.rows).toEqual([{ result_version: version + 1 }]);
        const beforeReplay = integrationWorkspaceResumeSchema.parse(
          (await mcp.call("workspace.resume")).data,
        );
        expect(
          beforeReplay.workItems.items.find((item) => item.id === workItemId)
            ?.progressUpdate?.note,
        ).toBe(command.payload.operation.note);
        expect(lossyMcp.errorOutput).not.toContain(pmcToken);
        record("授权写入已提交但响应未送达", {
          工具错误: String(lost.failure?.code),
          追踪编号与请求一致:
            lost.failure?.correlationId === command.correlationId,
          重放前数据库回执: committed.rowCount ?? 0,
        });
      } finally {
        await lossyMcp?.stop();
        relay.closeAllConnections();
        await new Promise<void>((resolve) => relay.close(() => resolve()));
      }

      const replay = await mcp.call("work.execute", command);
      expect(replay.isError).toBe(false);
      const receipt = governedCommandResultSchema.parse(replay.data);
      expect(receipt).toMatchObject({
        requestId,
        version: version + 1,
        replayed: true,
      });

      // A new requestId carrying the pre-write version must be refused.
      const staleRequestId = randomUUID();
      const staleCorrelationId = randomUUID();
      const stale = await modernMcp.call("work.execute", {
        ...command,
        requestId: staleRequestId,
        correlationId: staleCorrelationId,
      });
      expect(stale.isError).toBe(true);
      expect(stale.failure).toMatchObject({
        code: "STALE_VERSION",
        correlationId: staleCorrelationId,
      });

      const persisted = await pool.query(
        "SELECT count(*)::int AS count FROM vs01_project_subtasks WHERE progress_note = $1",
        [command.payload.operation.note],
      );
      expect(persisted.rows[0].count).toBe(1);

      // Three calls (write, replay, stale retry) must leave exactly one receipt:
      // the replay is answered from the ledger and the stale attempt is refused
      // before it reaches it.
      const receipts = await pool.query(
        "SELECT count(*)::int AS count, max(result_version)::int AS version FROM governed_command_receipts WHERE request_id = ANY($1::uuid[])",
        [[requestId, staleRequestId]],
      );
      expect(receipts.rows[0].count).toBe(1);
      expect(receipts.rows[0].version).toBe(version + 1);
      const progressEvents = await pool.query(
        "SELECT 1 FROM vs01_project_events WHERE project_id = $1 AND event_type = 'PROGRESS_SAVED' AND note = $2",
        [projectId, command.payload.operation.note],
      );
      expect(progressEvents.rowCount).toBe(1);

      const reread = await mcp.call("workspace.resume");
      expect(reread.isError).toBe(false);
      const snapshot = integrationWorkspaceResumeSchema.parse(reread.data);
      const saved = snapshot.workItems.items.find(
        (item) => item.id === workItemId,
      );
      expect(saved?.progressUpdate?.note).toBe(command.payload.operation.note);
      record("授权 PMC 提交进度并回读", {
        事项: workItemId,
        提交版本: receipt.version,
        同一请求返回原回执: replay.data?.replayed === true,
        旧版本提交: String(stale.failure?.code),
        数据库进度记录: persisted.rows[0].count,
        数据库回执: receipts.rows[0].count,
        "MCP 回读": saved!.progressUpdate!.note,
      });
    });

    it("keeps progress compact across snapshot, receipt and single-item readback", async () => {
      const fullBefore = await mcp.call("work.operations", { projectId });
      const state = workExecutionContextSchema.parse(fullBefore.data);
      const format = { projectId, responseFormat: "compact" };
      const compactBefore = await mcp.call("work.operations", format);
      expect(compactBefore.data).toMatchObject({
        responseFormat: "compact",
        projectId,
        version: state.version,
        stateFingerprint: state.stateFingerprint,
        allowedActions: ["progress.record"],
        items: expect.arrayContaining([
          expect.objectContaining({ id: workItemId }),
        ]),
      });
      expect(compactBefore.data).not.toHaveProperty("project");

      const note = "已复核合成工时记录。";
      const command = {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: state.version,
        reason: "精简进展返回回归",
        payload: {
          confirmation: "确认在合成演示库记录本条进展",
          stateFingerprint: state.stateFingerprint,
          operation: { action: "progress.record", workItemId, note },
        },
      };
      const args = { ...command, responseFormat: "compact" };
      expect((await readOnlyMcp.call("work.execute", args)).failure?.code).toBe(
        "PERMISSION_DENIED",
      );
      const wrongProject = await mcp.call("work.execute", {
        ...args,
        projectId: "PRJ-0D-001",
      });
      expect(wrongProject.failure?.code).toBe("FORBIDDEN");
      const written = await mcp.call("work.execute", args);
      expect(written.data).toMatchObject({
        requestId: command.requestId,
        version: state.version + 1,
        replayed: false,
        data: {
          responseFormat: "compact",
          projectId,
          action: "progress.record",
          item: { id: workItemId, progressUpdate: { note } },
        },
      });
      expect(written.data).not.toHaveProperty("data.project");

      const fullReplay = await mcp.call("work.execute", {
        ...command,
        projectId,
      });
      const compactReplay = await mcp.call("work.execute", args);
      for (const replay of [fullReplay, compactReplay]) {
        expect(replay.data).toMatchObject({
          requestId: command.requestId,
          version: state.version + 1,
          replayed: true,
        });
      }
      expect(fullReplay.data).toHaveProperty("data.project.phases");
      const fullAfter = await mcp.call("work.operations", { projectId });
      const readback = await mcp.call("work.operations", {
        ...format,
        workItemId,
      });
      const readOnlyReadback = await readOnlyMcp.call("work.operations", {
        ...format,
        workItemId,
      });
      expect(readOnlyReadback.data).toEqual(readback.data);
      expect(readback.data).toMatchObject({
        responseFormat: "compact",
        version: state.version + 1,
        item: { id: workItemId, progressUpdate: { note } },
      });
      expect(readback.data).not.toHaveProperty("stateFingerprint");
      const current = workExecutionContextSchema.parse(fullAfter.data);
      const phase = current.project?.phases.find((stage) =>
        stage.tasks.some((item) => item.id === workItemId),
      );
      const latest = phase?.tasks.find((item) => item.id === workItemId);
      expect(readback.data?.item).toEqual({
        id: workItemId,
        title: latest?.title,
        status: latest?.status,
        progressUpdate: latest?.progressUpdate,
        phaseCode: phase?.code,
        phaseName: phase?.name,
      });

      const hidden = await pool.query<{ id: string }>(
        `SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id
          WHERE n.project_id = $1 AND s.owner = 'OWNER' LIMIT 1`,
        [projectId],
      );
      expect(hidden.rows[0]).toBeDefined();
      for (const itemId of ["UNKNOWN-ITEM", hidden.rows[0]!.id]) {
        expect(
          (await mcp.call("work.operations", { ...format, workItemId: itemId }))
            .failure?.code,
        ).toBe("NOT_FOUND");
      }

      const receipts = await pool.query(
        "SELECT response FROM governed_command_receipts WHERE request_id = $1",
        [command.requestId],
      );
      expect(receipts.rowCount).toBe(1);
      expect(receipts.rows[0].response).toHaveProperty("project");
      expect(receipts.rows[0].response).not.toHaveProperty("responseFormat");

      const full = [fullBefore, fullReplay, fullAfter];
      const compact = [compactBefore, compactReplay, readback];
      const sum = (results: typeof full, field: "textBytes" | "resultBytes") =>
        results.reduce((total, result) => total + result[field], 0);
      const fullText = sum(full, "textBytes");
      const compactText = sum(compact, "textBytes");
      expect(compactText).toBeLessThanOrEqual(fullText * 0.7);
      record("同项目进展返回体积对照", {
        写前文本字节: `${fullBefore.textBytes} → ${compactBefore.textBytes}`,
        回执文本字节: `${fullReplay.textBytes} → ${compactReplay.textBytes}`,
        回读文本字节: `${fullAfter.textBytes} → ${readback.textBytes}`,
        完整文本字节: fullText,
        精简文本字节: compactText,
        文本减少百分比: Math.round((1 - compactText / fullText) * 100),
        完整结果字节: sum(full, "resultBytes"),
        精简结果字节: sum(compact, "resultBytes"),
        数据库回执: receipts.rowCount ?? 0,
      });
    });

    it("validates OAuth grants, blocks read-only writes and reads the authorized receipt back", async () => {
      const httpPort = 39_000 + Math.floor(Math.random() * 3_000);
      const remoteUrl = `http://127.0.0.1:${httpPort}/mcp`;
      const otherResource = new URL("/other-resource", remoteUrl).href;
      const metadataUrl = new URL(
        "/.well-known/oauth-protected-resource/mcp",
        remoteUrl,
      ).href;
      const issuer = await startOAuthTestIssuer([remoteUrl, otherResource]);
      const remote = spawn(process.execPath, [mcpHttpEntry], {
        env: {
          ...process.env,
          DINGJIANG_MCP_HTTP_URL: remoteUrl,
          DINGJIANG_MCP_HTTP_PORT: String(httpPort),
          DINGJIANG_MCP_OAUTH_ISSUER: issuer.issuer,
          DINGJIANG_MCP_OAUTH_JWKS_URL: issuer.jwksUrl,
          DINGJIANG_MCP_OAUTH_BINDINGS_JSON: JSON.stringify([
            { subject: "e2e-pmc", integrationToken: pmcToken },
            { subject: "e2e-api-readonly", integrationToken: readOnlyToken },
          ]),
          DINGJIANG_API_BASE_URL: baseUrl,
          DINGJIANG_API_ALLOWED_HOSTS: "127.0.0.1",
          DINGJIANG_MCP_API_TOKEN: "",
          DINGJIANG_MCP_READ_ONLY: "0",
          DINGJIANG_MCP_TOOL_SURFACE: "",
        },
        stdio: "ignore",
      });
      const request = (
        token: string | undefined,
        method: string,
        params: Record<string, unknown> = {},
        headers: Record<string, string> = {},
      ) =>
        fetch(remoteUrl, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version":
              modernMeta["io.modelcontextprotocol/protocolVersion"],
            "mcp-method": method,
            ...(method === "tools/call"
              ? { "mcp-name": String(params.name) }
              : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method,
            params: { ...params, _meta: modernMeta },
          }),
        });
      const call = async (
        token: string,
        name: string,
        args: Record<string, unknown> = {},
      ): Promise<JsonRpcResponse> => {
        const response = await request(token, "tools/call", {
          name,
          arguments: args,
        });
        return (await response.json()) as JsonRpcResponse;
      };

      try {
        await waitForHealth(metadataUrl);
        const unauthenticated = await request(undefined, "server/discover");
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers.get("www-authenticate")).toContain(
          `resource_metadata="${metadataUrl}"`,
        );

        const metadata = (await (await fetch(metadataUrl)).json()) as {
          resource: string;
          authorization_servers: string[];
          scopes_supported: string[];
        };
        expect(metadata).toMatchObject({
          resource: remoteUrl,
          authorization_servers: [issuer.issuer],
          scopes_supported: [oauthRead, oauthWrite],
        });
        const authorizationServer = metadata.authorization_servers[0]!;
        const [read, write, wrongAudience, noReadScope, unbound, apiReadOnly] =
          await Promise.all([
            obtainOAuthToken(authorizationServer, metadata.resource, [
              oauthRead,
            ]),
            obtainOAuthToken(authorizationServer, metadata.resource, [
              oauthRead,
              oauthWrite,
            ]),
            obtainOAuthToken(authorizationServer, otherResource, [oauthRead]),
            obtainOAuthToken(authorizationServer, metadata.resource, [
              oauthWrite,
            ]),
            obtainOAuthToken(
              authorizationServer,
              metadata.resource,
              [oauthRead],
              "e2e-unbound",
            ),
            obtainOAuthToken(
              authorizationServer,
              metadata.resource,
              [oauthRead, oauthWrite],
              "e2e-api-readonly",
            ),
          ]);
        // Exercise a cold JWKS cache. The same token should work once keys return.
        issuer.setJwksAvailable(false);
        const unavailable = await request(read, "tools/list");
        expect(unavailable.status).toBe(500);
        expect(unavailable.headers.get("www-authenticate")).toBeNull();
        expect(await unavailable.json()).toMatchObject({
          error: "server_error",
        });
        issuer.setJwksAvailable(true);
        expect((await request(read, "tools/list")).status).toBe(200);

        const invalid = await request(wrongAudience, "tools/list");
        expect(invalid.status).toBe(401);
        expect(invalid.headers.get("www-authenticate")).toContain(
          "invalid_token",
        );
        expect((await request("malformed", "tools/list")).status).toBe(401);
        const scopeDenied = await request(noReadScope, "tools/list");
        expect(scopeDenied.status).toBe(403);
        expect(scopeDenied.headers.get("www-authenticate")).toContain(
          "insufficient_scope",
        );
        expect((await request(unbound, "tools/list")).status).toBe(403);
        expect(
          (
            await request(
              read,
              "tools/list",
              {},
              { origin: "https://other.example.invalid" },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await fetch(`${baseUrl}/integration/events`, {
              headers: { authorization: `Bearer ${write}` },
            })
          ).status,
        ).toBe(401);

        const discovered = await request(read, "server/discover");
        expect(discovered.status).toBe(200);
        expect(discovered.headers.get("mcp-session-id")).toBeNull();
        expect(await discovered.json()).toMatchObject({
          result: {
            supportedVersions: ["2026-07-28"],
            instructions: expect.stringContaining("只读"),
          },
        });
        const listRead = (await (
          await request(read, "tools/list")
        ).json()) as JsonRpcResponse;
        expect(listRead.result?.tools).toHaveLength(7);
        expect(listRead.result?.tools).not.toContainEqual(
          expect.objectContaining({ name: "work.execute" }),
        );
        const listWrite = (await (
          await request(write, "tools/list")
        ).json()) as JsonRpcResponse;
        expect(listWrite.result?.tools).toHaveLength(13);

        const state = workExecutionContextSchema.parse(
          (await call(read, "work.operations", { projectId })).result
            ?.structuredContent,
        );
        const workItem = state.project?.phases
          .flatMap((phase) => phase.tasks)
          .find((item) => item.owner === "PMC" && item.status !== "DONE");
        if (!workItem) throw new Error("Missing remote MCP fixture work item");

        const requestId = randomUUID();
        const note = "通过 OAuth 授权的远程 MCP 已复核采购到料时间。";
        const command = {
          projectId,
          requestId,
          correlationId: randomUUID(),
          expectedVersion: state.version,
          reason: "远程 MCP 端到端测试",
          payload: {
            stateFingerprint: state.stateFingerprint,
            confirmation: "确认记录本次远程测试进展",
            operation: {
              action: "progress.record",
              workItemId: workItem.id,
              note,
            },
          },
        };

        expect(await call(read, "work.execute", command)).toMatchObject({
          error: { code: -32602, data: { code: "UNKNOWN_TOOL" } },
        });
        const limitedContext = integrationWorkContextSchema.parse(
          (await call(apiReadOnly, "work.context", { projectId })).result
            ?.structuredContent,
        );
        expect(limitedContext.context.sourceTask).toMatchObject({
          facts: [],
          evidence: [],
          materials: [],
          materialGaps: [],
        });
        expect(
          limitedContext.context.project.latestConfirmedWorkpaper,
        ).toBeNull();
        const denied = (await call(apiReadOnly, "work.execute", command))
          .result;
        expect(denied).toMatchObject({ isError: true });
        expect(denied).not.toHaveProperty("structuredContent");
        const errorContent = denied?.content as Array<{ text: string }>;
        expect(JSON.parse(errorContent[0]!.text)).toMatchObject({
          code: "PERMISSION_DENIED",
          correlationId: command.correlationId,
        });
        const receiptCount = async () =>
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM governed_command_receipts WHERE request_id = $1",
              [requestId],
            )
          ).rows[0]?.count;
        expect(await receiptCount()).toBe(0);

        const receipts = await Promise.all([
          call(write, "work.execute", command),
          call(write, "work.execute", command),
        ]);
        for (const response of receipts)
          expect(response.result?.structuredContent).toMatchObject({
            version: state.version + 1,
          });
        const replayFlags = receipts.map(
          (response) =>
            (response.result?.structuredContent as { replayed?: boolean })
              .replayed,
        );
        expect(replayFlags.sort()).toEqual([false, true]);
        expect(await receiptCount()).toBe(1);
        const snapshot = integrationWorkspaceResumeSchema.parse(
          (await call(read, "workspace.resume")).result?.structuredContent,
        );
        expect(
          snapshot.workItems.items.find((item) => item.id === workItem.id)
            ?.progressUpdate?.note,
        ).toBe(note);
        expect(snapshot.evidence.items[0]?.sourceFile).toBe("orders.csv");
        const progressReadback = workProgressReadbackSchema.parse(
          (
            await call(read, "work.operations", {
              projectId,
              workItemId: workItem.id,
              responseFormat: "compact",
            })
          ).result?.structuredContent,
        );
        expect(progressReadback).toMatchObject({
          version: state.version + 1,
          item: { id: workItem.id, progressUpdate: { note } },
        });
        const workContext = integrationWorkContextSchema.parse(
          (await call(read, "work.context", { projectId })).result
            ?.structuredContent,
        );
        expect(
          workContext.workItems.items.find((item) => item.id === workItem.id)
            ?.progressUpdate?.note,
        ).toBe(note);
        const evidenceBundle = integrationEvidenceBundleSchema.parse(
          (await call(read, "evidence.bundle", { projectId })).result
            ?.structuredContent,
        );
        expect(evidenceBundle.evidence).toEqual(snapshot.evidence);
        expect(evidenceBundle.materials).toEqual(snapshot.materials);
        expect(evidenceBundle.proposals).toEqual(snapshot.proposals);
        record("远程 MCP 经 OAuth 拦截与写入回读", {
          只读工具数: 7,
          提交版本: state.version + 1,
          数据库回执: 1,
          "MCP 回读": note,
        });
      } finally {
        if (remote.exitCode === null && remote.signalCode === null) {
          const exited = once(remote, "exit");
          remote.kill();
          await exited;
        }
        await issuer.close();
      }
    }, 75_000);
  },
);
