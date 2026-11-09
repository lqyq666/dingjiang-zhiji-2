# Dingjiang MCP

本地 stdio MCP 只调用 loopback `/api/integration/*`，不访问 PostgreSQL、业务文件或厂商 SDK。默认提供 13 个受限业务入口：7 个读取入口、6 个受治理写入口。Evidence Proposal 仍非 FACT；人工确认动作须由对应身份在 WorkBuddy 明确发起。Web 只读展示事实、过程和经营数据。

## 启动前提

1. Dingjiang API 在 `http://127.0.0.1:3001/api` 运行。
2. MCP 进程配置 `DINGJIANG_MCP_API_TOKEN`，值不得提交到 Git、evidence 或日志/stdout。
3. API 进程选择一种服务端身份绑定：
   - 兼容模式：`DINGJIANG_MCP_API_TOKEN`，可用 `DINGJIANG_MCP_PROJECT_IDS` 限制项目；
   - 多身份模式：`DINGJIANG_MCP_TOKEN_BINDINGS_JSON`，每个条目在服务端绑定 `token`、`tenantId`、`subjectId`、`role`、`scopes`、`projectIds`。

调用参数不接受 tenant、subject、role、scope 或 project allowlist。多身份 JSON 只放在本机/密钥管理环境变量中，不写入仓库配置。

## WorkBuddy 用户级安装与密钥轮换

WorkBuddy 5.3.14 的本机实测行为是不展开 MCP `env` 中的 `${VAR}`，也不能依赖已运行进程重新继承 Windows 用户环境变量。因此仓库根 `.mcp.json` 只是禁用、无密钥模板；可运行配置由 `scripts/workbuddy/install-global-mcp.ps1` 写入当前用户的 `~/.workbuddy/mcp.json`。

安装器从 Windows 用户级 `DINGJIANG_MCP_API_TOKEN` 读取值，只在上述用户级本地配置写入 literal token。它不向 stdout 输出 token，不把 token 写入仓库或 evidence；每次安装保留的 rollback bundle 只包含旧运行时文件和脱敏后的 dingjiang 配置，恢复时重新读取当前用户级 token。

轮换步骤：

1. 退出 WorkBuddy 后运行 `scripts/workbuddy/rotate-local-secrets.ps1`。脚本在内存生成新 Dingjiang token，同步更新项目 `.env`、Windows 用户环境和用户级 `~/.workbuddy/mcp.json`，并原位脱敏 WorkBuddy 文本历史中的旧 Dingjiang token 与当前飞书 App Secret；不制作明文备份、不输出密钥值。
2. 重启本地 Dingjiang API，使服务端身份配置读取新 token。
3. 重启 WorkBuddy/新建会话，运行 `scripts/workbuddy/verify-global-mcp.ps1`，确认版本、build identity、13 个默认工具和真实只读调用。
4. 旧 rollback bundle 不保存旧 token；如需回滚，运行 bundle 内 `restore-global-mcp.ps1`，它会注入轮换后的当前 token。

飞书 App Secret 的平台轮换是独立外部操作。上述本地脚本只清理 WorkBuddy 历史痕迹，不会重置开放平台凭据、修改飞书 Schema 或发送飞书消息。

## 传输层与客户端健壮性

stdio 入口由 `src/stdio.ts` 统一调度，`server.ts` 只负责进程与流接线：

- 请求串行处理：受治理写入口不会并发执行，响应顺序与请求顺序一致；`dispatch.drain()` 可等待已接收行全部应答。
- 异常兜底：handler 抛出的异常转换为 `-32603`，诊断写 stderr，不进入 stdout 协议流，也不中断后续请求。
- 单行上限：默认 1 MiB，可用 `DINGJIANG_MCP_MAX_LINE_BYTES` 调整（上限 64 MiB）；超限返回 `-32600` 与 `REQUEST_TOO_LARGE`，在解析前拒绝。
- 背压：stdout 写满时等待 `drain`，避免大批量响应乱序。

Integration client 将失败分为三类，避免把服务端问题误报为调用方参数错误：

