# Dingjiang MCP

实现说明（为什么零依赖、四个方法怎么落地、哪些故意不做）见 [PROTOCOL.md](PROTOCOL.md)。

本地 stdio MCP 只调用 loopback `/api/integration/*`，不访问 PostgreSQL、业务文件或厂商 SDK。默认提供 13 个受限业务入口：7 个读取入口、6 个受治理写入口。Evidence Proposal 仍非 FACT；人工确认动作须由对应身份在 WorkBuddy 明确发起。Web 只读展示事实、过程和经营数据。

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
- 两类都要用就配两条条目、各起一个进程；令牌可以复用，工具面互不影响。

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

## 密钥与轮换

- 令牌只放两处：API 进程与 MCP 进程的环境变量，两边必须一致；MCP 进程的令牌不进入工具参数，AI 也无法读取。
- 不提交 `.env`，不把令牌写进仓库内的客户端配置，不贴进对话、截图或日志。
- 轮换顺序：改两处令牌 → 重启 API → 客户端新建会话。stdio 进程在会话结束时退出，旧值不会残留。
- 本机 `~/.workbuddy/mcp.json` 保存的是明文令牌，属于运维待办：轮换后应视旧值为已泄露。
- 飞书 App Secret 的轮换是开放平台上的独立操作，与这里的 Dingjiang 令牌无关。

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

## 错误码与处置

工具失败时返回 `isError: true`，并在 `structuredContent` 里给出 `code` / `message` / `retryable` / `requiresHuman`，API 侧失败还带 `correlationId`。`content.text` 是同一份 JSON，供只读文本的宿主使用。

| code                                      | 来源     | 含义                                        | 处置                                               |
| ----------------------------------------- | -------- | ------------------------------------------- | -------------------------------------------------- |
| `INVALID_REQUEST`                         | MCP      | 工具参数不符合 contract                     | 按提示修正参数；不要改 `requestId` 重试            |
| `UNKNOWN_TOOL`                            | MCP      | 工具名不在本会话的工具面                    | 先 `tools/list` 确认；旧宿主可能要用兼容面的扁平名 |
| `TOOL_UNAVAILABLE`                        | MCP      | 未预期的内部异常                            | 按 `correlationId` 查 API 日志；不要盲目重试       |
| `CONTEXT_DRIFT`                           | MCP      | 当前项目与当前事项不一致                    | 重新 `workspace.resume` 后再试                     |
| `REQUEST_TOO_LARGE`                       | stdio    | 单行超过 `DINGJIANG_MCP_MAX_LINE_BYTES`     | 缩减 payload，或调大上限（≤ 64 MiB）               |
| `HANDLER_FAILURE`                         | stdio    | handler 抛异常，已隔离                      | 看 stderr；后续请求仍会继续处理                    |
| `FORBIDDEN`                               | API      | 身份、scope 或项目越权                      | 换有权限的身份；聚合工具不会把它降级成「暂无数据」 |
| `NOT_FOUND`                               | API      | 资源不存在或不在授权范围                    | 单条工具原样返回；聚合工具降级为 `null`            |
| `RATE_LIMITED`                            | API      | 单凭证每分钟请求超过上限                    | 按 `Retry-After` 等待后重试；读写额度分开计        |
| `INTEGRATION_TIMEOUT`                     | 传输     | 请求超时                                    | **不要改 requestId 重试**，用原请求核对服务端状态  |
| `INTEGRATION_NETWORK_ERROR`               | 传输     | 连不上 API                                  | 确认本地服务已启动、`DINGJIANG_API_BASE_URL` 正确  |
| `INTEGRATION_INVALID_RESPONSE`            | 传输     | 响应与 contract 不一致                      | 检查服务端与 MCP 的版本是否匹配                    |
| `-32700` / `-32601` / `-32602` / `-32603` | JSON-RPC | 解析失败 / 方法不存在 / 参数非法 / 内部错误 | 保留原始请求与 correlationId，必要时升级           |

