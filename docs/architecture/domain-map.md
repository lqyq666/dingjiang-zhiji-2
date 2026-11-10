# 领域概念 → 代码位置

[`CONTEXT.md`](../../CONTEXT.md) 定义每个概念**是什么**；这份索引回答**在哪实现、落到哪张表、跑什么能验证**。给第一次读代码、或想就某个点深挖的评审者用。所有路径与表名都可在仓库内直接核对。

> `vs01` / `VS15` / `VS17` 是历史切片编号，`SO-202608128` / `PRJ-OTD-001` / `PRJ-DEMO` 是种子与夹具标识。它们都是代码里的常量，不代表真实客户、项目状态或生产数据。

## 概念索引

| 业务概念                                  | 定义                                                 | 主要实现                                                                                                                   | 关键表                                                                                                                          | 可核对的验证                                       |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| BusinessProblem 经营问题                  | [CONTEXT.md](../../CONTEXT.md)                       | `apps/api/src/intake/source-facts.ts`                                                                                      | `vs01_orders`                                                                                                                   | `pnpm verify`                                      |
| ConsultingEngagement 咨询任务             | 同上                                                 | `apps/api/src/projects/project-lifecycle-service.ts`、`apps/api/src/vs01.service.ts`（门面）                               | `vs01_projects` / `vs01_tasks` / `vs01_decisions`                                                                               | `pnpm test:integration`                            |
| WorkStage 工作步骤（七个阶段）            | 同上                                                 | `apps/api/src/work-stages.ts`                                                                                              | `vs01_project_phases`                                                                                                           | `pnpm --filter @dingjiang/architecture-tests test` |
| WorkItem 执行事项                         | 同上                                                 | `apps/api/src/projects/task-templates.ts`、`apps/api/src/projects/project-primitives.ts`                                   | `vs01_project_subtasks` / `vs01_project_subtask_events`                                                                         | `pnpm --filter @dingjiang/api test`                |
| WorkContextSnapshot 工作上下文快照        | 同上                                                 | `apps/api/src/read-model/read-model-service.ts`、`services/dingjiang-mcp/src/tools/dispatch.ts` 的 `work.context`          | 只读聚合，不落表                                                                                                                | `pnpm --filter @dingjiang/mcp eval`                |
| GuidedAnalysis 引导式分析                 | 同上                                                 | `apps/api/src/assistant/guided-analysis.ts`、`apps/api/src/assistant/assistant-service.ts`                                 | 纯函数，不落表                                                                                                                  | `pnpm --filter @dingjiang/api test`                |
| TraceableMaterial 可追溯材料              | 同上                                                 | `apps/api/src/materials/material-service.ts`、`material-create-command.ts`                                                 | `vs01_task_materials` / `vs15_material_contents`                                                                                | `pnpm test:integration`                            |
| MaterialVerification 材料核验             | 同上                                                 | `apps/api/src/materials/material-verification-command.ts`                                                                  | `vs01_source_versions` + 核验事件流                                                                                             | `pnpm test:integration`                            |
| EvidenceProposal / HumanConfirmedEvidence | 同上                                                 | `apps/api/src/evidence/evidence-proposal-command.ts`、`evidence-confirmation-command.ts`                                   | `vs01_source_objects` / `vs01_source_versions`                                                                                  | `pnpm test:integration`                            |
| ValidationWorkpaper 核验工作底稿          | 同上                                                 | `apps/api/src/workpapers/`                                                                                                 | 底稿与版本表                                                                                                                    | `pnpm test:integration`                            |
| 经验候选 / 正式经验                       | 同上                                                 | `apps/api/src/experience/experience-service.ts`、`apps/api/src/read-model/projections.ts`                                  | `vs01_experience_candidates` / `vs01_experience_candidate_revisions` / `vs01_formal_experiences` / `vs01_experience_references` | `pnpm test:integration`                            |
| 受治理命令 / 幂等回执                     | [ADR 0003](../adr/0003-idempotency-by-request-id.md) | `apps/api/src/command-kernel/governed-command-kernel.ts`、`apps/api/src/command-kernel/postgres-governed-command-store.ts` | 命令回执表                                                                                                                      | `pnpm test:integration`                            |

## 三个入口，一套事实

| 入口     | 代码                       | 鉴权                             | 关键约束                               |
| -------- | -------------------------- | -------------------------------- | -------------------------------------- |
| Web      | `apps/web`                 | 会话 cookie                      | 生产环境浏览器只允许 GET，写必须走 MCP |
| MCP      | `services/dingjiang-mcp`   | bearer + `scopes` / `projectIds` | 不直连数据库，不持有维护凭据           |
| 集成 API | `apps/api/src/integration` | bearer → principal               | 只能走 Integration API，禁止直连数据库 |

三者最终落在同一段写入代码上，治理规则只有一份。完整链路见[系统总览 §4](system-overview.md)。

## 历史切片编号

| 编号   | 定位依据                                                                         | 现在看什么                                                                                  |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `vs01` | 主业务切片：项目、任务、材料、经验；起始迁移 `apps/api/migrations/0001_vs01.sql` | `apps/api/src/vs01.service.ts` 是 416 行门面，实现已按上下文分到六个服务                    |
| `VS15` | 材料治理：内容库、核验、受治理登记；`0019_vs15_traceable_materials.sql`          | `apps/api/src/materials/` 与 `vs15_*` 表                                                    |
| `VS17` | 经验智能：候选经验、飞书同步、正式经验                                           | `apps/api/src/experience/`、[演示脚本](../demo/vs17-experience-intelligence-demo-script.md) |

编号只用于定位历史文件与迁移，不改变当前架构分层。想按业务剧情走一遍，从 [README 的「一个延期工单如何被闭环」](../../README.md) 开始。
