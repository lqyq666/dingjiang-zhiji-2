# 系统架构总览

这份文档回答三个问题：系统由哪些部分组成、一次写操作真正走哪条路径、哪些不变量是"不能破"的。
所有事实都能在代码里找到对应位置；最后一节列出当前的架构债务，不做美化。

---

## 1. 它是什么

鼎江智绩是一个**顾问交付系统**：把"订单延期"这类模糊问题，变成有证据、有阶段门、有人签字确认的交付项目。

它的立身之本是三句话，也是所有架构决策的源头：

1. **PostgreSQL 是唯一业务事实源**。任何 UI 缓存、模型输出、消息队列都不是事实。
2. **AI 产出永远是提案**（`PROPOSAL`），不写入事实；写入必须由人或有确定性规则的命令完成。
3. **每条事实都必须能追到证据**，证据定位到不可变的 `SourceVersion`。

---

## 2. 分层视图

```text
┌──────────────────────────────── 渠道层 ────────────────────────────────┐
│  Web 角色控制台 (Next.js)      MCP 客户端 (WorkBuddy/IDE)   飞书 / n8n  │
│  PMC · OWNER · EXPERT 三个视图  自研 MCP Server，28 个工具   只读通知与同步 │
└───────────────┬──────────────────────────┬───────────────────────┬─────┘
                │ 浏览器 cookie + x-vs01-role│ bearer token + scope  │ Webhook
┌───────────────▼──────────────────────────▼───────────────────────▼─────┐
│                            接入层（apps/api）                            │
│  CORS 白名单 · no-store · ProductionAccessGuard · SafeExceptionFilter   │
│  集成接口鉴权（bearer → principal{tenant,subject,role,scopes,projects}）  │
└───────────────┬──────────────────────────┬─────────────────────────────┘
                │                          │
┌───────────────▼──────────────────────────▼─────────────────────────────┐
│                        应用层（NestJS controllers）                      │
│  Vs01Controller  AssistantController  RootCauseWorkpaperController      │
│  IntegrationController  ExperienceIntelligenceController  Identity*     │
└───────────────┬────────────────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────────────────┐
│                            领域层（无框架依赖）                          │
│  projects/vs01  ·  command-kernel  ·  materials  ·  evidence           │
│  workpapers     ·  experience-intelligence  ·  assistant  ·  intake    │
│  identity/access-policy  ·  task-orchestration                         │
└───────────────┬────────────────────────────────────────────────────────┘
                │  只有这里碰 SQL
┌───────────────▼────────────────────────────────────────────────────────┐
│                              数据层                                     │
│  PostgreSQL 17 + pgvector · 59 张表 · 业务表全部 FORCE ROW LEVEL SECURITY │
│  不可变 SourceVersion · 受治理命令回执 · 事件表 · 迁移 40 个（含校验和） │
│  文件内容库（MaterialContentVault，按 sha256 寻址）                      │
└────────────────────────────────────────────────────────────────────────┘
```

**依赖方向是单向的**，由 `tooling/architecture/boundaries.test.ts` 强制：包代码不许依赖 NestJS/Drizzle，Web 不许引入任何数据库驱动，跨包只能从包根导入。这条测试比文档可靠——文档会过期，测试不会。

---

## 3. 三个入口，一套事实

| 入口                       | 谁在用         | 鉴权方式                                                     | 关键约束                                                        |
| -------------------------- | -------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/web`                 | 人（三个角色） | 会话 cookie；写操作在生产环境被 `ProductionAccessGuard` 拦下 | 生产环境浏览器只允许 GET，写必须走 MCP                          |
| `services/dingjiang-mcp`   | AI 宿主        | 每会话 bearer token，绑定 `scopes` 与 `projectIds`           | 22 个只读工具 + 6 个受治理写工具，语义靠 `ToolAnnotations` 区分 |
| `apps/api/src/integration` | 飞书 / n8n     | 同上                                                         | 只能走 Integration API，禁止直连数据库                          |

MCP 不是"另一个后端"，它是**受治理命令的另一个客户端**。所以 `work.execute` 和 Web 的写按钮最终落在同一段事务代码上——这是刻意的：两个入口如果各写一套，治理规则迟早会分叉。

---

## 4. 一次受治理写入的真实路径

这是全系统最需要理解的流程。以 `progress.record`（记录子任务进展）为例：

```text
MCP 客户端
  │  tools/call { name: "work.execute",
  │               arguments: { requestId, expectedVersion, payload } }
  ▼
dingjiang-mcp/src/protocol.ts        校验入参 Zod schema，注入 Bearer
  │
  ▼  HTTP POST /api/integration/commands
integration-http.ts                  验证 token → principal{tenant,role,scopes,projects}
  │                                   越权项目 → 403 FORBIDDEN（不是 404，不掩盖）
  ▼
