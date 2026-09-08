# 企业任务推进、就地交接与 AI 辅助：桥水及官方产品资料研究

> 研究日期：2026-08-17。目的：为鼎江智绩的员工推进界面提炼可验证的 UX 原则：员工完成当前事项后，能立刻看见下一步；需要复核或审批时，在原工作位置交接；AI 提供受控建议而不替人作业务决定。
>
> 证据标准：只使用产品厂商、Bridgewater Associates 或 Ray Dalio/Principles.com 发布的资料。文中“事实”只陈述来源明确支持的内容；“推断”是对鼎江智绩的产品建议，不是桥水内部实现事实。

## 结论摘要

流畅的企业工作流不是把一个任务简单标为“完成”，而是把下面四个事实分开呈现、在同一处衔接：

```text
责任人完成可验证事项
  → 系统计算“是否已备妥”
  → 若需复核，生成带对象、依据、责任人和决定按钮的就地交接
  → 通过才解锁下一事项；退回则说明原因并回到可修正事项
```

公开资料最一致地支持三点：

1. **决定与意见不同。**Bridgewater 的公开 Principles 页面描述了投票、可信度加权和 `Responsible Party`（RP）的决定权；意见应被记录和考虑，但不能掩盖最终责任人。
2. **审批是一个有状态的工作对象。**Asana、Jira Service Management 和 Power Automate 都把审批做成显式状态/动作，而不是把“提交”当成“批准”。
3. **AI 应读上下文、返回可审阅产物。**Bridgewater 对 AIA/PAT 的公开披露指向“编码知识 + LLM/agentic workflows + 专家反馈”的投资研究用途，同时明确披露 AI 输出可能不准确。它不证明桥水把 AI Agent 用在咨询项目管理；鼎江智绩应保留人工确认、证据定位、权限和审计。
4. **系统应主动交付下一动作。**Asana 的依赖规则会在前置任务完成后自动解除阻塞、移动工作并通知下一责任人；Linear 的 Agent Session 把运行状态和需要人输入的时刻直接暴露给用户。员工不应完成事项后再自己寻找下一节点。

## 一、桥水 / Principles 的公开事实

### 1. Dot Collector、Baseball Cards 与“谁负责最终决定”

