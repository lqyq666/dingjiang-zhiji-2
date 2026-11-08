#!/usr/bin/env node
/**
 * MCP tool contract eval.
 *
 * Runs the real dispatcher from `dist/` against a deterministic mock Integration
 * client and reports invariant-level pass/fail. No network, no database, no
 * provider credential: every number in the report comes from actual execution.
 *
 * Usage:
 *   node evals/run.mjs                 # human-readable report
 *   node evals/run.mjs --out report.md # also write the report
 *   node evals/run.mjs --json          # machine-readable summary
 *
 * Exit code is 1 when any invariant fails, so CI can gate on it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const protocol = require("../dist/protocol.js");
const {
  IntegrationTransportError,
  IntegrationClientError,
} = require("../dist/client.js");

const { fixtures, cases } = JSON.parse(
  readFileSync(join(here, "cases.json"), "utf8"),
);

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

const createClient = (overrides = {}) => {
  const calls = [];
  const client = new Proxy(
    {},
    {
      get:
        (_target, property) =>
        async (...args) => {
          calls.push({ method: String(property), args });
          const override = overrides[property];
          if (override) return override(...args);
          return clone(fixtures[property] ?? {});
        },
    },
  );
  return { client, calls };
};

const identity = { startup: "eval", current: () => "eval" };

const withEnv = (env, run) => {
  if (!env) return run();
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

const invokeTool = async (handler, name, args) => {
  const response = await handler({
    jsonrpc: "2.0",
    id: `eval-${name}`,
    method: "tools/call",
    params: { name, arguments: args ?? {} },
  });
  const result = response?.result;
  const text = result?.content?.[0]?.text ?? "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return {
    isError: Boolean(result?.isError),
    structured: result?.structuredContent,
    payload,
    text,
  };
};

const ok = (detail) => ({ pass: true, detail });
const fail = (detail) => ({ pass: false, detail });

const runCase = async (testCase) =>
  withEnv(testCase.env, async () => {
    if (testCase.kind === "protocol") return runProtocolCase(testCase);

    const overrides = {};
    if (testCase.kind === "recovery") {
      overrides[testCase.failure.method] = () => {
        throw new IntegrationTransportError(
          testCase.failure.code,
          "Integration API 请求超时；不得改 requestId 重试",
        );
      };
    }
    if (testCase.kind === "absent") {
      const { method, code } = testCase.absent;
      overrides[method] = () => {
        throw new IntegrationClientError({
          ok: false,
          error: {
            code,
            message:
              code === "NOT_FOUND"
                ? "授权范围内未找到该资源"
                : "当前身份无权访问该资源",
            retryable: false,
            requiresHuman: code !== "NOT_FOUND",
          },
          correlationId: "6f1c2f7e-1111-4222-8333-444455556666",
        });
      };
    }
    const { client, calls } = createClient(overrides);
    const handler = protocol.createMcpHandler(client, identity);
    const result = await invokeTool(handler, testCase.tool, testCase.arguments);

    if (testCase.kind === "happy") {
      if (result.isError)
        return fail(`返回错误：${result.payload?.code ?? result.text}`);
      if (result.structured === undefined)
        return fail("缺少 structuredContent");
      const called = new Set(calls.map((call) => call.method));
      const missing = (testCase.expect?.calledMethods ?? []).filter(
        (method) => !called.has(method),
      );
      if (missing.length > 0) return fail(`未调用：${missing.join(", ")}`);
      return ok(`structuredContent + ${calls.length} 次 Integration 调用`);
    }

    if (testCase.kind === "guard" || testCase.kind === "governance") {
      if (!result.isError) return fail("非法参数未被拒绝");
      if (result.payload?.code !== "INVALID_REQUEST")
        return fail(
          `错误码为 ${result.payload?.code ?? "未知"}，应为 INVALID_REQUEST`,
        );
      if (calls.length > 0)
        return fail(`仍触达 Integration：${calls.length} 次`);
      return ok("INVALID_REQUEST 且零 Integration 调用");
    }

    if (testCase.kind === "recovery") {
      if (!result.isError) return fail("传输故障未转为错误结果");
      if (result.payload?.code !== testCase.failure.code)
        return fail(`错误码为 ${result.payload?.code ?? "未知"}`);
      if (result.text.includes("Bearer ")) return fail("错误内容泄露了授权头");
      const next = await invokeTool(handler, "get_current_project", {});
      if (next.isError) return fail("后续调用被前一次故障污染");
      return ok("结构化错误 + 后续调用恢复");
    }

    if (testCase.kind === "absent") {
      // A constituent that is merely not created yet must degrade; a
      // constituent the caller may not read must not.
      if (testCase.expect.errorCode) {
        if (!result.isError) return fail("越权缺失被静默降级");
        if (result.payload?.code !== testCase.expect.errorCode)
          return fail(
            `错误码为 ${result.payload?.code ?? "未知"}，应为 ${testCase.expect.errorCode}`,
          );
        return ok(`${testCase.expect.errorCode} 未被降级`);
      }
      if (result.isError)
        return fail(`聚合失败：${result.payload?.code ?? result.text}`);
      const value = result.structured?.[testCase.expect.path];
      if (value !== testCase.expect.value)
        return fail(`${testCase.expect.path} 为 ${JSON.stringify(value)}`);
      return ok(`${testCase.expect.path}=null 且其余字段完整`);
    }

    return fail(`未知用例类型：${testCase.kind}`);
  });

const runProtocolCase = async (testCase) => {
  const { client } = createClient();
  const handler = protocol.createMcpHandler(client, identity);
  const request = testCase.noId
    ? { jsonrpc: "2.0", method: testCase.method }
    : {
        jsonrpc: "2.0",
        id: `eval-${testCase.method}`,
        method: testCase.method,
      };
  const response = await handler(request);

  if (testCase.expect.noResponse)
    return response === undefined
      ? ok("notification 无响应")
      : fail("notification 返回了响应");

  if (testCase.expect.errorCode !== undefined)
    return response?.error?.code === testCase.expect.errorCode
      ? ok(`错误码 ${testCase.expect.errorCode}`)
      : fail(`错误码为 ${response?.error?.code ?? "无错误"}`);

  const result = response?.result;
  if (!result) return fail("缺少 result");
  for (const key of testCase.expect.resultKeys ?? [])
    if (!(key in result)) return fail(`缺少字段 ${key}`);
  if (testCase.expect.toolCount !== undefined) {
    const count = result.tools?.length ?? -1;
    if (count !== testCase.expect.toolCount)
      return fail(`工具数为 ${count}，应为 ${testCase.expect.toolCount}`);
  }
  return ok(
    testCase.expect.toolCount === undefined
      ? "协议字段完整"
      : `${testCase.expect.toolCount} 个工具`,
  );
};

const runDriftCheck = async () => {
  const { client } = createClient();
  const handler = protocol.createMcpHandler(client, identity);
  const names = new Set(
    [...protocol.dingjiangTools, ...protocol.dingjiangCompatibilityTools].map(
      (tool) => tool.name,
    ),
  );
  const broken = [];
  for (const name of names) {
    const result = await invokeTool(handler, name, {});
    if (
      result.payload?.code === "UNKNOWN_TOOL" ||
      result.text.includes("UNKNOWN_TOOL")
    )
      broken.push(name);
  }
  return {
    total: names.size,
    broken,
    pass: broken.length === 0,
  };
};

/**
 * Metadata invariants read from the wire, not from the module.
 *
 * `tool-contract.test.ts` already asserts these on the exported arrays; this
 * run repeats them against the actual JSON-RPC payload, because the surface is
 * assembled per negotiated revision and a bug in that assembly would be
 * invisible to a test that never serialises a response.
 */
