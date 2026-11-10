import { ForbiddenException } from "@nestjs/common";
import type { IntegrationPrincipal } from "@dingjiang/contracts";
import { runtimeTenantId } from "../runtime-config";

export const requireIntegrationTenant = (tenantId: string): void => {
  if (tenantId !== runtimeTenantId())
    throw new ForbiddenException("当前 tenant 不在本地 Integration API 范围内");
};

/** The wildcard grants project reads. Governed writes check explicit project IDs. */
export const hasProjectAccess = (
  principal: IntegrationPrincipal,
  projectId: string,
): boolean =>
  principal.projectIds.includes("*") ||
  principal.projectIds.includes(projectId);
