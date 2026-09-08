export type WorkspaceNavKey =
  | "home"
  | "diagnosis"
  | "risks"
  | "projects"
  | "data"
  | "dataSources"
  | "approval"
  | "experiences"
  | "expert"
  | "organization"
  | "settings"
  | "audit";

export type WorkspaceRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";

export const ownerProjectHref = (projectId: string): string =>
  `/boss/projects/${encodeURIComponent(projectId)}`;

export const ownerApprovalHref = (projectId: string): string =>
  `/boss/approvals/${encodeURIComponent(projectId)}`;

export const workspaceHrefFor = (
  key: WorkspaceNavKey,
  role: WorkspaceRole,
  projectId?: string | null,
): string | null => {
  void projectId;
  if (key === "home")
    return role === "OWNER"
      ? "/boss"
      : role === "EXPERT_REVIEWER"
        ? "/expert"
        : "/employee";
  if (key === "diagnosis")
    return role === "PMC" ? "/employee/confirmations" : null;
  if (key === "risks")
    return role === "OWNER"
      ? "/boss/risks"
      : role === "PMC"
        ? "/employee/risks"
        : null;
  if (key === "projects")
    return role === "OWNER"
      ? "/boss/projects"
      : role === "PMC"
        ? "/employee/projects"
        : null;
  if (key === "data") return role === "PMC" ? "/admin/import" : null;
  if (key === "dataSources")
    return role === "OWNER" ? "/boss/data-sources" : null;
  if (key === "experiences")
    return role === "EXPERT_REVIEWER"
      ? "/experiences?role=expert"
      : role === "PMC"
        ? "/experiences"
        : null;
  if (key === "approval") return role === "OWNER" ? "/boss/approvals" : null;
  if (key === "expert") return role === "EXPERT_REVIEWER" ? "/expert" : null;
  if (key === "organization")
    return role === "PMC" ? "/admin/organization" : null;
  if (key === "settings") return role === "PMC" ? "/admin/settings" : null;
  if (key === "audit") return role === "PMC" ? "/admin/audit" : null;
  return null;
};
