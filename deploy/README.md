# 单企业内部部署与运维手册

## 当前限制

本包是 **NOT_ACCEPTED 的加固候选版**。以下是待真实环境执行的标准交付流程，不是已成功部署的记录。生产业务写入默认关闭；RC2 三项业务修复尚未取得真实环境验收证据时，不要接入重要资料或让员工正式生产使用。外部 AI/飞书保持演示/未连接状态。

用户当前没有服务器、域名或 SSO。此方案选用独立员工账号 + 单机 PostgreSQL/API/Web + Caddy HTTPS，不引入多租户 SaaS 架构。正式部署前需要可使用 Docker Compose 的 Linux 主机、指向该主机的企业可控域名、网络访问边界和离机备份位置。没有域名时先做本机开发/验收，不关闭 Secure Cookie 或把生产模式改成明文 HTTP 来绕过要求。现有 demo 启动流程仅用于独立演示数据。

## 1. 文件与机密

`Dockerfile` 构建 API/Web，`compose.production.yml` 定义服务，`postgres-init.sh` 建运行账号，`runtime-grants.sql` 限制权限，`Caddyfile` 同源路由和 HTTPS。仅代理开放 80/443；数据库和 API 不映射宿主机端口。内部使用应另外配置企业网络/VPN/允许列表，不能误以为有密码即适合任意公网开放。

Integration API 按已认证凭证在 PostgreSQL 中累计分钟请求数。每个 API 进程每五分钟最多清扫一次当前租户的过期窗口，每批最多 5,000 条，保留最近 24 小时的窗口。多实例共用计数，清扫跳过其他事务已锁定的记录。

现有 Caddy 配置提供 TLS、请求体上限和代理超时。远程 MCP 进程监听回环地址，现有生产编排未发布它。预认证流量保护由企业网络边界负责。若批准公网接入，先配置入口网关的预认证速率限制，在隔离预发布环境验证匿名请求超额返回 429、其他来源和合法请求可用，再开放入口。

`deploy/.env.production.example` 只提供字段说明。请用工具生成独立随机密码；不要提交 `.env.production`、令牌和备份。包内没有任何可直接使用的默认员工密码，也没有生产数据。

以下在项目根目录执行，示例域名/公司/目标值只是语法示例，必须替换为自己的配置；目标准交率应由企业负责人确定。

```bash
python scripts/release/operator.py --env deploy/.env.production init   --domain ops.example.com --company '示例公司'   --tenant company-example --target 85 --project dingjiang-internal
python scripts/release/operator.py --env deploy/.env.production check-config
```

`init` 只生成文件，不联系服务器、不创建账号。拒绝覆盖现有配置。Linux 权限需 0600；Windows 应设置真实文件 ACL，chmod 的模拟权限不能替代 ACL。不要运行会将密码插值输出的 `docker compose config` 并把结果贴出；只验证时可用 `config --quiet`。

## 2. 全新空库安装演练（Bash）

先读 `RC2_OPERATIONS.md`；本轮已实现三项业务修复，仍须完成源码和真实数据库验收，再验证以下安装步骤。首次只读候选环境也应使用假数据/空库，不标成正式验收。

```bash
# 每次发布使用唯一标签；不是实际 immutable digest，请在验收记录补镜像 digest。
# 工具生成的初始标签为 rc2-20260907。
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml build api web
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --wait db
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml run --rm migrate
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml exec -T db   psql -v ON_ERROR_STOP=1 -U postgres -d dingjiang -f /runtime-grants.sql

# 交互式输入员工密码，不写在命令参数或聊天中。
python scripts/release/operator.py --env deploy/.env.production admin account-set   --username owner --display-name '企业负责人' --role OWNER
python scripts/release/operator.py --env deploy/.env.production admin account-set   --username employee01 --display-name '员工一' --role PMC
python scripts/release/operator.py --env deploy/.env.production admin project-assign --username employee01 --project-id PROJECT_ID
python scripts/release/operator.py --env deploy/.env.production admin feishu-bind --username employee01 --feishu-open-id ou_xxx
python scripts/release/operator.py --env deploy/.env.production admin feishu-org-sync

docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --wait api web proxy
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps
```