`TOOL_UNAVAILABLE` 的 message 是固定文案：任意异常的原文可能带出文件路径或内部标识，因此不回显给宿主；需要定位时用 `correlationId`。

## 会话档案（协议版本与工具面）

两个会话可能不同的只有两件事：协商到的协议版本，以及这个部署提供哪套工具面。它们在 `initialize` 时决定一次，保存在 `createMcpHandler` 的闭包里，`tools/list` 按**本次会话**的档案组装：

- 协议版本按调用方声明协商；旧版本不会收到 `outputSchema`，因为客户端会拿自己无法校验的契约为难。
- 工具面是**部署决策**：`DINGJIANG_MCP_TOOL_SURFACE=compatibility` 时所有会话都用兼容面；宿主名不能覆盖运维的显式选择。
- 未握手就 `tools/list` 时使用默认档案，既有部署行为不变。

工具定义只有一份：`protocol.ts` 的 `toolRegistry` 收录全部 28 个工具，两套工具面只是它上面的有序名单，共享同一批 `ToolDescriptor` 实例。`dispatchedToolNames` 仍独立手写，供 `tool-contract.test.ts` 双向比对声明与实现——它不能由注册表自动生成，否则守卫会空转。

**红线**：会话档案只影响「广告哪些元数据」，绝不改变租户、角色、scope、`requestId` 幂等与 `expectedVersion` 校验；这些统一在 API 侧执行，工具参数也不接受身份字段。

`createMcpHandler` 返回的是与传输无关的纯函数，`server.ts` 只把 stdio 接上，因此新增传输是新写一个 dispatcher，不需要改协议层。契约评测会把 40 个用例在 4 组（2 协议版本 × 2 工具面）会话组合下各跑一遍，确认降级没有顺手把权限一起降掉。

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

协议版本只声明 `2025-06-18`。请求旧版本的客户端会收到这个值并自行决定能否继续——这是规范允许的协商方式，服务端不假装支持一个没人验证过的修订版。此前保留过 `2025-03-26` 分支（对它不下发 `outputSchema`），因为没有真实客户端使用而删除：一条没人走的兼容分支，只会让「会话承诺了什么」变得难以核对。

`src/tool-contract.test.ts` 把这些元数据钉在入参契约上：受治理写入口的唯一结构特征是同时必填 `requestId` 与 `expectedVersion`，测试据此反推写集合，再断言没有任何写入口被标成只读——标注与实现无法一起悄悄漂移。

## 工具契约评测

`evals/` 提供可回归的契约评测，直接驱动 `dist/` 中的真实 dispatcher，Integration 侧使用确定性 mock，不依赖网络、数据库或模型凭据：

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval
```

当前基线：声明的 28 个工具全部可达（无 `UNKNOWN_TOOL`）；28 个工具的 annotations 与 `outputSchema`（25 个）在 wire 层完备且读/写标注与入参契约一致；24 个读写 happy path 返回 `structuredContent` 并命中预期 Integration 方法；7 类越权字段注入全部 `INVALID_REQUEST` 且零 Integration 调用；6 类非法参数全部被拒；传输超时结构化收敛且不泄露授权头；可选子资源缺失时降级、越权时不降级（2/2）；6 项协议契约通过。任一不变量失败时退出码为 1，CI 会阻断合并。用例格式与扩展方式见 `evals/README.md`。

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

单个读工具（`get_validation_workpaper`）保留 `NOT_FOUND`：调用方明确要那一条，不存在就是不存在。聚合工具（`workspace.resume`、`evidence.bundle`）把 `NOT_FOUND` 降级为 `null`——项目刚建、底稿尚未产生时，`resume` 恰好是最需要可用的时刻，不能因为一个可选子资源缺失就整体失败。`FORBIDDEN` 不降级：真实 API 对「缺 scope」和「越权项目」都返回 403，对「已授权但未创建」返回 404，两者可区分，所以这个降级不会把授权失败伪装成「暂无数据」。