governed-command-kernel.ts
  │  1. 检查 requiredScope 与 allowedRoles
  │  2. 计算 payload 指纹（canonicalJson，拒绝 NaN/稀疏数组/自定义原型）
  │  3. BEGIN
  │  4. 查回执表：同 requestId + 同指纹 → 直接返回原回执（replayed: true）
  │  5. 校验 expectedVersion，过期 → STALE_VERSION（乐观并发，不覆盖别人）
  │  6. 执行 handler（领域状态机）
  │  7. 写 governed_command_receipts（唯一索引 tenant+command+request_id）
  │  8. 写 governed_command_audit_events
  │  9. COMMIT
  ▼
PostgreSQL（RLS 兜底：即使应用层漏了 tenant 条件，行级策略仍然挡住）
  │
  ▼
回执 { version, data, replayed, correlationId }
```

三个细节值得单独指出：

- **幂等键是 `requestId`**，不是"重试次数"。网络抖动导致的重发，返回的是同一份回执，不会产生第二条事实。端到端测试里专门断言过：三次调用，`vs01_project_subtasks` 只落一条、`governed_command_receipts` 只落一条。
- **`expectedVersion` 是并发令牌**，不是提示。两个 PMC 同时改同一子任务，后一个必然拿到 `STALE_VERSION` 而不是静默覆盖。
- **payload 指纹在事务外算好**。同一个 `requestId` 配不同 payload 必须被拒绝——否则幂等键就变成了"可以覆盖"的后门。

---

## 5. 项目状态机与阶段门

项目不是一个状态字段，是**五个阶段 + 每阶段一道门**：

```text
ROOT_CAUSE_VALIDATION   根因验证    ── 证据 + 工作底稿，员工确认
        │ gate: OPEN → APPROVED
        ▼
SOLUTION_APPROVAL       方案定稿    ── PMC 提交，OWNER 批
        │ gate: PENDING → APPROVED / RETURNED
        ▼
EXECUTION_CONTROL       执行控制    ── 子任务逐个推进，每次写记事件
        │ gate: OPEN → APPROVED
        ▼
RESULT_ACCEPTANCE       结果验收    ── 指标对比，员工确认结果
        │ gate: OPEN → APPROVED
        ▼