维护命令将高权限连接串仅注入一次性 migrate/admin 容器，日常 API 只使用 `dingjiang_runtime`。不要为了通过启动检查改成 postgres 超级用户连接 API。本候选版的维护导入仅供隔离验收实例验证；重要生产数据和员工日常业务写入尚未放行。

Dockerfile 使用 Node 24.20.0，镜像标签为 PostgreSQL 17.11 / Caddy 2.11.4；这是选定并经过本轮实际构建/拉取验证的输入，不声称它们在未来持续最新或无漏洞。每次发布仍须锁定目标平台 digest，并重新执行扫描与测试。

Caddy 自动 HTTPS 需要 DNS/防火墙/证书签发条件真实可用。浏览器只访问配置的同一 HTTPS 域名；健康检查不等于 DNS、业务或权限验收。通过管理员账号进入后，空库显示暂无数据是预期，不应 `db:seed` 或 `db:reset` 填充演示完成记录。

本机隔离验收遇到 80/443 已占用时，可在 `init` 增加 `--http-port 18080 --https-port 18443`。正式部署省略这两个参数即保持 80/443；端口改写不关闭 HTTPS，也不能替代真实域名、证书和网络边界验收。

## 3. 旧库升级与回滚边界

升级前停止所有业务和维护写入，生成并**完成恢复验证**的 DB+材料备份，记录源代码/镜像/schema 版本。使用相同企业 tenant ID，不能临时换成 `tenant-demo`。

历史迁移没有校验和时，只有在核对实际 schema 与已审核迁移、备份及来源之后，单次设置 `DINGJIANG_BASELINE_MIGRATIONS=backup-verified` 执行维护迁移；之后清空该配置。不能对来源未知或已变更的旧库直接“认可基线”。新空库不需要该开关。

迁移后再次应用 runtime-grants，启动 API 验证所有权限门禁。迁移内容校验不通过应停止，不直接重写校验和。新增迁移会让旧二进制与新 schema 不一定兼容；本包会拒绝发现未识别新迁移的启动。回滚应按已验证的兼容方案或恢复到**新实例的旧备份+对应旧镜像**，不能直接覆盖生产卷或执行未审查的反向 SQL。

## 4. 员工账号与个人 MCP

角色：OWNER（负责人）、PMC（员工）、EXPERT_REVIEWER（内部审查者）。PMC 的事项队列按唯一员工项目归属隔离；项目完整上下文仍包含其他角色已经形成的协作事实，不是每个员工私有数据仓库。外部专家使用前另验收数据授权。

```bash
# 重置密码/调整角色使用 account-set，旧会话/旧 MCP 将撤销。
python scripts/release/operator.py --env deploy/.env.production admin account-disable --username employee01
python scripts/release/operator.py --env deploy/.env.production admin mcp-revoke --username employee01

# PROJECT_ID 是待替换的精确授权项目 ID；从事件立项时可预授权 PRJ-<真实订单ID>，不能发通配符。
python scripts/release/operator.py --env deploy/.env.production admin mcp-issue   --username employee01 --project-id PROJECT_ID --token-out /secure/employee01.secret.json
```

PMC 必须先通过 `project-assign` 获得项目归属，再签发不超过该归属范围的个人 MCP 令牌。一个项目只能分配给一名 PMC；重新分配时先对原员工执行不带 `--project-id` 的 `project-assign`，旧令牌会立即撤销，再分配给新员工并签发新令牌。OWNER 与 EXPERT_REVIEWER 仍使用显式项目白名单，不进入 PMC 事项队列。

飞书通知启用时，管理员通过 `feishu-bind` 将鼎江独立账号绑定到唯一飞书 `open_id`。绑定只写入维护数据库，不暴露给 WorkBuddy；账号停用会停用绑定。当前最小通知闭环仅在 PMC 通过受治理的 `event.start` 成功建项后发送，不把飞书作为业务事实源，也不授予飞书数据库或审批权限。

