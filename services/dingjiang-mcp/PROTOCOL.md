# 零依赖 MCP 协议实现

这是一份实现说明，不是使用说明。它讲这个 server 为什么不用官方 SDK、四个协议方法各自怎么落地、哪些东西是故意不做的，以及怎么证明它是对的。使用与配置见 [README.md](README.md)。

## 1. 为什么不用官方 SDK

运行时依赖只有 `zod` 和内部契约包，没有 `@modelcontextprotocol/sdk`。这不是姿态，是三个具体判断：

| 判断               | 依据                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议面只有四个方法 | `initialize` / `ping` / `tools/list` / `tools/call`。SDK 附带的 resources、prompts、sampling、elicitation 我们不用，却要跟着它的版本节奏升级 |
| 治理语义长在协议上 | `annotations`、`outputSchema`、`instructions` 的取值全部来自业务契约。SDK 只提供挂载点，不减少这部分工作                                     |
| 传输只有 stdio     | SDK 的多传输抽象在这里是没有调用者的代码                                                                                                     |

代价也要说清：协议演进要自己跟。当前只在 `session-profile.ts` 里声明 `2025-06-18` 一个常量，将来升级是改一处常量加一处回包，而不是改一套框架调用；反过来，如果某天要同时支持两个修订版，就得自己补版本分支——这个成本是被明确接受的。

## 2. 四个方法各自解决什么

### `initialize`

