/**
 * Host-specific capability overrides.
 *
 * One MCP process serves several hosts. Their differences belong here, as
 * data, not in `callTool`: adding a host is one row, and the dispatcher never
 * needs to know who is calling.
 *
 * A profile may only reduce the metadata a host is shown (tool naming,
 * optional output contracts). It must never weaken tenant scoping, role and
 * scope checks, or the governed command envelope. Those live in the API.
 */
export type ToolSurfaceName = "business" | "compatibility";

export type HostProfile = {
  id: string;
  /** Matched against initialize.params.clientInfo.name / .version. */
  match: RegExp;
  toolSurface?: ToolSurfaceName;
  supportsStructuredOutput?: boolean;
  note: string;
};

export const hostProfiles: readonly HostProfile[] = [
  {
    id: "workbuddy",
    match: /workbuddy/i,
    toolSurface: "business",
    // The 13-tool business surface has always been the default for this host;
    // declaring it here makes the choice session-scoped instead of process-wide.
    note: "Default 13-tool business surface.",
  },
];

/**
 * Unknown hosts deliberately get `undefined`: the caller falls back to the
 * existing environment setting, so adding a row can only affect hosts that
 * actually identify themselves.
 */
export const findHostProfile = (
  name: string,
  version = "",
): HostProfile | undefined =>
  hostProfiles.find(
    (profile) => profile.match.test(name) || profile.match.test(version),
  );
