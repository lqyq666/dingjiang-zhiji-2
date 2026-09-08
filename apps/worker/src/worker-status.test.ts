import { describe, expect, it } from "vitest";

import { createWorkerStatus } from "./worker-status";

describe("createWorkerStatus", () => {
  it("reports readiness without connecting to paid or remote services", () => {
    expect(createWorkerStatus()).toEqual({
      service: "worker",
      status: "ready",
    });
  });
});
