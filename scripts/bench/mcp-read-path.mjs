#!/usr/bin/env node
/**
 * Compare aggregate and individual reads on the real MCP and API.
 *
 * Build the API before the change and copy apps/api/dist and apps/api/migrations
 * into one baseline directory. Copy the baseline MCP build into its mcp-dist
 * subdirectory when comparing both components. Otherwise both versions use
 * the current MCP. Build the candidate API and MCP in this repo.
 * Set BENCH_DATABASE_URL to a disposable loopback PostgreSQL database named
 * dingjiang_next_action_bench. Start PostgreSQL with pg_stat_statements loaded
 * and install the extension in the postgres database. The API migrates and
 * seeds the benchmark database, creates two demo projects and binds the MCP
 * credential to one of them. It also imports a readable CSV fixture.
 *
 * Pass --workpaper to bind the token to the root-cause project and seed a draft.
 *
 * node scripts/bench/mcp-read-path.mjs <baseline directory> [--workpaper] > comparison.json
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apiDir = join(root, "apps/api");
const { Client } = createRequire(join(apiDir, "package.json"))("pg");
const baselineDir = process.argv[2];
assert.ok(
  baselineDir,
  "Pass the baseline directory containing dist and migrations.",
);
const database = URL.parse(process.env.BENCH_DATABASE_URL ?? "");
assert.ok(
  database?.protocol === "postgres:" &&
    database.hostname === "127.0.0.1" &&
    database.pathname === "/dingjiang_next_action_bench" &&
    !database.search,
  "BENCH_DATABASE_URL must point to the disposable loopback benchmark database.",
);

const mcpDist = join(root, "services/dingjiang-mcp/dist");
const baselineMcp = resolve(baselineDir, "mcp-dist");
const versions = [
  {
    name: "baseline",
    dist: resolve(baselineDir, "dist"),
    mcp: existsSync(baselineMcp) ? baselineMcp : mcpDist,
  },
  { name: "candidate", dist: join(apiDir, "dist"), mcp: mcpDist },
];
const withWorkpaper = process.argv.includes("--workpaper");
const sourceTaskId = withWorkpaper ? "SO-202608136" : "SO-202608128";
const warmup = 25;
const blocks = 4;
const samplesPerBlock = 50;
const token = randomUUID();
const osEnv = {
  Path: process.env.Path ?? process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
};

async function apiWorker() {
  require("reflect-metadata");
  const { randomUUID } = require("node:crypto");
  const { join } = require("node:path");
  const { NestFactory } = require("@nestjs/core");
  const dist = process.argv[1];
  const { AppModule } = require(join(dist, "app.module.js"));
  const { Vs01Service } = require(join(dist, "vs01.service.js"));
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");

  const business = app.get(Vs01Service);
  const sourceTaskId = process.argv[2];
  const projects = await business.projectList();
  for (const id of ["SO-202608128", "SO-202608136"]) {
    if (projects.some((project) => project.sourceTaskId === id)) continue;
    await business.decideTask(id, {
      actor: "PMC",
      type: "CONFIRMED",
      note: "Isolated read-path benchmark",
    });
    projects.push(
      await business.createProject({ actor: "PMC", sourceTaskId: id }),
    );
  }
  const project = projects.find((item) => item.sourceTaskId === sourceTaskId);
  if (!project) throw new Error("Missing benchmark project");
  process.env.DINGJIANG_MCP_PROJECT_IDS = project.id;

  const task = await business.task(sourceTaskId);
  const title = "Isolated benchmark material";
  let material = task.materials.find(
    (item) => item.title === title && item.status === "ACTIVE",
  );
  if (!material) {
    const buffer = Buffer.from("date,capacity\n2026-08-20,92%");
    material = await business.importTaskMaterial(
      sourceTaskId,
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title,
        requestId: randomUUID(),
      },
      { originalName: "capacity.csv", buffer, size: buffer.length },
    );
  }
  const evidence = task.evidence[0];
  if (!evidence || !material?.id)
    throw new Error("Missing read-path benchmark fixtures");
  if (sourceTaskId === "SO-202608136") {
    const { RootCauseWorkpaperService } = require(
      join(dist, "workpapers/root-cause-workpaper.service.js"),
    );
    const workpapers = app.get(RootCauseWorkpaperService);
    const view = await workpapers.view(project.id);
    if (view.revision === 0) {
      await workpapers.candidate(project.id, {
        actor: "PMC",
        requestId: randomUUID(),
        expectedRevision: 0,
        materialIds: [material.id],
      });
    }
  }
  process.send({
    port: app.getHttpServer().address().port,
    projectId: project.id,
    evidenceId: evidence.id,
    sourceVersionId: evidence.sourceVersionId,
    materialId: material.id,
  });
}

const processes = [];
const start = (args, stdio, env) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    stdio,
    env: { ...osEnv, ...env },
  });
  processes.push({ child, done: once(child, "close") });
  return child;
};

const openMcp = async ({ dist, mcp: mcpDir }) => {
  const api = start(
    [
      "-e",
      "(" +
        apiWorker.toString() +
        ")().catch(error => { console.error(error.message); process.exit(1); })",
      dist,
      sourceTaskId,
    ],
    ["ignore", "ignore", "inherit", "ipc"],
    {
      NODE_PATH: join(apiDir, "node_modules"),
      DATABASE_URL: database.href,
      DINGJIANG_DEPLOYMENT_MODE: "demo",
      FEISHU_PROVIDER_MODE: "DEMO_RULES",
      DINGJIANG_MCP_API_TOKEN: token,
      DINGJIANG_RATE_LIMIT_READ_PER_MIN: "100000",
      VS15_MATERIAL_VAULT_ROOT: resolve(baselineDir, "benchmark-materials"),
    },
  );
  const [{ port, ...fixture }] = await once(api, "message", {
    signal: AbortSignal.timeout(30000),
  });
  const business = await openSession(mcpDir, port, "business");
  const compatibility = await openSession(mcpDir, port, "compatibility");
  return {
    fixture,
    call: ({ surface, ...params }) =>
      (surface === "compatibility" ? compatibility : business)(params),
  };
};

const openSession = async (mcpDir, port, surface) => {
  const mcp = start([join(mcpDir, "server.js")], ["pipe", "pipe", "inherit"], {
    NODE_PATH: join(root, "services/dingjiang-mcp/node_modules"),
    DINGJIANG_API_BASE_URL: "http://127.0.0.1:" + port + "/api",
    DINGJIANG_MCP_API_TOKEN: token,
    DINGJIANG_MCP_TOOL_SURFACE: surface,
  });
  const output = createInterface({ input: mcp.stdout });
  let id = 0;
  const request = async (method, params) => {
    const line = once(output, "line", { signal: AbortSignal.timeout(12000) });
    mcp.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n",
    );
    const reply = JSON.parse((await line)[0]);
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined);
    assert.ok(reply.result && !reply.result.isError, method + " failed");
    return reply.result;
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-read-path-benchmark", version: "1" },
  });
  mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return async (call) => (await request("tools/call", call)).structuredContent;
};

const monitorUrl = new URL(database);
monitorUrl.pathname = "/postgres";
const monitor = new Client({ connectionString: monitorUrl.href });
const statements = async () => {
  const { rows } = await monitor.query(
    "SELECT query, sum(calls) AS calls FROM pg_stat_statements " +
      "WHERE toplevel AND dbid = (SELECT oid FROM pg_database WHERE datname = $1) " +
      "GROUP BY query",
    [database.pathname.slice(1)],
  );
  return new Map(rows.map(({ query, calls }) => [query, Number(calls)]));
};
const percentile = (durations, fraction) => {
  const sorted = durations.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};

try {
  await monitor.connect();
  await statements();
  for (const version of versions)
    Object.assign(version, await openMcp(version));
  const [
    {
      fixture: { projectId, evidenceId, materialId, sourceVersionId },
    },
  ] = versions;
  assert.deepEqual(
    versions[1].fixture,
    versions[0].fixture,
    "Fixture IDs changed",
  );
  const toolCalls = [
    { name: "project.next_action", arguments: { projectId } },
    { name: "workspace.resume", arguments: {} },
    { name: "work.context", arguments: { projectId } },
    { name: "evidence.bundle", arguments: { projectId } },
    { name: "get_current_work_item", arguments: {}, surface: "compatibility" },
    {
      name: "get_project_state",
      arguments: { projectId },
      surface: "compatibility",
    },
    {
      name: "list_traceable_materials",
      arguments: { projectId },
      surface: "compatibility",
    },
    {
      name: "list_evidence",
      arguments: { projectId },
      surface: "compatibility",
    },
    {
      name: "get_evidence",
      arguments: { projectId, evidenceId },
      surface: "compatibility",
    },
    {
      name: "get_material_preview",
      arguments: { projectId, materialId },
      surface: "compatibility",
    },
    {
      name: "get_source_version",
      arguments: { projectId, sourceVersionId },
      surface: "compatibility",
    },
  ];
  if (withWorkpaper)
    toolCalls.push({
      name: "get_validation_workpaper",
      arguments: { projectId },
      surface: "compatibility",
    });
  const results = [];
  for (const call of toolCalls) {
    const measurements = versions.map(() => ({
      durations: [],
      calls: new Map(),
      blockP95: [],
    }));
    let expected;
    for (const version of versions) {
      for (let index = 0; index < warmup; index++) {
        const payload = await version.call(call);
        assert.equal(
          call.name === "get_project_state" ? payload.id : payload.projectId,
          projectId,
        );
        if (call.name === "get_validation_workpaper")
          assert.ok(payload.history.length > 0);
        if (call.name === "workspace.resume")
          assert.equal(payload.nextAction.classification, "PROPOSAL");
        if (call.name === "project.next_action")
          assert.equal(payload.classification, "PROPOSAL");
        if (call.name === "get_material_preview")
          assert.equal(payload.bodyAvailable, true);
        expected ??= payload;
        assert.deepEqual(payload, expected, call.name + " response changed");
      }
    }

    for (let block = 0; block < blocks; block++) {
      for (const index of block % 2 === 0 ? [0, 1] : [1, 0]) {
        const measurement = measurements[index];
        const before = await statements();
        const durations = [];
        for (let sample = 0; sample < samplesPerBlock; sample++) {
          const startTime = performance.now();
          const payload = await versions[index].call(call);
          durations.push(performance.now() - startTime);
          assert.deepEqual(payload, expected, call.name + " response changed");
        }
        for (const [query, count] of await statements()) {
          const delta = count - (before.get(query) ?? 0);
          assert.ok(
            delta >= 0,
            "PostgreSQL counters reset during the comparison",
          );
          if (delta > 0)
            measurement.calls.set(
              query,
              (measurement.calls.get(query) ?? 0) + delta,
            );
        }
        measurement.durations.push(...durations);
        measurement.blockP95.push(percentile(durations, 0.95));
      }
    }

    for (const [index, measurement] of measurements.entries()) {
      const samples = measurement.durations.length;
      const sql = [...measurement.calls.entries()].toSorted(
        (left, right) => right[1] - left[1],
      );
      const total = sql.reduce((sum, [, count]) => sum + count, 0);
      const http = sql.find(([query]) =>
        /^INSERT INTO api_rate_limit_windows\b/i.test(query),
      )?.[1];
      assert.ok(http && total >= http, "Expected rate limit and business SQL");
      results.push({
        tool: call.name,
        version: versions[index].name,
        samples,
        sqlPerCall: total / samples,
        httpPerCall: http / samples,
        p50Ms: percentile(measurement.durations, 0.5),
        p95Ms: percentile(measurement.durations, 0.95),
        blockP95Ms: measurement.blockP95,
        sql: sql.map(([query, count]) => ({
          callsPerTool: count / samples,
          query: query.replace(/\s+/g, " ").trim(),
        })),
      });
    }
  }
  const sha256 = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const builds = {};
  for (const { name, dist, mcp } of versions) {
    builds[name] = {
      api: await sha256(join(dist, "integration/integration.service.js")),
      readModel: await sha256(join(dist, "read-model/read-model-service.js")),
      mcp: await sha256(join(mcp, "tools/dispatch.js")),
    };
  }
  console.log(
    JSON.stringify(
      {
        builds,
        sourceTaskId,
        warmupPerVersionAndTool: warmup,
        samplesPerBlock,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { child } of processes.toReversed()) child.kill();
  await Promise.all(processes.map(({ done }) => done));
  await monitor.end();
}
