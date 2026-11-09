#!/usr/bin/env node
/**
 * Full integration suite orchestrator.
 *
 * The repository ships over 100 database-backed tests behind `*_INTEGRATION=1`
 * switches, and three of them refuse to run against the shared dev database
 * because they reset it. Running them all used to require knowing which switch
 * belongs to which file, which database name each refuses to run without, and
 * that they cannot share a database in parallel.
 *
 * This script owns that knowledge:
 *
 *   tier 1  every API test file with all switches on, serial, shared database
 *   tier 2  VS17 against its own database
 *   tier 3  VS18 against its own database
 *   tier 4  real end-to-end: MCP process → HTTP → API process → PostgreSQL
 *   tier 5  real web data layer → HTTP → API process → PostgreSQL
 *
 * Any failure fails the run. Nothing here needs a model credential, a Feishu
 * app or network access beyond loopback.
 *
 * Usage:
 *   node scripts/testing/run-integration-suite.mjs
 *   node scripts/testing/run-integration-suite.mjs --tier=e2e
 *   node scripts/testing/run-integration-suite.mjs --tier=web
 *   DATABASE_URL=postgres://... node scripts/testing/run-integration-suite.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const apiDir = join(root, "apps/api");
const webDir = join(root, "apps/web");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
// `pg` is a dependency of the API package, not of the repository root, so it
// has to be resolved from there.
const pg = createRequire(join(apiDir, "package.json"))("pg");

const DEFAULT_DATABASE_URL =
  "postgres://dingjiang:local-only-password@127.0.0.1:5432/dingjiang";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const tierFilter = process.argv
  .find((argument) => argument.startsWith("--tier="))
  ?.slice("--tier=".length);
const coverage = process.argv.includes("--coverage");

/** Every switch the suite honours. Keeping them here is the point. */
const switches = {
  VS05_INTEGRATION: "1",
  VS11_INTEGRATION: "1",
  VS12_INTEGRATION: "1",
  VS14_INTEGRATION: "1",
  VS14_HTTP_INTEGRATION: "1",
  VS15_INTEGRATION: "1",
  VS15_HTTP_INTEGRATION: "1",
  VS16_INTEGRATION: "1",
  VS16_HTTP_INTEGRATION: "1",
  VS18_INTEGRATION: "1",
  VS18_HTTP_INTEGRATION: "1",
  MATERIAL_CREATE_INTEGRATION: "1",
  MATERIAL_CREATE_HTTP_INTEGRATION: "1",
  MATERIAL_VERIFICATION_INTEGRATION: "1",
  MATERIAL_VERIFICATION_HTTP_INTEGRATION: "1",
  EVIDENCE_INTAKE_INTEGRATION: "1",
  EVIDENCE_INTAKE_HTTP_INTEGRATION: "1",
  WORKPAPER_PROPOSAL_INTEGRATION: "1",
  WORKPAPER_PROPOSAL_HTTP_INTEGRATION: "1",
  WORK_EXECUTION_INTEGRATION: "1",
  INTEGRATION_HTTP_INTEGRATION: "1",
  GOVERNED_COMMAND_INTEGRATION: "1",
  ACCEPTANCE_FIXTURE_INTEGRATION: "1",
  ACCEPTANCE_FIXTURE_HTTP_INTEGRATION: "1",
  MATERIAL_VERIFICATION_FIXTURE_INTEGRATION: "1",
  EVIDENCE_FIXTURE_INTEGRATION: "1",
  PRODUCTION_INTEGRATION: "1",
  INDEX_AUDIT_INTEGRATION: "1",
  FEISHU_DELIVERY_INTEGRATION: "1",
  MIGRATION_DRIFT_INTEGRATION: "1",
};

const reservedDatabases = {
  vs17: "dingjiang_vs17_test",
  vs18: "dingjiang_vs18_test",
  web: "dingjiang_web_e2e",
};

const listTestFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTestFiles(path)));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
};

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

const runVitest = (
  label,
  { files, env, cwd = apiDir, coverage: withCoverage = false },
) =>
  new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "--no-file-parallelism",
        ...(withCoverage ? ["--coverage"] : []),
        ...files,
      ],
      {
        cwd,
        env: {
          ...process.env,
          ...switches,
          ...env,
          // The suite drives one credential from many files in a single minute,
          // which is not the behaviour the ceiling is meant to police. The 429
          // path is covered by rate-limit.service.test.ts; production keeps the
          // limit on by default.
          DINGJIANG_RATE_LIMIT_ENABLED: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      const plain = stripAnsi(output);
      const summary = plain
        .split("\n")
        .filter((line) => /Tests\s+\d|Test Files\s+\d/.test(line))
        .map((line) => line.replace(/\s+/g, " ").trim());
      resolvePromise({
        label,
        code,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        summary,
        output: plain,
      });
    });
  });