启用 `FEISHU_PROVIDER_MODE=FEISHU` 时，生产 Compose 会把飞书配置传给 API 和仅按需启动的维护容器。组织角色同步必须先预览再以完整 digest 提交；固定映射、歧义拒绝、离职撤销与专家人工边界见 `RC2_OPERATIONS.md`。维护容器只在执行期间连接外网和数据库，不作为 WorkBuddy 工具运行。

每位员工独立凭证，30 天有效。`.secret.json` 是敏感文件，默认不进入 Git/交付包，管理员应通过受控渠道发给本人。个人 WorkBuddy/MCP 客户端的 `DINGJIANG_MCP_API_TOKEN` 用来保存这个个人令牌；**不要把它设回生产 API 进程的同名旧共享令牌变量**，API 生产配置明确拒绝旧共享令牌。

MCP 的 API 地址为企业 HTTPS 域名下 `/api`，仅本机演示允许 HTTP。令牌绑定项目范围不能代替人的逐次高风险批准。本候选版只发只读 scope，不支持从 Agent 自行提权。

## 5. 备份与恢复演练

工具在备份期间停止 API，然后执行 PostgreSQL custom dump 与材料归档，完成后恢复原 API 运行状态。管理员、迁移/导入和其他写进程必须同时停写，跨主机调度器不会被本机文件锁自动暂停。备份目录必须是新目录，失败文件不能当有效备份。

```bash
python scripts/release/operator.py --env deploy/.env.production backup --directory /secure/backups/backup-001
```

离机加密保存整个目录与另外受保护的配置；保存日期、代码和镜像版本。备份包含员工身份/密码哈希/业务数据，应按敏感数据管理。数据库配置秘密不在备份中，单独保护；旧会话/MCP 信息可能在数据库 dump 中，恢复后工具会撤销。SHA-256 清单不是签名，也不能抵御攻击者同时替换备份和清单。

恢复只能到新 Compose 项目。使用新的私有配置、不同项目名、新空卷、**相同 tenant ID**，并使用与备份对应的应用/schema 版本。不能与原部署抢占 80/443：在独立主机/隔离网络演练；本工具恢复后不启动 Web/Proxy 或切流量。

```bash
python scripts/release/operator.py --env deploy/.env.restore init   --domain restore.example.com --company '示例公司'   --tenant company-example --target 85 --project dingjiang-restore-001
# 在私有配置中核对并设置与备份匹配的 DJ_RELEASE_TAG，确保镜像已存在。
python scripts/release/operator.py --env deploy/.env.restore restore   --directory /secure/backups/backup-001 --confirm-new-instance dingjiang-restore-001
```

恢复会校验清单/归档路径/文件哈希、拒绝旧目标卷；写入新数据库和材料后撤销会话/MCP，再由管理员核验记录数、抽样材料哈希、来源引用、RLS、业务可读性和版本一致性，重新发个人令牌。未经验证不切流量。不使用 `down -v` 清理正式系统；误删卷不可用普通容器重启恢复。

## 6. 运营验收与监控

首批员工真实完成授权数据接入、项目逐阶段推进、人的批准与证据审查后，量化处理耗时/错误/返工；不要承诺固定节时比例。须验证登录失败与代理 IP、角色数据边界、重复写幂等、并发版本冲突、断电重启、DB/材料满盘、卷权限和备份告警。

CPU/内存/存储按真实数据量和并发测量；Compose 限额只是防止无限使用，不是机器配置推荐或容量证明。单机故障会停服，没有 HA/灾备自动切换；日志轮转不是告警系统。确定负责人、备份频率/保留、可接受停机和数据损失窗口后，再选择监控与恢复目标。本轮没有足够业务量/服务价格数据给出可信运行成本。

## RC2 新增维护流程

真实来源导入与独立人工命令授权见 [RC2_OPERATIONS.md](RC2_OPERATIONS.md)。这两条流程没有新增 Web 业务写接口，也不把维护身份交给 MCP。新 SQL 0035/0036 须先在可销毁 PostgreSQL 中验收；`ACCEPTED-*` 字符串不是验收证明。
