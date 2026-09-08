# RC2 来源导入与人工授权操作

**仅用于通过源码检查后的隔离验收部署。当前 RC2 不具备正式发布资格。** 先读 README.md 与 handoff；生产写入默认关闭，不要通过本说明绕过发布锁。

维护账号与 Docker/DB 权限属于可信运维边界。不得把 `deploy/.env.production`、数据库管理密码或员工登录密码放入 WorkBuddy/MCP 的工作目录、工具参数或模型上下文。终端交互不是对拥有这些凭据的自动化程序的安全隔离。

## 一、三文件受控导入

使用 UTF-8（允许 BOM），逗号分隔，表头严格如下。日期 `YYYY-MM-DD`；允许标准双引号转义逗号/换行，CSV 行号是逻辑记录号。

| 文件          | 第一行                                                |
| ------------- | ----------------------------------------------------- |
| orders.csv    | orderId,customer,promisedDate,forecastDate,status     |
| bom.csv       | orderId,plannedBomDate,actualBomDate,completionStatus |
| purchases.csv | orderId,plannedStartDate,actualStartDate,arrivalRisk  |

每文件 1 字节至 5 MiB、最多10,000订单，每字段最多500字符。三个文件应含相同完整订单 ID 集合、无重复，且包含系统已经导入的所有订单；不支持通过省略删除订单。ID 长度2–101，首字符英数、其后英数/下划线/横线。每个字段必须非空且无首尾空白；日期有效且在2000–2100。实际日期未知时应先核实，不得让 AI 编造。状态目前保留企业非空字符串，禁止测试专用 E2E_ACCEPTANCE；企业枚举与业务映射需另外统一。

把三份真实文件放在源码仓库之外的私有目录，先检查内容。以下目录只是占位，不能直接填充演示数据作为企业事实：

```bash
# 生成一次批次 ID 并记录；重试时不要重新生成。
python -c "import uuid; print(uuid.uuid4())"
python scripts/release/operator.py --env deploy/.env.production import-sources --directory /secure/import-001 --batch-id <已记录UUID> --username employee01
```

员工输入自身账号密码，服务器给出企业/账号、文件SHA、行数与前3条样本；人工核对原文件和摘要，输入完整64位摘要后才提交。取消不会写入导入批次。支持 OWNER/PMC；EXPERT_REVIEWER 不能导入。维护服务重新核验活动账号，不信任 JSON 自报身份。

三份源原字节、版本、逐行记录、业务投影、批次回执与审计同事务保存。原始 CSV 在 PostgreSQL 中，随数据库备份；其他材料仍在现有私有材料卷。导入成功不是对业务内容已审核的证明。只有预计晚于承诺日期的订单自动产生待处理事件，不能把“未生成事件”误认为导入失败。

同一批次 UUID + 相同文件字节再次提交返回已完成回执；相同 UUID 绑定不同字节拒绝。真正的新快照使用新 UUID，保留既有订单集合。出现“提交结果未知”时保留原 UUID 和字节重试，不要新批次盲写。

## 二、精确人工批准

当前候选只读 MCP 不能完成高风险写入；以下是源码中已实现、待验收后的正式操作设计。在可销毁测试数据库中可以按测试用例验证，不能据此开放生产。

WorkBuddy 准备命令，但不执行“代人批准”。保存一个本地私有 UTF-8 JSON 文件，只允许三个顶层字段：

```json
{
  "name": "work.execute",
  "projectId": "PRJ-真实订单ID",
  "request": {
    "requestId": "使用当前命令的合法UUID",
    "correlationId": "合法UUID",
    "expectedVersion": 0,
    "reason": "真实操作理由",
    "payload": {
      "stateFingerprint": "必须来自当前work.context的真实指纹",
      "confirmation": "人工确认说明，不能代替批准凭证",
      "operation": { "action": "event.start" }
    }
  }
}
```

这是字段说明，包含占位符，不能直接执行。request 必须是对应工具准备的精确请求；不要自己猜版本/指纹。`material.verify` 和 `evidence.confirm` 用各自的现有 request schema，不能套 work.execute 的载荷。

