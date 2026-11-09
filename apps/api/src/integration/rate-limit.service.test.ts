import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredLimit,
  countRequest,
  enforceWindow,
  RateLimitExceeded,
} from "./rate-limit.service";

const originalRead = process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN;
const originalWrite = process.env.DINGJIANG_RATE_LIMIT_WRITE_PER_MIN;

afterEach(() => {
  if (originalRead === undefined)
    delete process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN;
  else process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN = originalRead;
  if (originalWrite === undefined)
    delete process.env.DINGJIANG_RATE_LIMIT_WRITE_PER_MIN;
  else process.env.DINGJIANG_RATE_LIMIT_WRITE_PER_MIN = originalWrite;
});

const poolWith = (count: number) => ({
  query: vi.fn().mockResolvedValue({ rows: [{ request_count: count }] }),
});

const actor = {
  tenantId: "tenant-1",
  subjectId: "subject-1",
  credentialId: "credential-1",
};

describe("integration rate limit", () => {
  it("defaults to 360 reads and 60 writes per minute", () => {
    delete process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN;
    delete process.env.DINGJIANG_RATE_LIMIT_WRITE_PER_MIN;
    expect(configuredLimit("read")).toBe(360);
    expect(configuredLimit("write")).toBe(60);
  });

  it("falls back to the default instead of disabling the limit", () => {
    for (const unusable of ["0", "-5", "abc", ""]) {
      process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN = unusable;
      expect(configuredLimit("read")).toBe(360);
    }
  });

  it("charges the credential and falls back to the subject", async () => {
    const pool = poolWith(1);
    await countRequest(pool, actor, "read");
    expect(pool.query.mock.calls[0]?.[1]).toEqual([
      "tenant-1",
      "credential-1",
      "read",
      expect.any(Date),
    ]);

    await countRequest(pool, { ...actor, credentialId: undefined }, "read");
    expect(pool.query.mock.calls[1]?.[1]?.[1]).toBe("subject-1");
  });

  it("keeps reads and writes in separate buckets", async () => {
    const pool = poolWith(1);
    await countRequest(pool, actor, "read");
    await countRequest(pool, actor, "write");
    expect(pool.query.mock.calls[0]?.[1]?.[2]).toBe("read");
    expect(pool.query.mock.calls[1]?.[1]?.[2]).toBe("write");
  });

  it("reports a retry-after inside the current minute", async () => {
    const pool = poolWith(1);
    const now = Date.UTC(2026, 10, 9, 14, 30, 15);
    const { retryAfterSeconds } = await countRequest(pool, actor, "read", now);
    expect(retryAfterSeconds).toBe(45);
  });

  it("allows the request at the limit and refuses the next one", async () => {
    process.env.DINGJIANG_RATE_LIMIT_READ_PER_MIN = "2";
    await expect(
      enforceWindow(poolWith(2), actor, "read"),
    ).resolves.toBeUndefined();
    await expect(
      enforceWindow(poolWith(3), actor, "read"),
    ).rejects.toBeInstanceOf(RateLimitExceeded);
  });

  it("carries a 429 with a retry hint and no human escalation", () => {
    const error = new RateLimitExceeded("write", 60, 42);
    expect(error.getStatus()).toBe(429);
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.getResponse()).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      requiresHuman: false,
    });
  });
});
