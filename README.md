# 鼎江智绩 2.0

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
supabase                 版本化数据库迁移
docs                     架构与公开说明
```

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
pnpm test
pnpm build
docker compose config --quiet
```

真实飞书、模型或其他外部服务需要使用者自行创建应用并通过环境变量注入凭据。不要把密钥、真实业务数据、备份或验收日志提交到 Git。

## 开源状态

仓库公开仅用于源码展示与技术交流；当前未附带开源许可证，除法律默认允许的浏览和 fork 外，不授予额外复制、修改或分发许可。
