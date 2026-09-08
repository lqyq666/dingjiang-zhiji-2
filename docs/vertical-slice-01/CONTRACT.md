# VS01 Contract Freeze

代码事实源：`packages/contracts/src/vs01.ts`。

## Invariants

- 日期使用 `YYYY-MM-DD`；百分比使用 0–100 的整数；延期天数使用非负整数。
- fixture 中的 `sourceRow` 从 2 开始，1 为表头；`sourceSheet` 是稳定逻辑名。
- `candidateCause` 永远是 `PROPOSAL`；人工 Decision 单独保存。
- Evidence 必须包含 SourceObject、SourceVersion、文件、sheet、行号和原始字段。
- Project 只能由已决策 Task 创建；只有 OWNER 可将待审批项目变成 RUNNING 或 RETURNED。
- 材料登记只保存引用元数据，不上传文件本体；AI 辅助输出只能填入人工判断草稿。
- 只有 RUNNING Project 的 Subtask 可以完成或重新打开；Node 百分比由完成数 / 总数派生，不能直接写入。

## Fixed IDs

- Order/Task：`SO-202608128`
- Project：`PRJ-OTD-001`
- Node：`NODE-BOM-001`
- Subtask：`SUB-BOM-001` 至 `SUB-BOM-004`
- Tenant：`tenant-demo`

## API

```text
GET  /api/vs01/employee
GET  /api/vs01/tasks/:id
POST /api/vs01/tasks/:id/decision
POST /api/vs01/tasks/:id/decision/revert
POST /api/vs01/tasks/:id/materials
POST /api/vs01/tasks/:id/assist
POST /api/vs01/projects
POST /api/vs01/projects/:id/submit
POST /api/vs01/projects/:id/approve
POST /api/vs01/projects/:id/return
GET  /api/vs01/projects/:id
POST /api/vs01/project-subtasks/:id/status
GET  /api/vs01/boss
POST /api/vs01/reset
```

所有写操作返回更新后的公开资源；非法角色、状态或 ID 返回非 2xx 与结构化 `{ error, message }`。

## Deterministic Analysis

若 BOM 实际完成日期晚于计划完成日期，候选原因固定为“BOM准备滞后可能是当前主要原因”。辅助窗口按当前选择的 BOM、采购或产能情况返回材料、原因、方法或判断草稿，provider 始终标记为 `DEMO_RULES`、classification 始终为 `PROPOSAL`。这不是外部模型输出，也不是人工确认事实。

## Change Control

Builder 不得修改本文件或代码 contract。变更请求必须包含：现状、最小变更、受影响切片、迁移与测试影响。
