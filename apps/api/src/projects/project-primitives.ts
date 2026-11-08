import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";

import type { Project } from "@dingjiang/contracts";
import { projectActionInputSchema } from "@dingjiang/contracts";
import { runtimeTenantId } from "../runtime-config";

const tenantId = runtimeTenantId();

/**
 * The identifiers and write primitives that the project state machine and the
 * experience commands share.
 *
 * Appending a project event and locking a project node are not one side's
 * business: a candidate experience cites the project it came from, and a
 * project transition writes to the same timeline. One implementation,
 * imported by both, so the event shape cannot drift between them.
 */

/** The demonstration project every seeded workspace starts from. */
export const legacyProjectId = "PRJ-OTD-001";
export const legacyNodeId = "NODE-BOM-001";

/** Append one entry to a project's timeline. */
export const appendProjectEvent = async (
  client: PoolClient,
  id: string,
  eventType: string,
  actor: "PMC" | "OWNER" | "EXPERT_REVIEWER",
  note: string,
  snapshot: Record<string, unknown>,
  phaseCode: Project["phases"][number]["code"] = "KNOWLEDGE_CAPTURE",
): Promise<void> => {
  await client.query(
    "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    [tenantId, id, eventType, phaseCode, note, actor, JSON.stringify(snapshot)],
  );
};

/** Lock and return the node of a project. */
export const projectNodeId = async (
  client: PoolClient,
  id: string,
): Promise<string> => {
  const result = await client.query(
    "SELECT id FROM vs01_project_nodes WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE",
    [id, tenantId],
  );
  if (result.rowCount !== 1) throw new NotFoundException("项目节点不存在");
  return String(result.rows[0]?.id);
};

/** Reject an action whose actor does not match the required role. */
export const assertProjectAction = (
  input: unknown,
  actor: "PMC" | "OWNER",
): void => {
  const parsed = projectActionInputSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException("无效的操作请求");
  if (parsed.data.actor !== actor)
    throw new ForbiddenException("当前角色无权执行此操作");
};
