# WorkBuddy 主工作台架构

> 2026-09-06 产品方向更新：Web 收敛为只读事实与过程记录、事件状态和经营数据视图。WorkBuddy 承担具体业务操作。候选实现见 `docs/plans/workbuddy-record-platform-04.md` 与 `services/dingjiang-mcp/README.md`。下文原 3 写工具及 Web human gate 描述保留为已部署基线的历史说明；候选版本已通过身份绑定的 MCP 命令承接人工动作，尚未宣称真实 runtime 已晋级。

## 决策

WorkBuddy 成为员工与专业角色的日常 Agent 工作台；鼎江 API 与 PostgreSQL 保持唯一事实源。二者之间只有一个版本化 Seam：`dingjiang-mcp` 调用 Integration API。

```text
WorkBuddy Agent / Skill
        |
        | 15 read tools + 3 governed write tools
        v
dingjiang-mcp Adapter
        |
        | Bearer auth + versioned HTTP contract
        v
Integration API Interface
        |
        | authorized projections / governed command
        v
VS01 / VS12 / Workpaper Modules ----> PostgreSQL
```

## Module 与 Interface

### Integration API Module

Interface 保持业务意图级：项目、事项、证据、材料、工作底稿和正式经验的只读投影，以及 `workpaper.propose`、`material.create`、`evidence.propose` 三个受治理命令。Evidence Proposal 必须经过独立 PMC human gate 才投影为 FACT。Implementation 复用现有业务服务与 Governed Command Kernel；认证、授权、tenant 与 project allowlist 都在业务读取或写入前完成。

### dingjiang-mcp Module

Interface 是 15 个只读业务工具与三个固定 Proposal/登记命令。Implementation 只做 MCP 协议、严格参数验证、Integration API 调用、响应 schema 验证、安全错误映射与 build identity 检测；不接受任意 scope、SQL、Shell、URL 或路径，也不暴露人工确认。

### WorkBuddy Agent / Skill Module

Interface 是角色化工作意图。PMC 可留存分析底稿 Proposal、登记待核验材料、从 VERIFIED Material 提出 Evidence Proposal；正式 Evidence 确认仍由 Web/API human gate 执行。OWNER、EXPERT_REVIEWER 和 Automation 仍无产品写权限。

### n8n Automation Module

Interface 只接收确定性事件和明确命令；Implementation 可做通知、调度、同步和 ETL。它不拥有审批、推理或事实状态。

## Seam 与 Adapter

- WorkBuddy 厂商能力停在 MCP Seam。
- 飞书、Coze、n8n 和未来模型都经独立 Adapter 接入。
- 领域 Module 只依赖公开 Interface，不直接依赖厂商 SDK。
- Web 与 WorkBuddy 都只调用 API；它们不是事实源。

## Depth、Leverage 与 Locality

Integration API 和 MCP 的 Interface 保持稳定业务意图，内部隐藏权限、领域投影、幂等、并发、事务、审计、协议和错误处理，形成足够 Depth。相同 API 投影与 Command Kernel 可被 WorkBuddy、测试工具和未来逐个批准的命令复用。MCP 条件不进入业务模块，保持 Locality。

## 权限与数据边界

1. Bearer Token 在服务端绑定 tenant、subject、role、scopes。
2. PMC 的项目白名单必须是服务端持久化员工项目归属的子集；一个项目只有一名当前 PMC 责任员工，变更归属会撤销旧令牌。
3. 当前项目优先从该员工角色拥有的 `IN_PROGRESS`、`RETURNED`、`READY`、`WAITING_REVIEW` 事项派生；事项列表不会混入其他角色工作。
4. 调用方不能通过参数覆盖 scope、项目归属或责任角色。
5. 项目读取必须先解析授权 principal，再查询项目及来源任务。
6. 材料只返回安全摘要与受控预览，不返回 storage key、绝对路径或 bytes。
7. 正式经验只返回 `PUBLISHED` 对象，必须保留 locator、evidenceLocator 和 limitations。
8. `workpaper.propose` 只追加 `PMC_PROPOSAL`、不可覆盖 SourceVersion 和 Audit；相同 requestId 幂等，变更载荷冲突，expectedVersion 失配 fail closed。
9. Workpaper mutation、receipt 与 Audit 在一个 PostgreSQL 事务中提交；失败全部回滚。
10. Agent 输出与写入对象始终是 `PROPOSAL`，不改变判断、进度、审批或结果。
11. 撤销不删除历史；未来若批准 compensation，只能追加引用原 command/audit 的新事件与版本。本阶段不开放 compensation Tool。
12. 员工飞书身份只能由维护 CLI 绑定；`event.start` 在业务事务内登记通知，提交后发送幂等卡片。飞书失败不回滚已提交的业务事实，通知状态与回执留在 PostgreSQL，重放相同 requestId 不新增通知。

## WorkBuddy MCP 注册与部署

`%USERPROFILE%\.workbuddy\mcp.json` 是 WorkBuddy 用户级 MCP 源配置，宿主会把它投影到内部 connector proxy。安装、恢复和 Secret 轮换必须先在同目录完成 UTF-8 JSON 写入与解析，再以 `MoveFileEx(REPLACE_EXISTING | WRITE_THROUGH)` 单次原子发布；禁止直接截断覆盖被监听文件。若源配置启用 dingjiang 而代理投影缺失，注册探针 fail closed。恢复注册后，业务 Agent 必须重新读取当前项目与版本，不得继续使用阻塞前缓存的写入载荷。

## 错误语义

- `UNAUTHORIZED`：未提供或令牌错误；不可自动重试，需要人工配置。
- `FORBIDDEN`：principal 无所需 scope 或资源不在授权范围；不可自动重试。
- `PERMISSION_DENIED`：命令身份、角色或项目边界不满足；不可自动重试。
- `NOT_FOUND`：授权范围内不存在对象；不可自动重试。
- `INVALID_REQUEST`：输入不符合 contract；不可自动重试。
- `STALE_VERSION`：工作底稿版本已变化；刷新只读视图后由调用方重新判断。
- `CONFLICT`：相同 requestId 被用于不同命令内容；必须停止并人工核对请求来源。
- `TEMPORARILY_UNAVAILABLE`：依赖暂时不可用；只允许调用方有限重试一次。
- `INTERNAL_ERROR`：未分类服务错误；不泄露内部实现或秘密。

## 演进顺序

1. Phase 1：六个只读工具与本地 WorkBuddy 配置。
2. Phase 2：Governed Command Kernel 已建立；先仅开放 `workpaper.propose`，经真实写后回读验收后再逐个评估其他命令。
3. Phase 3：n8n 承接确定性外部编排，飞书保持协作界面。
4. Phase 4：WorkBuddy 稳定后，Web 收缩为管理、配置、审计与异常处理控制面；Coze 从主链退出。
