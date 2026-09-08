export type FeishuFieldKind = "text" | "number" | "select" | "datetime";

export type FeishuLogicalResource =
  "experience_candidate_review" | "owner_decision" | "knowledge_quality";

export type FieldManifest = {
  key: string;
  name: string;
  kind: FeishuFieldKind;
  options?: readonly string[];
};

export type TableManifest = {
  logicalResource: FeishuLogicalResource;
  name: string;
  existingTableIdEnv?: "FEISHU_REVIEW_TABLE_ID";
  minimumRecordCount?: number;
  fields: readonly FieldManifest[];
  views: readonly string[];
};

const text = (name: string, key = name): FieldManifest => ({
  key,
  name,
  kind: "text",
});
const number = (name: string, key = name): FieldManifest => ({
  key,
  name,
  kind: "number",
});
const datetime = (name: string, key = name): FieldManifest => ({
  key,
  name,
  kind: "datetime",
});
const select = (
  name: string,
  options: readonly string[],
  key = name,
): FieldManifest => ({
  key,
  name,
  kind: "select",
  options,
});

export const feishuSchemaManifest: readonly TableManifest[] = [
  {
    logicalResource: "experience_candidate_review",
    name: "VS17 经验审核",
    existingTableIdEnv: "FEISHU_REVIEW_TABLE_ID",
    minimumRecordCount: 3,
    fields: [
      text("候选ID"),
      text("候选版本", "候选版本ID"),
      text("项目ID"),
      text("来源WorkItemID"),
      text("标题"),
      text("适用情境"),
      text("经营问题", "业务问题"),
      text("采取做法", "实践方法"),
      text("结果摘要"),
      text("限制", "限制条件"),
      text("触发条件", "Trigger"),
      text("判断条件", "Conditions"),
      text("推荐动作", "Actions"),
      text("原因", "Rationale"),
      text("例外", "Exceptions"),
      text("Scope"),
      text("EvidenceRefs"),
      text("MissingInformation"),
      select("审核结果", ["待审核", "批准", "退回"], "审核状态"),
      text("审核意见"),
      text("审核人"),
      datetime("审核时间"),
      number("ExpectedVersion"),
      select("同步状态", ["SYNCED", "PENDING", "CONFLICT", "FAILED"]),
      datetime("最后同步时间"),
      text("CozeExecuteId"),
      text("鼎江智绩链接"),
    ],
    views: ["待审核", "已退回", "本周已审核", "同步异常"],
  },
  {
    logicalResource: "owner_decision",
    name: "负责人决策台",
    fields: [
      text("审批请求ID"),
      text("ProposalID"),
      text("项目ID"),
      text("阶段"),
      text("事项标题"),
      text("事项目的"),
      text("决策依据"),
      select("类型", ["MONEY", "DIRECTION"]),
      number("金额"),
      text("币种"),
      text("EvidenceRefs"),
      text("申请人"),
      datetime("申请时间"),
      select("状态", ["PENDING", "APPROVED", "CHANGES_REQUESTED", "REJECTED"]),
      text("Owner意见"),
      text("决定人"),
      datetime("决定时间"),
      number("ExpectedVersion"),
      select("同步状态", ["SYNCED", "PENDING", "CONFLICT", "FAILED"]),
      datetime("最后同步时间"),
    ],
    views: ["待决策", "金钱决策", "方向决策", "已处理", "同步异常"],
  },
  {
    logicalResource: "knowledge_quality",
    name: "知识质量运营台",
    fields: [
      text("QualityCaseID"),
      text("TenantID"),
      text("项目ID"),
      text("问题"),
      text("AI回答摘要"),
      select("失败类型", [
        "KNOWLEDGE_MISSING",
        "KNOWLEDGE_BAD",
        "RETRIEVAL_MISS",
        "RETRIEVAL_NOISE",
        "APPLICABILITY_ERROR",
        "FACT_ERROR",
        "GENERATION_ERROR",
        "CITATION_ERROR",
        "ABSTENTION_ERROR",
        "SECURITY_ERROR",
      ]),
      text("ExpectedSources"),
      text("ActualSources"),
      text("RelatedExperienceID"),
      select("严重度", ["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      number("出现次数"),
      text("Owner"),
      select("状态", ["OPEN", "IN_PROGRESS", "RESOLVED", "WONT_FIX"]),
      text("处理意见"),
      datetime("创建时间"),
      datetime("解决时间"),
    ],
    views: [
      "待处理",
      "高严重度",
      "Knowledge Gap",
      "Retrieval Miss",
      "Applicability Error",
      "已解决",
    ],
  },
] as const;

export const feishuPermissionManifest = {
  status: "NEED_HUMAN_FEISHU_PERMISSION",
  reason:
    "FEISHU_APPROVER_OPEN_ID and organization role membership are not configured.",
  roles: {
    PMC: {
      review: "related records read-only; review fields denied",
      approval: "related records read-only; decision fields denied",
      quality: "create and read related cases; high-risk close denied",
    },
    OWNER: {
      review: "read-only",
      approval: "状态 and Owner意见 editable",
      quality: "read-only",
    },
    EXPERT_REVIEWER: {
      review: "审核结果 and 审核意见 editable",
      approval: "decision fields denied",
      quality: "knowledge governance fields editable",
    },
  },
} as const;
