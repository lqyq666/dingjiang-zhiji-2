# MCP 宿主支持矩阵

这份矩阵回答「哪些宿主组合是**验证过**的」，不是「打算支持谁」。没有实测证据的组合一律写「未验证」，不把计划写成能力。依据来自 `pnpm --filter @dingjiang/mcp eval` 的会话档案矩阵、`tool-contract.test.ts` 与 CI。

## 传输边界

`createMcpHandler`（`services/dingjiang-mcp/src/protocol.ts`）返回一个纯函数 `JsonRpcRequest -> Promise<JsonRpcResponse | undefined>`，不读 stdin/stdout，也不 import `stdio.ts`。`src/server.ts` 只把 `readline` 的行事件接到 `createStdioDispatcher`，再把响应写回 stdout。

因此新增一种传输只需要一个新的 dispatcher 调用同一个 handler，**不需要改 `protocol.ts`、`callTool` 或任何业务代码**。`src/transport-boundary.test.ts` 把这条边界钉在测试里。

当前**只有 stdio**，没有对外 HTTP 监听端口。理由：本地宿主对 stdio 支持最广，且不需要处理 OAuth、CORS 与会话持久化；远程传输的安全边界需要单独设计，不在本轮范围。

## 已验证的组合

| 维度       | 取值                                                                                | 验证入口                                 |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| 传输       | stdio，一行一个 JSON，默认 1 MiB 行上限                                             | `stdio.test.ts`、tier4 真实两进程        |
| 协议版本   | `2025-06-18`（含 `outputSchema`）、`2025-03-26`（不含）                             | eval 会话矩阵、`tool-contract.test.ts`   |
| 工具面     | business 13 个、compatibility 23 个，去重 28 个                                     | eval 的 `protocol-tools-list-*`          |
| 宿主识别   | `WorkBuddy` 命中能力表；未知宿主回落 `DINGJIANG_MCP_TOOL_SURFACE`；未握手用默认档案 | `session-profile.test.ts`、eval 会话矩阵 |
| 治理不变量 | 越权字段注入 7 例、非法参数 6 例、缺失降级 2 例，在 12 组会话组合下累计 480 次回归  | eval 会话档案矩阵                        |

一个进程可以同时服务不同宿主：会话档案由 `initialize` 生成并保存在 handler 闭包里，`tools/list` 按本次会话组装，不再读进程级开关决定全部会话。

## 明确未验证

| 组合                                   | 状态       | 原因                                                           |
| -------------------------------------- | ---------- | -------------------------------------------------------------- |
| Claude Desktop / Cursor / 其它桌面 IDE | 未验证     | 未拿到这些宿主真实的 `clientInfo` 与协议版本，不假定工具面偏好 |
| 云端 Agent / Streamable HTTP           | 未实现     | 需要远程鉴权、CORS 与会话边界，属于独立一轮                    |
| 真实飞书 / Coze                        | 见演示脚本 | 默认 `DEMO_RULES` 只证明本地可重复，不代表真实权限或模型输出   |

演示脚本在 `docs/demo/vs17-experience-intelligence-demo-script.md`。

## 新增一个宿主

1. 从宿主握手日志取 `initialize.params.clientInfo.name / version` 与 `protocolVersion`。
2. 在 `src/host-profiles.ts` 加一行，可覆盖 `toolSurface` 与 `supportsStructuredOutput`；**只写有依据的偏好**，未知就留空走回落。
3. 在 `evals/run.mjs` 的 `runSessionMatrixCheck` 里加一个 scenario，写明期望工具面。
4. 跑 `pnpm --filter @dingjiang/mcp build`、`pnpm --filter @dingjiang/mcp eval`，再跑 `pnpm verify`。
5. 把实测结果补进「已验证」；没有实测的继续留在「未验证」。

## 红线

宿主能力表只影响**广告哪些元数据**。租户、角色、scopes、`requestId` 幂等、`expectedVersion` 乐观并发与越权拦截一律在 API 侧执行；工具参数不接受身份字段，`callTool` 不按宿主分支。评测矩阵会在每个会话组合下重跑越权与非法参数用例，专门验证降级没有顺手把权限一起降掉。
