import { runtimeTenantId } from "../runtime-config";
import { ForbiddenException } from "@nestjs/common";

import type { AssistantRole, AssistantScope } from "./contracts";

const allowedRoles = new Set<AssistantRole>([
  "PMC",
  "OWNER",
  "EXPERT_REVIEWER",
]);

export const assistantScopeFromRequest = (
  projectId: string,
  role: string | undefined,
): AssistantScope => {
  if (!allowedRoles.has(role as AssistantRole))
    throw new ForbiddenException("当前角色无权使用岗位助手");
  return {
    tenantId: runtimeTenantId(),
    subjectId: `demo-${(role as AssistantRole).toLowerCase()}`,
    role: role as AssistantRole,
    projectId,
    sourceTaskId: null,
    policyVersion: "VS12-1",
  };
};

/** Model-controlled scope fields are rejected instead of being silently ignored. */
export const rejectModelScopeArguments = (input: unknown): void => {
  if (!input || typeof input !== "object") return;
  const prohibited = [
    "tenantId",
    "tenant_id",
    "projectId",
    "project_id",
    "role",
    "subjectId",
    "userId",
  ];
  if (prohibited.some((key) => key in input))
    throw new ForbiddenException("助手工具不接受模型提供的权限范围");
};
