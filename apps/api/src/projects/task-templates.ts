import { BadRequestException } from "@nestjs/common";

import { isProduction, runtimeTargetOtd } from "../runtime-config";
import type { phases } from "../work-stages";

export type ProjectFactContext = {
  sourceTaskId: string;
  orderDelay: number;
  bomDelay: number;
  purchaseDelay: number;
  orderEvidenceReference: string;
  bomEvidenceReference: string;
  purchaseEvidenceReference: string;
  historicalSnapshotReference: string;
};

/**
 * The seven-phase task catalogue. Pure construction: no database, no
 * transaction, no service state. It lives outside the state machine so the
 * command file reads as commands rather than as a 500-line table.
 */
export function buildTaskTemplates(facts: ProjectFactContext) {
  const sourceTaskId = facts.sourceTaskId;
  const task = (
    id: string,
    phaseCode: (typeof phases)[number][0],
    title: string,
    purpose: string,
    status: string,
    origin: "LIVE" | "HISTORICAL",
    sortOrder: number,
    inputs: Array<{
      label: string;
      status: "AVAILABLE" | "MISSING" | "UNVERIFIED";
      reference: string | null;
    }>,
    process: string[],
    expectedOutput: string,
    acceptance: string[],
    owner: "PMC" | "OWNER" = "PMC",
    outputReference = origin === "HISTORICAL"
      ? facts.historicalSnapshotReference
      : "来源订单、BOM、采购记录与人工判断",
  ) => ({
    id,
    phaseCode,
    title,
    purpose,
    status,
    origin,
    sortOrder,
    owner,
    outputReference,
    inputs,
    process: process.map((label) => ({
      label,
      completed: origin === "HISTORICAL",
    })),
    expectedOutput,
    acceptance,
  });
  const historical = [
    {
      label: `订单异常任务 ${sourceTaskId}`,
      status: "AVAILABLE" as const,
      reference: sourceTaskId,
    },
    {
      label: "订单、BOM、采购证据",
      status: "AVAILABLE" as const,
      reference: `${facts.orderEvidenceReference}；${facts.bomEvidenceReference}；${facts.purchaseEvidenceReference}`,
    },
    {
      label: "项目历史事实快照",
      status: "AVAILABLE" as const,
      reference: facts.historicalSnapshotReference,
    },
  ];
  const templates = [
    task(
      "SUB-SCOPE-001",
      "PROJECT_SCOPING",
      "确认经营问题与范围",
      "把异常转为可观察的绩效差距",
      "DONE",
      "HISTORICAL",
      1,
      historical,
      ["读取订单承诺与预测交期", "界定 OTD 异常及受影响订单"],
      "订单交付问题界定卡",
      ["问题使用 OTD 口径", "范围指向具体延期订单"],
    ),
    task(
      "SUB-SCOPE-002",
      "PROJECT_SCOPING",
      "确认目标与责任边界",
      "确认项目目标、角色和约束",
      "DONE",
      "HISTORICAL",
      2,
      [
        ...historical,
        {
          label: "PMC 人工判断",
          status: "AVAILABLE",
          reference: "已保存人工判断",
        },
      ],
      [
        `确认目标预计准交率 ${runtimeTargetOtd()}%`,
        "明确 PMC 与老板的决策边界",
      ],
      "目标与责任边界记录",
      ["目标有数值", "责任角色明确"],
    ),
    task(
      "SUB-SCOPE-003",
      "PROJECT_SCOPING",
      "形成项目立项快照",
      "留下可回看的项目界定",
      "DONE",
      "HISTORICAL",
      3,
      historical,
      ["汇总问题、目标与证据", "记录项目创建前的来源时间"],
      "项目立项历史快照",
      ["可回到来源任务", "包含来源记录时间"],
    ),
    task(
      "SUB-BASE-001",
      "BASELINE_FACTS",
      "核对 OTD 计算口径",
      "确认基线口径一致",
      "DONE",
      "HISTORICAL",
      1,
      historical,
      [
        "按承诺交期与实际/预测交期重算",
        `确认该订单预计延期 ${facts.orderDelay} 天`,
      ],
      "OTD 基线口径说明",
      ["分子分母明确", "可与结果阶段同口径比较"],
    ),
    task(
      "SUB-BASE-002",
      "BASELINE_FACTS",
      "核对延期订单事实",
      "确认异常事实与来源",
      "DONE",
      "HISTORICAL",
      2,
      historical,
      ["核对订单延期天数", "核对 BOM 与采购启动滞后"],
      "延期订单事实清单",
      ["每项事实有证据编号", "不把推断当事实"],
    ),
    task(
      "SUB-BASE-003",
      "BASELINE_FACTS",
      "记录数据质量边界",
      "登记缺失和待核验项",
      "DONE",
      "HISTORICAL",
      3,
      [
        ...historical,
        { label: "产能负荷与工时记录", status: "MISSING", reference: null },
      ],
      ["标记产能风险尚未核验", "记录数据边界"],
      "数据质量与待核验清单",
      ["缺失材料被明确标识", "不阻断 BOM 治理路径"],
    ),
    task(
      "SUB-CAUSE-001",
      "ROOT_CAUSE_VALIDATION",
      "列出候选原因",
      "区分候选原因与事实",
      "DONE",
      "HISTORICAL",
      1,
      historical,
      ["比对 BOM 和采购时间差", "形成候选原因，不宣称根因"],
      "候选原因假设清单",
      ["候选原因与事实分开", "含待核验项"],
    ),
    task(
      "SUB-CAUSE-002",
      "ROOT_CAUSE_VALIDATION",
      "关联 BOM 与采购证据",
      "用证据检验候选原因",
      "DONE",
      "HISTORICAL",
      2,
      historical,
      [
        `关联 BOM 完成晚 ${facts.bomDelay} 天`,
        `关联采购启动晚 ${facts.purchaseDelay} 天`,
      ],
      "原因证据链",
      ["至少两条来源证据", "证据能追溯版本"],
    ),
    task(
      "SUB-CAUSE-003",
      "ROOT_CAUSE_VALIDATION",
      "保存人工判断",
      "由 PMC 对候选原因作出判断",
      "DONE",
      "HISTORICAL",
      3,
      [
        ...historical,
        {
          label: "PMC 人工判断",
          status: "AVAILABLE",
          reference: "确认：BOM准备滞后",
        },
      ],
      ["展示 AI 候选建议", "由 PMC 确认或修改"],
      "人工判断记录",
      ["包含判断人与时间", "可以在下游前撤销"],
    ),
    task(
      "SUB-SOLUTION-001",
      "SOLUTION_APPROVAL",
      "形成 BOM 治理方案",
      "把根因转化为可执行方案",
      "READY",
      "LIVE",
      1,
      [
        {
          label: "原因证据链",
          status: "AVAILABLE",
          reference: `${facts.bomEvidenceReference}；${facts.purchaseEvidenceReference}`,
        },
        { label: "产能负荷核验", status: "UNVERIFIED", reference: null },
      ],
      [
        "提出 BOM 分类、补齐与规则两个以上方案",
        "比较预期影响、成本与风险",
        "选择建议方案并说明未核验边界",
      ],
      "BOM 治理方案比较表",
      ["至少两个候选方案", "有取舍理由", "标记产能待核验"],
    ),
    task(
      "SUB-SOLUTION-002",
      "SOLUTION_APPROVAL",
      "拆解执行任务与验收方式",
      "明确任务、依据和验收方式",
      "READY",
      "LIVE",
      2,
      [
        {
          label: "已选 BOM 治理方案",
          status: "AVAILABLE",
          reference: "方案比较表",
        },
      ],
      [
        "拆成分类、补料、责任、规则四项任务",
        "为每项写责任人、完成依据与验收",
        "核对依赖与截止时间",
      ],
      "执行任务、责任与验收清单",
      ["四项任务均有责任人", "每项都有验收依据"],
    ),
    task(
      "SUB-SOLUTION-003",
      "SOLUTION_APPROVAL",
      "企业负责人确认解决方案",
      "由业务负责人决定是否启动",
      "LOCKED",
      "LIVE",
      3,
      [
        {
          label: "方案比较表",
          status: "AVAILABLE",
          reference: "SUB-SOLUTION-001 输出",
        },
        {
          label: "任务、责任与验收清单",
          status: "AVAILABLE",
          reference: "SUB-SOLUTION-002 输出",
        },
      ],
      ["老板核对方案范围、责任与风险", "批准启动或退回补充"],
      "项目批准或退回记录",
      ["老板动作有审计", "批准后才解锁执行"],
      "OWNER",
      "项目批准记录",
    ),
    task(
      "SUB-BOM-001",
      "EXECUTION_CONTROL",
      "完成 BOM 问题分类",
      "识别可治理的 BOM 异常",
      "LOCKED",
      "LIVE",
      1,
      [
        {
          label: "BOM 异常明细",
          status: "AVAILABLE",
          reference: facts.bomEvidenceReference,
        },
      ],
      ["按缺料、变更、编码错误分类", "统计每类数量和影响订单"],
      "BOM 问题分类清单",
      ["分类覆盖异常项", "影响订单可追溯"],
    ),
    task(
      "SUB-BOM-002",
      "EXECUTION_CONTROL",
      "补齐缺失 BOM 材料",
      "让执行依据完整可追溯",
      "LOCKED",
      "LIVE",
      2,
      [
        {
          label: "BOM 问题分类清单",
          status: "AVAILABLE",
          reference: "SUB-BOM-001 输出",
        },
        { label: "缺失 BOM/变更资料", status: "MISSING", reference: null },
      ],
      ["催收缺失 BOM 或变更资料", "复核补齐版本与适用订单"],
      "缺失 BOM 补齐记录",
      ["缺失项有处理结果", "补齐版本可追溯"],
    ),
    task(
      "SUB-BOM-003",
      "EXECUTION_CONTROL",
      "输出治理清单并确认责任人",
      "形成可执行责任清单",
      "LOCKED",
      "LIVE",
      3,
      [
        {
          label: "分类与补齐记录",
          status: "AVAILABLE",
          reference: "SUB-BOM-001 / SUB-BOM-002 输出",
        },
      ],
      ["列出治理动作", "分配责任人和完成期限", "确认复核人"],
      "BOM 治理责任清单",
      ["每个动作有唯一责任人", "有期限和复核人"],
    ),
    task(
      "SUB-BOM-004",
      "EXECUTION_CONTROL",
      "评审并发布治理规则",
      "确认规则被发布并可执行",
      "LOCKED",
      "LIVE",
      4,
      [
        {
          label: "BOM 治理责任清单",
          status: "AVAILABLE",
          reference: "SUB-BOM-003 输出",
        },
      ],
      ["评审分类与补齐规则", "发布规则并通知责任人", "保留评审记录"],
      "BOM 治理规则发布记录",
      ["规则有版本", "责任人已确认接收"],
    ),
    task(
      "SUB-RESULT-001",
      "RESULT_ACCEPTANCE",
      "重新计算同口径 OTD",
      "得到与基线可比较的当前值",
      "LOCKED",
      "LIVE",
      1,
      [
        {
          label: "订单交期记录",
          status: "AVAILABLE",
          reference: facts.orderEvidenceReference,
        },
        {
          label: "OTD 基线口径",
          status: "AVAILABLE",
          reference: "SUB-BASE-001 输出",
        },
      ],
      ["使用同一分子分母重算", "标注计算日期和样本范围"],
      "当前 OTD 重算表",
      ["口径与基线一致", "计算可复查"],
    ),
    task(
      "SUB-RESULT-002",
      "RESULT_ACCEPTANCE",
      "核对结果证据与副作用",
      "验证数据与影响边界",
      "LOCKED",
      "LIVE",
      2,
      [
        {
          label: "当前 OTD 重算表",
          status: "AVAILABLE",
          reference: "SUB-RESULT-001 输出",
        },
        {
          label: "BOM 治理发布记录",
          status: "AVAILABLE",
          reference: "SUB-BOM-004 输出",
        },
      ],
      ["解释 Before、Current、Target 差异", "收集影响与副作用证据"],
      "结果差异与影响证据包",
      ["差异解释不夸大因果", "副作用或边界已记录"],
    ),
    task(
      "SUB-RESULT-003",
      "RESULT_ACCEPTANCE",
      "形成结果验收建议",
      "给老板提供可签收结论",
      "LOCKED",
      "LIVE",
      3,
      [
        {
          label: "OTD 重算表与证据包",
          status: "AVAILABLE",
          reference: "SUB-RESULT-001 / SUB-RESULT-002 输出",
        },
      ],
      ["汇总验收结论", "提出签收或退回建议"],
      "结果验收建议书",
      ["含 Before/Current/Target", "引用证据包"],
    ),
    task(
      "SUB-KNOWLEDGE-001",
      "KNOWLEDGE_CAPTURE",
      "整理有效做法与适用情境",
      "提炼经验的适用边界",
      "LOCKED",
      "LIVE",
      1,
      [
        {
          label: "员工已确认结果",
          status: "AVAILABLE",
          reference: "结果验收 locator",
        },
      ],
      ["描述适用订单和异常情境", "提炼可复用做法"],
      "适用情境与做法草稿",
      ["不泛化为所有订单", "情境可识别"],
    ),
    task(
      "SUB-KNOWLEDGE-002",
      "KNOWLEDGE_CAPTURE",
      "整理结果与证据引用",
      "保证经验有结果依据",
      "LOCKED",
      "LIVE",
      2,
      [
        {
          label: "员工已确认结果证据",
          status: "AVAILABLE",
          reference: "结果验收 locator",
        },
      ],
      ["复用员工已确认结果定位", "核对结果摘要与来源一致"],
      "经验证据引用清单",
      ["不新增或替换结果来源", "版本编号可追溯"],
    ),
    task(
      "SUB-KNOWLEDGE-003",
      "KNOWLEDGE_CAPTURE",
      "记录限制与待验证条件",
      "避免候选经验被当成确定规则",
      "LOCKED",
      "LIVE",
      3,
      [{ label: "未核验产能风险", status: "UNVERIFIED", reference: null }],
      ["记录不适用范围", "记录待验证条件与后续审核点"],
      "经验限制条件清单",
      ["限制条件明确", "候选经验标为待专家审核"],
    ),
  ];
  if (!isProduction() && sourceTaskId === "SO-202608136") {
    const workpaperTask = templates.find((item) => item.id === "SUB-CAUSE-003");
    if (!workpaperTask) throw new BadRequestException("缺少根因核验事项模板");
    workpaperTask.title = "核验主要原因并确认结论";
    workpaperTask.purpose = "基于事实与待核验材料，由 PMC 确认根因结论";
    workpaperTask.status = "READY";
    workpaperTask.origin = "LIVE";
    workpaperTask.inputs = [
      ...workpaperTask.inputs.filter((input) => input.label !== "PMC 人工判断"),
      { label: "产能负荷与工时记录", status: "MISSING", reference: null },
    ];
    workpaperTask.process = [
      { label: "核对来源事实与有效材料", completed: false },
      { label: "区分候选建议与员工结论", completed: false },
      { label: "确认结论并完成事项", completed: false },
    ];
    workpaperTask.expectedOutput = "根因核验工作底稿确认版";
    workpaperTask.acceptance = [
      "事实证据与待核验材料已区分",
      "员工结论说明了支持或不支持理由",
      "结论边界与下一步核验已记录",
    ];
    for (const solutionTask of templates.filter(
      (item) => item.phaseCode === "SOLUTION_APPROVAL",
    ))
      solutionTask.status = "LOCKED";
  }
  return templates;
}
