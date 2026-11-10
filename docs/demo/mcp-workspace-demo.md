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
