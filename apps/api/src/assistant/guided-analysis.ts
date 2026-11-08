import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";

import type {
  GuidedAnalysisWorkflow,
  Project,
  ProjectAssistantResponse,
  TaskDetail,
} from "@dingjiang/contracts";
import { isProduction } from "../runtime-config";

export function currentWorkStage(project: Project): Project["phases"][number] {
  if (isProduction() && project.status === "DRAFT") {
    const open = project.phases.find((phase) => phase.gate.status === "OPEN");
    if (!open)
      throw new BadRequestException("项目没有已解锁阶段，请检查阶段状态");
    return open;
  }
  const rootCause = project.phases.find(
    (phase) => phase.code === "ROOT_CAUSE_VALIDATION",
  );
  if (
    project.sourceTaskId === "SO-202608136" &&
    rootCause?.gate.status === "OPEN"
  )
    return rootCause;
  const codeByStatus: Record<string, Project["phases"][number]["code"]> = {
    DRAFT: "SOLUTION_APPROVAL",
    PENDING_APPROVAL: "SOLUTION_APPROVAL",
    RETURNED: "SOLUTION_APPROVAL",
    RUNNING: "EXECUTION_CONTROL",
    RESULT_VALIDATION: "RESULT_ACCEPTANCE",
    PENDING_RESULT_ACCEPTANCE: "RESULT_ACCEPTANCE",
    KNOWLEDGE_CAPTURE: "KNOWLEDGE_CAPTURE",
    COMPLETED: "KNOWLEDGE_CAPTURE",
  };
  const code = codeByStatus[project.status] ?? "PROJECT_SCOPING";
  const stage = project.phases.find((phase) => phase.code === code);
  if (!stage) throw new BadRequestException("咨询任务缺少当前工作步骤");
  return stage;
}

export function assistantContextFingerprint(
  project: Project,
  stageCode: Project["phases"][number]["code"],
): string {
  const stage = project.phases.find((item) => item.code === stageCode);
  const snapshot = {
    projectId: project.id,
    projectStatus: project.status,
    stageCode,
    stageStatus: stage?.status,
    stageProgress: stage?.progress,
    tasks: stage?.tasks.map((item) => ({
      id: item.id,
      status: item.status,
      inputs: item.inputs.map((input) => [input.label, input.status]),
      output: item.output.locator?.sourceVersionId ?? null,
    })),
    outcome: [project.outcome.status, project.outcome.current],
    experience: project.experienceCandidate?.status ?? null,
    activityCount: project.auditTrail.length,
  };
  return `CTX-${createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex")
    .slice(0, 20)}`;
}

export function guidedAnalysisClarifications(
  stage: Project["phases"][number],
  answers: Map<string, string>,
): GuidedAnalysisWorkflow["clarifications"] {
  const materialGaps = stage.tasks.flatMap((workItem) =>
    workItem.inputs
      .filter((input) => input.status !== "AVAILABLE")
      .map((input) => ({ workItem: workItem.title, input })),
  );
  const questions: GuidedAnalysisWorkflow["clarifications"] = materialGaps
    .slice(0, 2)
    .map((gap, index) => {
      const id = `CLARIFY-MATERIAL-${index + 1}`;
      return {
        id,
        question: `“${gap.workItem}”所需的“${gap.input.label}”当前采用什么替代依据，还是要先补齐后再分析？`,
        reason:
          gap.input.status === "MISSING"
            ? "该输入当前标记为缺失，直接分析可能遗漏关键事实"
            : "该输入当前待核验，需要员工明确可信版本或风险边界",
        required: true,
        answer: answers.get(id) ?? null,
      };
    });
  if (questions.length < 3) {
    const id = "CLARIFY-FOCUS";
    questions.push({
      id,
      question: `这次分析“${stage.name}”最希望 AI 优先检查什么？`,
      reason: "限定分析重点，避免把完整项目上下文变成泛泛建议",
      required: false,
      answer: answers.get(id) ?? null,
    });
  }
  return questions;
}

