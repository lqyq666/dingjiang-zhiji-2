import { describe, expect, it } from "vitest";

import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports a structured healthy state", () => {
    expect(new HealthController().check()).toEqual({
      service: "api",
      status: "ok",
    });
  });
});
