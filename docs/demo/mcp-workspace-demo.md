# 鼎江智绩 MCP 演示

一个负责交期的员工要恢复延期工单，找出下一动作和对应证据，再登记一条可回读的进度。同一项写操作由只读身份和授权身份分别发起，以验证 API 对两种身份的处理。

## 运行

准备 Node.js 22.19+、pnpm 11 和本机 Docker。在仓库根目录执行

```bash
pnpm install --frozen-lockfile
pnpm demo:mcp
```

脚本会构建 API 和 MCP，启动仅绑定到 loopback 的临时 PostgreSQL，并在临时库中装载合成订单 `SO-202608128`。首次运行时 Docker 会按需拉取与本地开发相同的 PostgreSQL 镜像。演示凭据和工作目录由程序临时生成。 [回放脚本](../../scripts/demo/mcp-workspace.mjs)

## 一次实跑的节选

```text
3. 恢复延期项目并读取证据
   工单  "SO-202608128"
   阶段  "定下解决方案"
   下一动作  "形成 BOM 治理方案"
   动作分类  "PROPOSAL"
   来源位置  "orders.csv · 订单明细 · row 2"

4. 只读身份提交进度
   结果  "PERMISSION_DENIED"

5. 授权 PMC 提交进度并回读
   同一请求返回原回执  true
   旧版本提交  "STALE_VERSION"
   数据库回执  1
   MCP 回读  "已核对订单预计交期，准备与采购复核到料时间。"

6. 远程 MCP 经 OAuth 拦截与写入回读
   只读工具数  7
   数据库回执  1
   MCP 回读  "通过 OAuth 授权的远程 MCP 已复核采购到料时间。"
```

回放与集成测试共用同一套实际工具调用和断言。 [真实端到端用例](../../apps/api/src/integration/real-e2e.integration.test.ts)

## 终端演示顺序

1. 打开仓库首页，说明场景是订单延期交接。从终端运行 `pnpm demo:mcp`。
2. 停在项目恢复输出，展示来源版本和行号，再说明 `PROPOSAL` 是待确认的下一步。
3. 展示只读身份的拒绝结果、授权提交和同一请求的重放。最后停在数据库回执数与 MCP 回读的进度。

## 从 Agent 宿主体验

可按接入说明连接 WorkBuddy 或其他 MCP 宿主，然后用任务集中的 `ctx-01` 检查自然语言能否触发项目恢复。这里的命令行回放验证真实协议、API 和落库，宿主选工具的准确率来自独立的任务执行记录。 [宿主接入](../../services/dingjiang-mcp/README.md) · [Agent 任务集和记录口径](../../services/dingjiang-mcp/evals/agent/README.md)

## 候选版验收记录

`pnpm demo:mcp` 用合成订单运行真实 stdio 和 Streamable HTTP/OAuth MCP 进程、Integration API 与临时 PostgreSQL。回放连接旧版 `initialize` 和新版 `server/discover`，读取工具列表，经 `workspace.resume` 返回授权项目、事实、来源版本和行号。下一动作标记为 `PROPOSAL`。只读写入被拒绝，授权提交可回读，同一请求重放只留下一个回执。 [回放断言](../../apps/api/src/integration/real-e2e.integration.test.ts)

本地候选的验证命令如下。集成运行器覆盖五层，架构检查可独立运行。MCP 契约评测用确定性 mock 覆盖两种协议和两套工具面。 [权限矩阵](../../apps/api/src/integration-http.integration.test.ts)

```bash
pnpm verify
pnpm --filter @dingjiang/architecture-tests test
pnpm test:coverage
pnpm demo:mcp
```

### 真实宿主与自然语言评测

用已登录的 Codex CLI 运行同一套合成数据。指定模型以便记录版本。Windows 可通过 `--codex` 指定实际可执行文件。

```bash
pnpm demo:mcp --agent --model <模型名称> --codex <Codex-CLI-可执行文件>
```

运行目录的 `plan.json` 记录 Git 提交、宿主版本、配置的模型及任务版本。 `outcomes.json` 记录原始输入、工具调用、业务回执和自动检查结果。结合最终回答按场景验收规则复核，允许等价调用路线。自然语言场景的初始输入不提供 ID、版本或指纹。需要确认时使用合成用户的确认语句，完整命令场景单列。可重复指定 `--case` 运行部分场景。单独运行旧版本场景时，夹具会先记录一条进展以制造版本差异，该动作单独记入结果。 [任务变体](../../services/dingjiang-mcp/evals/agent/demo-cases.json)

```bash
pnpm demo:mcp --workbuddy
```

在 WorkBuddy 打开命令输出的候选项目目录，选择该项目下的 `dingjiang_candidate` 连接器。项目级配置绑定当次构建、临时 API 与合成测试身份。退出演示时用 Ctrl+C，运行器清理临时数据库和带演示凭证的配置文件。 [WorkBuddy 项目级配置](https://www.codebuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)

### 异常返回与写入恢复

成功时 `structuredContent` 继续遵循工具的 `outputSchema`。工具执行失败时，宿主读取 `isError: true` 及 `content` 里的 JSON 文本。未知方法和未知工具仍按协议错误处理。

API 的标准业务错误保留服务端 `correlationId`。如果与请求头不同，`requestCorrelationId` 保留实际发出的编号。超时、断连及无效响应使用原请求追踪号。合法的 `Retry-After` 秒数或 HTTP 日期会转换为 `retryAfterSeconds`，未知时省略该字段并说明等待时间未知。MCP 不自动重发。两种会话档案都提示宿主收到限流后停止本轮调用并报告等待时间。

兼容工具面用 `list_traceable_materials` 定位材料，以 `get_material_preview` 返回的 `bodyAvailable` 判断预览能否引用。`work.execute` 按请求输入生成 Schema，`progress.record` 的 `outputReference` 可由服务端默认填充。新命令使用 UUID 和当前状态快照。写前说明目标与影响，取得用户确认后再调用。进展写入遇到连接中断时，工具会提示提交状态未知，引导宿主先查询目标事项。需要取回回执时，经用户确认后原样重放完整命令。

### 进展精简返回

`work.operations` 和 `work.execute` 默认提供完整返回。记录进展时可用 `responseFormat: "compact"`。写前查询返回候选事项、版本、状态指纹和授权提示。写入回执只包含原回执标识、版本与该事项进展。独立回读在 `work.operations` 同时传 `workItemId`，用单条 SQL 读取事项和对应版本。

只有一个授权项目时，`progress.record` 可以省略 `projectId`。MCP 用当前凭证查询授权项目，再将准确 ID 和原命令交给原写入接口。多个项目时先明确目标并传入项目 ID。显式填写的项目 ID 直接用于该命令。

精简格式在 MCP 返回时投影。命令、状态校验和数据库审计回执沿用现有契约，同一命令可在两种格式间重放。两种格式都提供 `content` 与 `structuredContent`。本地 Demo 按同一项目快照对照三次调用的文本和结果字节数。

回放在测试专用的本地中转连接丢弃已提交命令的响应。重放前先检查数据库已有回执并回读进展，随后以原命令重放，验证最终只有一条进度事件和一条回执。版本冲突与权限拒绝不会追加写入。 [真实进程断连回归](../../apps/api/src/integration/real-e2e.integration.test.ts)
