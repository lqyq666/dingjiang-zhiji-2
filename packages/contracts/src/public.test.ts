import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "./public";

describe("healthResponseSchema", () => {
  it("rejects an unknown service", () => {
    expect(() =>
      healthResponseSchema.parse({ service: "unknown", status: "ok" }),
    ).toThrow();
  });
});
