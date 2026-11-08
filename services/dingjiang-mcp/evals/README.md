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
| 元数据完备   | 两套工具面的 annotations 全覆盖、`outputSchema`（25 个）、`initialize.instructions` 携带治理不变量                   | 28/28    |
| happy path   | 读工具与两个写工具返回 `structuredContent`，且命中预期 Integration 方法                                              | 24/24    |
| 越权注入拦截 | `role` / `scopes` / `projectIds` / `sql` / `shell` / `url` / `filePath` 一律 `INVALID_REQUEST` 且零 Integration 调用 | 7/7      |
| 参数守卫     | 缺失、类型错误、空白、非 UUID 均被拒                                                                                 | 6/6      |
| 传输故障收敛 | 超时映射为 `INTEGRATION_TIMEOUT`，不泄露授权头，后续调用仍成功                                                       | 1/1      |
| 缺失降级     | 可选子资源 `NOT_FOUND` → `null` 且聚合成功；`FORBIDDEN` 原样失败                                                     | 2/2      |
| 协议契约     | `initialize` / `ping` / `tools/list` / 未知方法 / notification                                                       | 6/6      |

「元数据完备」这一项从 wire 层读取：测试已经断言导出数组上的 annotations，这里再对真实 JSON-RPC 响应断言一次，因为工具面是按协商版本组装的——如果组装逻辑出错，只读模块的测试看不出来。判定「写入口」不靠工具名清单，而是看入参契约是否同时必填 `requestId` 与 `expectedVersion`：这是受治理命令的唯一结构特征，据此可以独立校验标注有没有说谎。

## 用例类型

`cases.json` 中每个用例带 `kind`：

- `happy`：合法调用，断言不报错、有 `structuredContent`、`expect.calledMethods` 全部命中。
- `guard`：非法参数，断言 `INVALID_REQUEST` 且未触达 Integration。
- `governance`：越权字段注入，与 `guard` 同断言，单独统计以突出治理边界。
- `recovery`：指定方法抛 `IntegrationTransportError`，断言错误码、无授权头泄露、后续调用恢复。
- `absent`：指定方法抛 `IntegrationClientError`。`NOT_FOUND` 断言聚合仍成功且字段为 `null`，`FORBIDDEN` 断言原样失败——这条用例来自真实端到端跑出的回归：新建项目没有底稿时，`workspace.resume` 曾整体失败。
- `protocol`：JSON-RPC 层，断言 `result` 字段、工具数量、错误码、notification 无响应；可用 `env` 切换工具面。

新增工具时同步四处：`protocol.ts` 的工具声明、`callTool` 分支、`dispatchedToolNames`、`toolGovernance`。`src/tool-contract.test.ts` 会在任一处漏改时立即失败——工具声明与 dispatcher 双向不一致、或某个工具没有登记读写分类，都会直接抛错而不是退回「默认可疑」的 annotations。

## 为什么没有「LLM 选工具准确率」

该指标需要外部模型凭据，输出不可在 CI 中稳定复现，也无法证明治理边界。本评测刻意只覆盖**可判定**的契约与安全不变量。若要在本地评估自然语言到工具选择的质量，应另建 live 评测：固定模型与温度、记录 tool_choice 与参数、人工标注期望工具，并与本报告的契约层结果分开陈述，避免把不可复现的分数写进简历或验收结论。

## 未覆盖

- 真实 Dingjiang API 的网络、鉴权、事务与 RLS。
- `material.create` / `material.verify` / `evidence.propose` / `evidence.confirm` 的完整写 payload（由可达性与参数守卫覆盖）。
- 并发与长稳测试；`src/stdio.test.ts` 只覆盖单进程内的串行与背压行为。
