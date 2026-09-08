import { describe, expect, it } from "vitest";

import { localWebOrigins } from "./local-web-origins";

describe("localWebOrigins", () => {
  it("accepts both loopback hostnames on the default Web port", () => {
    expect(localWebOrigins()).toEqual(
      new Set([
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:3010",
        "http://localhost:3010",
      ]),
    );
  });

  it("keeps an explicit Web origin without dropping safe local defaults", () => {
    expect(localWebOrigins("http://localhost:3200")).toEqual(
      new Set([
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:3010",
        "http://localhost:3010",
        "http://localhost:3200",
      ]),
    );
  });
});