- 服务端返回的标准 failure envelope → `IntegrationClientError`，保留服务端 code 与 correlationId。
- 传输层失败 → `IntegrationTransportError`：`INTEGRATION_TIMEOUT`、`INTEGRATION_NETWORK_ERROR`、`INTEGRATION_INVALID_RESPONSE`（非 JSON 响应、HTTP 失败且无标准 envelope、响应与 contract 不一致）。
- 入参校验失败 → `INVALID_REQUEST`，只对应调用方参数；响应 schema 校验失败不再归入此类。

`DINGJIANG_MCP_TIMEOUT_MS` 配置请求超时（默认 10000，范围 100–120000）。超时错误仍要求复用原 requestId / correlationId 核对，不得改 requestId 重试。`DINGJIANG_API_BASE_URL` 的校验结果按原始值缓存，环境变量变化时立即重新校验；loopback HTTP 覆盖完整 `127.0.0.0/8`，并拒绝 `127.0.0.1.evil.com` 这类伪装主机。

## 多宿主适配（会话级）

不同 AI 宿主对协议版本、工具命名和返回说明书的支持不一样。差异只在握手时收敛一次，不进分发逻辑：

- `src/host-profiles.ts` 是宿主能力表：按 `initialize.params.clientInfo.name / version` 匹配，新增宿主只需加一行，可覆盖工具面与是否支持结构化输出。
- `src/session-profile.ts` 由握手参数生成会话档案（协议版本、工具面、是否下发 `outputSchema`），保存在 `createMcpHandler` 的闭包里；`tools/list` 按**本次会话**的档案组装，所以一个进程可同时服务不同宿主。
- 未识别的宿主回落到部署级 `DINGJIANG_MCP_TOOL_SURFACE`，既有配置不会失效；未握手就 `tools/list` 时使用默认档案。

工具定义只有一份：`protocol.ts` 的 `toolRegistry` 收录全部 28 个工具，两套工具面只是它上面的有序名单，共享同一批 `ToolDescriptor` 实例。`dispatchedToolNames` 仍独立手写，供 `tool-contract.test.ts` 双向比对声明与实现——它不能由注册表自动生成，否则守卫会空转。

**红线**：宿主能力表只影响「广告哪些元数据」，绝不改变租户、角色、scope、`requestId` 幂等与 `expectedVersion` 校验；这些统一在 API 侧执行，工具参数也不接受身份字段。

## 工具元数据：让治理边界对宿主可见

`tools/list` 不只是参数表。宿主用它决定调用前是否弹确认、结果能否当不可信外部内容、界面上显示什么名字。而协议的默认值对治理型服务最不利：什么都不声明时 `readOnlyHint` 为 false、`destructiveHint` 为 true、`openWorldHint` 为 true——22 个只读工具在宿主眼里和写入口没有区别，宿主只能选择对每次读取都弹框，或者干脆忽略提示。

因此每个工具都必须先在 `toolGovernance` 表登记读写分类；`annotationsFor` 查不到条目时直接抛错（fail closed），而不是退回默认值——默认值会把真正的写入口淹在一堆误报里。

| 维度              | 只读工具（22） | 受治理写入口（6） |
| ----------------- | -------------- | ----------------- |
| `readOnlyHint`    | `true`         | `false`           |
| `destructiveHint` | `false`        | `true`            |
| `idempotentHint`  | `true`         | `true`            |
| `openWorldHint`   | `false`        | `false`           |
| `title`           | 中文动作名     | 中文动作名        |

`idempotentHint` 全为 `true` 不是偷懒：读工具天然幂等；写工具的幂等性来自契约本身——`requestId` 是受治理命令的幂等键，相同 `requestId` + `expectedVersion` 重放返回原回执，这也正是超时必须复用原 requestId 而不能新生成的原因。

规范明确 annotations 只是**不可信提示**，不能作为授权依据。本服务不靠它做权限判断：角色、scope、阶段与完成条件仍由 Integration API 校验，annotations 只影响宿主 UX。

`outputSchema` 由 25 个工具声明，直接取自 client 校验响应所用的那批 Zod schema（`z.toJSONSchema(schema, { io: "output" })`），所以 `structuredContent` 与声明同构是构造出来的，不是承诺出来的。三个聚合工具（`workspace.resume`、`work.context`、`evidence.bundle`）刻意不声明：它们是多个 payload 的拼装结果，写一个猜出来的 schema 只会得到一份会漂移的契约。`project.next_action` 相反——输出是本服务自建对象，于是定义了显式 schema 并在返回前 `parse`，使 `classification` 不可能出现 `PROPOSAL` 之外的值。

