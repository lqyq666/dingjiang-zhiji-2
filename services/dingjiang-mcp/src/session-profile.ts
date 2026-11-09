import { findHostProfile, type ToolSurfaceName } from "./host-profiles";

/**
 * Everything that may differ between two MCP sessions, resolved once at
 * `initialize` and kept in the handler closure. `tools/list` must describe the
 * revision and surface this session agreed on, not whatever the newest build
 * happens to support.
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

export type SessionProfile = {
  hostId: string;
  revision: string;
  toolSurface: ToolSurfaceName;
  structuredToolOutput: boolean;
};

/** Kept as the fallback so existing deployments using the env var still work. */
const environmentSurface = (): ToolSurfaceName =>
  process.env.DINGJIANG_MCP_TOOL_SURFACE === "compatibility"
    ? "compatibility"
    : "business";

type InitializeParams = {
  protocolVersion?: unknown;
  clientInfo?: { name?: unknown; version?: unknown };
  capabilities?: unknown;
};

/**
 * Derive a session profile from the handshake. Unknown or absent clientInfo
 * falls back to the historical environment-driven behaviour, so introducing
 * host profiles cannot change what an existing host sees.
 */
export const createSessionProfile = (params: unknown): SessionProfile => {
  const raw = (params ?? {}) as InitializeParams;
  const clientInfo = raw.clientInfo ?? {};
  const name = typeof clientInfo.name === "string" ? clientInfo.name : "";
  const version =
    typeof clientInfo.version === "string" ? clientInfo.version : "";
  const host = findHostProfile(name, version);
  const revision = negotiateProtocolVersion(raw.protocolVersion);

  return {
    hostId: host?.id ?? "default",
    revision,
    toolSurface: host?.toolSurface ?? environmentSurface(),
    structuredToolOutput:
      (host?.supportsStructuredOutput ?? true) &&
      structuredToolOutputFor(revision),
  };
};
