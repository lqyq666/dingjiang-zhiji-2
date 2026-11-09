/**
 * The protocol revision this server speaks. Only the newest is supported: a
 * client asking for an older one is answered with this value and decides
 * whether it can continue, which is what the specification expects.
 *
 * There used to be a revision table that withheld `outputSchema` from older
 * clients. It was removed because no such client exists here, and an untested
 * compatibility branch is worse than a missing one: it silently changes what a
 * session is promised without anyone exercising it.
 */
export const latestProtocolVersion = "2025-06-18";

export type ToolSurfaceName = "business" | "compatibility";

export type SessionProfile = {
  revision: string;
  toolSurface: ToolSurfaceName;
};

const environmentSurface = (): ToolSurfaceName =>
  process.env.DINGJIANG_MCP_TOOL_SURFACE === "compatibility"
    ? "compatibility"
    : "business";

export const createSessionProfile = (): SessionProfile => ({
  revision: latestProtocolVersion,
  toolSurface: environmentSurface(),
});
