/**
 * What can differ between two MCP sessions: the negotiated protocol revision,
 * and the tool surface this deployment serves. Both are resolved once at
 * initialize and kept in the handler closure, so tools/list describes what this
 * session agreed on rather than whatever the newest build supports.
 *
 * The surface is a deployment decision. A host cannot widen it, so setting
 * DINGJIANG_MCP_TOOL_SURFACE=compatibility gets that surface for every session
 * instead of being silently overridden per client.
 */
export const latestProtocolVersion = "2025-06-18";

const protocolRevisions: Record<string, { structuredToolOutput: boolean }> = {
  "2025-06-18": { structuredToolOutput: true },
  "2025-03-26": { structuredToolOutput: false },
};

export const supportedProtocolVersions: readonly string[] =
  Object.keys(protocolRevisions);

export const structuredToolOutputFor = (revision: string): boolean =>
  protocolRevisions[revision]?.structuredToolOutput ?? true;

/**
 * Echo the revision the caller asked for when supported, otherwise answer with
 * the newest one we speak. `Object.hasOwn` rather than `in`, so a probe such as
 * `toString` or `__proto__` cannot masquerade as a revision.
 */
export const negotiateProtocolVersion = (requested: unknown): string =>
  typeof requested === "string" && Object.hasOwn(protocolRevisions, requested)
    ? requested
    : latestProtocolVersion;

export type ToolSurfaceName = "business" | "compatibility";

export type SessionProfile = {
  revision: string;
  toolSurface: ToolSurfaceName;
  structuredToolOutput: boolean;
};

const environmentSurface = (): ToolSurfaceName =>
  process.env.DINGJIANG_MCP_TOOL_SURFACE === "compatibility"
    ? "compatibility"
    : "business";

export const createSessionProfile = (params: unknown): SessionProfile => {
  const revision = negotiateProtocolVersion(
    (params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
  );
  return {
    revision,
    toolSurface: environmentSurface(),
    structuredToolOutput: structuredToolOutputFor(revision),
  };
};
