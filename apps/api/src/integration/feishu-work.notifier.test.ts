import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { FeishuWorkNotifier } from "./feishu-work.notifier";

const row = {
  project_id: "PRJ-SO-TEST-001",
  project_name: "验收客户 · SO-TEST-001",
  action: "event.start",
  open_id: "ou_testemployee0001",
};

describe("FeishuWorkNotifier", () => {
  it("enqueues one notification in the governed command transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const notifier = new FeishuWorkNotifier({ mode: "FEISHU" }, {
      end: vi.fn(),
    } as unknown as Pool);
    await notifier.enqueue({ query } as unknown as PoolClient, {
      tenantId: "tenant-test",
      userId: "00000000-0000-4000-8000-000000000001",
      requestId: "00000000-0000-4000-8000-000000000002",
      projectId: row.project_id,
      projectName: row.project_name,
      action: "event.start",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT");
  });

  it("sends an idempotent employee card and records the Feishu receipt", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: "test-token",
          expire: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { message_id: "om_test" } }),
      });
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "app-test",
        appSecret: "secret-test",
        fetchImpl: fetchImpl as typeof fetch,
      },
      { query, end: vi.fn() } as unknown as Pool,
    );
    await expect(
      notifier.deliver("tenant-test", "00000000-0000-4000-8000-000000000002"),
    ).resolves.toBe("SENT");
    const message = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(message).toMatchObject({
      receive_id: row.open_id,
      msg_type: "interactive",
      uuid: "00000000-0000-4000-8000-000000000002",
    });
    expect(JSON.parse(message.content)).toMatchObject({
      header: { title: { content: "鼎江智绩 · 工作已同步" } },
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      "SENT",
      "om_test",
      null,
      "tenant-test",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("fails closed without an active employee binding", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "PENDING" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const fetchImpl = vi.fn();
    const notifier = new FeishuWorkNotifier(
      { mode: "FEISHU", fetchImpl: fetchImpl as typeof fetch },
      { query, end: vi.fn() } as unknown as Pool,
    );
    await expect(
      notifier.deliver("tenant-test", "00000000-0000-4000-8000-000000000002"),
    ).resolves.toBe("NOT_CONFIGURED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