回包四个字段，每个都有明确用途：

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": {
    "name": "dingjiang-mcp",
    "version": "0.7.0",
    "buildIdentity": "…"
  },
  "instructions": "…"
}
```

- `capabilities` 只声明 tools，且 `listChanged: false`：工具面只在部署时变更，不假装能推送更新。
- `buildIdentity` 是进程启动时记下的构建标记。每次请求都会比对当前部署，变了就返回 `SESSION_MCP_PROCESS_STALE` 并建议新建会话——否则宿主会拿着旧进程的工具清单继续调用一个已经换过的服务端。
- `instructions` 是这段实现里最不"协议"的部分：它把「AI 输出恒为 PROPOSAL」「写前必读 `work.operations`」「超时复用 `requestId`」这些业务规则作为协议内容交给宿主放进模型上下文。规范允许这样做，但多数实现只把它当欢迎语。
- 重复 `initialize` 幂等：第二次握手返回第一次协商的结果。宿主重试握手是正常的，但静默改变已承诺的工具面不是。

### `tools/list`

返回的顺序是声明顺序，不是字典遍历顺序。规范建议确定性顺序，宿主才能跨轮复用工具块、命中提示词缓存。

工具不是运行时拼的：`toolRegistry` 里每个工具只有一份定义，`business` 与 `compatibility` 是两个有序名单，映射到同一批 `ToolDescriptor` 实例。共享工具在两个面里是同一个对象，改一处不会只改到一面。

`dispatchedToolNames` 故意不从这个注册表生成。它是 `callTool` 分发分支的独立手写镜像，`tool-contract.test.ts` 拿它和声明集做双向比对——如果让它自动派生，这条守卫就变成了自己和自己比，永远为真。

### `tools/call`

三层结构，顺序不能换：

1. **信封**：`{ name, arguments }` 用 `passthrough()` 校验——多出来的字段不拒绝，因为宿主可能附加 `_meta` 之类的传输层信息。
2. **参数**：每个工具的 `inputSchema` 都由 Zod `.strict()` 契约生成，未知字段直接拒绝。权限与项目范围**不在参数里**，全部来自服务端按令牌绑定的身份，工具无法通过传参伪造。
3. **分发**：`switch` 落到具体实现；未登记的名字返回 `UNKNOWN_TOOL`，而不是静默成功。

成功回包同时给 `content`（文本，给只读文本的宿主）和 `structuredContent`（结构化，给能校验契约的宿主）。这是有意的冗余：MCP 规范要求 `content` 必填，只给结构化内容会让一部分宿主拿不到数据。

### `ping` 与通知

`ping` 返回空对象。所有通知（`id` 缺失的请求）直接忽略、不回复——包括 `notifications/initialized`。规范没有要求服务端对通知做回执，忽略是合规的；代价是当前不处理 `notifications/cancelled`，这一点在「故意不做」里说明。

## 3. JSON-RPC 的错误面

| 场景           | 返回                           | 说明                                        |
| -------------- | ------------------------------ | ------------------------------------------- |
| 非法 JSON      | `-32700`，`id: null`           | 解析失败时无法知道请求 id，规范要求 null    |
| 单行超限       | `-32600` + `REQUEST_TOO_LARGE` | 在解析前拒绝，避免为一条超大行分配内存      |
| 未知方法       | `-32601`                       |                                             |
| 参数校验失败   | `-32602`                       | 只有 Zod 参数错误映射到这里                 |
| handler 抛异常 | `-32603` + `HANDLER_FAILURE`   | 诊断写 stderr，不进协议流，也不中断后续请求 |

业务失败**不**占 JSON-RPC 错误码，而是放在结果里：`isError: true` + `structuredContent.code`。这样宿主能同时拿到机器可读的 `code`、`retryable`、`requiresHuman`，以及服务端的 `correlationId`。错误分类按固定顺序判定：

| 类型                        | 含义                                 | 是否保留原文                             |
| --------------------------- | ------------------------------------ | ---------------------------------------- |
| `IntegrationClientError`    | 服务端返回的标准 failure envelope    | 保留（服务端消息可信）                   |
| `IntegrationTransportError` | 超时 / 网络 / 响应与契约不一致       | 保留（我们自己写的文案）                 |
| `ZodError`                  | 入参不符合契约                       | 固定文案                                 |
| `ToolRefusal`               | 可预期的业务拒绝，如 `CONTEXT_DRIFT` | 保留（消息由我们定义）                   |
| 其它异常                    | 未预期                               | **不保留**，只给固定文案 + correlationId |

最后一行是刻意的：任意异常的 message 可能带出文件路径或内部标识，直接回给宿主等于把它们写进对话记录。

## 4. stdio 的五个决定

`stdio.ts` 只有 102 行，但每个决定都对应一类线上事故：

1. **串行执行**：所有请求排进一条 Promise 链，受治理写永不并发，响应顺序与请求顺序一致。
2. **失败不毒化队列**：`queue.then(execute, execute)`——上一行抛错后，下一行照常执行。
3. **解析前限流**：超限行返回 `REQUEST_TOO_LARGE`，不做 `JSON.parse`。
4. **诊断走 stderr**：`onError` 只拿到异常，协议流里只有 JSON-RPC 消息，不会因为一行日志破坏解析。
5. **响应可 await**：`respond` 返回 Promise，stdout 背压时等待 `drain`，避免写入乱序。

## 5. 元数据不是抄出来的

- `annotations` 覆盖全部工具，`readOnlyHint` 与「入参是否同时必填 `requestId` + `expectedVersion`」双向断言——受治理写不可能被标成只读。
- `outputSchema` 有 25 个，直接取自 client 校验响应用的同一批 Zod schema（`z.toJSONSchema`），所以 `structuredContent` 与声明同构是构造出来的。三个聚合工具（`workspace.resume`、`work.context`、`evidence.bundle`）刻意不声明：它们是多个 payload 的拼装，写一个猜出来的 schema 只会得到一份会漂移的契约。
- `project.next_action` 相反，输出是本服务自建对象，于是定义显式 schema 并在返回前 `parse`，让 `classification` 不可能出现 `PROPOSAL` 以外的值。

## 6. 故意不做

| 不做                              | 理由                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 协议版本表（曾支持 `2025-03-26`） | 没有真实客户端使用；一条没人走的兼容分支会让「会话承诺了什么」难以核对                                    |
| `resources` / `prompts`           | 当前没有宿主消费它们；只声明不实现比不声明更糟                                                            |
| `notifications/cancelled`         | 读可以接受取消，写不行；语义没想清楚前宁可不接                                                            |
| `progress` 通知                   | 聚合工具最长也就数秒，进度条收益低于实现与测试成本                                                        |
| `tools/list` 分页                 | 28 个工具远没到需要游标的量级                                                                             |
| MCP 2026-07-28 无状态协议         | 主流宿主仍是 opt-in；现在实现等于维护两套逻辑                                                             |
| 压缩 inputSchema                  | 6 个写工具共享同一套 governed envelope，重复是必然；用 `$ref` 省几 KB，赌所有客户端正确解析跨 schema 引用 |

## 7. 怎么证明它是对的

协议实现最怕"看起来对"。这里的做法是让每条不变量都有可执行的证据：

- `evals/` 的 46 个用例直接驱动 `dist/` 里的真实 dispatcher，覆盖 happy path、越权注入、参数守卫、超时恢复、缺失降级与协议契约。
- 会话矩阵把 40 个非协议用例在两套工具面上各跑一遍，断言两面给出同一套治理标注与拦截。
- `tool-contract.test.ts` 双向比对声明与实现，并检查 `annotations` 与入参契约是否一致。
- 变异验证：删掉错误脱敏、忽略宿主档案、让视图返回副本而不共享实例——每一次都应有测试变红；没有变红的守卫等于没有守卫。

## 8. 读代码的顺序

1. `endpoint-policy.ts`（67 行）：允许连哪个 API，为什么。
2. `client.ts`（386 行）：三类错误的边界，响应如何按契约校验。
3. `protocol.ts` 的 `toolGovernance` → `toolRegistry` → `callTool`：工具面怎么组装、怎么分发。
4. `stdio.ts`（102 行）：传输层的五个决定。
5. `protocol.ts` 的 `createMcpHandler`：会话状态、握手幂等、错误映射。
