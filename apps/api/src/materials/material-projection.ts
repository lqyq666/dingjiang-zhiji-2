import type { TaskMaterial } from "@dingjiang/contracts";
import type { QueryResultRow } from "pg";

/**
 * Project a material row into the contract shape.
 *
 * Shared by the read model (a task lists the materials attached to it) and the
 * material commands (a mutation returns the material it just changed), so the
 * two views cannot drift apart.
 */
export const materialProjection = (material: QueryResultRow): TaskMaterial => {
  const uploaded = material.kind === "UPLOADED_FILE";
  return {
    id: String(material.id),
    situationCode: material.situation_code,
    requirementId: material.requirement_id ?? null,
    title: material.title,
    sourceReference: material.source_reference,
    note: material.note,
    kind: uploaded ? "UPLOADED_FILE" : "MANUAL_REFERENCE",
    status: material.status ?? "ACTIVE",
    locator:
      material.source_object_id && material.source_version_id
        ? {
            sourceObjectId: String(material.source_object_id),
            sourceVersionId: String(material.source_version_id),
            reference: `${String(material.title)} · v1`,
          }
        : null,
    file: uploaded
      ? {
          originalName: String(material.original_name),
          mediaType: String(material.media_type),
          byteSize: Number(material.byte_size),
          sha256: String(material.sha256),
          extractionStatus: material.extraction_status,
          contentPreview: material.content_preview ?? null,
          readableByAi: Boolean(material.readable_by_ai),
        }
      : null,
    withdrawnAt: material.withdrawn_at
      ? new Date(material.withdrawn_at).toISOString()
      : null,
    withdrawnReason: material.withdrawn_reason ?? null,
    createdBy: "PMC",
    createdAt: new Date(material.created_at).toISOString(),
    verification: {
      status: material.verification_status ?? "UNVERIFIED",
      version: Number(material.verification_version ?? 0),
      note: material.verification_note ?? "",
      verifiedBy: material.verified_by ?? null,
      verifiedAt: material.verified_at
        ? new Date(material.verified_at).toISOString()
        : null,
    },
    verificationEligible: Boolean(material.verification_eligible),
  };
};

/** A material requirement only applies to the situation it was defined for. */
export const requirementFor = (
  situationCode: TaskMaterial["situationCode"],
  requirementId: string,
): boolean =>
  (situationCode === "BOM_DELAY" && requirementId === "REQ-BOM-CHANGE") ||
  (situationCode === "PURCHASE_DELAY" &&
    requirementId === "REQ-PURCHASE-CONFIRM") ||
  (situationCode === "CAPACITY_RISK" && requirementId === "REQ-CAPACITY-LOAD");
