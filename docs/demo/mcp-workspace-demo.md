# 鼎江智绩 MCP 演示

## 受控材料与证据闭环

`pnpm demo:mcp` 中的真实进程回归包含新增材料流程：正式 API 登记 CONTROLLED_TEXT，另一个 MCP 客户端只凭材料 ID 独立读取已保存正文，记录合成核验，再提出、确认并独立读取证据。它是确定性脚本验证，不是真实 Agent 自主选择测试。数据库核对单次业务效果与原回执重放，仍保留旧版本、错误来源和引用错位的既有负例。

真实 WorkBuddy 使用现有运行器的两个固定身份入口，每条命令都启动新的本机临时数据库：

```bash
pnpm demo:mcp --workbuddy --suite material-flow --input literal --case material-authorized --output <新的成功场景目录>
pnpm demo:mcp --workbuddy --suite material-flow --input literal --case material-restricted --output <新的拒绝场景目录>
```

打开输出的独立工作区，通过候选 MCP 执行 [固定原话与判定规则](../../services/dingjiang-mcp/evals/agent/demo-cases.json) 中 `materialFlowCases`。`--input literal` 选择版本 1 的 `literalPrompt`：用 JSON 字符串表示正文换行和缩进，解码后的原文与旧任务相同；外层引号和围栏不是正文。生成的 `plan.json` 固定实际输入、候选与版本。省略此参数仍使用原自然语言输入及原评分，不追溯修改旧结果。每场执行一次；仅实际缺陷修复后允许一次事先固定的定向复验，保留所有记录。运行器通过原有领域命令创建项目与前置事实，使用原生“形成 BOM 治理方案”事项、BOM_DELAY 与 REQ-BOM-CHANGE，不通过 SQL 重命名事项或跳过业务 gate。成功场景使用独立合成 PMC 身份，受限场景保留缺少 `material:write` 的原身份，模型不能自行切换。

成功场景先登记待核验材料，再开新会话，仅按材料名称请求原文和来源，不携带原始正文。先核对数据库尚无核验或正式证据，再由测试驱动发送预先固定的合成确认，分别推进核验和提案确认。最终同时核对宿主工具轨迹、材料正文、来源版本、UTF-16 引用区间、核验事件、提案、正式证据和回执。正文创建时裁去首尾空白，独立回读保留内部换行与空格；不能拿摘要或旧对话充当服务端原文。

这是隔离环境中的合成审批测试，不是真人试用，不代表生产人工授权已验收。生产审批、角色、Scope、租户、项目归属、幂等与版本规则保持不变。实际候选与全部宿主结果以 [验收摘要](../evals/agent-results.md) 为准。