`initialize` 结果携带 `instructions`，把治理不变量（PROPOSAL 不是 FACT、写前必读 `work.operations`、超时复用 requestId、定稿仅 OWNER / 发布仅 EXPERT_REVIEWER）交给客户端放进模型上下文，而不是指望每个宿主的提示词恰好写对。

协议版本按会话协商：`2025-06-18` 支持 `outputSchema`，`2025-03-26` 不支持，因此面向后者发起的会话不下发该字段——给旧客户端塞它无法表达的字段，只会让校验形同虚设。`Object.hasOwn` 而非 `in` 判断版本键，避免 `toString`/`__proto__` 被当成合法修订版。

`src/tool-contract.test.ts` 把这些元数据钉在入参契约上：受治理写入口的唯一结构特征是同时必填 `requestId` 与 `expectedVersion`，测试据此反推写集合，再断言没有任何写入口被标成只读——标注与实现无法一起悄悄漂移。

## 工具契约评测

`evals/` 提供可回归的契约评测，直接驱动 `dist/` 中的真实 dispatcher，Integration 侧使用确定性 mock，不依赖网络、数据库或模型凭据：

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval
```

当前基线：声明的 28 个工具全部可达（无 `UNKNOWN_TOOL`）；28 个工具的 annotations 与 `outputSchema`（25 个）在 wire 层完备且读/写标注与入参契约一致；24 个读写 happy path 返回 `structuredContent` 并命中预期 Integration 方法；7 类越权字段注入全部 `INVALID_REQUEST` 且零 Integration 调用；6 类非法参数全部被拒；传输超时结构化收敛且不泄露授权头；可选子资源缺失时降级、越权时不降级（2/2）；6 项协议契约通过。任一不变量失败时退出码为 1，CI 会阻断合并。用例格式与扩展方式见 `evals/README.md`。

## 工具边界

默认读取：`workspace.resume`、`workspace.events`、`work.context`、`work.operations`、`evidence.bundle`、`experience.search`、`project.next_action`。

受治理写入：`workpaper.propose`、`material.create`、`evidence.propose`、`material.verify`、`evidence.confirm`、`work.execute`。兼容工具面为 23 个。

`work.execute` 必须先读取 `work.operations` 的 version、stateFingerprint 和 allowedActions。用户明确确认后记录原话；已知字段由助手关联。相同请求重放返回原回执，不重复执行。状态过期拒绝覆盖；超时保留原请求核对。版本、状态、不可覆盖来源及审计同事务提交。

新增权限不会自动授予旧 token：PMC 需要 workitem:write；材料核验/证据确认分别需要 material:verify / evidence:confirm；OWNER 定稿需要 project:approve；EXPERT_REVIEWER 发布需要 experience:publish。新事件必须有明确的预留项目白名单项，例如 PRJ-SO-202608136，workspace.events 才会提供入口。现有项目继续使用原 ID。

仓库候选版本为 0.7.0（新增工具元数据与版本协商）。只有正式同步 bundle、服务端 bindings 和 runtime checkout 并通过真实会话验证后，才能声明接通。

不存在工作底稿或材料正文时返回安全的 NOT_FOUND/BODY_NOT_AVAILABLE 语义，不伪造内容；材料预览不返回原始 bytes、绝对路径或存储键。

单个读工具（`get_validation_workpaper`）保留 `NOT_FOUND`：调用方明确要那一条，不存在就是不存在。聚合工具（`workspace.resume`、`evidence.bundle`）把 `NOT_FOUND` 降级为 `null`——项目刚建、底稿尚未产生时，`resume` 恰好是最需要可用的时刻，不能因为一个可选子资源缺失就整体失败。`FORBIDDEN` 不降级：真实 API 对「缺 scope」和「越权项目」都返回 403，对「已授权但未创建」返回 404，两者可区分，所以这个降级不会把授权失败伪装成「暂无数据」。
