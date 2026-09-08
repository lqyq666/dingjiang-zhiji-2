/** Production initialization is deliberately different from the historical demo.
 * Importing a source proves only that the source exists, never that a person
 * finished scoping, checked its accuracy, or approved a cause/solution.
 */
export const productionPhaseOrder = [
  "PROJECT_SCOPING",
  "BASELINE_FACTS",
  "ROOT_CAUSE_VALIDATION",
  "SOLUTION_APPROVAL",
  "EXECUTION_CONTROL",
  "RESULT_ACCEPTANCE",
  "KNOWLEDGE_CAPTURE",
] as const;
export type ProductionPhase = (typeof productionPhaseOrder)[number];
export type LifecycleTemplate = {
  id: string;
  phaseCode: ProductionPhase;
  title: string;
  purpose: string;
  status: string;
  origin: "LIVE" | "HISTORICAL";
  sortOrder: number;
  owner: "PMC" | "OWNER";
  outputReference: string;
  inputs: {
    label: string;
    status: "AVAILABLE" | "MISSING" | "UNVERIFIED";
    reference: string | null;
  }[];
  process: { label: string; completed: boolean }[];
  expectedOutput: string;
  acceptance: string[];
};
export function initialProductionGate(index: number): "OPEN" | "LOCKED" {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= productionPhaseOrder.length
  )
    throw new Error("Unknown production phase");
  return index === 0 ? "OPEN" : "LOCKED";
}
export function initializeProductionTemplates(
  templates: readonly LifecycleTemplate[],
): LifecycleTemplate[] {
  return templates.map((original) => {
    const item: LifecycleTemplate = {
      ...original,
      status:
        original.phaseCode === "PROJECT_SCOPING" && original.owner === "PMC"
          ? "READY"
          : "LOCKED",
      origin: "LIVE",
      outputReference: "",
      process: original.process.map(({ label }) => ({
        label,
        completed: false,
      })),
      inputs: original.inputs
        .filter((input) => input.label !== "PMC 人工判断")
        .map((input) => ({
          ...input,
          label:
            input.label === "项目历史事实快照"
              ? "项目来源快照（未人工核验）"
              : input.label,
          status: input.status === "MISSING" ? "MISSING" : "UNVERIFIED",
        })),
      acceptance: [...original.acceptance],
    };
    // Historical wording must not imply that a cause or output already exists.
    if (item.id === "SUB-SCOPE-003") {
      item.title = "形成项目立项记录";
      item.expectedOutput = "项目问题、目标、责任及来源记录";
      item.process = ["核对来源版本和问题范围", "记录本次人工确认及限制"].map(
        (label) => ({ label, completed: false }),
      );
    }
    if (item.id === "SUB-CAUSE-003") {
      item.title = "核验主要原因并确认结论";
      item.purpose = "依据材料核验候选原因，不把 AI 建议当结论";
      item.process = [
        "核对来源事实与有效材料",
        "说明支持、矛盾与未知项",
        "人工确认结论和适用边界",
      ].map((label) => ({ label, completed: false }));
      item.expectedOutput = "根因核验工作底稿确认版";
      item.acceptance = [
        "事实证据与待核验材料已区分",
        "员工结论说明了支持或不支持理由",
        "结论边界与下一步核验已记录",
      ];
    }
    if (item.id === "SUB-SOLUTION-001") {
      item.title = "形成问题解决方案";
      item.purpose = "依据已确认结论比较可执行方案";
      item.process = [
        "提出两个以上候选方案",
        "比较预期影响、成本与风险",
        "说明取舍和待核验边界",
      ].map((label) => ({ label, completed: false }));
    }
    return item;
  });
}
/** Only these early phases auto-unlock after *all* their human-confirmed tasks.
 * Root cause, solution approval and result acceptance keep their existing gates.
 */
export function nextEarlyPhase(
  phase: string,
  total: number,
  confirmed: number,
): ProductionPhase | null {
  if (
    !Number.isInteger(total) ||
    !Number.isInteger(confirmed) ||
    total < 1 ||
    confirmed !== total
  )
    return null;
  if (phase === "PROJECT_SCOPING") return "BASELINE_FACTS";
  if (phase === "BASELINE_FACTS") return "ROOT_CAUSE_VALIDATION";
  return null;
}
export function productionReservationId(sourceTaskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,100}$/.test(sourceTaskId))
    throw new Error("Invalid source task ID");
  return `PRJ-${sourceTaskId}`;
}
export function sourceTaskFromReservation(projectId: string): string | null {
  if (!projectId.startsWith("PRJ-")) return null;
  const source = projectId.slice(4);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,100}$/.test(source) ? source : null;
}
