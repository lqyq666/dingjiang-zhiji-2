# Dingjiang MCP

本地 stdio MCP 将工具调用转成带 Bearer 令牌的 `/api/integration/*` 请求。本机可以用 HTTP，远程 API 需用 HTTPS。默认业务面有 7 个只读工具和 6 个受治理写工具。人工确认由对应身份发起，Evidence Proposal 要经过核验才可能成为事实。 [调用链和协议实现](PROTOCOL.md)

从仓库根目录运行 `pnpm demo:mcp` 可以回放一次完整的延期项目处理过程，并在终端查看权限、幂等回执和数据回读。 [演示说明](../../docs/demo/mcp-workspace-demo.md)

## 启动前提

1. Dingjiang API 在 `http://127.0.0.1:3001/api` 运行。
2. MCP 进程配置 `DINGJIANG_MCP_API_TOKEN`，值不得提交到 Git、evidence 或日志/stdout。
3. API 进程选择一种服务端身份绑定：
   - 兼容模式：`DINGJIANG_MCP_API_TOKEN`，可用 `DINGJIANG_MCP_PROJECT_IDS` 限制项目；
   - 多身份模式：`DINGJIANG_MCP_TOKEN_BINDINGS_JSON`，每个条目在服务端绑定 `token`、`tenantId`、`subjectId`、`role`、`scopes`、`projectIds`。

调用参数不接受 tenant、subject、role、scope 或 project allowlist。多身份 JSON 只放在本机/密钥管理环境变量中，不写入仓库配置。

## 接入客户端

MCP 走 stdio：客户端启动 `node dist/server.js`，通过标准输入输出通信，不监听端口。先构建一次：

```bash
pnpm --filter @dingjiang/mcp build
```

每个客户端各配一条 server 条目。形状是 MCP 标准的 stdio 配置，把路径换成你的仓库绝对路径：

```json
{
  "mcpServers": {
    "dingjiang": {
      "command": "node",
      "args": ["/absolute/path/to/services/dingjiang-mcp/dist/server.js"],
      "env": {
        "DINGJIANG_API_BASE_URL": "http://127.0.0.1:3001/api",
        "DINGJIANG_MCP_API_TOKEN": "<与 API 进程相同的令牌>"
      }
    }
  }
}
```

工具面是**进程级**的，所以：

- 认命名空间工具名（`work.context`、`evidence.bundle`）的客户端：按上面的配置，得到 business 面 13 个工具。
- 只认扁平工具名（`get_project_context`、`list_evidence`）的客户端：在 `env` 里加 `"DINGJIANG_MCP_TOOL_SURFACE": "compatibility"`，该进程给 23 个工具。
- 两类客户端都要接入时，可以配置两条条目，各自启动进程。
- 只读接入在 `env` 里加 `"DINGJIANG_MCP_READ_ONLY": "1"`，业务面提供 7 个只读工具，兼容面提供 17 个。直接调用写工具也会在 MCP 层被拦截。

### Codex CLI

Codex 用 TOML，配置在 `~/.codex/config.toml`（或受信项目里的 `.codex/config.toml`）。令牌用 `env_vars` 从 shell 继承，配置文件本身就不含秘密、可以提交：

```toml
[mcp_servers.dingjiang]
command = "node"
args = ["/absolute/path/to/services/dingjiang-mcp/dist/server.js"]
# 本地 node 启动很快，默认 10s 足够；放在慢磁盘上可放宽。
startup_timeout_sec = 20
# 必须大于 DINGJIANG_MCP_TIMEOUT_MS（默认 10s），否则 Codex 先断开，看不到结构化错误。
tool_timeout_sec = 30
# 只在写工具前弹确认，读工具直接执行；依赖服务端 annotations.readOnlyHint。
default_tools_approval_mode = "writes"

# 从当前 shell 继承，不把令牌写进文件
env_vars = ["DINGJIANG_MCP_API_TOKEN"]
env = { DINGJIANG_API_BASE_URL = "http://127.0.0.1:3001/api" }
```

如果只想让 Codex 只读，把它限制在读工具上：

```toml
disabled_tools = ["work.execute", "material.verify", "evidence.confirm", "workpaper.propose", "material.create", "evidence.propose"]
```

`codex mcp list` 看连接状态与工具数，`codex mcp logs` 看握手失败原因。一个容易误判的点：`INTEGRATION_TIMEOUT` **不等于请求失败**——写操作可能已经提交，必须用原 `requestId` 重新核对，不能改号重试。

### 其他客户端