export function guidedAnalysisPlan({
  stage,
  evidenceReferences,
  materialGaps,
  nextAction,
  completed,
}: {
  stage: Project["phases"][number];
  evidenceReferences: string[];
  materialGaps: string[];
  nextAction: string;
  completed: boolean;
}): GuidedAnalysisWorkflow["plan"] {
  const status = completed ? ("COMPLETED" as const) : ("PLANNED" as const);
  const stageItemTitles = stage.tasks.map((item) => item.title);
  const completedTitles = stage.tasks
    .filter((item) => item.status === "DONE")
    .map((item) => item.title);
  const unfinishedTitles = stage.tasks
    .filter((item) => item.status !== "DONE")
    .map((item) => item.title);
  return [
    {
      id: "WORK-CONTEXT",
      title: "核对节点事实与责任状态",
      objective: "确认当前节点真正完成了什么、还由谁负责什么",
      inputs: stageItemTitles.length ? stageItemTitles : [stage.name],
      output: "节点完成事实与待办边界",
      dependsOn: [],
      executionMode: "PARALLEL",
      status,
      finding: completed
        ? `已完成 ${completedTitles.length}/${stage.totalTaskCount} 项；待完成 ${unfinishedTitles.length} 项。`
        : null,
      evidenceReferences: [],
      completionCheck: "事项状态、责任角色和系统进度相互一致",
    },
    {
      id: "WORK-EVIDENCE",
      title: "核对证据与输出定位",
      objective: "区分已记录事实、缺失依据和候选判断",
      inputs: evidenceReferences.length
        ? [`已授权的 ${evidenceReferences.length} 个版本化证据来源`]
        : ["当前节点尚无版本化证据"],
      output: "可追溯证据与未证实判断清单",
      dependsOn: [],
      executionMode: "PARALLEL",
      status,
      finding: completed
        ? `当前授权上下文可定位 ${evidenceReferences.length} 个证据版本；没有定位的内容仍按候选判断处理。`
        : null,
      evidenceReferences,
      completionCheck: "每个事实结论都能指向版本化依据或明确标为待核验",
    },
    {
      id: "WORK-GAPS",
      title: "检查材料缺口与推进风险",
      objective: "识别会让建议失真的输入缺口和下游风险",
      inputs: materialGaps.length ? materialGaps : ["当前节点材料状态"],
      output: "材料缺口、影响和处理优先级",
      dependsOn: [],
      executionMode: "PARALLEL",
      status,
      finding: completed
        ? materialGaps.length
          ? `仍有 ${materialGaps.length} 项材料缺失或待核验：${materialGaps.join("、")}。`
          : "当前节点没有未标明的材料缺口。"
        : null,
      evidenceReferences: [],
      completionCheck: "每个缺口都说明对结论和下一步的影响",
    },
    {
      id: "WORK-SYNTHESIS",
      title: "综合形成下一步建议",
      objective: "把事实、证据和缺口合成为员工可判断的候选行动",
      inputs: ["节点完成事实", "证据边界", "材料缺口"],
      output: "带责任人和完成标准的下一步候选建议",
      dependsOn: ["WORK-CONTEXT", "WORK-EVIDENCE", "WORK-GAPS"],
      executionMode: "SEQUENTIAL",
      status,
      finding: completed ? `候选下一步：${nextAction}。` : null,
      evidenceReferences,
      completionCheck: "建议不越过责任员工确认和两道人工审批关口",
    },
  ];
}

export function guidedAnalysisVerification({
  evidenceCount,
  materialGapCount,
}: {
  evidenceCount: number;
  materialGapCount: number;
}): GuidedAnalysisWorkflow["verification"] {
  return [
    {
      id: "CHECK-CONTEXT",
      label: "已读取所选节点和完整项目上下文",
      status: "PASS",
      detail: "分析同时使用七步状态、事项、材料、结果、经验和操作记录",
    },
    {
      id: "CHECK-EVIDENCE",
      label: "事实与候选判断已分开",
      status: evidenceCount > 0 ? "PASS" : "WARNING",
      detail:
        evidenceCount > 0
          ? `当前上下文包含 ${evidenceCount} 个版本化证据定位`
          : "当前上下文没有版本化证据，建议不能作为事实使用",
    },
    {
      id: "CHECK-MATERIALS",
      label: "材料缺口已显式标明",
      status: materialGapCount === 0 ? "PASS" : "WARNING",
      detail:
        materialGapCount === 0
          ? "当前节点没有未标明的材料缺口"
          : `仍有 ${materialGapCount} 项材料缺失或待核验，需由责任员工判断`,
    },
    {
      id: "CHECK-NO-WRITE",
      label: "业务状态未被 AI 改写",
      status: "PASS",
      detail: "本次只返回 PROPOSAL；事项完成、阶段推进和审批仍由对应人员操作",
    },
  ];
}

