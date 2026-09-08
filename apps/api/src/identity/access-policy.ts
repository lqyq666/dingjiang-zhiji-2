/** Pure policy functions, shared by HTTP guards and offline regression tests. */
export type BusinessRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";

export function browserReadRole(
  path: string,
  role: BusinessRole,
): BusinessRole | null {
  if (
    /^\/api\/vs01\/(employee|tasks\/[^/]+(?:\/materials\/[^/]+\/content)?)\/?$/.test(
      path,
    )
  )
    return role === "PMC" || role === "OWNER" ? "PMC" : null;
  if (/^\/api\/vs01\/boss\/?$/.test(path))
    return role === "OWNER" ? "OWNER" : null;
  if (
    /^\/api\/vs01\/expert\/(experience-reviews|experience-history)\/?$/.test(
      path,
    )
  )
    return role === "EXPERT_REVIEWER" || role === "OWNER"
      ? "EXPERT_REVIEWER"
      : null;
  if (/^\/api\/vs01\/projects\/[^/]+\/?$/.test(path)) return role;
  if (/^\/api\/vs01\/experiences(?:\/[^/]+)?\/?$/.test(path))
    return role === "OWNER" ? "PMC" : role;
  return null;
}

export function hasExpectedOrigin(
  origin: unknown,
  expected: string | undefined,
): boolean {
  return typeof origin === "string" && Boolean(expected) && origin === expected;
}

/** Ambiguous duplicate cookies must never select an arbitrary identity. */
export function cookieToken(
  header: unknown,
  cookieName: string,
): string | undefined {
  if (typeof header !== "string" || header.length > 8192) return undefined;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]!.slice(cookieName.length + 1);
  return /^[\w-]{43}$/.test(token) ? token : undefined;
}
