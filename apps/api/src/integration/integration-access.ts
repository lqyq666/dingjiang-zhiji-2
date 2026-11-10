import { ForbiddenException } from "@nestjs/common";
import type {
  IntegrationPrincipal,
  IntegrationScope,
} from "@dingjiang/contracts";
import { runtimeTenantId } from "../runtime-config";

export const requireIntegrationTenant = (tenantId: string): void => {
  if (tenantId !== runtimeTenantId())
    throw new ForbiddenException("当前 tenant 不在本地 Integration API 范围内");
};

export const hasScope = (
  principal: IntegrationPrincipal,
  scope: IntegrationScope,
) => principal.scopes.includes(scope);

export const workpaperReadScopes = [
  "workpaper:read",
  "evidence:read",
  "material:read",
] as const;

/** The wildcard grants project reads. Governed writes check explicit project IDs. */
export const hasProjectAccess = (
  principal: IntegrationPrincipal,
  projectId: string,
): boolean =>
  principal.projectIds.includes("*") ||
  principal.projectIds.includes(projectId);
