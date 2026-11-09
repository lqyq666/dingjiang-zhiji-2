import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionProfile,
  latestProtocolVersion,
  negotiateProtocolVersion,
  structuredToolOutputFor,
  supportedProtocolVersions,
} from "./session-profile";

const originalSurface = process.env.DINGJIANG_MCP_TOOL_SURFACE;

afterEach(() => {
  if (originalSurface === undefined)
    delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
  else process.env.DINGJIANG_MCP_TOOL_SURFACE = originalSurface;
});

describe("session profile", () => {
  it("defaults to the business surface and the newest revision", () => {
    delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
    expect(createSessionProfile(undefined)).toEqual({
      revision: latestProtocolVersion,
      toolSurface: "business",
      structuredToolOutput: true,
    });
  });

  it("honours the deployment-level surface choice", () => {
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    expect(createSessionProfile(undefined).toolSurface).toBe("compatibility");
    // A host name must not override the operator's explicit choice.
    expect(
      createSessionProfile({ clientInfo: { name: "WorkBuddy" } }).toolSurface,
    ).toBe("compatibility");
  });

  it("gates output contracts by the negotiated revision", () => {
    const legacy = supportedProtocolVersions.find(
      (revision) => revision !== latestProtocolVersion,
    );
    expect(legacy).toBeDefined();
    expect(structuredToolOutputFor(legacy!)).toBe(false);

    const profile = createSessionProfile({ protocolVersion: legacy });
    expect(profile.revision).toBe(legacy);
    expect(profile.structuredToolOutput).toBe(false);
  });

  it("falls back to the newest revision for hostile version probes", () => {
    for (const requested of ["1999-01-01", "toString", "__proto__", 1, null]) {
      const profile = createSessionProfile({ protocolVersion: requested });
      expect(profile.revision).toBe(latestProtocolVersion);
      expect(negotiateProtocolVersion(requested)).toBe(latestProtocolVersion);
    }
  });

  it("carries metadata only, never identity or authorization", () => {
    expect(Object.keys(createSessionProfile(undefined)).sort()).toEqual([
      "revision",
      "structuredToolOutput",
      "toolSurface",
    ]);
  });
});