const runMetadataCheck = async () => {
  // Both surfaces are checked: the business facade is the default, but the
  // compatibility surface is what most existing hosts still call.
  const listSurface = async (surface) => {
    const previous = process.env.DINGJIANG_MCP_TOOL_SURFACE;
    if (surface) process.env.DINGJIANG_MCP_TOOL_SURFACE = surface;
    else delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
    try {
      const { client } = createClient();
      const handler = protocol.createMcpHandler(client, identity);
      const listed = await handler({
        jsonrpc: "2.0",
        id: `meta-list-${surface ?? "business"}`,
        method: "tools/list",
      });
      return listed?.result?.tools ?? [];
    } finally {
      if (previous === undefined) delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
      else process.env.DINGJIANG_MCP_TOOL_SURFACE = previous;
    }
  };

  const { client } = createClient();
  const initialized = await protocol
    .createMcpHandler(
      client,
      identity,
    )({
      jsonrpc: "2.0",
      id: "meta-initialize",
      method: "initialize",
      params: { protocolVersion: protocol.latestProtocolVersion },
    })
    .then((response) => response?.result);

  const tools = [
    ...new Map(
      [...(await listSurface()), ...(await listSurface("compatibility"))].map(
        (tool) => [tool.name, tool],
      ),
    ).values(),
  ];
  const missingAnnotations = tools
    .filter(
      (tool) =>
        !tool.annotations ||
        typeof tool.annotations.readOnlyHint !== "boolean" ||
        typeof tool.annotations.title !== "string",
    )
    .map((tool) => tool.name);
  const mislabelled = tools
    .filter((tool) => {
      const required = tool.inputSchema?.required ?? [];
      const governedWrite =
        required.includes("requestId") && required.includes("expectedVersion");
      return governedWrite === Boolean(tool.annotations?.readOnlyHint);
    })
    .map((tool) => tool.name);
  const instructions = initialized?.instructions ?? "";
  const declaresInvariant = ["PROPOSAL", "requestId", "OWNER"].every((token) =>
    instructions.includes(token),
  );
  const failed =
    missingAnnotations.length +
    mislabelled.length +
    (declaresInvariant ? 0 : 1);
  return {
    total: tools.length,
    failed,
    withOutputSchema: tools.filter((tool) => tool.outputSchema).length,
    missingAnnotations,
    mislabelled,
    declaresInvariant,
    pass: tools.length > 0 && failed === 0,
  };
};

