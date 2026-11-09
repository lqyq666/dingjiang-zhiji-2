import { afterEach, describe, expect, it } from "vitest";

import { findHostProfile, hostProfiles } from "./host-profiles";
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
  it("defaults to the historical behaviour when there is no handshake", () => {
    delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
    expect(createSessionProfile(undefined)).toEqual({
      hostId: "default",
      revision: latestProtocolVersion,
      toolSurface: "business",
      structuredToolOutput: true,
    });
  });

  it("still honours the deployment-level compatibility switch", () => {
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    expect(createSessionProfile(undefined).toolSurface).toBe("compatibility");
    expect(
      createSessionProfile({ clientInfo: { name: "UnknownHost" } }).toolSurface,
    ).toBe("compatibility");
  });

  it("lets a recognised host choose its surface inside a shared process", () => {
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    const profile = createSessionProfile({
      clientInfo: { name: "WorkBuddy", version: "5.3.14" },
    });
    expect(profile.hostId).toBe("workbuddy");
    expect(profile.toolSurface).toBe("business");
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

  it("never carries identity or authorization in a host profile", () => {
    // A profile may only change advertised metadata. Tenant, role, scopes and
    // tokens are injected by the transport/API, never by a host capability row.
    for (const profile of hostProfiles) {
      for (const forbidden of [
        "tenant",
        "role",
        "scope",
        "token",
        "projectIds",
      ])
        expect(Object.keys(profile)).not.toContain(forbidden);
    }
    expect(Object.keys(createSessionProfile(undefined)).sort()).toEqual([
      "hostId",
      "revision",
      "structuredToolOutput",
      "toolSurface",
    ]);
  });

  it("matches host names case-insensitively and ignores unknown hosts", () => {
    expect(findHostProfile("WORKBUDDY")?.id).toBe("workbuddy");
    expect(findHostProfile("unrelated-client")).toBeUndefined();
    expect(findHostProfile("")).toBeUndefined();
  });
});
