export type ToolSurfaceName = "business" | "compatibility";

export type SessionProfile = {
  toolSurface: ToolSurfaceName;
  readOnly: boolean;
};

const environmentSurface = (): ToolSurfaceName =>
  process.env.DINGJIANG_MCP_TOOL_SURFACE === "compatibility"
    ? "compatibility"
    : "business";

export const createSessionProfile = (): SessionProfile => {
  const readOnly = process.env.DINGJIANG_MCP_READ_ONLY;
  if (readOnly && readOnly !== "0" && readOnly !== "1")
    throw new Error("DINGJIANG_MCP_READ_ONLY must be 0 or 1");

  return {
    toolSurface: environmentSurface(),
    readOnly: readOnly === "1",
  };
};