const run = async () => {
  const results = [];
  for (const testCase of cases)
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      ...(await runCase(testCase)),
    });

  const drift = await runDriftCheck();
  const metadata = await runMetadataCheck();
  const group = (kind) => results.filter((item) => item.kind === kind);
  const rate = (items) =>
    items.length === 0
      ? 1
      : items.filter((item) => item.pass).length / items.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    commit: currentCommit(),
    node: process.version,
    drift,
    metadata,
    happy: tally(group("happy")),
    guard: tally(group("guard")),
    governance: tally(group("governance")),
    recovery: tally(group("recovery")),
    absent: tally(group("absent")),
    protocol: tally(group("protocol")),
    failures: results.filter((item) => !item.pass),
  };
  summary.ok =
    drift.pass &&
    metadata.pass &&
    ["happy", "guard", "governance", "recovery", "absent", "protocol"].every(
      (kind) => rate(group(kind)) === 1,
    );

  const report = renderReport(summary, results);
  console.log(report);

  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1])
    writeFileSync(process.argv[outIndex + 1], `${report}\n`, "utf8");
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(summary, null, 2));

  process.exitCode = summary.ok ? 0 : 1;
};

function tally(items) {
  return {
    total: items.length,
    passed: items.filter((item) => item.pass).length,
    results: items,
  };
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: here,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function renderReport(summary, results) {
  const line = (item) => {
    const mark = item.pass ? "PASS" : "FAIL";
    return `| ${item.id} | ${mark} | ${item.detail} |`;
  };
  const invariant = (name, passed, total, evidence) =>
    `| ${name} | ${passed}/${total} | ${evidence} |`;

  return [
    "# MCP 工具契约评测",
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 提交：\`${summary.commit}\``,
    `- Node：\`${summary.node}\``,
    "- 驱动方式：真实 dispatcher（`dist/`）+ 确定性 mock Integration client，无网络、无数据库、无模型凭据",
    "",
    `## 结论：${summary.ok ? "PASS" : "FAIL"}`,
    "",
    "## 不变量与结果",
    "",
    "| 不变量 | 通过 | 证据 |",
    "| --- | --- | --- |",
    invariant(
      "声明的工具都可达（无 UNKNOWN_TOOL）",
      summary.drift.total - summary.drift.broken.length,
      summary.drift.total,
      summary.drift.broken.length === 0
        ? "工具面声明与 dispatcher 实现一致"
        : `未实现：${summary.drift.broken.join(", ")}`,
    ),
    invariant(
      "工具元数据完备（annotations / outputSchema / instructions）",
      summary.metadata.total - summary.metadata.failed,
      summary.metadata.total,
      [
        `${summary.metadata.withOutputSchema}/${summary.metadata.total} 声明 outputSchema`,
        summary.metadata.missingAnnotations.length === 0
          ? "annotations 全覆盖"
          : `缺 annotations：${summary.metadata.missingAnnotations.join(", ")}`,
        summary.metadata.mislabelled.length === 0
          ? "读/写标注与入参契约一致"
          : `标错：${summary.metadata.mislabelled.join(", ")}`,
        summary.metadata.declaresInvariant
          ? "initialize 携带治理指令"
          : "initialize 未携带治理指令",
      ].join("；"),
    ),
    invariant(
      "读/写工具 happy path 返回 structuredContent",
      summary.happy.passed,
      summary.happy.total,
      "逐工具调用并断言 Integration 方法命中",
    ),
    invariant(
      "越权字段注入一律拒绝",
      summary.governance.passed,
      summary.governance.total,
      "role/scopes/projectIds/sql/shell/url/filePath 注入返回 INVALID_REQUEST 且零 Integration 调用",
    ),
    invariant(
      "非法参数一律拒绝",
      summary.guard.passed,
      summary.guard.total,
      "缺失、类型错误、空白、非 UUID 均返回 INVALID_REQUEST",
    ),
    invariant(
      "传输故障结构化暴露且不扩散",
      summary.recovery.passed,
      summary.recovery.total,
      "超时映射为 INTEGRATION_TIMEOUT，不泄露授权头，后续调用仍成功",
    ),
    invariant(
      "可选子资源缺失时降级、越权时不降级",
      summary.absent.passed,
      summary.absent.total,
      "NOT_FOUND → null 且聚合成功；FORBIDDEN → 原样失败",
    ),
    invariant(
      "协议契约",
      summary.protocol.passed,
      summary.protocol.total,
      "initialize/ping/tools.list/未知方法/notification",
    ),
    "",
    "## 明细",
    "",
    "| 用例 | 结果 | 证据 |",
    "| --- | --- | --- |",
    ...results.map(line),
    "",
    "## 未覆盖",
    "",
    "- 未连接真实 Dingjiang API：所有 Integration 行为为 mock，未验证网络、鉴权、事务与 RLS。",
    "- 未验证 LLM 自然语言到工具选择的准确率：需要外部模型凭据，且结果不可在 CI 中稳定复现。",
    "- 未对 fixture 做 `outputSchema` 校验：mock client 绕过了 client.ts 中的 Zod 响应校验，因此元数据不变量只断言声明完备与读/写标注一致，不声称 fixture 与 schema 同构。",
    "- 未覆盖 `material.create` / `material.verify` / `evidence.propose` / `evidence.confirm` 的完整写 payload；这些工具由可达性检查与参数守卫覆盖。",
  ].join("\n");
}

await run();
