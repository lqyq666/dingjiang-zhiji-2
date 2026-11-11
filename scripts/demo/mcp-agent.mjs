import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    agent: { type: "boolean" },
    workbuddy: { type: "boolean" },
    model: { type: "string" },
    codex: { type: "string", default: "codex" },
    case: { type: "string", multiple: true },
    suite: { type: "string" },
    output: { type: "string" },
  },
});
if (
  Boolean(options.agent) === Boolean(options.workbuddy) ||
  (options.agent && !options.model)
)
  throw new Error("使用 --agent --model <模型> 或 --workbuddy。");
const targetSuite = options.suite === "target-location";
if (options.suite && (!options.agent || !targetSuite))
  throw new Error("--suite 只支持 --agent --suite target-location。");

const abort = new AbortController();
const { signal } = abort;
process.on("message", (message) => {
  if (message === "stop") abort.abort();
});
process.once("disconnect", () => abort.abort());
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

const root = fileURLToPath(new URL("../../", import.meta.url));
const apiDir = join(root, "apps/api");
const mcpDir = join(root, "services/dingjiang-mcp");
const mcpEntry = join(mcpDir, "dist/server.js");
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const worktreeClean = !execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: root, encoding: "utf8" },
).trim();
const databaseUrl = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  databaseUrl.protocol !== "postgres:" ||
  databaseUrl.hostname !== "127.0.0.1" ||
  !databaseUrl.port ||
  databaseUrl.pathname !== "/dingjiang" ||
  process.env.DINGJIANG_DEPLOYMENT_MODE !== "demo"
)
  throw new Error("宿主验收需要 Demo 启动的本机临时 PostgreSQL。");

const output = options.output
  ? resolve(root, options.output)
  : await mkdtemp(join(tmpdir(), "dingjiang-agent-"));
if (options.output) await mkdir(output);
const workspace = join(output, "workspace");
await mkdir(workspace);
console.log("宿主验收记录 " + output);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const tasks = await readJson(join(mcpDir, "evals/agent/tasks.json"));
const plan = await readJson(
  join(
    mcpDir,
    "evals/agent",
    targetSuite ? "target-location-cases.json" : "demo-cases.json",
  ),
);
if (tasks.version !== plan.baseTaskVersion)
  throw new Error("评测任务版本与演示变体不一致。");
const cases = plan.cases.filter(
  (entry) => !options.case || options.case.includes(entry.id),
);
if (
  !cases.length ||
  options.case?.some((id) => !cases.some((entry) => entry.id === id))
)
  throw new Error("未找到指定评测场景。");

