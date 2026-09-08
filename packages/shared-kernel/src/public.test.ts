import { describe, expect, it } from "vitest";

import { tenantId } from "./public";

describe("tenantId", () => {
  it("normalizes a non-empty identifier", () => {
    expect(tenantId(" tenant-a ")).toBe("tenant-a");
  });

  it("rejects an empty identifier", () => {
    expect(() => tenantId("   ")).toThrow("TenantId cannot be empty");
  });
});
