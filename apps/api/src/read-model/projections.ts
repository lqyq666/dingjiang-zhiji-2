import type { FormalExperience, TaskDetail } from "@dingjiang/contracts";
import type { QueryResultRow } from "pg";

/**
 * Projections the read model and the commands that write both need.
 *
 * A retracted experience and an experience list must render the same formal
 * experience, and an assistant's material view and a task's material view
 * must resolve the same situation. One implementation, imported by both
 * sides, so the two cannot drift apart.
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