const ensureDatabase = async (name) => {
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${name}`);
      return `created ${name}`;
    }
    return `${name} ready`;
  } finally {
    await client.end();
  }
};

const withDatabase = (name) => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const main = async () => {
  // tier4 and tier5 spawn the packaged entrypoints, so a missing build is a
  // setup error, not a test failure. Say so instead of failing inside the spawn.
  if (
    !tierFilter ||
    tierFilter === "tier4" ||
    tierFilter === "tier5" ||
    tierFilter === "e2e" ||
    tierFilter === "web"
  ) {
    const entries = [
      join(apiDir, "dist/main.js"),
      join(root, "services/dingjiang-mcp/dist/server.js"),
    ];
    const missing = entries.filter((entry) => !existsSync(entry));
    if (missing.length > 0) {
      console.error(
        `真实端到端需要构建产物，缺少：\n${missing.map((entry) => `- ${entry}`).join("\n")}\n先运行 \`pnpm build\`。`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const probe = new URL(databaseUrl);
  probe.pathname = "/postgres";
  const client = new pg.Client({ connectionString: probe.toString() });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    console.error(
      `无法连接 PostgreSQL（${databaseUrl}）。先运行 \`docker compose up -d postgres\`。\n${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    await client.end().catch(() => undefined);
  }

  const allFiles = await listTestFiles(join(apiDir, "src"));
  const dedicated = [
    join(apiDir, "src/vs17.integration.test.ts"),
    join(apiDir, "src/vs17-http.integration.test.ts"),
    join(apiDir, "src/vs18.integration.test.ts"),
    join(apiDir, "src/vs18-http.integration.test.ts"),
    join(apiDir, "src/integration/real-e2e.integration.test.ts"),
  ];
  const sharedFiles = allFiles.filter((file) => !dedicated.includes(file));
  const e2eFiles = [
    join(apiDir, "src/integration/real-e2e.integration.test.ts"),
  ];
  const vs17Files = [
    join(apiDir, "src/vs17.integration.test.ts"),
    join(apiDir, "src/vs17-http.integration.test.ts"),
  ];
  const vs18Files = [
    join(apiDir, "src/vs18.integration.test.ts"),
    join(apiDir, "src/vs18-http.integration.test.ts"),
  ];
  const webFiles = [join(webDir, "src/api-live.integration.test.ts")];

  const notes = [];
  for (const name of Object.values(reservedDatabases))
    notes.push(await ensureDatabase(name));

  const tiers = [
    {
      name: "tier1 全部 API 测试（含开关）",
      files: sharedFiles,
      coverage,
      env: {
        DATABASE_URL: databaseUrl,
        VS17_INTEGRATION: "",
        REAL_E2E: "",
        WEB_E2E: "",
      },
    },
    {
      name: "tier2 VS17 专用库",
      files: vs17Files,
      env: {
        DATABASE_URL: withDatabase(reservedDatabases.vs17),
        VS17_INTEGRATION: "1",
        VS17_HTTP_INTEGRATION: "1",
      },
    },
    {
      name: "tier3 VS18 专用库",
      files: vs18Files,
      env: {
        DATABASE_URL: withDatabase(reservedDatabases.vs18),
        VS18_INTEGRATION: "1",
        VS18_HTTP_INTEGRATION: "1",
      },
    },
    {
      name: "tier4 真实端到端（MCP 进程 → HTTP → API 进程 → PostgreSQL）",
      files: e2eFiles,
      env: {
        DATABASE_URL: databaseUrl,
        REAL_E2E: "1",
        // The suite drives many writes through one credential from several
        // processes. The 429 path is covered by rate-limit.service.test.ts;
        // here the ceiling only needs to stay out of the way.
        DINGJIANG_RATE_LIMIT_READ_PER_MIN: "100000",
        DINGJIANG_RATE_LIMIT_WRITE_PER_MIN: "100000",
      },
    },
    {
      name: "tier5 真实前端数据层（Web → HTTP → API 进程 → PostgreSQL）",
      files: webFiles,
      cwd: webDir,
      env: {
        DATABASE_URL: withDatabase(reservedDatabases.web),
        WEB_E2E: "1",
      },
    },
  ].filter((tier) => {
    if (!tierFilter) return true;
    if (tierFilter === "e2e") return tier.name.startsWith("tier4");
    if (tierFilter === "web") return tier.name.startsWith("tier5");
    return tier.name.startsWith(tierFilter);
  });

  console.log("# 全量集成测试\n");
  for (const note of notes) console.log(`- 数据库：${note}`);
  console.log(`- 共享库：${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(
    `- 用例文件：API ${allFiles.length} 个 / Web ${webFiles.length} 个\n`,
  );

  const results = [];
  for (const tier of tiers) {
    console.log(`## ${tier.name}（${tier.files.length} 文件）`);
    const result = await runVitest(tier.name, tier);
    results.push(result);
    for (const line of result.summary) console.log(`  ${line}`);
    console.log(
      `  ${result.code === 0 ? "PASS" : "FAIL"}  ${result.seconds}s\n`,
    );
  }

  const failed = results.filter((result) => result.code !== 0);
  console.log("## 结论\n");
  for (const result of results)
    console.log(
      `- ${result.code === 0 ? "PASS" : "FAIL"}  ${result.label}  ${result.seconds}s`,
    );
  if (failed.length > 0) {
    console.log("\n失败明细：");
    for (const result of failed)
      console.log(`\n--- ${result.label} ---\n${result.output.slice(-4000)}`);
    process.exitCode = 1;
  }
};

await main();
