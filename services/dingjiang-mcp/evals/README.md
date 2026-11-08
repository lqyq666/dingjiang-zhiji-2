# MCP 工具契约评测

把「工具声明与实现是否一致、越权与非法参数是否被拦住、协议契约是否成立」从口头保证变成可回归的指标。评测直接驱动 `dist/` 中的真实 dispatcher，Integration 侧使用确定性 mock，不依赖网络、数据库或模型凭据。

## 运行

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval

# 输出 Markdown 报告
pnpm --filter @dingjiang/mcp exec node evals/run.mjs --out mcp-eval.md

# 机器可读摘要（CI / 趋势对比）
pnpm --filter @dingjiang/mcp exec node evals/run.mjs --json
```

任一不变量失败时退出码为 1，CI 可直接据此阻断。

## 指标

| 指标         | 含义                                                                                                                 | 当前基线 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | -------- |
| 工具可达性   | 声明的每个工具都能进入实现，不落到 `UNKNOWN_TOOL`                                                                    | 28/28    |
| happy path   | 读工具与两个写工具返回 `structuredContent`，且命中预期 Integration 方法                                              | 24/24    |
| 越权注入拦截 | `role` / `scopes` / `projectIds` / `sql` / `shell` / `url` / `filePath` 一律 `INVALID_REQUEST` 且零 Integration 调用 | 7/7      |
| 参数守卫     | 缺失、类型错误、空白、非 UUID 均被拒                                                                                 | 6/6      |
| 传输故障收敛 | 超时映射为 `INTEGRATION_TIMEOUT`，不泄露授权头，后续调用仍成功                                                       | 1/1      |
| 协议契约     | `initialize` / `ping` / `tools/list` / 未知方法 / notification                                                       | 6/6      |

## 用例类型

`cases.json` 中每个用例带 `kind`：

- `happy`：合法调用，断言不报错、有 `structuredContent`、`expect.calledMethods` 全部命中。
- `guard`：非法参数，断言 `INVALID_REQUEST` 且未触达 Integration。
- `governance`：越权字段注入，与 `guard` 同断言，单独统计以突出治理边界。
- `recovery`：指定方法抛 `IntegrationTransportError`，断言错误码、无授权头泄露、后续调用恢复。
- `protocol`：JSON-RPC 层，断言 `result` 字段、工具数量、错误码、notification 无响应；可用 `env` 切换工具面。

新增工具时同步三处：`protocol.ts` 的工具声明、`callTool` 分支、`dispatchedToolNames`。`src/tool-contract.test.ts` 会在双向不一致时立即失败，`eval` 会验证每个声明工具确实可达。

## 为什么没有「LLM 选工具准确率」

该指标需要外部模型凭据，输出不可在 CI 中稳定复现，也无法证明治理边界。本评测刻意只覆盖**可判定**的契约与安全不变量。若要在本地评估自然语言到工具选择的质量，应另建 live 评测：固定模型与温度、记录 tool_choice 与参数、人工标注期望工具，并与本报告的契约层结果分开陈述，避免把不可复现的分数写进简历或验收结论。

## 未覆盖

- 真实 Dingjiang API 的网络、鉴权、事务与 RLS。
- `material.create` / `material.verify` / `evidence.propose` / `evidence.confirm` 的完整写 payload（由可达性与参数守卫覆盖）。
- 并发与长稳测试；`src/stdio.test.ts` 只覆盖单进程内的串行与背压行为。
