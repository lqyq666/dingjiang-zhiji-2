import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const apiDir = join(root, "apps/api");
const { Client } = createRequire(join(apiDir, "package.json"))("pg");
const exec = promisify(execFile);
const password = randomUUID();
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() !== "DOCKER_HOST",
  ),
);
const docker = async (args, env = dockerEnv) =>
  (
    await exec("docker", args, {
      env,
      timeout: 240_000,
      windowsHide: true,
    })
  ).stdout.trim();

const waitForPostgres = async (connectionString, signal) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch {
      // PostgreSQL may still be initializing its empty data directory.
    } finally {
      await client.end().catch(() => undefined);
    }
    await sleep(250, undefined, { signal });
  }
  throw new Error("临时 PostgreSQL 启动超时。");
};

const runDemo = async (signal) => {
  const context = await docker(["context", "show"]);
  const endpoint = await docker([
    "context",
    "inspect",
    context,
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (
    !endpoint.startsWith("unix://") &&
    !endpoint.startsWith("npipe:////./pipe/")
  )
    throw new Error("演示需要使用本机 Docker socket 的 context。");

  const localDocker = (args, env) =>
    docker(["--context", context, ...args], env);
  const directory = await mkdtemp(join(tmpdir(), "dingjiang-mcp-demo-"));
  const envFile = join(directory, ".env");
  const traceFile = join(directory, "trace.json");
  let container;
  try {
    // The child API uses this directory as cwd, which isolates env discovery.
    await writeFile(envFile, "", { flag: "wx" });
    signal.throwIfAborted();
    const id = await localDocker(
      [
        "create",
        "--rm",
        "--label",
        "com.dingjiang.demo=mcp-workspace",
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_DB=dingjiang",
        "--env",
        "POSTGRES_USER=dingjiang",
        "--env",
        "POSTGRES_PASSWORD",
        "pgvector/pgvector:pg17",
      ],
      { ...dockerEnv, POSTGRES_PASSWORD: password },
    );
    if (!/^[0-9a-f]{64}$/.test(id))
      throw new Error("Docker 未返回临时容器 ID。");
    container = id;
    signal.throwIfAborted();
    await localDocker(["start", container]);
    const binding = await localDocker(["port", container, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error("临时 PostgreSQL 未绑定到 loopback。");
    const databaseUrl =
      "postgres://dingjiang:" + password + "@127.0.0.1:" + port + "/dingjiang";
    await waitForPostgres(databaseUrl, signal);
    await exec(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "src/integration/real-e2e.integration.test.ts",
        "--no-color",
      ],
      {
        cwd: apiDir,
        windowsHide: true,
        timeout: 240_000,
        env: {
          PATH: process.env.PATH ?? process.env.Path,
          SystemRoot: process.env.SystemRoot,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          TMPDIR: process.env.TMPDIR,
          DATABASE_URL: databaseUrl,
          DINGJIANG_DEPLOYMENT_MODE: "demo",
          REAL_E2E_DEMO_DIRECTORY: directory,
          COZE_PROVIDER_MODE: "DEMO_RULES",
          FEISHU_PROVIDER_MODE: "DEMO_RULES",
          REAL_E2E: "1",
        },
      },
    );
    signal.throwIfAborted();
    const trace = JSON.parse(await readFile(traceFile, "utf8"));
    if (!Array.isArray(trace) || trace.length === 0)
      throw new Error("端到端测试没有生成演示记录。");
    return trace;
  } finally {
    try {
      if (container)
        await localDocker(["rm", "--force", "--volumes", container]);
    } finally {
      await rm(traceFile, { force: true });
      await rm(envFile, { force: true });
      await rmdir(directory);
    }
  }
};

const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  console.log("正在运行订单延期样例，使用临时 PostgreSQL 和实际 MCP 进程。");
  const steps = await runDemo(abort.signal);
  console.log("\n# 鼎江智绩 MCP 演示记录\n");
  console.log(
    "stdio / OAuth HTTP → MCP → Integration API → PostgreSQL · 本地合成样例",
  );
  for (const [index, step] of steps.entries()) {
    console.log("\n" + (index + 1) + ". " + step.title);
    for (const [key, value] of Object.entries(step.result))
      console.log("   " + key + "  " + JSON.stringify(value));
  }
} catch (error) {
  const detail = [error.message, error.stdout, error.stderr]
    .filter(Boolean)
    .join("\n")
    .replaceAll(password, "[redacted]")
    .replace(/real-e2e-(?:pmc|readonly)-[0-9a-f-]{36}/g, "[redacted]");
  console.error(detail.slice(-5000));
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
