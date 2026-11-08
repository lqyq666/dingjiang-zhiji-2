import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
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

const repoRoot = resolve(process.cwd(), "../..");
const apiEntry = resolve(process.cwd(), "dist/main.js");
const mcpEntry = resolve(repoRoot, "services/dingjiang-mcp/dist/server.js");

const pmcToken = `real-e2e-pmc-${randomUUID()}`;
const readOnlyToken = `real-e2e-readonly-${randomUUID()}`;

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

  constructor(token: string, baseUrl: string) {
    this.child = spawn(process.execPath, [mcpEntry], {
      env: {
        ...process.env,
        DINGJIANG_API_BASE_URL: baseUrl,
        DINGJIANG_MCP_API_TOKEN: token,
        DINGJIANG_MCP_TOOL_SURFACE: "",
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
      this.pending.delete(id);
    });
  }

  get errorOutput(): string {
    return this.stderr.join("");
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): Promise<JsonRpcResponse> {
    const id = randomUUID();
    const settled = new Promise<JsonRpcResponse>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}`)),
        timeoutMs,
      );
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      });
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`MCP exited with ${code} during ${method}`));
      });
    });
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
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
    return isError
      ? { failure: payload, isError }
      : { data: result.structuredContent, isError };
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
    let readOnlyMcp: McpProcess;
    let projectId: string;
    let version: number;
    let stateFingerprint: string;
    let workItemId: string;
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
        env: {
          ...process.env,
          PORT: String(port),
          API_HOST: "127.0.0.1",
          VS15_MATERIAL_VAULT_ROOT: resolve(
            process.cwd(),
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
      readOnlyMcp = new McpProcess(readOnlyToken, baseUrl);
    }, 180_000);

    afterAll(async () => {
      await mcp?.stop();
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
    }, 120_000);

    it("negotiates over stdio and publishes the governed surface", async () => {
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
    });

    it("reads the workspace and derives a PROPOSAL next action", async () => {
      const resumed = await mcp.call("workspace.resume");
      expect(resumed.isError).toBe(false);
      const nextAction = resumed.data?.nextAction as {
        classification: string;
        projectId: string;
      };
      expect(nextAction.projectId).toBe(projectId);
      // The derived classification is the product invariant: never FACT.
      expect(nextAction.classification).toBe("PROPOSAL");
      // A freshly created project has no workpaper. The composite must report the
      // absence rather than collapsing; this is the regression the real run found.
      expect(resumed.data?.workpaper).toBeNull();

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
      const denied = await readOnlyMcp.call("work.execute", {
        projectId,
        requestId: randomUUID(),
        correlationId: randomUUID(),
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
      expect(denied.failure?.code).toBe("PERMISSION_DENIED");
      // A permission denial is not something the model may retry its way out of.
      expect(denied.failure?.retryable).toBe(false);
      expect(denied.failure?.requiresHuman).toBe(true);
    });

    it("runs a governed write, replays it safely and rejects a stale version", async () => {
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
            note: "真实端到端测试写入的服务端事实",
          },
        },
      };

      const written = await mcp.call("work.execute", command);
      expect(written.isError).toBe(false);
      const receipt = written.data as { version: number; replayed: boolean };
      expect(receipt.replayed).toBe(false);
      expect(receipt.version).toBe(version + 1);

      // Same requestId must return the original receipt instead of writing again.
      const replay = await mcp.call("work.execute", command);
      expect(replay.isError).toBe(false);
      expect((replay.data as { replayed: boolean }).replayed).toBe(true);
      expect((replay.data as { version: number }).version).toBe(
        receipt.version,
      );

      // A new requestId carrying the pre-write version must be refused.
      const stale = await mcp.call("work.execute", {
        ...command,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      expect(stale.isError).toBe(true);
      expect(stale.failure?.code).toBe("STALE_VERSION");

      const persisted = await pool.query(
        "SELECT count(*)::int AS count FROM vs01_project_subtasks WHERE progress_note = $1",
        ["真实端到端测试写入的服务端事实"],
      );
      expect(persisted.rows[0].count).toBe(1);

      // Three calls (write, replay, stale retry) must leave exactly one receipt:
      // the replay is answered from the ledger and the stale attempt is refused
      // before it reaches it.
      const receipts = await pool.query(
        "SELECT count(*)::int AS count, max(result_version)::int AS version FROM governed_command_receipts WHERE request_id = $1",
        [requestId],
      );
      expect(receipts.rows[0].count).toBe(1);
      expect(receipts.rows[0].version).toBe(version + 1);
    });
  },
);
