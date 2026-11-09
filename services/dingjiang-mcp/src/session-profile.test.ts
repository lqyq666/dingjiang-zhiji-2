import { afterEach, describe, expect, it } from "vitest";

import { createSessionProfile, latestProtocolVersion } from "./session-profile";

const originalSurface = process.env.DINGJIANG_MCP_TOOL_SURFACE;

afterEach(() => {
  if (originalSurface === undefined)
    delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
  else process.env.DINGJIANG_MCP_TOOL_SURFACE = originalSurface;
});

describe("session profile", () => {
  it("defaults to the business surface and the only revision we speak", () => {
    delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
    expect(createSessionProfile()).toEqual({
      revision: latestProtocolVersion,
      toolSurface: "business",
    });
  });

  it("honours the deployment-level surface choice", () => {
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    expect(createSessionProfile().toolSurface).toBe("compatibility");
  });

  it("carries metadata only, never identity or authorization", () => {
    expect(Object.keys(createSessionProfile()).sort()).toEqual([
      "revision",
      "toolSurface",
    ]);
  });
});
