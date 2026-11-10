import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionProfile } from "./session-profile";

afterEach(() => vi.unstubAllEnvs());

describe("session profile", () => {
  it("defaults to the regular business surface", () => {
    vi.stubEnv("DINGJIANG_MCP_TOOL_SURFACE", undefined);
    vi.stubEnv("DINGJIANG_MCP_READ_ONLY", undefined);
    expect(createSessionProfile()).toEqual({
      toolSurface: "business",
      readOnly: false,
    });
  });

  it("honours the deployment-level surface choice", () => {
    vi.stubEnv("DINGJIANG_MCP_TOOL_SURFACE", "compatibility");
    expect(createSessionProfile().toolSurface).toBe("compatibility");
  });

  it("fails startup if an explicit read-only value is invalid", () => {
    vi.stubEnv("DINGJIANG_MCP_READ_ONLY", "true");
    expect(createSessionProfile).toThrow("DINGJIANG_MCP_READ_ONLY");
  });

  it("carries startup policy without caller credentials or identity", () => {
    expect(Object.keys(createSessionProfile()).sort()).toEqual([
      "readOnly",
      "toolSurface",
    ]);
  });
});
