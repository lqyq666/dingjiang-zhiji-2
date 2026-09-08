import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /health", () => {
  it("reports a structured healthy state", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "web",
      status: "ok",
    });
  });
});