录制时分别展示登记后的 UNVERIFIED、无正文输入的新会话回读、确认前零核验/零正式证据、两个合成确认和最终独立查询。核对文本需同时保留预设输入、宿主实际提交的输入、命令载荷及数据库正文。旧自然语言输入被 WorkBuddy 移除了第二行开头两个空格，原结果仍为 PARTIAL；后续 JSON 原文变体在真实宿主中保留了这两个空格，不能推广为任意宿主输入均逐字不变。核对类型时看显式预览的 `materialType`；证据 `limitations` 只写确认后仍成立的边界，当前待确认状态留在对话中。新工作区说明要求完成回读后在对话汇报并停止，不写本地记忆，但它仍不是工具沙箱。 [本次限定复验](../evals/agent-results.md#原文输入与宿主收尾的限定复验)

一个负责交期的员工要恢复延期工单，找出下一动作和对应证据，再登记一条可回读的进度。同一项写操作由只读身份和授权身份分别发起，以验证 API 对两种身份的处理。

## 作品展示版

`showcase-v1` 固定源码、合成数据和演示指南，沿用 `4a9ead1` 已验收的运行代码。演示从订单延期交接开始，展示如何找到证据、拒绝无权写入、保存进展并回读原文。 [基线提交](https://github.com/lqyq666/dingjiang-zhiji-2/commit/4a9ead16c2155f6402efb571cf69e8dd280d6faa) · [基线 CI](https://github.com/lqyq666/dingjiang-zhiji-2/actions/runs/42981087233)

- **脚本回放**使用预设调用顺序，走实际 stdio、Streamable HTTP/OAuth、Integration API 与临时 PostgreSQL。
- **真实 Agent 调用**由已登录的宿主根据输入选择工具。已有 Codex CLI 评测的完整预期为 7/10；后续 WorkBuddy 桌面运行已验证进展写入与新会话回读。 [真实 Agent 记录](../evals/agent-results.md)
- **未验收**的能力包括真人试用、生产部署和企业身份联调。固定旧标签不包含后续材料改动；后续候选已完成 WorkBuddy 合成材料到证据闭环，需按上方专用入口和对应验收版本展示。

`showcase-v1` 标签保持不变。进展回归对应 `78d70c75e154b0866cfec5a2a165d139cbdbf9fb`；MCP 专用任务与材料拒绝说明对应 `ebcc1ccec0d77c429216e60958b0b66825437b4e`。复现时检出对应候选再运行宿主入口，旧标签不包含后续说明。 [桌面运行边界与各轮结果](../evals/agent-results.md#workbuddy-桌面真实任务)

## 运行

在 Node.js 24、pnpm 11.19.0 和本机 Docker 的环境中，从独立目录检出展示版。

```bash
git clone --branch showcase-v1 --single-branch https://github.com/lqyq666/dingjiang-zhiji-2.git
cd dingjiang-zhiji-2
git describe --tags --exact-match HEAD
pnpm install --frozen-lockfile
pnpm demo:mcp
```

脚本构建 API 与 MCP，启动仅绑定到本机的临时 PostgreSQL，并装载合成订单 `SO-202608128`。首次运行时 Docker 会按需拉取 PostgreSQL 镜像。 [回放脚本](../../scripts/demo/mcp-workspace.mjs)

## 终端演示顺序

开场展示仓库的系统图和终端输出的 `showcase-v1`。运行 `pnpm demo:mcp` 时，把画面标为「脚本回放」。脚本结束后会一次打印记录，可以按以下顺序切换画面。

1. **第 3 节，找证据。** 展示延期订单、`SRC-ORDERS-V1` 和 `orders.csv · 订单明细 · row 2`。说明下一动作标记为 `PROPOSAL`，需要业务人员判断。
2. **第 4 节，验证权限。** 同一进展命令由只读身份发出时，结果为 `PERMISSION_DENIED`。
3. **第 5、6 节，断连后核对。** 测试中转丢弃已提交的响应。展示重放前已有回执、同一请求返回原回执、数据库只有一条进展和一份回执。停在独立回读的原句「已核对订单预计交期，准备与采购复核到料时间。」
4. **第 8 节，远程接入。** 展示 OAuth 只读工具面、授权写入后的回执和独立回读。

## 非开发者试用

演示者在展示版目录运行 `pnpm demo:mcp --workbuddy`，在已登录的 WorkBuddy 中打开命令输出的候选项目目录，使用项目级 `dingjiang_candidate` 连接器。试用者只需在对话窗口操作。试用结束后由演示者按 Ctrl+C，运行器清理临时数据库和带凭证的配置文件。 [WorkBuddy 项目级配置](https://www.codebuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)

最新候选同时生成只适用于该合成目录的 `AGENTS.md`，让宿主直接使用 MCP，并区分权限拒绝与尚未执行的业务校验。需打开输出的工作区；任务说明不修改日常记忆、工具权限或服务端授权，也不是工具沙箱。 [实际效果与失败记录](../evals/agent-results.md#mcp-专用任务与拒绝边界复验)

1. 询问「请告诉我合成订单 SO-202608128 的当前阶段，以及交期证据在哪份文件哪一行。这次只查看。」预期读到「定下解决方案」和 `orders.csv` 第 2 行。
2. 请求「请在『解决订单延期问题』的『产能负荷核对』事项上记录『已核对订单预计交期，准备与采购复核到料时间。』。请先让我核对目标和原句，等我确认后再提交。」由试用者本人确认。
3. 请求「请重新查询这项进展，并按原文回读。」核对文字与标点，记录是否有未经确认的写入。

每人记一行 `日期 | 试用编号 | 版本和宿主 | 完成到哪一步 | 原文是否一致 | 本人一句反馈 | PASS / FAIL / NOT_RUN`。来源正确、仅在确认后写入、独立回读逐字一致才记为 `PASS`。当前真人试用为 **NOT_RUN**。

现有样例为定位评测重命名了一个方案事项，保留了其原始 BOM 方案步骤；因此只能验证工具使用、文字保存与权限行为，不用于判定产能核对业务完成。宿主入口的 PMC 测试身份也不含材料写入、核验或证据确认权限。不得把登记进展说成材料已核验、事项已完成，或为跑通而临时扩大日常身份权限。

## 验收与复现

### 进展文字核对

本轮在 `4a9ead1` 重跑 `pnpm demo:mcp`，通过现有断言。stdio 用例把命令中的进展原句与数据库事项、进展事件和独立回读逐字比对。OAuth HTTP 用例核对完整与精简回读，均保留句中文字和标点。输入契约会修剪首尾空白。 [端到端断言](../../apps/api/src/integration/real-e2e.integration.test.ts) · [输入契约](../../packages/contracts/src/work-execution.ts)

复核既有两轮 Agent 轨迹，六次获准写入的命令、数据库进展事件与独立回读均与固定输入相同。测试中转会拦截不符合预期原文的写入。同名事项场景曾在澄清答复中改写拟写内容，未发生写入。 [两轮复测](../evals/agent-results.md#候选两轮复测)

### 工程验证

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

### 写入目标定位评测

固定输入、首写与恢复的独立记录、正式 API 拒绝证据和离线复现命令集中在 [MCP 与真实 Agent 验收记录](../evals/agent-results.md)。

### 异常返回与写入恢复

成功时 `structuredContent` 继续遵循工具的 `outputSchema`。工具执行失败时，宿主读取 `isError: true` 及 `content` 里的 JSON 文本。未知方法和未知工具仍按协议错误处理。

API 的标准业务错误保留服务端 `correlationId`。如果与请求头不同，`requestCorrelationId` 保留实际发出的编号。超时、断连及无效响应使用原请求追踪号。合法的 `Retry-After` 秒数或 HTTP 日期会转换为 `retryAfterSeconds`，未知时省略该字段并说明等待时间未知。MCP 不自动重发。两种会话档案都提示宿主收到限流后停止本轮调用并报告等待时间。

兼容工具面用 `list_traceable_materials` 定位材料，以 `get_material_preview` 返回的 `bodyAvailable` 判断预览能否引用。`work.execute` 按请求输入生成 Schema，`progress.record` 的 `outputReference` 可由服务端默认填充。新命令使用 UUID 和当前状态快照。写前说明目标与影响，取得用户确认后再调用。进展写入遇到连接中断时，工具会提示提交状态未知，引导宿主先查询目标事项。需要取回回执时，经用户确认后原样重放完整命令。

### 进展精简返回

`work.operations` 和 `work.execute` 默认提供完整返回。记录进展时可用 `responseFormat: "compact"`。写前查询返回候选事项、版本、状态指纹和授权提示。写入回执只包含原回执标识、版本与该事项进展。独立回读在 `work.operations` 同时传 `workItemId`，用单条 SQL 读取事项和对应版本。

只有一个授权项目时，`progress.record` 可以省略 `projectId`。MCP 用当前凭证查询授权项目，再将准确 ID 和原命令交给原写入接口。多个项目时先明确目标并传入项目 ID。显式填写的项目 ID 直接用于该命令。

精简格式在 MCP 返回时投影。命令、状态校验和数据库审计回执沿用现有契约，同一命令可在两种格式间重放。两种格式都提供 `content` 与 `structuredContent`。本地 Demo 按同一项目快照对照三次调用的文本和结果字节数。

回放在测试专用的本地中转连接丢弃已提交命令的响应。重放前先检查数据库已有回执并回读进展，随后以原命令重放，验证最终只有一条进度事件和一条回执。版本冲突与权限拒绝不会追加写入。 [真实进程断连回归](../../apps/api/src/integration/real-e2e.integration.test.ts)
