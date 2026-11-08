# 鼎江智绩 2.0

[![CI](https://github.com/lqyq666/dingjiang-zhiji-2/actions/workflows/ci.yml/badge.svg)](https://github.com/lqyq666/dingjiang-zhiji-2/actions/workflows/ci.yml)

鼎江智绩是一套面向单企业内部使用的绩效与咨询项目协作系统。它把项目、阶段、任务、材料、证据、审批和经验沉淀放在同一条可追溯业务链中，并通过服务端授权的 MCP 接口连接 WorkBuddy；飞书用于组织同步和人工协作投影。

## 核心边界

- PostgreSQL 是唯一业务事实源，核心数据按租户和项目隔离。
- AI 输出始终是建议，不能直接完成任务、确认结果或批准经验。
- Web 只调用 API；MCP 不直连数据库，也不持有维护凭据。
- 飞书租户管理员可映射为 `OWNER`，其他激活成员映射为 `PMC`；`EXPERT_REVIEWER` 由人工授予。
- 生产写入默认关闭，启用前必须完成迁移、备份和权限验收。

## 项目结构

```text
apps/web                 Next.js Web
apps/api                 NestJS API、迁移与业务模块
packages/contracts       跨服务公开合同
services/dingjiang-mcp   WorkBuddy MCP 适配器
deploy                   Docker 部署与运维脚本
docs                     架构与公开说明
```

> 迁移文件位于 `apps/api/migrations/`（PostgreSQL，由 API 进程在启动时执行）。README 早期曾把迁移标注在 `supabase/` 下，那是遗留描述；仓库从未使用 Supabase 作为事实源，该目录已移除。

想先理解系统怎么跑起来的，读 [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)：分层、一次受治理写入的真实路径、项目五阶段与门、以及当前明确记录的架构债务。

## 本地启动

要求 Node.js 22.19+、pnpm 11 和 Docker Desktop。

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm --filter @dingjiang/contracts build
pnpm --filter @dingjiang/api db:reset
pnpm dev
```

默认 Web 地址为 `http://localhost:3000`，API 地址为 `http://127.0.0.1:3001`。`db:reset` 只允许用于本地可销毁数据库。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test          # 不需要数据库：单元测试 + 默认关闭的集成用例
pnpm build
docker compose config --quiet
```

需要真实数据库的验证另有一条命令。仓库里约 90 个用例挂在 `*_INTEGRATION=1` 开关后面，其中三个还会拒绝在共享库上运行（它们会重置数据，要求专用库），过去只能靠口头约定逐个跑：

```bash
docker compose up -d postgres
pnpm test:integration
```

它按五个层级组织，任一失败即非零退出：

| 层级  | 内容                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ |
| tier1 | 全部 API 测试文件，27 个开关全开，串行跑共享库（串行是因为这些用例会重置同一个库）         |
| tier2 | VS17 集成与 HTTP，独立库 `dingjiang_vs17_test`                                             |
| tier3 | VS18 集成与 HTTP，独立库 `dingjiang_vs18_test`                                             |
| tier4 | 真实端到端：MCP 进程 → 真实 HTTP → API 进程 → PostgreSQL                                   |
| tier5 | 真实前端数据层：Web 数据层 → 真实 HTTP → API 进程 → PostgreSQL，独立库 `dingjiang_web_e2e` |

tier4 不 mock 任何一层：独立进程启动 `apps/api/dist/main.js` 与 `services/dingjiang-mcp/dist/server.js`，用 bearer token 走真实鉴权，验证 `initialize`/`tools/list` 元数据、越权写被拒、受治理写成功、同 `requestId` 重放返回原回执、旧 `expectedVersion` 被拒，最后回查数据库确认只落一条事实与一条回执。

tier5 补的是最后一个没走真实链路的入口。页面本身是客户端渲染，抓 HTML 证明力很低；真正会让界面出问题的是 Web 数据层与 API 之间的契约漂移，而 `apps/web/src/app/lib/vs01-api.ts` 是普通 TypeScript，可以直接驱动。测试因此不重写、不 mock，直接把 `NEXT_PUBLIC_API_BASE_URL` 指向真实 API 进程，再调用已发布的数据层函数，让函数内部的 Zod 解析判定契约是否还成立；写入走 `updateProjectSubtask` 后，用独立请求回读确认落库。库里的演示项目也由测试自己走「重置 → 确认工单 → 立项」建立，不依赖外部预置数据。

`pnpm verify` 把上述全部门禁串起来执行，CI 的 `integration` job 与 `verify` job 均设为 `main` 的必需检查。

覆盖率不是挂在无数据库的单元层，而是针对真实 PostgreSQL 测的——那才是受治理命令、材料、证据与工作纸真正被执行的地方：

```bash
pnpm test:coverage   # tier1 全量 + 27 开关，产出覆盖率并按阈值退出
```

CI 的 `integration` job 会在 `test:integration` 之后跑它，阈值定义在 `apps/api/vitest.config.mts`（当前约 74% 行、81% 函数、72% 语句、62% 分支）。

上面「核心边界」那几条不是文档承诺，而是可执行的检查。`pnpm depcruise`（`.dependency-cruiser.cjs`）把依赖方向写成规则并接入 CI：Web 与 MCP 适配层不得 import API 实现或数据库驱动，合同不得依赖实现，API 不得反向依赖入口层。当前扫描 286 个模块、635 条依赖，零违规。

## 性能基准

三条热读路径的索引不是凭直觉加的，它们有可复现的测量：

```bash
pnpm bench:read-path
```

脚本自建临时库、应用真实的迁移文件、灌入 30 万行级的合成数据，然后**把索引删掉测一遍、再建回来测一遍**，同一台机器上做前后对比。当前结果（约 300 项目 / 10 万子任务 / 20 万事件 / 20 万材料）：

| 读路径         | 无索引             | 有索引                 | 提升  |
| -------------- | ------------------ | ---------------------- | ----- |
| 子任务阶段计数 | 6.1 ms（Seq Scan） | 0.045 ms（Index Scan） | ~136× |
| 项目事件时间线 | 8.0 ms（Seq Scan） | 0.093 ms（Index Scan） | ~86×  |
| 任务材料列表   | 8.9 ms（Seq Scan） | 0.107 ms（Index Scan） | ~83×  |

绝对数字会随机器变化，可复现的是"有没有索引"这一组对比。

## 接口面文档

`docs/api-surface.md` 列出全部 85 个 HTTP 路由，按控制器分组。它由 `pnpm docs:api-surface` 从控制器源码用 TypeScript 解析器生成，不是手写的，所以不会漏。`tooling/architecture/api-surface.test.ts` 每次测试都会核对文档与代码：新增路由忘了重新生成文档，CI 会红并指出是哪一条。

## 决策记录

关键取舍写在 `docs/adr/`，每篇都能对照代码核对：

| ADR                                                                | 决策                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| [0001](docs/adr/0001-repository-foundation.md)                     | 仓库基础：pnpm + Turborepo，运行时入口的增删判据             |
| [0002](docs/adr/0002-tenant-isolation-in-postgres.md)              | 租户隔离放在 PostgreSQL（全表 FORCE RLS），不只靠应用层      |
| [0003](docs/adr/0003-idempotency-by-request-id.md)                 | 幂等靠 `requestId` + `pg_advisory_xact_lock`，不是"先查再插" |
| [0004](docs/adr/0004-layered-integration-suite.md)                 | 测试分五层，tier4/tier5 起真实进程而不是 mock                |
| [0005](docs/adr/0005-coverage-on-real-postgres.md)                 | 覆盖率在真实 PostgreSQL 上测，不拿单元层的 33% 当数          |
| [0006](docs/adr/0006-dependency-boundaries-as-tests.md)            | 架构边界用工具守住，空壳模块直接删                           |
| [0007](docs/adr/0007-performance-needs-a-repeatable-comparison.md) | 性能改动必须附带可复现的前后对比                             |

真实飞书、模型或其他外部服务需要使用者自行创建应用并通过环境变量注入凭据。不要把密钥、真实业务数据、备份或验收日志提交到 Git。

## 工具契约评测

MCP 适配层（`services/dingjiang-mcp`）附带可回归的契约评测，直接驱动构建产物，Integration 侧使用确定性 mock：

```bash
pnpm --filter @dingjiang/mcp build
pnpm --filter @dingjiang/mcp eval
```

覆盖七类不变量：工具声明与实现一致（28/28 可达）、工具元数据完备（annotations 全覆盖、25 个 `outputSchema`、`initialize.instructions` 携带治理不变量）、读写 happy path（24/24）、越权字段注入拦截（7/7）、非法参数拦截（6/6）、传输故障收敛（超时结构化返回且不泄露授权头）、协议契约（6/6）。任一失败即退出码 1，CI 在 `pnpm build` 后执行该评测。方法与未覆盖范围见 `services/dingjiang-mcp/evals/README.md`。

MCP 工具面除参数 schema 外还声明 `annotations`（读写、破坏性、幂等、开放世界）与 `outputSchema`：宿主据此决定是否在受治理写入口前弹确认，而 `outputSchema` 直接取自已用于校验响应的 Zod schema，因此 `structuredContent` 与声明同构是构造出来的。设计取舍见 `services/dingjiang-mcp/README.md`。

## 开源状态

仓库公开仅用于源码展示与技术交流；当前未附带开源许可证，除法律默认允许的浏览和 fork 外，不授予额外复制、修改或分发许可。
