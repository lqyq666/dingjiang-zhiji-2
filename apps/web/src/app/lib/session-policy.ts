export type SessionRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";
export const roleHome = (role: SessionRole): string =>
  role === "OWNER"
    ? "/boss"
    : role === "EXPERT_REVIEWER"
      ? "/expert"
      : "/employee";
/** Navigation is UX only; the API remains the authorization boundary. */
export function canVisitWorkspace(path: string, role: SessionRole): boolean {
  if (path === "/") return true;
  if (/^\/boss(?:\/|$)/.test(path)) return role === "OWNER";
  if (/^\/expert(?:\/|$)/.test(path))
    return role === "OWNER" || role === "EXPERT_REVIEWER";
  if (/^\/employee(?:\/|$)/.test(path))
    return role === "PMC" || role === "OWNER";
  if (/^\/projects?(?:\/|$)/.test(path)) return true;
  if (/^\/admin\/(audit|import|settings|organization)\/?$/.test(path))
    return role !== "EXPERT_REVIEWER";
  if (path === "/confirmations") return role !== "EXPERT_REVIEWER";
  if (/^\/experiences(?:\/|$)/.test(path)) return true;
  return false;
}