KNOWLEDGE_CAPTURE       经验沉淀    ── 经验候选 → 专家审核 → 正式经验
```

门的四种状态各有硬语义，落在 `vs01_project_phases.gate_status`：`LOCKED`（前一阶段没过，改不动）、`OPEN`（可操作）、`PENDING`（已提交待裁决）、`RETURNED`（被退回，带理由）。

**阶段推进是代码算出来的，不是配置出来的**：`updateSubtask` 在每次状态变更后重新统计"本阶段应完成数与已确认数"，只有 `confirmed_at` 与 `confirmed_by` 都非空才算真完成。这样"点了完成"和"确认完成"不会混为一谈。

---

## 6. AI 在哪、不在哪

| 位置                              | 做什么                                                     | 不做什么                       |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `assistant`（VS12）               | 观察已提交事件，读授权快照，产出可追溯提案，SSE 推给侧边栏 | 不执行任何业务命令；不进入事务 |
| `experience-intelligence`（VS17） | 经验抽取、检索、复盘建议                                   | 不发布经验，发布要专家签字     |
| `task-orchestration`（VS18）      | 生成任务提案、金额建议                                     | 提案进审批请求，人批了才落地   |
| `workpapers`（VS16）              | 根因底稿草稿                                               | 底稿结论要员工逐条确认         |

一条工程约束把这条边界钉住了：AI 相关的表（`vs12_*`、`vs17_*`、`vs18_*`）里没有任何一列能让业务状态前进。模型挂了、超时了、说胡话了，业务事实不受影响——因为业务事务在提交时才写 `vs12_work_events` 的 outbox，之后 AI 链路失败只会影响通知，不会回滚事实。

---

## 7. 契约层为什么独立成包

`packages/contracts` 是纯 Zod schema，被 API、Web、MCP 三方共同依赖：

- **API** 用它校验入参、定义回执形状；
- **Web** 用它 `schema.parse()` 响应——契约漂移会在数据层炸，而不是在白屏里炸；
- **MCP** 用 `z.toJSONSchema(schema, { io: "output" })` 派生出 25 个 `outputSchema`，让宿主知道工具返回什么。

一份定义、三个消费者、零重复。tier5 前端 e2e 能成立的全部前提就是这一条。

---

## 8. 已知的架构债务（不美化）

### 8.1 `apps/api/src/vs01.service.ts`：423 行、一个门面

它曾经是全仓库最大的单点问题：5261 行、94 个方法、六个上下文混在一个类里。现在它是一层门面——保留所有对外方法签名，把实现交给六个各自负责的服务：

| 模块          | 负责                 | 关键方法                                         |
| ------------- | -------------------- | ------------------------------------------------ |
| `read-model/` | 只读投影             | `employee` `boss` `task` `project` `findProject` |
| `materials/`  | 材料登记、导入、撤回 | `importTaskMaterial` `materialById`              |
| `projects/`   | 项目状态机           | `createProject` `updateSubtask` `taskTemplates`  |
| `experience/` | 经验资产生命周期     | `approveExperienceCandidate` `retractExperience` |
| `assistant/`  | AI 引导与反馈        | `assistProject` `createAssistantFeedback`        |
| `tasks/`      | 任务决策与回退       | `decideTask` `revertTaskDecision`                |

搬移的顺序是按耦合度从低到高，每一步都以全量用例做回归护栏：

1. **AI 引导分析**（八个纯函数）→ `assistant/guided-analysis.ts`。零事务、零状态写入，是耦合度最低的一块。
2. **材料子域** → `materials/material-service.ts`，投影拆到 `material-projection.ts` 由读写两侧共享。
3. **读模型** → `read-model/read-model-service.ts`。只读的部分原本是一张网——`projects()` 调 `project()`，`project()` 调 `findProject()`——所以整张网一起搬。
4. **项目状态机** → `projects/project-lifecycle-service.ts`。
5. **经验资产** → `experience/experience-service.ts`。因为上一轮已把共享写原语抽走，这一步最省力。
6. **AI 助手与任务决策** → `assistant/assistant-service.ts`、`tasks/task-decision-service.ts`。

**每一次搬移都要守的东西是事务纪律。** 绑定实例跑在命令内核的事务内，绝不 commit / rollback / release 调用方的 client；独立实例自己开自己关。命令都以"写完再读回"结束，那次读必须走同一个事务，否则返回的是数据库还没提交的状态——所以读模型是各写入服务的协作者，不是便利工具。

三方共享的写原语（追加项目事件、锁定项目节点、校验操作者）抽到 `projects/project-primitives.ts`；七个阶段的名字、目的与模板抽到 `work-stages.ts`；两个跨读写共用的投影抽到 `read-model/projections.ts`。都是普通函数或常量，两侧共同 import，不复制。

同时删掉了 `projectTransition`（生产零调用、只有测试在测的死代码）以及 `date` / `delay` 两个只是 `isoDate` / `delayDays` 的薄包装。

`tooling/architecture/boundaries.test.ts` 的尺寸棘轮守着这个文件不许再长大，预算随每次拆分同步下调（5261 → 4888 → 4642 → 3560 → 1779 → 423）。

### 8.2 其他已记录的债务

- **迁移校验和不可回改**：已发布的迁移一旦发布，任何字符改动都会导致启动失败。这是刻意的（防静默改历史），代价是修正只能新增迁移。
- **迁移文件被重写会让本地活库与新部署分叉**：本仓库历史上有两个迁移文件被重写过（旧的 ERP 拉取与 WPS 投影），长期使用的本地库因此多出五张代码零引用的表，而全新部署不会有——两边结构悄悄分开了。现在 `migrate` 会检查 `schema_migrations` 里是否存在仓库中已不存在的迁移并拒绝启动，`pnpm --filter @dingjiang/api db:reset` 改为重建 schema 而不是只清数据，用来修复这类漂移。
- **重建 schema 会丢掉默认权限**：`CREATE SCHEMA public` 不等于 PostgreSQL 初始化时那个 public schema——后者带 `GRANT USAGE ... TO PUBLIC`，重建的那个不带。少了这条，运行时角色看不见任何表，报出来的是"relation does not exist"，而不是本该报的权限错误，排查方向会被完全带偏。`db:reset` 现在会显式补回这条授权并把 schema 的 owner 交回 `pg_database_owner`。
- **`~/.workbuddy/mcp.json` 里 `DINGJIANG_MCP_API_TOKEN` 是明文**：本机配置文件，不在仓库内，但仍是待处理项。
- **没有浏览器级 e2e**：判据取舍见 `README.md` tier5 一节。当前用数据层直驱覆盖契约，不覆盖渲染。

---

## 9. 验证这一切的方式

架构不是靠文档保证的，是靠下面这些可执行的门：

| 门         | 位置                                                 | 挡住什么                               |
| ---------- | ---------------------------------------------------- | -------------------------------------- |
| 依赖方向   | `tooling/architecture/boundaries.test.ts`            | 领域层偷偷依赖框架、Web 偷偷连数据库   |
| 契约       | `packages/contracts/*.test.ts`                       | 三方对同一形状理解不一致               |
| 工具元数据 | `services/dingjiang-mcp/src/tool-contract.test.ts`   | 只读工具被标成可写、写工具漏了幂等信封 |
| 数据库行为 | 五层 `pnpm test:integration`（238 用例）             | 状态机、幂等、越权、RLS                |
| 读路径索引 | `apps/api/src/read-path-indexes.integration.test.ts` | 热查询悄悄退回全表扫描                 |
| 真实进程   | tier4 / tier5                                        | 打包产物、启动、鉴权、stdio 帧一起坏   |

`main` 分支已把 `verify` 与 `integration` 设为必需检查：以上任何一条不过，合不进去。