**事实。**Principles.com 对“可信度加权决策”的公开说明称，Bridgewater 使用 Baseball Cards 和 Dot Collector 系统记录、衡量人员经验及历史表现；会议中用 Dot Collector 记录投票，并同时展示等权与可信度加权结果。页面还描述：当两者不一致时先尝试解决分歧；在不同决定类别中，RP 可能覆盖加权结果，或由加权结果优先。[Believability Weight Your Decision Making（Principles.com）](https://www.principles.com/principles/633d5d13-8610-425f-ad62-cd62347d9165)

**事实。**同一官方 Principles 摘录将决策分为学习和决定两个步骤，主张把原则转换为算法、让电脑与人一起决策，并同时提醒：没有深刻理解时要谨慎信任 AI。它还明确把“可信度加权”描述为辅助 Responsible Party 决策的工具，而非替代品。[Principles 摘录，Bridgewater](https://www.bridgewater.com/_document/principles-excerpt?id=00000174-ffa8-d25e-a9ff-ffeabe9d0000)

**边界。**Dot Collector 的公开产品页仍使用 beta/early-access 表述；公开页没有足以验证其当前内部数据模型、权限、算法或审计实现的技术细节。因此不能把“桥水使用 Dot Collector”外推为“鼎江智绩应复制其评分算法”或“桥水当前所有内部流程均由 Agent 驱动”。[Dot Collector 产品页（Principles.com）](https://www.principles.com/summitla/)

**面向鼎江的推断。**

- 在每个工作事项中同时展示“事实/证据”“AI 候选建议”“责任人完成确认”“阶段复核决定”，不要把它们压成一个 Done。
- 让咨询师、老板、专家各自看到自己的**待行动作**；但记录中仍保留所有相关意见、反证、输出 locator 和退回原因。
- 使用“建议权 / 确认权 / 批准权”而不是笼统的“参与人”标签。第一版不需要人员可信度评分；先确保责任、依据和可恢复审计准确。

### 2. 把原则、反馈、任务和结果做成可复盘的机器

**事实。**Bridgewater 官方 Principles 摘录主张：把工具用于收集数据，并把数据处理为结论和行动；结论的逻辑和数据应能被追踪。它还区分目标和任务，并主张用清单但不把清单误认为个人责任。[Principles 摘录，15. Use Tools and Protocols / 14. Use checklists](https://www.bridgewater.com/_document/principles-excerpt?id=00000174-ffa8-d25e-a9ff-ffeabe9d0000)

**事实。**Bridgewater 的创始人页面描述其长期做法为把对市场的因果理解编码成系统化投资过程，并将人类判断与机器智能结合、用现实持续测试与改进；这是其投资研究和投资流程的陈述。[Bridgewater 首页](https://www.bridgewater.com/)

**面向鼎江的推断。**

- “下一步”应由当前项目事实推导：例如“方案事项完成 → 待老板批准”“4/4 项已确认 → 员工进入结果确认”“结果已由员工确认 → 进入经验整理”，而非只给一个固定导航菜单。
- 交接卡必须给接手人最小充分上下文：要决定什么、谁请求、当前状态、必要证据/输出、影响范围、可选动作、退回后由谁修正。
- 状态改变只写入一个明确的事件；AI 的摘要、风险提示和下一步建议必须从该只读上下文派生，不得反写事实或越过角色动作。

### 3. 公开的 AI / Agent 资料：能说明什么、不能说明什么

**事实。**Bridgewater AIA Labs 的官方页面称其正在构建用于投资研究的 AIA（artificial investor），强调可解释的基本面研究、与经验丰富投资者的反馈循环，以及以既有系统化研究、数据和显式推理语料为基础；风险披露同时说明 AI Tools 的输出可能不准确、有错误、缺陷或安全漏洞。[AIA Labs: The Future of Investment Intelligence](https://www.bridgewater.com/aia-labs)

**事实。**Bridgewater 当前 FAQ 对技术与 AI 的公开描述是：用 AI 和机器智能捕捉关系、规模化检验假设、改进决策系统，同时保留人类判断与监督。[Bridgewater Working FAQ](https://www.bridgewater.com/working-at-bridgewater/faqs)

**事实。**Bridgewater 官方页面将 PAT 描述为让投资者把数小时探索性研究缩短到数分钟的 automated analyst，并称其组合了编码的投资知识、LLM、agentic workflows 和现代软件架构；该页面说明内容源自 2026-05-19 的 LangChain 演讲。[How Bridgewater’s AIA Labs Built PAT](https://www.bridgewater.com/aia-labs/how-bridgewaters-aia-labs-built-pat-the-ai-pocket-analyst-tool)

**不能推出。**这些是投资研究场景，不是企业绩效咨询或通用任务审批产品的公开规格；资料没有证明 PAT/Dot Collector 会自动批准任务、改变项目状态，或使用与鼎江相同的权限/审计设计。

**面向鼎江的推断。**AI 悬浮窗口可提供“本项目已读上下文范围、引用的正式经验、材料缺口、当前阶段、下一人工动作、候选经验草稿”，并标明 `PROPOSAL`。每个建议应可打开来源；写入完成确认、批准、结果签收和正式经验发布仍必须由相应角色二次确认。

## 二、相近企业工作流产品的官方做法

| 官方产品事实                                                                                                                                                                                                                                                                                                                                                              | 对“完成 → 下一步 → 就地交接”的启示                                                                     | 鼎江应采用的最小实现                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Asana 将审批建模为一种任务，审批者可选 Approve、Request changes 或 Reject；请求者能得到明确反馈。其官方帮助也提醒，默认并非只有 assignee 可以完成审批。 [Asana Approvals](https://help.asana.com/s/article/approvals)                                                                                                                                                     | 审批必须是独立状态，且“修改请求”应返回原责任人，而非静默结束。权限不能只依赖视觉按钮。                 | `PhaseGate=PENDING` 时生成“待某角色复核”卡；服务端验证角色，批准/退回均写审计。                           |
| Asana 的官方流程资料说明：阶段变为 Awaiting Approval 时可自动改为审批并分配给正确审批者；审批通过后才启动/衔接后续项目。 [Asana workflow movement](https://help.asana.com/s/article/add-movement-to-your-workflow)                                                                                                                                                        | 将真正需要治理的交接做成当前状态的自然后果，但不要把每个步骤都膨胀成审批。                             | 只在方案定稿和候选经验发布生成 PENDING；员工自己的落实与结果确认直接推进并保留审计。                      |
| Jira Service Management 官方说明：审批步骤挂在特定工作流状态；指定审批者收到通知，批准/拒绝后请求才进入下一状态，并将评论通知请求人。 [What are approvals?](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/)                                                                                                                         | 把审批入口放在发生等待的状态位置，审批内容、决定和反馈连着看，而不是让用户去另一张无上下文的表找任务。 | 在第 4/6/7 步原位置显示“下一责任人 + 去处理 + 通过/退回的后果”；老板/专家驾驶舱只作为同一事项的聚合入口。 |
| Power Automate 的官方 connector 区分 Create approval 与 Start and wait；后者在审批完成或超时前阻塞后续流转，且能取得审批者、响应与评论。 [Microsoft Learn: approval actions](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/approvals/differences-between-flow-approval-actions)                                                            | “送审”不能等同于“审批完成”；工作流必须明确等待条件、响应和下游解锁条件。                               | 保留 `submittedAt / reviewedBy / reviewedAt / decision / reason`；待审时不标项目完成，不展示结果已达成。  |
| Asana 依赖规则可在前置任务完成后自动解除下一任务的阻塞、移动任务、设置日期并通知下一责任人。 [Asana task dependencies](https://help.asana.com/s/article/use-dependencies-to-kick-work-off-at-the-right-time)                                                                                                                                                              | 完成动作必须同时产生“接下来做什么”，不能只刷新一个百分比。                                             | 完成 API 返回最新项目后，页面自动选中下一事项；若步骤结束，则把唯一主动作切换为下一阶段业务动作。         |
| Linear Agent 使用 issue、project、team、history、documents 与 guidance 等现有工作区上下文；委派给 Agent 时，人仍是主负责人，Agent Session 状态对用户可见并会提示何时需要输入。 [Linear Agent](https://linear.app/docs/linear-agent) / [Agents in Linear](https://linear.app/docs/agents-in-linear) / [Agent interaction](https://linear.app/developers/agent-interaction) | Agent 不应夺走人的责任；其工作、等待和需要人输入的时刻必须在原工作对象中可见。                         | AI 悬浮窗从当前咨询任务完整上下文派生建议；员工主动作仍留在行动条，AI 入口只做聚焦解释和草稿。            |

## 三、鼎江员工推进界面：可落地 UX 原则

### 1. 一页只回答三个问题

员工打开任一咨询事项时，首屏只需明确：

1. **现在发生什么？** 当前阶段、事项进度、经营结果状态分开显示。
2. **我现在能做什么？** 一个主动作（补材料 / 保存进展 / 确认完成 / 提交复核），并附“为什么是它”。
3. **完成后谁接手、会发生什么？** 在按钮附近显示下一责任人、将写入的状态和可回退路径。

页面顶部应持续显示一条由最新项目状态派生的“当前要做”：当前步骤、具体事项、责任人、完成影响、唯一主按钮和就地 AI 入口。员工完成后，系统直接把这条行动更新为下一事项，而不是让员工回到七步导航自行搜索。

### 2. 将“完成”限制为可验证的事实

完成操作应要求：完成说明、输出/证据定位、逐项验收勾选和二次确认。保存进展、材料登记、AI 建议、审批提交均不得增加完成分子；阶段/节点进度只由有效完成确认派生。

### 3. 让交接就地发生，而不是把用户踢出流程

当方案事项已备妥，原区域应从“继续编辑”变为一张交接卡：

```text
解决方案：2 / 2 项已由责任员工确认
下一责任人：企业负责人
需要决定：批准方案 / 退回修改
审批依据：方案比较、执行事项、输出 locator、材料缺口与风险
[提交负责人确认方案]  [查看完整依据]
```

退回后同一位置显示原因和“去重新打开指定事项”；重开应回算派生进度、保留旧确认快照，避免误点成为不可纠正的死路。

### 4. AI 做“上下文解释器”，不是隐藏的状态机

AI 窗口应显式展示已读取范围（阶段数、事项数、证据数、材料缺口、活动记录、正式经验引用数）及其建议性质。建议的安全边界：

- 可以：解释材料缺口、比较候选做法、归纳进展、起草候选经验、提示下一人工动作；
- 不可以：确认事项完成、批准阶段、签收经营结果、发布正式经验、把 `PROPOSAL` 写成事实；
- 每次可写入动作均由人看到“将写入什么 / 会影响什么”，再二次确认；发生下游依赖时提供补偿路径而非静默回滚。

### 5. 用两个视图服务同一条链，而非两套工作流

- **员工视图：**只显示当前主动作、必要上下文与恢复入口；落实和结果由员工直接推进。
- **老板/专家视图：**只聚合方案审批和候选经验审核，点击后回到同一事项、同一证据、同一审计事件；不得生成另一个脱节的审批副本。

## 四、建议的验收问题

在继续扩展 AI 或角色前，逐条在浏览器与 API 验收：

1. 补材料、保存进展、AI 建议是否都不会改变完成数、阶段门或经营结果？
2. 责任人完成后，页面是否自动定位下一事项或明确展示两道审批之一的责任人、依据和影响？
3. 方案或候选经验送审后，下游是否保持锁定，直至对应负责人或专家写入批准？
4. 退回是否就地展示原因并定位到可重开事项？重开是否回算投影并保留原输出和确认快照？
5. AI 是否只读授权内的完整上下文、展示引用计数/列表，并把输出标成候选建议？
6. 每一个按钮是否有中文业务名称，且用户无需猜测“项目”“任务”“审批”各自代表什么？

## 来源索引

- [Principles.com：Believability Weight Your Decision Making](https://www.principles.com/principles/633d5d13-8610-425f-ad62-cd62347d9165)
- [Principles.com：Dot Collector](https://www.principles.com/summitla/)
- [Bridgewater：Principles 摘录（PDF）](https://www.bridgewater.com/_document/principles-excerpt?id=00000174-ffa8-d25e-a9ff-ffeabe9d0000)
- [Bridgewater：AIA Labs](https://www.bridgewater.com/aia-labs)
- [Bridgewater：Working FAQ](https://www.bridgewater.com/working-at-bridgewater/faqs)
- [Bridgewater：PAT](https://www.bridgewater.com/aia-labs/how-bridgewaters-aia-labs-built-pat-the-ai-pocket-analyst-tool)
- [Asana：Approvals](https://help.asana.com/s/article/approvals)
- [Asana：Workflow movement](https://help.asana.com/s/article/add-movement-to-your-workflow)
- [Asana：Task dependencies](https://help.asana.com/s/article/use-dependencies-to-kick-work-off-at-the-right-time)
- [Atlassian：Jira Service Management approvals](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/)
- [Microsoft Learn：approval action lifecycle](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/approvals/differences-between-flow-approval-actions)
- [Linear：Linear Agent](https://linear.app/docs/linear-agent)
- [Linear：Agents in Linear](https://linear.app/docs/agents-in-linear)
- [Linear Developers：Agent interaction](https://linear.app/developers/agent-interaction)
