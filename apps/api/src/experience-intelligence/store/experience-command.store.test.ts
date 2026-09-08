import { describe, expect, it, vi } from "vitest";

import {
  ExperienceCommandReuseError,
  ExperienceCommandStore,
} from "./experience-command.store";

describe("ExperienceCommandStore", () => {
  const input = {
    tenantId: "tenant-demo",
    route: "VS17_FEISHU_PULL",
    requestId: "7c3b8ed8-9926-4d6e-8c3b-72f8ce287f1b",
    payloadFingerprint: "a".repeat(64),
  } as const;

  it("returns an exact-payload replay receipt before an external provider can run twice", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "1",
            payload_fingerprint: "a".repeat(64),
            status: "SUCCEEDED",
            response: {
              items: [],
              summary: { applied: 0, skipped: 0, failed: 0 },
            },
            error_code: null,
            created_at: new Date("2026-08-26T00:00:00.000Z"),
            completed_at: new Date("2026-08-26T00:01:00.000Z"),
          },
        ],
      });
    const store = new ExperienceCommandStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    await expect(store.createOrGet(input)).resolves.toMatchObject({
      created: false,
      receipt: { status: "SUCCEEDED" },
    });
  });

  it("rejects reuse of a tenant route request id with a different payload fingerprint", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "1",
            payload_fingerprint: "b".repeat(64),
            status: "FAILED",
            response: null,
            error_code: "PROVIDER_FAILED",
            created_at: new Date(),
            completed_at: new Date(),
          },
        ],
      });
    const store = new ExperienceCommandStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    await expect(store.createOrGet(input)).rejects.toBeInstanceOf(
      ExperienceCommandReuseError,
    );
  });

  it("persists an SQL null response for a failed command receipt", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const store = new ExperienceCommandStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });
    const receipt = {
      id: "run-1",
      status: "RUNNING",
      response: null,
      errorCode: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
    } as const;

    await store.fail("tenant-demo", receipt, "PROVIDER_FAILED");

    expect(query.mock.calls[0]?.[1]?.[3]).toBeNull();
  });
});