各客户端的配置文件位置与字段名以其官方文档为准；上面 JSON 是 MCP 标准的 stdio 条目形状，字段为 `command` / `args` / `env`。Codex 用 TOML，字段名与上面示例一致。

**WorkBuddy 5.3.14 的实测差异**：它不展开 `env` 里的 `${VAR}`，也不会让已运行进程重新继承 Windows 用户环境变量。因此令牌要直接写进当前用户的 `~/.workbuddy/mcp.json`（明文，仅本机，不要提交）。改完配置要新建会话——stdio 进程随会话启动，旧进程读不到新值。

## 远程接入

远程入口由官方 TypeScript SDK 提供 Streamable HTTP。它逐请求验证 OAuth access token。stdio 宿主继续使用原来的启动命令和双版本协议。

把以下配置注入远程进程。公开地址应是客户端访问的完整 HTTPS URL，并与 OAuth audience 一致。应用监听本机回环地址，HTTPS 反向代理转发时保留公开地址的 `Host`。本地验证可用回环 HTTP。

| 配置                                | 用途                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DINGJIANG_MCP_HTTP_URL`            | 公开资源 URL，路径固定为 `/mcp`                                                                                        |
| `DINGJIANG_MCP_HTTP_PORT`           | 本机监听端口，默认 `3002`                                                                                              |
| `DINGJIANG_MCP_OAUTH_ISSUER`        | 信任的发行方标识，和 JWT 的 `iss` 完全一致                                                                             |
| `DINGJIANG_MCP_OAUTH_JWKS_URL`      | 发行方的 JWKS 地址                                                                                                     |
| `DINGJIANG_MCP_OAUTH_BINDINGS_JSON` | JSON 数组，每个 `{ "subject": "...", "integrationToken": "..." }` 把发行方的 `sub` 绑定到该身份独有的 Integration 令牌 |
| `DINGJIANG_API_BASE_URL`            | Integration API 地址，默认本机 `http://127.0.0.1:3001/api`                                                             |

