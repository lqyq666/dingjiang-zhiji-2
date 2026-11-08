# VS17 — 飞书 + Coze 经验智能闭环演示脚本

状态：本地 `DEMO_RULES` 演示、自动化回归和构建已完成；真实 Coze / 飞书仅用于最终 Founder/Operator 验收。<br />
预计时长：5–7 分钟。

## 演示前准备

1. 在仓库根目录执行 `Copy-Item .env.example .env`。保持 `COZE_PROVIDER_MODE=DEMO_RULES`、`FEISHU_PROVIDER_MODE=DEMO_RULES`；此本地演示不需要账号或网络凭证。
2. 启动本地 PostgreSQL、API 与 Web，并执行 `pnpm --filter @dingjiang/api db:reset`。推荐地址：`http://localhost:3010`。
3. 确认页面显示 provider `DEMO_RULES`。它是确定性本地降级，不能称为真实 Coze 或飞书。
4. 不要在聊天、终端输出、截图或 Git 中放入 Token、App Secret 或 Base Token。

## 12 步本地演示

1. 打开 `/project/PRJ-OTD-001`，进入“总结做法”。说明项目的材料、确认根因、结果和 Evidence 均由本地 PostgreSQL 管理。
2. 点击“AI 提取候选经验”，确认显示 `PROPOSAL` 与 `DEMO_RULES`。这一步只创建草稿，不创建 Candidate。
3. 编辑六个兼容字段和 Structured Experience Card：触发条件、判断条件、推荐动作、原因、例外、适用范围、claims 与 Evidence refs。
4. 核对 Evidence locator，说明服务端会在同一事务内按 tenant/project/sourceTask 校验 `evidenceRefs` 和 `claims[].evidenceIds`；伪造或跨项目引用会整次回滚。
5. 以 PMC 身份点击“提交候选经验”，确认生成新的不可覆盖候选版本。HTTP seam 会拒绝缺失 Structured Card 或未知字段。
6. 打开 `/expert`，确认候选版本、正文和飞书同步投影可见。
7. 点击“同步到飞书”。说明同一 Candidate push 由 PostgreSQL advisory lock 串行化，重复相同 requestId 可重放而不同载荷复用同一 requestId 会被拒绝。
8. 点击“同步飞书审核结果”。说明服务端只接受审核结果、意见与审核人；terminal 结果重入只跳过，冲突和过期版本被拒绝，飞书正文不能反向覆盖 PostgreSQL。
9. 走本地专家批准路径发布正式经验；确认正式经验进入 `/experiences`。飞书 `FAILED` 时只会留下脱敏集成投影和命令收据，不会改写候选正文、业务状态、revision、正式经验或项目进度。
10. 在正式经验上执行 Coze 索引提交。`DEMO_RULES` 时明确展示为本地演示；索引失败也必须保留 `PUBLISHED` 正式经验并显示同步状态。
11. 打开 `/experiences?taskId=SO-202608128`，提问“遇到产能不足导致交付延期，应该先检查什么？”。确认答案为 `PROPOSAL`，含经验 ID、适用性、引用和缺失信息；无匹配时必须澄清或标记 `UNKNOWN`。
12. 点击“缺少上下文”并提交反馈。确认反馈已登记为待评审，而项目、候选和正式经验状态没有被改变。

## 本地已记录证据

- 完整候选生成、编辑、提交，飞书 DEMO 同步/拉取，专家批准，Coze DEMO 索引，问答与反馈均走通。
- 回读结果：Candidate `APPROVED`、Formal Experience `PUBLISHED`、Coze `INDEXED`；extract/publish/answer 均是 `DEMO_RULES` 成功运行；反馈为 `PENDING_REVIEW`，原结果仍为 `ACCEPTED`。
- 项目页、专家页和经验助手页在 1536px、1024px 和 390px 下无横向溢出；console 无 warn/error。

## 截图清单

- 项目页：`PROPOSAL`、provider 标签、可编辑草稿、Structured Card 与 Evidence locator。
- 项目页：提交候选前后，证明 Draft 不等于 Candidate。
- 专家页：候选版本、飞书同步投影、Record ID（如有）和本地审批路径。
- 正式经验页：`PUBLISHED` 与 Coze 索引状态；失败时仍保留正式经验。
- 经验助手：答案、经验 ID、适用性、citation、missing information 和 `PROPOSAL` 标签。
- 负反馈提交结果：反馈已登记且项目/经验状态未改变。

## 最终外部验收（Founder/Operator 执行）

只有本地验证全部通过后才可执行。Founder/Operator 在本机 `.env` 填入实际值并切换 `COZE_PROVIDER_MODE=COZE`、`FEISHU_PROVIDER_MODE=FEISHU`：

- Coze：`COZE_API_TOKEN`、`COZE_EXTRACT_WORKFLOW_ID`、`COZE_PUBLISH_WORKFLOW_ID`、`COZE_ANSWER_WORKFLOW_ID`。
- 飞书：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BASE_APP_TOKEN`、`FEISHU_REVIEW_TABLE_ID`，并将应用加入目标多维表格的协作者。

不要将这些值提交到仓库、贴进对话或外发给第三方。真实最终验收至少执行一次 Coze Extract 或 Answer，以及一次飞书候选 push、人工审核与 pull。记录脱敏界面及重新读取的本地状态；不得把 HTTP 200、外部工作流完成或单页显示当作整体最终验收。

## 已知限制

- 一天演示版不包含生产认证、Webhook、飞书正式审批 API、双向正文编辑、自动发布、向量数据库、自建检索、远端部署或付费模型调用。
- `DEMO_RULES` 只证明本地可重复演示，不证明真实 Coze 输出、飞书权限或外部资源配置。
- Coze 调试链接如有仅为短期诊断信息；长期追溯以本地 `workflow_id`、`execute_id`、输入引用和结构化输出为准。
