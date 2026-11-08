# 贡献指南

感谢你愿意读这份代码。这个仓库的定位是**可运行、可验证、可追溯**：每一条业务事实都能在数据库里查到，每一次结论都能追到证据，每一次架构取舍都写在了 `docs/adr/` 里。贡献代码时请沿用这个基调。

## 这是什么

鼎江智绩是一套面向单企业内部使用的绩效与咨询项目协作系统。它把项目、阶段、任务、材料、证据、审批和经验沉淀放在同一条可追溯业务链中，并通过服务端授权的 MCP 接口连接 WorkBuddy。

仓库里是**完整实现**，含演示数据与合成夹具，**不含任何真实企业数据、客户信息或生产凭据**。

## 环境要求

| 依赖       | 版本              | 说明                                                 |
| ---------- | ----------------- | ---------------------------------------------------- |
| Node.js    | 24                | `pnpm` 需要                                          |
| pnpm       | 11.19.0           | CI 固定这个版本                                      |
| PostgreSQL | 17（含 pgvector） | 唯一业务事实源，`docker compose up -d postgres` 即可 |

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @dingjiang/api db:migrate   # 应用迁移
pnpm --filter @dingjiang/api db:seed      # 写入演示数据
```

Web 在 `http://localhost:3000`，API 在 `http://127.0.0.1:3001`。

## 提交前必须跑通

```bash
pnpm verify
```

它串起全部门禁：依赖边界 → lint → 类型检查 → 单元测试 → 构建 → MCP 契约评测 → 五层集成测试 → 格式检查。任一失败即非零退出。

需要真实数据库的更完整验证：

```bash
pnpm test:integration    # 五层：全量 API / VS17 / VS18 / 真实端到端 / 真实前端数据层
pnpm test:coverage       # 覆盖率（针对真实 PostgreSQL，不是单元层）
```

其他辅助命令：

| 命令                                    | 作用                             |
| --------------------------------------- | -------------------------------- |
| `pnpm depcruise`                        | 检查架构依赖方向                 |
| `pnpm bench:read-path`                  | 三条热读路径的索引前后对比       |
| `pnpm docs:api-surface`                 | 重新生成 85 条路由的接口面文档   |
| `pnpm --filter @dingjiang/api db:reset` | 重建本地库（会删数据，仅限本地） |

## 代码风格

- 格式化与 lint 统一交给 Prettier 和 ESLint：`pnpm format` 与 `pnpm lint`。
- TypeScript 开启 `strict` 与 `noUncheckedIndexedAccess`，不要用 `any` 绕过类型错误。
- 导入类型用 `import type`，这是 ESLint 的强制规则。
- 新增依赖前先想清楚：这个能力能不能用现有依赖解决？

## 架构约束（会被 CI 拦住）

- **依赖方向**：Web 与 MCP 适配层不得 import API 实现或数据库驱动；`packages/contracts` 不得依赖实现；API 不得反向依赖入口层。规则在 `.dependency-cruiser.cjs`。
- **门面只做委托**：`apps/api/src/vs01.service.ts` 已经拆成一层门面，六个上下文各在 `apps/api/src/<context>/` 下。`boundaries.test.ts` 的尺寸棘轮守着它不许再长大，`facade.test.ts` 守着方法体不许直接写 SQL 或领域逻辑。**新逻辑请放进对应的独立模块。**
- **接口面**：新增或删除路由后要跑 `pnpm docs:api-surface`，否则守卫测试会红。
- **许可证**：`LICENSE` 是 apache.org 的官方原文，`tooling/architecture/licence.test.ts` 用 sha256 钉住了它，不要改。

## 数据库变更

- **只能新增迁移**，不能修改已发布的迁移文件。已发布的迁移被改动会导致启动时校验和不匹配而失败——这是刻意的，用来防止静默改写历史。
- 迁移文件放在 `apps/api/migrations/`，同时要在 `apps/api/src/vs01-db.ts` 的 `migrations` 数组里登记 id。
- 新增租户相关表时记得开 `FORCE ROW LEVEL SECURITY`；`apps/api/src/vs01-db.ts` 里的 `assertMigrationInvariants` 会检查这一点。

## 提交信息

这个仓库的提交信息偏长，是有意的：**记录为什么，而不只记录改了什么**。一条好的提交信息应该能回答"当时面临哪些选项、为什么选了这个、拿什么证据验证的"。

```text
<type>: <一句话说明做了什么>

<为什么：面临什么问题，有哪些选项，为什么选这个>

<证据：怎么验证的，测试数字是多少>
```

参考本仓库的既有提交，比如 `chore: remove empty shells instead of pretending they run`、`fix(api): refuse a database whose schema no longer matches the migrations`。

## 拉取请求

1. 从 `main` 切分支，一个 PR 只做一件事。
2. 提交前 `pnpm verify` 必须是绿的。
3. PR 描述里写清楚：**改了什么、为什么、怎么验证的、有没有破坏性变更**（含数据库迁移、需要重新生成的文档、接口面变化）。
4. 如果动了 `apps/api/src/vs01.service.ts`，说明为什么不能放进独立模块——尺寸棘轮会拦住它。

## 讨论架构

架构取舍不放在评论里，放在 `docs/adr/`。新增一篇 ADR，说明：当时的约束是什么、有哪些选项、为什么选这个、代价是什么。写给半年后要维护这段代码的人看。

## 行为准则

对事不对人。评审关注的是论证和证据，不是措辞。