```bash
python scripts/release/operator.py --env deploy/.env.production approve-command --command-file /secure/command-to-review.json --username employee01
```

员工需要一个当前有效、精确项目白名单、权限匹配的个人 MCP 凭证。只有一个活动凭证时才允许签发，不明确的多凭证须先轮换。立项事件可以预授权 `PRJ-<真实订单ID>`；不使用通配符。

核对服务器展示的账号、企业、角色、项目、动作、版本、精确字段和摘要，输入完整摘要。维护程序保存10分钟一次性批准，**此时业务未执行**；随后由该员工原 MCP 身份提交完全相同的请求。更改业务内容、请求 ID、版本、角色或个人凭证需要重新核对批准。传输 correlationId 不属于业务授权摘要，但原有幂等机制仍可能有更严格重放约束，优先保持整个请求不变。

已过期未消费授权使用新 context 和新 requestId 重新准备，不能延长旧授权。域操作失败时授权消费与业务同时回滚；已成功的相同请求返回回执，不重复业务写入。若响应丢失，保持原 requestId/内容查询或重试。

## 三、员工飞书绑定

飞书应用配置由部署环境注入，员工身份绑定只能通过维护容器执行：

```bash
python scripts/release/operator.py --env deploy/.env.production admin feishu-bind --username employee01 --feishu-open-id ou_xxx
```

`open_id` 必须来自该企业飞书应用的可见范围，一个飞书账号不能同时绑定多个鼎江账号。绑定不会改变角色、项目归属或 MCP scope；账号停用时绑定同步停用。当前闭环只在受治理的 `event.start` 成功提交后向该员工发送工作同步卡片，失败状态记录在数据库中，不回滚已经提交的业务事实。

### 组织角色同步

组织同步只读取飞书应用已获授权的通讯录范围，不接受 WorkBuddy、HTTP 或调用方提交的角色。规则固定为：飞书租户管理员映射 `OWNER`，其他激活成员映射 `PMC`，明确返回离职状态的已绑定成员停用并撤销 session/MCP；`EXPERT_REVIEWER` 始终人工维护，遇到专家冲突时同步拒绝写入。

系统不会自动创建带未知密码的新账号。未绑定成员仅在存在唯一同角色、激活且未绑定的本地账号时自动关联；0 个或多个候选都会作为 blocker 返回。未出现在应用授权范围内的本地账号不会被猜测停用。

先只读预览：

```bash
python scripts/release/operator.py --env deploy/.env.production admin feishu-org-sync
```

输出只包含统计和 64 位 digest，不输出姓名、open_id、App Secret 或 token。核对成员数、角色变化、绑定、停用、人工专家和 blocker；`blockers` 必须为 0。随后重新读取飞书目录并以相同摘要提交：

```bash
python scripts/release/operator.py --env deploy/.env.production admin feishu-org-sync --confirm-digest <完整64位摘要>
```

目录或本地账号在两次调用间发生任何相关变化都会改变摘要并拒绝提交。角色变化和离职停用在单个数据库事务中写入身份审计，并撤销旧 session/MCP；新的 PMC 项目归属和个人 MCP token 仍需管理员明确分配、签发。

## 四、迁移、权限和备份提醒

先执行维护迁移 0035/0036/0037/0038，再重新应用 runtime-grants；0037 只保留无歧义的现有 PMC 项目归属，0038 增加飞书身份绑定与通知回执。出现多人共享同一项目时必须由管理员明确重新分配，不能让迁移猜测。运行 API 不能拥有高权限/表所有权或插入批准的权限。历史迁移校验和不可重写。既有生产项目若无快照需要显式迁移核对，不让系统拿最新源假装历史。

备份包含源文件原字节、业务内容及密码/会话哈希，是敏感数据。manifest 已更正相关描述；需要加密离机及独立密钥保护。不要把备份上传到普通源码交接。恢复演练需核对原始 CSV 哈希、项目快照和材料，并确认旧会话/令牌已撤销。