发行方提供 OAuth 或 OIDC 发现、授权码与 PKCE S256，并为该资源签发 JWT access token。入口接受 `typ=at+jwt`、RS256 或 ES256 签名的令牌，验证发行方、audience、签名和有效期，并读取 `sub`、`client_id` 和空格分隔的 `scope`。客户端注册和用户授权由发行方管理。

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp start:http
```

客户端选择 Streamable HTTP，填公开 `/mcp` URL。未授权访问返回 401 和指向 `/.well-known/oauth-protected-resource/mcp` 的 `WWW-Authenticate`，客户端据此查找发行方。令牌校验失败返回 401 `invalid_token`。发行方的公钥服务不可用时返回 500 `server_error`，原令牌可在公钥服务恢复后重试。基本查询需要 `dingjiang:mcp:read`。有读范围时只看到只读工具，另获 `dingjiang:mcp:write` 才能使用受治理写工具。直接调用当前工具面屏蔽的写工具返回 `UNKNOWN_TOOL`。

`DINGJIANG_MCP_READ_ONLY=1` 把整个进程限制为只读。Integration API 用绑定的独立业务令牌检查租户、角色、项目和操作权限。两个入口使用同一套版本校验、幂等和回执逻辑。 [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## 密钥与轮换

- 令牌只放两处：API 进程与 MCP 进程的环境变量，两边必须一致；MCP 进程的令牌不进入工具参数，AI 也无法读取。
- 不提交 `.env`，不把令牌写进仓库内的客户端配置，不贴进对话、截图或日志。
- 轮换顺序：改两处令牌 → 重启 API → 客户端新建会话。stdio 进程在会话结束时退出，旧值不会残留。
- 本机 `~/.workbuddy/mcp.json` 保存的是明文令牌，属于运维待办：轮换后应视旧值为已泄露。
- 飞书 App Secret 的轮换是开放平台上的独立操作，与这里的 Dingjiang 令牌无关。

## 传输层与客户端健壮性

stdio 入口由 `src/stdio.ts` 统一调度，`server.ts` 只负责进程与流接线：

- 同一会话相邻的只读工具调用最多同时执行 4 个。已受理请求按原顺序发出响应，初始化、受治理写入等串行请求隔开读调用组。
- `notifications/cancelled` 可取消排队或运行中的只读调用，也可丢弃尚未发出的读响应。运行中的取消会中止 MCP 发出的 HTTP 请求及响应体读取。受治理写入继续等待原回执。
- 默认最多接受 64 个尚未完成的请求，包含等待按序发出的结果。队列满时立即返回 `QUEUE_OVERFLOW`，取消通知仍可处理。`dispatch.drain()` 等待已接收请求完成。
- 异常兜底：handler 抛出的异常转换为 `-32603`，诊断写 stderr，不进入 stdout 协议流，也不中断后续请求。
- 单行上限：默认 1 MiB，可用 `DINGJIANG_MCP_MAX_LINE_BYTES` 调整（上限 64 MiB）；超限返回 `-32600` 与 `REQUEST_TOO_LARGE`，在解析前拒绝。
- 背压：stdout 写满时等待 `drain`，避免大批量响应乱序。

Integration client 将失败分为三类，避免把服务端问题误报为调用方参数错误：

- 服务端返回的标准 failure envelope → `IntegrationClientError`，保留服务端 code 与 correlationId。
- 传输层失败 → `IntegrationTransportError`：`INTEGRATION_TIMEOUT`、`INTEGRATION_NETWORK_ERROR`、`INTEGRATION_INVALID_RESPONSE`（非 JSON 响应、HTTP 失败且无标准 envelope、响应与 contract 不一致）。
- 入参校验失败 → `INVALID_REQUEST`，只对应调用方参数；响应 schema 校验失败不再归入此类。

`DINGJIANG_MCP_TIMEOUT_MS` 配置请求超时（默认 10000，范围 100–120000）。超时错误仍要求复用原 requestId / correlationId 核对，不得改 requestId 重试。`DINGJIANG_API_BASE_URL` 的校验结果按原始值缓存，环境变量变化时立即重新校验；loopback HTTP 覆盖完整 `127.0.0.0/8`，并拒绝 `127.0.0.1.evil.com` 这类伪装主机。

## 错误码与处置

工具失败时返回 `isError: true`。`content.text` 中的 JSON 包含 `code`、`message`、`retryable` 和 `requiresHuman`。API 侧失败还带 `correlationId`。常规工具错误也提供同一份 `structuredContent`。

| code                                      | 来源     | 含义                                        | 处置                                               |
| ----------------------------------------- | -------- | ------------------------------------------- | -------------------------------------------------- |
| `INVALID_REQUEST`                         | MCP      | 工具参数不符合 contract                     | 按提示修正参数；不要改 `requestId` 重试            |
| `UNKNOWN_TOOL`                            | MCP      | 工具名未知或被只读模式拦截                  | 用 `tools/list` 查找当前工具面中的名称             |
| `TOOL_UNAVAILABLE`                        | MCP      | 未预期的内部异常                            | 按 `correlationId` 查 API 日志；不要盲目重试       |
| `REQUEST_TOO_LARGE`                       | stdio    | 单行超过 `DINGJIANG_MCP_MAX_LINE_BYTES`     | 缩减 payload，或调大上限（≤ 64 MiB）               |
| `HANDLER_FAILURE`                         | stdio    | handler 抛异常，已隔离                      | 看 stderr；后续请求仍会继续处理                    |
| `AGGREGATE_RESULT_TOO_LARGE`              | MCP      | 聚合工具结果超过 512 KiB                    | 改用范围更小的只读工具                             |
| `FORBIDDEN`                               | API      | 身份、scope 或项目越权                      | 换有权限的身份；聚合工具不会把它降级成「暂无数据」 |
| `NOT_FOUND`                               | API      | 资源不存在或不在授权范围                    | 单条工具原样返回；聚合工具降级为 `null`            |
| `RATE_LIMITED`                            | API      | 单凭证每分钟请求超过上限                    | 按 `Retry-After` 等待后重试；读写额度分开计        |
| `INTEGRATION_TIMEOUT`                     | 传输     | 请求超时                                    | **不要改 requestId 重试**，用原请求核对服务端状态  |
| `INTEGRATION_NETWORK_ERROR`               | 传输     | 连不上 API                                  | 确认本地服务已启动、`DINGJIANG_API_BASE_URL` 正确  |
| `INTEGRATION_INVALID_RESPONSE`            | 传输     | 响应与 contract 不一致                      | 检查服务端与 MCP 的版本是否匹配                    |
| `-32700` / `-32601` / `-32602` / `-32603` | JSON-RPC | 解析失败 / 方法不存在 / 参数非法 / 内部错误 | 保留原始请求与 correlationId，必要时升级           |

`TOOL_UNAVAILABLE` 的 message 是固定文案：任意异常的原文可能带出文件路径或内部标识，因此不回显给宿主；需要定位时用 `correlationId`。

## 会话档案

进程启动时固定工具面和只读策略。同一 stdio 入口支持 `2025-06-18` 的 `initialize` 握手，以及 `2026-07-28` 的 `server/discover` 和逐请求版本校验。两种协议共享工具注册表和声明顺序。

`DINGJIANG_MCP_READ_ONLY=1` 同时限制 `tools/list` 和 `tools/call`，判断依据是注册表中的读写分类。未设置、空值或 `0` 使用常规模式，其他值会使进程启动失败。API 仍按令牌核验租户、角色、权限范围和项目，并校验受治理写入的 `requestId` 与 `expectedVersion`。

`protocol.ts` 校验并分发 JSON-RPC，`stdio.ts` 负责限流、并发、取消和按序回包。契约评测在两个协议版本和两套工具面的四种组合中，各运行同一批 40 个用例。

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

全部 28 个工具都声明 `outputSchema`。单项工具复用 client 校验 HTTP 响应时用的 Zod 契约。三个聚合工具使用同一份 Zod 契约裁剪返回值并发布 `outputSchema`。业务 API 派生的 `project.next_action` 按共享契约返回 `PROPOSAL`。

| 聚合工具           | 保留与裁剪                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work.context`     | 阶段保留状态、进度和关口，事项细节集中在 `currentWorkItem` 与 `workItems`。保留来源事实、证据和材料缺口。上下文中的材料保留元数据，省略文件预览。 |
| `workspace.resume` | 通过一次授权快照返回阶段摘要、当前事项和下一动作。证据和材料集中在顶层，`context.sourceTask` 保留事实和材料缺口。                                 |
| `evidence.bundle`  | 保留证据原文与定位、授权的材料预览、证据提案以及底稿当前和最近确认版本。底稿省略历史版本与上下文中重复的材料预览。                                |