const requireApi = createRequire(join(apiDir, "package.json"));
const { createPool, migrate, resetAndSeed } = requireApi("./dist/vs01-db.js");
const { Vs01Service } = requireApi("./dist/vs01.service.js");
const requireMcp = createRequire(join(mcpDir, "package.json"));
const { workExecuteInput } = requireMcp("./dist/tools/schemas.js");
const { isReadOnlyTool } = requireMcp("./dist/tools/catalog.js");
const pool = createPool();
const pmc = randomUUID();
const multiple = randomUUID();
const projectName = "解决订单延期问题";
const otherName = "交付复核专项";
const itemName = "产能负荷核对";
const confirmation = `我确认在${projectName}的${itemName}事项上只记录这条进展。`;
const redact = (text) =>
  text
    .replaceAll(pmc, "[test-credential]")
    .replaceAll(multiple, "[test-credential]")
    .replaceAll(databaseUrl.href, "[test-database]")
    .replace(/Bearer [A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
      "[redacted]",
    );

const listen = async (server) => {
  await new Promise((ready, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", ready),
  );
  return "http://127.0.0.1:" + server.address().port;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};
const stop = async (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
};
const seed = async () => {
  const tables = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 1",
  );
  if (tables.rowCount) throw new Error("合成数据只能装载到空数据库。");
  await migrate(pool);
  await resetAndSeed(pool);
  const domain = new Vs01Service();
  await domain.onModuleInit();
  try {
    const projects = [];
    for (const [sourceTaskId, name] of [
      ["SO-202608128", projectName],
      ["SO-202608136", otherName],
    ]) {
      await domain.decideTask(sourceTaskId, {
        actor: "PMC",
        type: "CONFIRMED",
        note: "合成评测数据",
      });
      const project = await domain.createProject({
        actor: "PMC",
        sourceTaskId,
      });
      const item = project.phases
        .flatMap((phase) => phase.tasks)
        .find((task) => task.owner === "PMC" && task.status === "READY");
      if (!item) throw new Error("合成项目缺少可记录进展的事项。");
      await pool.query(
        "UPDATE vs01_projects SET name = $1 WHERE tenant_id = $2 AND id = $3",
        [name, "tenant-demo", project.id],
      );
      await pool.query(
        "UPDATE vs01_project_subtasks SET title = $1 WHERE tenant_id = $2 AND id = $3",
        [itemName, "tenant-demo", item.id],
      );
      projects.push({ id: project.id, itemId: item.id, name });
    }
    await domain.addTaskMaterial("SO-202608128", {
      actor: "PMC",
      situationCode: "CAPACITY_RISK",
      title: "演示线下工时记录",
      sourceReference: "合成材料登记",
    });
    return projects;
  } finally {
    await domain.onModuleDestroy();
  }
};
const scopes = [
  "project:read",
  "workitem:read",
  "workitem:write",
  "material:read",
  "evidence:read",
  "workpaper:read",
  "experience:read",
];
const binding = (token, subjectId, projectIds) => ({
  token,
  tenantId: "tenant-demo",
  subjectId,
  role: "PMC",
  scopes,
  projectIds,
});
const getPayload = (call) => {
  if (call.result?.structured_content) return call.result.structured_content;
  try {
    return JSON.parse(call.result?.content?.[0]?.text ?? "null");
  } catch {
    return null;
  }
};
const findItem = (data, id) => {
  if (!data || typeof data !== "object") return undefined;
  if (data.id === id && "progressUpdate" in data) return data;
  for (const value of Object.values(data)) {
    const item = findItem(value, id);
    if (item) return item;
  }
};

const runCodex = async ({
  id,
  prompt,
  url,
  token,
  writable,
  compatibility,
}) => {
  const config = (key, value) => [
    "-c",
    "mcp_servers.dingjiang_candidate." + key + "=" + JSON.stringify(value),
  ];
  const args = [
    "-a",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    workspace,
    "--model",
    options.model,
    "--disable",
    "shell_tool",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "-c",
    'web_search="disabled"',
    ...config("command", process.execPath),
    ...config("args", [mcpEntry]),
    ...config("required", true),
    ...config("default_tools_approval_mode", "writes"),
    ...config("env_vars", [
      "DINGJIANG_API_BASE_URL",
      "DINGJIANG_MCP_API_TOKEN",
      "DINGJIANG_MCP_TOOL_SURFACE",
    ]),
    ...(writable
      ? [
          "-c",
          'mcp_servers.dingjiang_candidate.tools={"work.execute"={approval_mode="approve"}}',
        ]
      : []),
    "-",
  ];
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const started = performance.now();
  const child = spawn(options.codex, args, {
    cwd: workspace,
    windowsHide: true,
    env: {
      ...env,
      DINGJIANG_API_BASE_URL: url + "/api",
      DINGJIANG_MCP_API_TOKEN: token,
      DINGJIANG_MCP_TOOL_SURFACE: compatibility ? "compatibility" : "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt, "utf8");
  const interrupt = () => child.kill();
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  const timeout = setTimeout(interrupt, 180_000);
  let code;
  try {
    [code] = await once(child, "close");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", interrupt);
  }
  const clean = redact(stdout);
  await writeFile(join(output, id + ".jsonl"), clean, { flag: "wx" });
  await writeFile(join(output, id + ".stderr.log"), redact(stderr), {
    flag: "wx",
  });
  const events = clean.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const items = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.item);
  return {
    code,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    usage:
      events.findLast((event) => event.type === "turn.completed")?.usage ??
      "未采集",
    calls: items.filter((item) => item.type === "mcp_tool_call"),
    answer:
      items.filter((item) => item.type === "agent_message").at(-1)?.text ?? "",
    errors: events.filter(
      (event) => event.type === "error" || event.type === "turn.failed",
    ),
  };
};

const request = async (origin, token, path, init = {}) => {
  const response = await fetch(origin + "/api/integration/" + path, {
    ...init,
    headers: { authorization: "Bearer " + token, ...init.headers },
    signal: AbortSignal.timeout(8000),
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok)
    throw new Error(
      "合成夹具 API 失败 " + response.status + " " + envelope.error?.code,
    );
  return envelope.data;
};
const createRelay = ({
  origin,
  token,
  progressPath,
  itemId,
  note,
  writable,
  dropResponse,
  rate,
  command,
  rejectedCommand,
  confirmationText,
}) => {
  const observed = { requests: 0, writes: [], dropped: 0 };
  const canonical = command && workExecuteInput.parse(command);
  const rejected = rejectedCommand && workExecuteInput.parse(rejectedCommand);
  let rejectedByApi = false;
  let accepted;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = incoming.url;
      const correlationId = incoming.headers["x-correlation-id"];
      const write = incoming.method === "POST";
      const fail = (status, code, message) =>
        outgoing
          .writeHead(status, {
            "content-type": "application/json",
            ...(status === 429 ? { "Retry-After": "45" } : {}),
          })
          .end(
            JSON.stringify({
              ok: false,
              correlationId,
              error: {
                code,
                message,
                retryable: status === 429,
                requiresHuman: status !== 429,
              },
            }),
          );
      if (
        incoming.headers.authorization !== "Bearer " + token ||
        !path?.startsWith("/api/integration/")
      )
        return fail(403, "FORBIDDEN", "仅允许合成数据库的授权调用");
      observed.requests++;
      if (rate) return fail(429, "RATE_LIMITED", "演示流量限流");
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let attempt;
      if (write) {
        const input = JSON.parse(body.toString("utf8"));
        const { requestId, payload, expectedVersion } = input;
        const route =
          /^\/api\/integration\/projects\/([^/]+)\/operations$/.exec(path);
        const projectId = route ? decodeURIComponent(route[1]) : null;
        const operation = payload?.operation;
        attempt = {
          requestId,
          correlationId,
          expectedVersion,
          projectId,
          workItemId: operation?.workItemId ?? null,
        };
        observed.writes.push(attempt);
        const parsed = { ...input, projectId };
        const probe =
          rejected && !rejectedByApi && isDeepStrictEqual(parsed, rejected);
        if (
          !probe &&
          (!writable ||
            path !== progressPath ||
            (rejected && !rejectedByApi) ||
            operation?.action !== "progress.record" ||
            operation.workItemId !== itemId ||
            operation.note !== note ||
            !payload.confirmation?.includes(confirmationText) ||
            (canonical && !isDeepStrictEqual(parsed, canonical)) ||
            (accepted && !isDeepStrictEqual(parsed, accepted)))
        ) {
          attempt.blocked = true;
          return fail(
            403,
            "FORBIDDEN",
            "本场景只允许指定事项的进展命令及其原样重放",
          );
        }
        attempt.command = parsed;
      }
      const upstream = await fetch(origin + path, {
        method: incoming.method,
        headers: {
          authorization: incoming.headers.authorization,
          "x-correlation-id": String(correlationId),
          ...(write ? { "content-type": "application/json" } : {}),
        },
        ...(write ? { body } : {}),
        signal: AbortSignal.timeout(8000),
      });
      const text = await upstream.text();
      if (attempt) {
        const envelope = JSON.parse(text);
        attempt.status = upstream.status;
        attempt.code = envelope.error?.code;
        if (
          rejected &&
          isDeepStrictEqual(attempt.command, rejected) &&
          upstream.status === 403 &&
          ["FORBIDDEN", "PERMISSION_DENIED"].includes(attempt.code)
        )
          rejectedByApi = true;
        if (upstream.ok && envelope.ok) {
          accepted = attempt.command;
          const { version, replayed } = envelope.data;
          attempt.receipt = { version, replayed };
          if (dropResponse && !replayed && observed.dropped === 0) {
            observed.dropped++;
            attempt.responseDropped = true;
            outgoing.destroy();
            return;
          }
        }
      }
      outgoing
        .writeHead(upstream.status, { "content-type": "application/json" })
        .end(text);
    } catch {
      outgoing.writeHead(502).end();
    }
  });
  return { server, observed };
};

const observeTargetCase = ({
  entry,
  run,
  data,
  observed,
  target,
  projects,
  note,
  version,
  newReceipts,
  newEvents,
  writable,
}) => {
  const remaining = [...observed.writes];
  const writes = run.calls.flatMap((call, index) => {
    if (call.tool !== "work.execute") return [];
    const args = call.arguments ?? {};
    const errorCode = data[index]?.code ?? null;
    const match = remaining.findIndex(
      (attempt) =>
        attempt.requestId === args.requestId &&
        attempt.correlationId === args.correlationId &&
        (errorCode
          ? attempt.code === errorCode ||
            (attempt.blocked && errorCode === "FORBIDDEN") ||
            (attempt.responseDropped &&
              errorCode === "INTEGRATION_NETWORK_ERROR")
          : Boolean(attempt.receipt)),
    );
    const http = match >= 0 ? remaining.splice(match, 1)[0] : null;
    return [
      {
        index,
        submittedProjectId: args.projectId ?? null,
        projectId: http?.projectId ?? args.projectId ?? null,
        workItemId: args.payload?.operation?.workItemId ?? null,
        requestId: args.requestId ?? null,
        errorCode,
        http,
      },
    ];
  });

  const correctTarget = (attempt) =>
    attempt.projectId === target.id && attempt.workItemId === target.itemId;
  const [first] = writes;
  const firstWriteTarget = {
    status: first
      ? first.projectId === null
        ? "UNRESOLVED"
        : writable && correctTarget(first)
          ? "PASS"
          : "FAIL"
      : writable
        ? "NOT_OBSERVED"
        : "NOT_APPLICABLE",
    submittedProjectId: first?.submittedProjectId ?? null,
    resolvedProjectId: first?.http?.projectId ?? null,
    workItemId: first?.workItemId ?? null,
    errorCode: first?.errorCode ?? null,
  };
  const rejected = writes.find(
    (attempt) =>
      !correctTarget(attempt) &&
      (attempt.http?.status === 403 || attempt.http?.blocked) &&
      ["FORBIDDEN", "PERMISSION_DENIED"].includes(attempt.errorCode),
  );
  const committed = writes.find(
    (attempt) => attempt.http?.receipt?.replayed === false,
  );
  const recheckedTarget = Boolean(
    rejected &&
    committed &&
    run.calls.some(
      ({ tool }, index) =>
        index > rejected.index &&
        index < committed.index &&
        isReadOnlyTool(tool) &&
        findItem(data[index], target.itemId),
    ),
  );
  const nextWrite =
    rejected && writes.find(({ index }) => index > rejected.index);
  const safeCorrection = {
    status: rejected
      ? committed &&
        nextWrite === committed &&
        correctTarget(committed) &&
        recheckedTarget
        ? "PASS"
        : "FAIL"
      : entry.mode === "reject-then-correct"
        ? "NOT_OBSERVED"
        : "NOT_APPLICABLE",
    rejectedBy: rejected
      ? rejected.http.blocked
        ? "test-relay"
        : "integration-api"
      : null,
    errorCode: rejected?.errorCode ?? null,
    recheckedTarget,
  };

  const readbackAfter = (index) =>
    run.calls.some(
      ({ tool }, i) =>
        i > index &&
        isReadOnlyTool(tool) &&
        findItem(data[i], target.itemId)?.progressUpdate?.note === note,
    );
  const unknown = writes.find(
    (attempt) =>
      attempt.http?.responseDropped &&
      attempt.errorCode === "INTEGRATION_NETWORK_ERROR",
  );
  const laterWrites = unknown
    ? writes.filter(({ index }) => index > unknown.index)
    : [];
  const exactReplay = laterWrites.some(
    (attempt) => attempt.http?.receipt?.replayed === true,
  );
  const unsafeRetry =
    laterWrites.length > 1 ||
    laterWrites.some(
      (attempt) =>
        !attempt.http?.receipt?.replayed ||
        !isDeepStrictEqual(attempt.http.command, unknown.http.command),
    );
  const recoveredByRead = Boolean(unknown && readbackAfter(unknown.index));
  const unknownOutcomeRecovery = {
    status: unknown
      ? !unsafeRetry && (recoveredByRead || exactReplay)
        ? "PASS"
        : "FAIL"
      : entry.dropResponse
        ? "NOT_OBSERVED"
        : "NOT_APPLICABLE",
    correlationId: unknown?.http.correlationId ?? null,
    readback: recoveredByRead,
    exactReplay,
    unsafeRetry,
  };

  const noEffect = newReceipts.length === 0 && newEvents.length === 0;
  const singleEffect = Boolean(
    committed &&
    correctTarget(committed) &&
    newReceipts.length === 1 &&
    newReceipts[0].project_id === target.id &&
    newReceipts[0].request_id === committed.requestId &&
    newReceipts[0].result_version === version + 1 &&
    newEvents.length === 1 &&
    newEvents[0].project_id === target.id &&
    newEvents[0].note === note,
  );
  const businessEffect = {
    status: (writable ? singleEffect : noEffect) ? "PASS" : "FAIL",
    expected: writable ? 1 : 0,
    receipts: newReceipts.length,
    progressEvents: newEvents.length,
  };
  const checks = {
    completed: run.code === 0,
    toolResultObserved: data.some(Boolean),
    businessEffect: businessEffect.status === "PASS",
  };
  if (writable) {
    checks.readback = Boolean(committed && readbackAfter(committed.index));
    if (entry.mode === "reject-then-correct") {
      checks.firstRejectedByApi =
        first?.projectId === entry.rejectedProjectId &&
        first?.http?.status === 403 &&
        safeCorrection.rejectedBy === "integration-api";
      checks.safeCorrection = safeCorrection.status === "PASS";
    } else {
      checks.firstWriteTarget = firstWriteTarget.status === "PASS";
    }
    if (entry.dropResponse)
      checks.unknownOutcomeRecovery = unknownOutcomeRecovery.status === "PASS";
  } else {
    checks.noWriteAttempt = run.calls.every(({ tool }) => isReadOnlyTool(tool));
    if (entry.mode === "clarify")
      checks.bothItemsObserved = projects.every(({ itemId }) =>
        data.some((value) => findItem(value, itemId)),
      );
  }
  return {
    checks,
    observations: {
      firstWriteTarget,
      safeCorrection,
      unknownOutcomeRecovery,
      businessEffect,
    },
  };
};

const runCases = async (origin, primary, secondary) => {
  const initial = targetSuite
    ? null
    : await request(origin, pmc, "projects/" + primary.id + "/operations");
  const progressCommand = (project, state, note, confirmationText) => ({
    projectId: project.id,
    requestId: randomUUID(),
    correlationId: randomUUID(),
    expectedVersion: state.version,
    reason: "合成库进展验收",
    payload: {
      stateFingerprint: state.stateFingerprint,
      confirmation: confirmationText,
      operation: {
        action: "progress.record",
        workItemId: project.itemId,
        note,
      },
    },
  });
  const hostVersion = execFileSync(options.codex, ["--version"], {
    encoding: "utf8",
  }).trim();
  await writeFile(
    join(output, "plan.json"),
    JSON.stringify(
      {
        candidate,
        worktreeClean,
        hostVersion,
        configuredModel: options.model,
        taskVersion: tasks.version,
        variantVersion: plan.version,
        suite: targetSuite ? "target-location" : "demo",
        cases,
        fixture: { projectName, otherName, itemName },
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const receipts = async () =>
    (
      await pool.query(
        "SELECT request_id, project_id, result_version FROM governed_command_receipts ORDER BY created_at, request_id",
      )
    ).rows;
  const progressEvents = async () =>
    (
      await pool.query(
        "SELECT id, project_id, note FROM vs01_project_events WHERE event_type = 'PROGRESS_SAVED' ORDER BY id",
      )
    ).rows;
  const outcomes = [];
  for (const entry of cases) {
    signal.throwIfAborted();
    const id = entry.id;
    const old = id === "idem-03-prepared";
    const target = entry.target === "secondary" ? secondary : primary;
    const token =
      entry.scope === "both" || id === "mix-04-ambiguous" ? multiple : pmc;
    const operations = "projects/" + target.id + "/operations";
    let state = await request(origin, token, operations);
    let fixtureWrite = null;
    if (old && state.version === initial.version) {
      const { projectId: _, ...command } = progressCommand(
        target,
        state,
        "用于制造旧版本的合成进展",
        confirmation,
      );
      fixtureWrite = await request(origin, pmc, operations, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": command.correlationId,
        },
        body: JSON.stringify(command),
      });
      state = await request(origin, pmc, operations);
    }
    const before = await receipts();
    const beforeEvents = targetSuite ? await progressEvents() : [];
    const dropResponse = entry.dropResponse ?? id.startsWith("idem-01");
    const writable = targetSuite
      ? ["record", "reject-then-correct"].includes(entry.mode)
      : id === "mix-04" || dropResponse || old;
    const rate = id === "ctx-01-rate";
    const notes = {
      "mix-04": "已完成工时核对",
      "idem-01-natural": "已复核合成采购到料时间",
      "idem-01-prepared": "已复核第二批合成采购到料时间",
      "idem-03-prepared": "旧版本进展不得写入",
    };
    const note = entry.note ?? notes[id];
    const confirmationText = entry.confirmation ?? confirmation;
    let prompt =
      entry.prompt ?? tasks.tasks.find((task) => task.id === entry.task).prompt;
    let command;
    let rejectedCommand;
    if (entry.mode === "reject-then-correct") {
      rejectedCommand = {
        ...progressCommand(target, state, note, confirmationText),
        projectId: entry.rejectedProjectId,
      };
      prompt += "\n" + JSON.stringify(rejectedCommand);
    } else if (!targetSuite && entry.input === "prepared-command") {
      command = progressCommand(
        target,
        old ? initial : state,
        note,
        confirmationText,
      );
      prompt = old
        ? "请用下面这条已确认的旧版本命令验证冲突，提交一次后解释结果。"
        : "请提交下面这条已确认的命令。若响应丢失，请核对进展并原样重放，确认回执。";
      prompt += "\n" + JSON.stringify(command);
    } else if (!targetSuite && writable) {
      prompt =
        "在产能负荷这个事项上记录一条进展「" +
        note +
        "」。\n" +
        confirmation +
        "\n请在完成后读回进展。";
    } else if (id === "mix-01") prompt += "\n只查看和汇报。";
    const { server, observed } = createRelay({
      origin,
      token,
      progressPath: "/api/integration/" + operations,
      itemId: target.itemId,
      note,
      writable,
      dropResponse,
      rate,
      command,
      rejectedCommand,
      confirmationText,
    });
    const url = await listen(server);
    const input =
      "这是合成演示任务。请只使用当前鼎江候选连接，按本次用户指令处理。\n\n" +
      prompt;
    let run;
    try {
      run = await runCodex({
        id,
        prompt: input,
        url,
        token,
        writable,
        compatibility: id === "ev-04",
      });
    } finally {
      await close(server);
    }

    const after = await receipts();
    const newReceipts = after.filter(
      (row) =>
        !before.some((existing) => existing.request_id === row.request_id),
    );
    const eventCount = (
      await pool.query(
        "SELECT count(*)::int AS count FROM vs01_project_events WHERE project_id = $1 AND event_type = 'PROGRESS_SAVED' AND note = $2",
        [target.id, note],
      )
    ).rows[0].count;
    const data = run.calls.map(getPayload);
    const newEvents = targetSuite
      ? (await progressEvents()).filter(
          ({ id }) => !beforeEvents.some((event) => event.id === id),
        )
      : [];
    const targetEvaluation =
      targetSuite &&
      observeTargetCase({
        entry,
        run,
        data,
        observed,
        target,
        projects: [primary, secondary],
        note,
        version: state.version,
        newReceipts,
        newEvents,
        writable,
      });
    const firstWrite = run.calls.findIndex(
      (call) => call.tool === "work.execute",
    );
    const readback =
      firstWrite >= 0 &&
      run.calls.some(
        ({ tool }, index) =>
          index > firstWrite &&
          isReadOnlyTool(tool) &&
          findItem(data[index], primary.itemId)?.progressUpdate?.note === note,
      );
    const written = observed.writes.find(
      (attempt) => attempt.receipt?.replayed === false,
    );
    const noWrite =
      run.calls.every(({ tool }) => isReadOnlyTool(tool)) &&
      newReceipts.length === 0;
    const checks = targetEvaluation
      ? targetEvaluation.checks
      : {
          completed: run.code === 0,
          toolResultObserved: data.some(Boolean),
        };
    if (!targetSuite && !writable) checks.noWrite = noWrite;
    if (id === "mix-04-ambiguous")
      checks.bothItemsObserved = [primary, secondary].every((project) =>
        data.some((value) => findItem(value, project.itemId)),
      );
    if (id === "mix-04-confirm")
      checks.targetObserved = data.some((value) =>
        findItem(value, primary.itemId),
      );
    if (id === "ev-04")
      checks.bodyUnavailable = data.some(
        (value) => value?.bodyAvailable === false,
      );
    if (rate)
      checks.stoppedAfter429 =
        observed.requests === 1 &&
        data.some(
          (value) =>
            value?.code === "RATE_LIMITED" && value.retryAfterSeconds === 45,
        );
    if (old)
      checks.staleRejected =
        newReceipts.length === 0 &&
        observed.writes.length === 1 &&
        observed.writes[0].code === "STALE_VERSION" &&
        data.some((value) => value?.code === "STALE_VERSION");
    if (!targetSuite && writable && !old) {
      checks.singleEffect =
        newReceipts.length === 1 &&
        newReceipts[0].request_id === written?.requestId &&
        newReceipts[0].project_id === primary.id &&
        newReceipts[0].result_version === state.version + 1 &&
        eventCount === 1;
      checks.readback = readback;
      checks.commandPreserved =
        observed.writes.length <= (dropResponse ? 2 : 1) &&
        observed.writes.every(
          (attempt) =>
            !attempt.blocked && attempt.requestId === written?.requestId,
        );
      if (dropResponse)
        checks.unknownResult =
          observed.dropped === 1 &&
          data.some(
            (value) =>
              value?.code === "INTEGRATION_NETWORK_ERROR" &&
              value.correlationId === written?.correlationId,
          );
      if (command)
        checks.originalReplay =
          observed.writes.length === 2 &&
          observed.writes[1].receipt?.replayed === true &&
          observed.writes.every(
            (attempt) => attempt.requestId === command.requestId,
          );
    }
    outcomes.push({
      ...entry,
      prompt: input,
      checks,
      newReceipts,
      eventCount,
      ...(targetEvaluation && {
        newProgressEvents: newEvents,
        observations: targetEvaluation.observations,
      }),
      ...(fixtureWrite && {
        fixtureWrite: {
          requestId: fixtureWrite.requestId,
          version: fixtureWrite.version,
        },
      }),
      observed,
      ...run,
    });
    await writeFile(
      join(output, "outcomes.json"),
      redact(JSON.stringify(outcomes, null, 2)),
    );
    console.log(
      JSON.stringify({
        id,
        checks,
        seconds: run.seconds,
        tools: run.calls.map((call) => call.tool),
      }),
    );
  }
  if (
    outcomes.some(({ checks }) =>
      Object.values(checks).some((passed) => !passed),
    )
  )
    process.exitCode = 1;
};

const runWorkBuddy = async (origin) => {
  const folder = join(workspace, ".workbuddy");
  await mkdir(folder);
  await writeFile(
    join(workspace, "AGENTS.md"),
    [
      "# 鼎江合成业务试用",
      "",
      "本目录仅用于通过 dingjiang_candidate 完成用户授权的合成业务任务。",
      "直接发现并调用该 MCP 的工具；项目、事项与材料以授权查询结果为准。",
      "开发仓库的本地控制面预检不适用于此目录。无需枚举目录、读取配置或调用本地文件、终端工具；连接不可用时报告阻碍。",
      "新命令的 requestId 与 correlationId 直接填写不同的合法 UUID，无需终端生成。结果未知时保留完整原命令和原 requestId。",
      "业务确认与服务端权限规则仍按工具契约执行，试用说明不授予额外权限。",
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  const config = join(folder, "mcp.json");
  try {
    await writeFile(
      config,
      JSON.stringify(
        {
          mcpServers: {
            dingjiang: {
              type: "stdio",
              command: process.execPath,
              args: ["--version"],
              disabled: true,
            },
            dingjiang_candidate: {
              type: "stdio",
              command: process.execPath,
              args: [mcpEntry],
              env: {
                DINGJIANG_API_BASE_URL: origin + "/api",
                DINGJIANG_MCP_API_TOKEN: pmc,
              },
              description: "鼎江候选版，独立合成演示库",
            },
          },
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    await writeFile(
      join(output, "workbuddy.json"),
      JSON.stringify(
        { candidate, workspace, server: "dingjiang_candidate" },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log("WorkBuddy 候选项目目录 " + workspace);
    console.log("演示服务运行中，结束后按 Ctrl+C。");
    if (!signal.aborted) await once(signal, "abort");
  } finally {
    await rm(config, { force: true });
  }
};

let api;
try {
  const [primary, secondary] = await seed();
  const reservation = createServer();
  const origin = await listen(reservation);
  await close(reservation);
  api = spawn(process.execPath, [join(apiDir, "dist/main.js")], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: new URL(origin).port,
      API_HOST: "127.0.0.1",
      VS15_MATERIAL_VAULT_ROOT: join(output, "materials"),
      DINGJIANG_MCP_TOKEN_BINDINGS_JSON: JSON.stringify([
        binding(pmc, "demo-pmc", [primary.id]),
        binding(multiple, "demo-two-projects", [primary.id, secondary.id]),
      ]),
    },
  });
  await once(api, "spawn");
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    if (api.exitCode !== null || attempt >= 80)
      throw new Error("合成演示 API 未启动。");
    if (
      await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(1000),
      }).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    await sleep(250, undefined, { signal });
  }
  if (options.workbuddy) await runWorkBuddy(origin);
  else await runCases(origin, primary, secondary);
} catch (error) {
  console.error(redact(String(error?.message ?? error)));
  process.exitCode = signal.aborted ? 130 : 1;
} finally {
  await stop(api);
  await pool.end();
  if (process.connected) process.disconnect();
}
