/**
 * The seven stages of a consulting engagement, with the purpose each one has.
 *
 * Both the read model and the project state machine need these names, so they
 * live in their own module rather than on either side.
 */
export const workStageNames = {
  PROJECT_SCOPING: "明确要解决的问题",
  BASELINE_FACTS: "核清事实",
  ROOT_CAUSE_VALIDATION: "找到主要原因",
  SOLUTION_APPROVAL: "定下解决方案",
  EXECUTION_CONTROL: "落实解决措施",
  RESULT_ACCEPTANCE: "确认实际结果",
  KNOWLEDGE_CAPTURE: "总结可复用做法",
} as const;
export const workStagePurposes = {
  PROJECT_SCOPING: "说清要解决什么、影响谁、目标是什么",
  BASELINE_FACTS: "统一数据口径，核对事实和材料质量",
  ROOT_CAUSE_VALIDATION: "用证据验证候选原因，不把推断当事实",
  SOLUTION_APPROVAL: "比较解决办法，明确责任和验收方式",
  EXECUTION_CONTROL: "按可验证事项落实解决措施",
  RESULT_ACCEPTANCE: "按同一口径确认实际经营结果",
  KNOWLEDGE_CAPTURE: "把经过验证的做法整理为有边界的候选经验",
} as const;
