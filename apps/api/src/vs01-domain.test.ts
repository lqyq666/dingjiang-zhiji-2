import { describe, expect, it } from "vitest";

import { delayDays, isoDate, otdPercentage } from "./vs01-domain";

describe("VS01 delivery calculation seam", () => {
  it("calculates the frozen delayed order and fixture OTD", () => {
    expect(
      delayDays({ promisedDate: "2026-08-18", forecastDate: "2026-08-23" }),
    ).toBe(5);
    expect(
      otdPercentage([
        { promisedDate: "2026-08-18", forecastDate: "2026-08-23" },
        { promisedDate: "2026-08-19", forecastDate: "2026-08-22" },
        { promisedDate: "2026-08-19", forecastDate: "2026-08-18" },
        { promisedDate: "2026-08-20", forecastDate: "2026-08-20" },
        { promisedDate: "2026-08-20", forecastDate: "2026-08-19" },
        { promisedDate: "2026-08-21", forecastDate: "2026-08-21" },
        { promisedDate: "2026-08-21", forecastDate: "2026-08-20" },
      ]),
    ).toBe(71);
  });

  it("normalizes PostgreSQL Date values to the public date contract", () => {
    expect(isoDate(new Date("2026-08-18T00:00:00.000Z"))).toBe("2026-08-18");
    expect(isoDate("2026-08-18")).toBe("2026-08-18");
  });

  it("keeps calculation limited to observable delivery facts", () => {
    expect(otdPercentage([])).toBe(0);
  });
});
