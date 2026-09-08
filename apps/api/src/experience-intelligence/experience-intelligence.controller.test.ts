import { describe, expect, it, vi } from "vitest";

import { ExperienceIntelligenceController } from "./experience-intelligence.controller";

describe("ExperienceIntelligenceController", () => {
  it("rejects an unauthorized role before it calls the provider-facing service", () => {
    const draft = vi.fn();
    const controller = new ExperienceIntelligenceController({ draft } as never);

    expect(() =>
      controller.draft("PRJ-1", { requestId: "x" }, "OWNER"),
    ).toThrow("FORBIDDEN");
    expect(draft).not.toHaveBeenCalled();
  });
});
