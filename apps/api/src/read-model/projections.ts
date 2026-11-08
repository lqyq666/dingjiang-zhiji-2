import type { FormalExperience, TaskDetail } from "@dingjiang/contracts";
import type { QueryResultRow } from "pg";

import { sourceTaskSuffix } from "../vs01-domain";

/**
 * Row-to-contract projections, free of database access and service state.
 *
 * `formalExperienceView` and `materialSituationForInput` are shared by the
 * read model and the commands that write, so those two sides cannot drift.
 * The remaining builders are pure read-model projections: the task situation
 * catalogue, evidence records, candidate views and input requirement mapping.
 */

/** The situation a material input belongs to, inferred from its label. */
export const materialSituationForInput = (
  label: string,
): TaskDetail["situations"][number]["code"] | null => {
  if (/产能|工时/.test(label)) return "CAPACITY_RISK";
  if (/BOM|变更/.test(label)) return "BOM_DELAY";
  if (/采购|供应商|到货/.test(label)) return "PURCHASE_DELAY";
  return null;
};

/** The published formal experience, with its traceability locators. */
export const formalExperienceView = (row: QueryResultRow): FormalExperience => {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    sourceProjectId: row.source_project_id,
    sourceTaskId: row.source_task_id,
    status: row.status,
    title: row.title,
    applicableSituation: row.applicable_situation,
    businessProblem: row.business_problem,
    practice: row.practice,
    resultSummary: row.result_summary,
    limitations: row.limitations,
    publishedBy: "EXPERT_REVIEWER",
    publishedAt: new Date(row.published_at).toISOString(),
    retractedAt: row.retracted_at
      ? new Date(row.retracted_at).toISOString()
      : null,
    retractedReason: row.retracted_reason ?? null,
    locator: {
      sourceObjectId: row.source_object_id,
      sourceVersionId: row.source_version_id,
      reference: row.title,
    },
    candidateLocator: {
      sourceObjectId: row.candidate_source_object_id,
      sourceVersionId: row.candidate_source_version_id,
      reference: row.title,
    },
    evidenceLocator: {
      sourceObjectId: row.evidence_source_object_id,
      sourceVersionId: row.evidence_source_version_id,
      reference: row.result_summary,
    },
    structuredCard: row.structured_card ?? null,
    cozeIndex: {
      status: row.coze_index_status ?? "INDEX_PENDING",
      executeId: row.coze_execute_id ?? null,
      debugUrl: row.coze_debug_url ?? null,
      indexedAt: row.coze_indexed_at
        ? new Date(row.coze_indexed_at).toISOString()
        : null,
    },
  };
};