三个聚合工具各发一次 Integration GET 请求。API 在各自的 PostgreSQL 只读快照内读取数据并组装结果。

| 工具               | Integration 入口                                | 所需 scopes                                                                         |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `workspace.resume` | `/api/integration/workspace/resume`             | `project:read`、`workitem:read`、`evidence:read`、`material:read`、`workpaper:read` |
| `work.context`     | `/api/integration/projects/:id/work-context`    | `project:read`、`workitem:read`                                                     |
| `evidence.bundle`  | `/api/integration/projects/:id/evidence-bundle` | `project:read`、`evidence:read`、`material:read`、`workpaper:read`                  |

升级时先让 API 提供对应入口，再更新 MCP 进程。

512 KiB 上限适用于 JSON-RPC 的完整 `result` 对象，按 UTF-8 计入 `structuredContent`、`content.text` 和新版协议元数据。超限通过 `isError: true` 和 `content.text` 中的 JSON 返回 `AGGREGATE_RESULT_TOO_LARGE` 和 `limitBytes`，供按成功 schema 校验结构化结果的宿主识别。`workspace.resume` 超限时可按需调用 `work.context` 或 `evidence.bundle`。兼容面提供 `get_evidence`、`get_material_preview` 和 `get_validation_workpaper` 等单项读取。