export function nextConsultingAction(
  project: Project,
  currentStage: Project["phases"][number],
): string {
  if (project.status === "PENDING_APPROVAL")
    return "等待企业负责人确认解决方案";
  if (project.status === "PENDING_RESULT_ACCEPTANCE")
    return "返回结果步骤，由责任员工重新确认实际结果";
  if (project.status === "COMPLETED")
    return "咨询任务已完成，可查看结果和正式经验";
  if (project.experienceCandidate?.status === "PENDING_REVIEW")
    return "等待资深专家审核候选经验";
  if (project.experienceCandidate?.status === "RETURNED")
    return "根据专家退回原因修订候选经验";
  const nextItem = currentStage.tasks.find(
    (item) =>
      item.owner === "PMC" && ["READY", "RETURNED"].includes(item.status),
  );
  if (nextItem) return `完成“${nextItem.title}”`;
  if (
    currentStage.code === "SOLUTION_APPROVAL" &&
    currentStage.tasks
      .filter((item) => item.owner === "PMC")
      .every((item) => item.status === "DONE")
  )
    return "复核解决方案并提交负责人确认";
  if (
    currentStage.code === "RESULT_ACCEPTANCE" &&
    currentStage.tasks.every((item) => item.status === "DONE")
  )
    return "复核同口径结果并确认实际结果";
  if (
    currentStage.code === "KNOWLEDGE_CAPTURE" &&
    currentStage.tasks.every((item) => item.status === "DONE")
  )
    return "复核 AI 整理的候选经验并提交";
  return `查看“${currentStage.name}”的完成情况`;
}

export function experienceDraft(
  project: Project,
  sourceTask: TaskDetail,
): ProjectAssistantResponse["experienceDraft"] {
  const knowledge = project.phases.find(
    (phase) => phase.code === "KNOWLEDGE_CAPTURE",
  );
  if (
    project.outcome.status !== "ACCEPTED" ||
    !knowledge?.tasks.every((item) => item.status === "DONE") ||
    !project.outcome.evidenceReference
  )
    return null;
  const completedOutputs = project.phases
    .filter((phase) =>
      ["SOLUTION_APPROVAL", "EXECUTION_CONTROL"].includes(phase.code),
    )
    .flatMap((phase) => phase.tasks)
    .filter((item) => item.owner === "PMC" && item.status === "DONE")
    .map((item) => item.title);
  const gapNames = project.phases
    .flatMap((phase) => phase.tasks)
    .flatMap((item) => item.inputs)
    .filter((item) => item.status !== "AVAILABLE")
    .map((item) => item.label);
  return {
    title: "BOM 准备滞后订单的交付恢复做法",
    applicableSituation:
      "适用于订单已承诺交期、BOM 准备出现明确滞后，且需要跨 BOM、采购与交付协调的场景。",
    businessProblem: `${sourceTask.order.orderId} 预计延期 ${sourceTask.order.delayDays} 天，OTD 基线 ${project.outcome.baseline}% 低于目标 ${project.outcome.target}%。`,
    practice: completedOutputs.length
      ? `依次完成：${completedOutputs.join("；")}。每项都保留完成说明和版本化输出定位。`
      : "核清延期事实，验证主要原因，明确解决措施、责任人与验收依据。",
    resultSummary: `按同一口径复核，OTD 从 ${project.outcome.baseline}% 变为 ${project.outcome.current}%，目标为 ${project.outcome.target}%；结果已经事项责任员工确认。`,
    limitations: gapNames.length
      ? `仍有“${[...new Set(gapNames)].join("、")}”缺失或待核验；仅作为候选经验，须经专家审核后复用。`
      : "仅适用于证据口径和组织条件相近的订单；须经专家审核后复用。",
    evidenceReference: project.outcome.evidenceReference,
  };
}

export function answerConsultingQuestion(
  question: string,
  progressSummary: string,
  gapSummary: string,
  nextAction: string,
  hasExperienceDraft: boolean,
): string {
  if (/进度|做到哪|完成/.test(question))
    return `${progressSummary} 下一步建议：${nextAction}。`;
  if (/材料|缺少|缺什么|证据/.test(question)) return gapSummary;
  if (/经验|总结|复用/.test(question))
    return hasExperienceDraft
      ? "候选经验草稿已经具备生成条件，我会复用员工已确认结果的证据定位；请人工复核适用情境和限制。"
      : "候选经验要等结果签收且总结事项全部完成后生成，避免把未验证做法当成经验。";
  if (/下一步|现在做什么|怎么推进/.test(question))
    return `下一步建议：${nextAction}。`;
  return `结合完整工作上下文，我建议先${nextAction}。${gapSummary} 这是候选建议，不会替你保存判断或推进状态。`;
}
