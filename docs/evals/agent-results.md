# MCP 与真实 Agent 验收记录

记录日期为 2026-11-11。以下样例使用合成订单和隔离 PostgreSQL。读者可从 [验证证据分层](../../services/dingjiang-mcp/evals/agent/README.md#验证证据分层)了解各类验证的范围。

## 真实模型运行

宿主为 Codex CLI 0.149.0，调用时指定 `gpt-5.6-sol`。服务端精确模型快照未采集。任务集版本为 `1`。演示变体与目标定位变体分别有版本记录。

| 实际候选 SHA                               | 运行范围                        | 实际结果                                                                                                            |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `f241a344b679b5fe5d947b6144444094ac5d4c17` | 演示变体 v1                     | 自然语言 7/8，完整命令 2/2                                                                                          |
| `65f87af8b2d4bb43b8ad9050861ebfdea460744c` | 演示变体 v1                     | 自然语言 8/8，完整命令 2/2，按原自动规则                                                                            |
| `805fc62c1440f0f02ded3ca1013beb6e1025a022` | 目标定位变体 v1，五项各运行一次 | 无 ID 自然语言 2/3。显式编号 1/1 自动检查通过，完整预期 0/1。完整命令 0/1。合计自动检查 3/5，人工按完整预期复核 2/5 |

`f241a34` 的 `idem-01-natural` 首次提交把合成项目 `PRJ-OTD-001` 写成 `PRJ-0D-001`。测试中转拒绝首写。Agent 查回准确项目后成功提交，响应被丢弃，再独立回读确认。最终只有一条进展事件和一份回执，原自然语言结果保留为 7/8。

`65f87af` 的对应场景中，Agent 省略项目 ID。首个调用因状态指纹截断在 MCP 前置校验失败，随后只有一次写请求到达 API。响应丢失后独立回读成功。该轮的自动规则保留了这次通过结果，首个调用的参数错误仍记录在原始轨迹中。

### 五个目标定位变体

| 场景                 | 首次定位和拒绝                                   | 恢复或业务结果                                                            |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 唯一授权项目断连     | 首写目标正确，提交后响应被丢弃                   | 独立回读成功，一条事件和一份回执                                          |
| 指定第二个项目       | 首写省略 `projectId`，MCP 在转发前拒绝           | 填写已读取的项目 ID 后成功回读，一条事件和一份回执                        |
| 同名事项歧义         | 读到两个同名事项并询问目标                       | 零写入、零回执                                                            |
| 显式错号             | 查明已授权编号与所给编号不符并停止               | 零写入，答复缺少预设的主动确认提问                                        |
| 明确拒绝后才允许纠正 | 跳过给定的错号命令，提前尝试纠正，被测试中转拦截 | 未观察到正式 API 的写拒绝或后续纠正，零写入。答复把拦截来源误报为正式 API |

[原演示任务](../../services/dingjiang-mcp/evals/agent/demo-cases.json) · [固定目标定位输入和判定](../../services/dingjiang-mcp/evals/agent/target-location-cases.json)

离线汇总分别输出 `firstTargetCorrect`、`rejectedAttemptHadNoEffect`、`correctionAfterDefinitiveRejectionSafe`、`unknownOutcomeRecoverySafe`、`singleBusinessEffect` 和 `readbackVerified`。首写项目没有解析时记为 `UNRESOLVED`。拒绝的零副作用从前置拦截证据确认。真实 API 拒绝若缺少单次写入前后的证据，报告 `NOT_OBSERVED`，整组最终计数单独记录。明确拒绝并确认零副作用后，可以按原授权纠正并形成新命令。写入结果未知时保留原命令和请求编号。 [离线汇总实现](../../scripts/demo/target-evidence.mjs) · [异常处置](../../services/dingjiang-mcp/PROTOCOL.md#错误与恢复)

## WorkBuddy 连接

`f241a344b679b5fe5d947b6144444094ac5d4c17` 的隔离候选通过 WorkBuddy 附带的 CodeBuddy 2.165.0 运行器确认 `dingjiang_candidate` 已连接。独立 stdio 探针发现 13 个工具，并读回合成项目。模型运行要求登录，记为 `NOT_RUN`。日常 WorkBuddy 配置和真实企业资料列为未验收。

## compact 字节对照

`805fc62c1440f0f02ded3ca1013beb6e1025a022` 的 `pnpm demo:mcp` 对同一合成项目、同一命令测量工具文本 UTF-8 字节数。两种回执格式都取自同一已存命令的重放结果。

| 调用     | 默认 full | compact |
| -------- | --------: | ------: |
| 写前查询 |    32,043 |     766 |
| 写入回执 |    31,886 |     518 |
| 独立回读 |    32,177 |     360 |
| 合计     |    96,106 |   1,644 |

工具文本减少约 98.3%。本次测量范围为上述三次调用的文本。模型 token、任务耗时和生产性能均未测量。 [对照断言](../../apps/api/src/integration/real-e2e.integration.test.ts) · [Demo](../demo/mcp-workspace-demo.md#进展精简返回)

## 后端拒绝与复现

错号通过实际 MCP 进程和正式 Integration API 拒绝。跨项目事项通过 Integration HTTP 直连验证，调用凭证同时具备两个项目的权限。旧版本和正确版本搭配过期状态指纹均通过正式写入路径触发 `STALE_VERSION`。回放只在真实提交后丢弃响应，原命令重放返回已存回执。 [真实进程用例](../../apps/api/src/integration/real-e2e.integration.test.ts) · [跨项目用例](../../apps/api/src/integration-http.integration.test.ts)

```bash
pnpm demo:mcp
pnpm demo:mcp --agent --suite target-location --model <模型名称> --codex <Codex-CLI-可执行文件>
node scripts/demo/target-evidence.mjs <评测运行目录>
```

Demo 仅连接临时 API 与合成库。模型命令使用已获授权且已登录的宿主。离线命令读取同一运行的 `plan.json` 和 `outcomes.json`，可复用已有记录。生产部署、企业身份联调和 WorkBuddy 模型任务均列为未验收。