`initialize` 和 `server/discover` 都返回 `instructions`。宿主可据此展示 PROPOSAL 的来源、确认受治理写入，并在超时时复用 `requestId`。新版每次调用都携带版本和能力字段。 [协议说明](PROTOCOL.md#3-协议方法)

`src/tool-contract.test.ts` 把这些元数据钉在入参契约上：受治理写入口的唯一结构特征是同时必填 `requestId` 与 `expectedVersion`，测试据此反推写集合，再断言没有任何写入口被标成只读——标注与实现无法一起悄悄漂移。

## 工具契约评测

`evals/` 提供可回归的契约评测，直接驱动 `dist/` 中的真实 dispatcher，Integration 侧使用确定性 mock，不依赖网络、数据库或模型凭据：

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval
```

当前基线：声明的 28 个工具全部可达（无 `UNKNOWN_TOOL`）；28 个工具的 annotations 与 `outputSchema`（28 个）在 wire 层完备且读/写标注与入参契约一致；24 个读写 happy path 返回 `structuredContent` 并命中预期 Integration 方法；7 类越权字段注入全部 `INVALID_REQUEST` 且零 Integration 调用；6 类非法参数全部被拒；传输超时结构化收敛且不泄露授权头；可选子资源缺失时降级、越权时不降级（2/2）；6 项协议契约通过。任一不变量失败时退出码为 1，CI 会阻断合并。用例格式与扩展方式见 `evals/README.md`。

## 工具边界

business 面 13 个、compatibility 面 23 个，去重 28 个；下表按读 / 写分组，`面` 列是首次出现的工具面。

**受治理写入（6）**，都必须同时带 `requestId` 与 `expectedVersion`，参数不接受身份字段：

| 工具                | 用途                        | 面       |
| ------------------- | --------------------------- | -------- |
| `work.execute`      | 记录进展、确认或提交方案    | business |
| `material.verify`   | 记录材料人工核验            | business |
| `evidence.confirm`  | 确认或驳回证据提案          | business |
| `workpaper.propose` | 追加根因核验或分析 Proposal | business |
| `material.create`   | 登记待核验材料版本          | business |
| `evidence.propose`  | 登记证据 Proposal           | business |

**只读（22）**：

| 工具                        | 用途                       | 面            |
| --------------------------- | -------------------------- | ------------- |
| `workspace.events`          | 列出授权事件与项目入口     | business      |
| `work.operations`           | 读取操作版本与获准动作     | business      |
| `workspace.resume`          | 恢复当前项目全貌与下一动作 | business      |
| `work.context`              | 读取项目完整工作上下文     | business      |
| `evidence.bundle`           | 读取证据包与材料核验       | business      |
| `experience.search`         | 检索已发布正式经验         | business      |
| `project.next_action`       | 派生唯一可解释的下一动作   | business      |
| `list_projects`             | 列出授权咨询项目           | compatibility |
| `get_current_project`       | 读取当前咨询项目           | compatibility |
| `get_project_context`       | 读取项目工作上下文         | compatibility |
| `get_project_state`         | 读取项目状态与阶段         | compatibility |
| `get_current_work_item`     | 读取当前事项               | compatibility |
| `list_project_work_items`   | 列出阶段事项               | compatibility |
| `list_evidence`             | 列出可追溯事实证据         | compatibility |
| `list_traceable_materials`  | 列出材料摘要与核验状态     | compatibility |
| `get_material_preview`      | 读取材料安全摘要           | compatibility |
| `get_evidence`              | 读取单条事实证据           | compatibility |
| `get_source_version`        | 解析来源版本定位           | compatibility |
| `get_validation_workpaper`  | 读取根因核验工作底稿       | compatibility |
| `search_formal_experiences` | 检索正式经验               | compatibility |
| `get_formal_experience`     | 读取单条正式经验           | compatibility |
| `get_experience_evidence`   | 读取经验引用的证据定位     | compatibility |

兼容工具面的扁平命名是为旧宿主保留的，两套工具面共享同一批实现与同一份工具定义（`toolRegistry`）。新增工具要同时更新实现、治理分类与两套视图，`tool-contract.test.ts` 会拦住只改一半的情况。

`work.execute` 必须先读取 `work.operations` 的 version、stateFingerprint 和 allowedActions。返回里还有 `approvalRequiredActions`：这些动作需要可信人工控制台签发的一次性授权记录（`production_human_approvals`，绑定身份、requestId、项目、内容指纹与 expectedVersion，10 分钟过期、单次消费）。宿主用它决定何时向人确认，但**它只是信号**——服务端仍以那张表为准，模型自述与客户端声明都不参与判定。用户明确确认后记录原话；已知字段由助手关联。相同请求重放返回原回执，不重复执行。状态过期拒绝覆盖；超时保留原请求核对。版本、状态、不可覆盖来源及审计同事务提交。

新增权限不会自动授予旧 token：PMC 需要 workitem:write；材料核验/证据确认分别需要 material:verify / evidence:confirm；OWNER 定稿需要 project:approve；EXPERT_REVIEWER 发布需要 experience:publish。新事件必须有明确的预留项目白名单项，例如 PRJ-SO-202608136，workspace.events 才会提供入口。现有项目继续使用原 ID。

仓库候选版本为 0.7.0（新增工具元数据与版本协商）。只有正式同步 bundle、服务端 bindings 和 runtime checkout 并通过真实会话验证后，才能声明接通。

不存在工作底稿或材料正文时返回安全的 NOT_FOUND/BODY_NOT_AVAILABLE 语义，不伪造内容；材料预览不返回原始 bytes、绝对路径或存储键。

`get_validation_workpaper` 在底稿缺失时返回 `NOT_FOUND`。`workspace.resume` 和 `evidence.bundle` 在 API 验证项目及底稿读权限后，用 `workpaper: null` 表示底稿缺失。权限不足返回 `FORBIDDEN`，找不到授权项目时返回 `NOT_FOUND`。
