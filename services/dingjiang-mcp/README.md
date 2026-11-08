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

## 工具契约评测

`evals/` 提供可回归的契约评测，直接驱动 `dist/` 中的真实 dispatcher，Integration 侧使用确定性 mock，不依赖网络、数据库或模型凭据：

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval
```

当前基线：声明的 28 个工具全部可达（无 `UNKNOWN_TOOL`）；24 个读写 happy path 返回 `structuredContent` 并命中预期 Integration 方法；7 类越权字段注入全部 `INVALID_REQUEST` 且零 Integration 调用；6 类非法参数全部被拒；传输超时结构化收敛且不泄露授权头；6 项协议契约通过。任一不变量失败时退出码为 1，CI 会阻断合并。用例格式与扩展方式见 `evals/README.md`。

## 工具边界

默认读取：`workspace.resume`、`workspace.events`、`work.context`、`work.operations`、`evidence.bundle`、`experience.search`、`project.next_action`。

受治理写入：`workpaper.propose`、`material.create`、`evidence.propose`、`material.verify`、`evidence.confirm`、`work.execute`。兼容工具面为 23 个。

`work.execute` 必须先读取 `work.operations` 的 version、stateFingerprint 和 allowedActions。用户明确确认后记录原话；已知字段由助手关联。相同请求重放返回原回执，不重复执行。状态过期拒绝覆盖；超时保留原请求核对。版本、状态、不可覆盖来源及审计同事务提交。

新增权限不会自动授予旧 token：PMC 需要 workitem:write；材料核验/证据确认分别需要 material:verify / evidence:confirm；OWNER 定稿需要 project:approve；EXPERT_REVIEWER 发布需要 experience:publish。新事件必须有明确的预留项目白名单项，例如 PRJ-SO-202608136，workspace.events 才会提供入口。现有项目继续使用原 ID。

仓库候选版本为 0.6.0；`.ai-dev/WORKBUDDY_RUNTIME.json` 仍记录已部署基线。只有正式同步 bundle、服务端 bindings 和 runtime checkout 并通过真实会话验证后，才能声明接通。

不存在工作底稿或材料正文时返回安全的 NOT_FOUND/BODY_NOT_AVAILABLE 语义，不伪造内容；材料预览不返回原始 bytes、绝对路径或存储键。
