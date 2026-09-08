import { createHash } from "node:crypto";
/** This module has no framework dependency and is shared by the trusted human
 * console and command execution. Authorization is not supplied by the model. */
export type ApprovalEnvelope = {
  name: string;
  principal: {
    tenantId: string;
    subjectId: string;
    role: string;
    credentialId?: string;
    scopes: string[];
    projectIds: string[];
  };
  target: { tenantId: string; projectId: string };
  request: {
    requestId: string;
    expectedVersion: number;
    reason: string;
    payload: Record<string, unknown>;
    correlationId: string;
  };
};
/** Strict deterministic JSON; reject values JSON.stringify silently loses. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("Payload nesting exceeds 64");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new Error("Sparse/extended arrays are not JSON");
    return `[${value.map((child) => canonicalJson(child, depth + 1)).join(",")}]`;
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Non-JSON value");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("Symbol keys are not JSON");
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`,
    )
    .join(",")}}`;
}
export function approvalDigest(envelope: ApprovalEnvelope): string {
  // Includes request ID and exact reason/payload/version; transport correlation
  // may change on retry without invalidating a person's business authorization.
  return createHash("sha256")
    .update(
      canonicalJson({
        name: envelope.name,
        target: envelope.target,
        subject: {
          tenantId: envelope.principal.tenantId,
          subjectId: envelope.principal.subjectId,
          role: envelope.principal.role,
          credentialId: envelope.principal.credentialId ?? null,
        },
        request: {
          requestId: envelope.request.requestId,
          expectedVersion: envelope.request.expectedVersion,
          reason: envelope.request.reason,
          payload: envelope.request.payload,
        },
      }),
    )
    .digest("hex");
}
/** Explicit small low-risk allowlist. All unknown mutations fail closed. */
export function requiresHumanApproval(
  name: string,
  payload: Record<string, unknown>,
): boolean {
  if (
    ["workpaper.propose", "evidence.propose", "material.create"].includes(name)
  )
    return false;
  if (name === "work.execute") {
    const op = payload.operation;
    return !(
      op &&
      typeof op === "object" &&
      !Array.isArray(op) &&
      (op as Record<string, unknown>).action === "progress.record"
    );
  }
  return true;
}
export function commandAuthorization(
  name: string,
  payload: Record<string, unknown>,
): { scope: string; role: string } | null {
  const plain: Record<string, { scope: string; role: string }> = {
    "workpaper.propose": { scope: "workpaper:write", role: "PMC" },
    "material.create": { scope: "material:write", role: "PMC" },
    "material.verify": { scope: "material:verify", role: "PMC" },
    "evidence.propose": { scope: "evidence:write", role: "PMC" },
    "evidence.confirm": { scope: "evidence:confirm", role: "PMC" },
  };
  if (name !== "work.execute")
    return Object.hasOwn(plain, name) ? plain[name]! : null;
  const op = payload.operation;
  if (!op || typeof op !== "object" || Array.isArray(op)) return null;
  const action = (op as Record<string, unknown>).action;
  if (["project.approve", "project.return"].includes(String(action)))
    return { scope: "project:approve", role: "OWNER" };
  if (["experience.publish", "experience.return"].includes(String(action)))
    return { scope: "experience:publish", role: "EXPERT_REVIEWER" };
  if (
    [
      "event.start",
      "progress.record",
      "workitem.complete",
      "workitem.reopen",
      "project.submit",
      "outcome.record",
      "outcome.reopen",
      "experience.submit",
      "experience.resubmit",
      "experience.withdraw",
      "workpaper.confirm",
      "workpaper.reopen",
    ].includes(String(action))
  )
    return { scope: "workitem:write", role: "PMC" };
  return null;
}
export function principalStillAuthorized(
  envelope: ApprovalEnvelope,
  current: Record<string, unknown> | undefined,
): boolean {
  const expected = commandAuthorization(
    envelope.name,
    envelope.request.payload,
  );
  return Boolean(
    expected &&
    current &&
    current.role === envelope.principal.role &&
    current.role === expected.role &&
    Array.isArray(current.scopes) &&
    current.scopes.includes(expected.scope) &&
    Array.isArray(current.project_ids) &&
    current.project_ids.includes(envelope.target.projectId) &&
    envelope.principal.tenantId === envelope.target.tenantId,
  );
}