export function situations(
  row: QueryResultRow,
  materials: TaskDetail["materials"],
  sourceTaskId: string,
): TaskDetail["situations"] {
  const evidenceSuffix = sourceTaskSuffix(sourceTaskId);
  const materialFor = (
    code: TaskDetail["situations"][number]["code"],
    requirementId: string,
  ) =>
    materials.find(
      (material) =>
        material.status === "ACTIVE" &&
        material.situationCode === code &&
        material.requirementId === requirementId,
    ) ?? null;
  const bomMaterial = materialFor("BOM_DELAY", "REQ-BOM-CHANGE");
  const purchaseMaterial = materialFor(
    "PURCHASE_DELAY",
    "REQ-PURCHASE-CONFIRM",
  );
  const capacityMaterial = materialFor("CAPACITY_RISK", "REQ-CAPACITY-LOAD");
  return [
    {
      code: "BOM_DELAY",
      label: "BOM 准备滞后",
      state: Number(row.bom_delay) > 0 ? "MATCHED" : "UNVERIFIED",
      summary: `计划与实际 BOM 完成相差 ${Number(row.bom_delay)} 天。`,
      requirements: [
        {
          id: "REQ-BOM-SCHEDULE",
          label: "BOM 计划与实际完成记录",
          fulfilled: true,
          evidenceId: `E-BOM-${evidenceSuffix}`,
          materialId: null,
        },
        {
          id: "REQ-BOM-CHANGE",
          label: "BOM 差异或变更清单",
          fulfilled: Boolean(bomMaterial),
          evidenceId: null,
          materialId: bomMaterial?.id ?? null,
        },
      ],
      solutions: [
        {
          id: "SOL-BOM-CLASSIFY",
          title: "先分类",
          instruction: "按缺料、设计变更、编码错误和责任部门分类 BOM 异常。",
        },
        {
          id: "SOL-BOM-OWNER",
          title: "再定责",
          instruction: "为每类异常确认责任人、完成期限和复核人。",
        },
      ],
    },
    {
      code: "PURCHASE_DELAY",
      label: "采购启动滞后",
      state: Number(row.purchase_delay) > 0 ? "MATCHED" : "UNVERIFIED",
      summary: `采购实际启动比计划晚 ${Number(row.purchase_delay)} 天。`,
      requirements: [
        {
          id: "REQ-PURCHASE-SCHEDULE",
          label: "采购计划与实际启动记录",
          fulfilled: true,
          evidenceId: `E-PURCHASE-${evidenceSuffix}`,
          materialId: null,
        },
        {
          id: "REQ-PURCHASE-CONFIRM",
          label: "供应商到货承诺或催交记录",
          fulfilled: Boolean(purchaseMaterial),
          evidenceId: null,
          materialId: purchaseMaterial?.id ?? null,
        },
      ],
      solutions: [
        {
          id: "SOL-PURCHASE-CRITICAL",
          title: "锁定关键物料",
          instruction: "识别影响开工的关键物料，并取得供应商确认到货日期。",
        },
        {
          id: "SOL-PURCHASE-ESCALATE",
          title: "升级催交",
          instruction: "对无法满足日期的物料发起替代料或管理升级处理。",
        },
      ],
    },
    {
      code: "CAPACITY_RISK",
      label: "产能负荷风险",
      state: "UNVERIFIED",
      summary: "当前记录未提供已核验的产能负荷事实，需补充并核验材料后判断。",
      requirements: [
        {
          id: "REQ-CAPACITY-LOAD",
          label: "关键产线负荷与工时记录",
          fulfilled: Boolean(capacityMaterial),
          evidenceId: null,
          materialId: capacityMaterial?.id ?? null,
        },
      ],
      solutions: [
        {
          id: "SOL-CAPACITY-CHECK",
          title: "核对负荷",
          instruction:
            "比较订单所需工时、可用工时与排产锁定量，确认是否超出安全区间。",
        },
      ],
    },
  ];
}

export function evidence(
  id: string,
  sourceObjectId: string,
  sourceVersionId: string,
  sourceFile: string,
  sourceSheet: string,
  sourceRow: number,
  classification: "FACT",
  fields: Record<string, string>,
) {
  return {
    id,
    sourceObjectId,
    sourceVersionId,
    sourceFile,
    sourceSheet,
    sourceRow,
    fields,
    classification,
  };
}

export function candidateView(row: QueryResultRow) {
  return {
    id: row.candidate_id ?? row.id,
    title: row.title,
    applicableSituation: row.applicable_situation,
    businessProblem: row.business_problem,
    practice: row.practice,
    resultSummary: row.result_summary,
    evidenceReference: row.evidence_reference,
    limitations: row.limitations,
    status: row.status,
    revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString(),
    submittedAt: new Date(
      row.candidate_submitted_at ?? row.created_at,
    ).toISOString(),
    returnedReason: row.returned_reason ?? null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at
      ? new Date(row.reviewed_at).toISOString()
      : null,
    formalExperienceId: row.formal_experience_id ?? null,
    candidateLocator: {
      sourceObjectId: row.candidate_source_object_id,
      sourceVersionId: row.candidate_source_version_id,
      reference: row.title,
    },
    evidenceLocator: {
      sourceObjectId: row.evidence_source_object_id ?? row.source_object_id,
      sourceVersionId: row.evidence_source_version_id ?? row.source_version_id,
      reference: row.evidence_reference,
    },
    structuredCard: row.structured_card ?? null,
    feishuSync: {
      recordId: row.feishu_record_id ?? null,
      revision: row.feishu_synced_revision
        ? Number(row.feishu_synced_revision)
        : null,
      status: row.feishu_sync_status ?? null,
      syncedAt: row.feishu_synced_at
        ? new Date(row.feishu_synced_at).toISOString()
        : null,
    },
  };
}

export function requirementForInput(label: string): string | null {
  if (/产能|工时/.test(label)) return "REQ-CAPACITY-LOAD";
  if (/BOM|变更/.test(label)) return "REQ-BOM-CHANGE";
  if (/采购|供应商|到货/.test(label)) return "REQ-PURCHASE-CONFIRM";
  return null;
}
