import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { FeishuWorkNotifier } from "./feishu-work.notifier";

const TENANT = "tenant-test";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const CLAIM = "SET status='SENDING'";
const RECIPIENT = "JOIN app_feishu_user_bindings";
const STILL_OURS = "SELECT 1 FROM app_feishu_work_notifications";
const CURRENT = "SELECT status,attempts FROM app_feishu_work_notifications";
const SETTLE = "SET status=$1";
const PARK = "SET status='DEAD'";

type Result = { rowCount: number; rows: unknown[] };

/** Answer by SQL shape, so a case never depends on call ordering. */
const poolOf = (handlers: Array<[string, Result]>) => {
  const query = vi.fn(async (text: string) => {
    for (const [needle, result] of handlers)
      if (text.includes(needle)) return result;
    return { rowCount: 0, rows: [] };
  });
  return { query, end: vi.fn() } as unknown as Pool;
};

const claimed = (attempt: number): Result => ({
  rowCount: 1,
  rows: [
    {
      project_id: "PRJ-SO-TEST-001",
      project_name: "验收客户 · SO-TEST-001",
      attempts: attempt,
    },
  ],
});

const bound = { rowCount: 1, rows: [{ open_id: "ou_testemployee0001" }] };

const tokenOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: 0,
    tenant_access_token: "token-a",
    expire: 3600,
  }),
});

const messageOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { message_id: "om_test" } }),
});

const callFor = (query: ReturnType<typeof vi.fn>, needle: string) =>
  query.mock.calls.find(([sql]) => String(sql).includes(needle));

describe("FeishuWorkNotifier", () => {
  it("enqueues one notification in the governed command transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const notifier = new FeishuWorkNotifier({ mode: "FEISHU" }, {
      end: vi.fn(),
    } as unknown as Pool);
    await notifier.enqueue({ query } as unknown as PoolClient, {
      tenantId: TENANT,
      userId: "00000000-0000-4000-8000-000000000001",
      requestId: REQUEST,
      projectId: "PRJ-SO-TEST-001",
      projectName: "验收客户 · SO-TEST-001",
      action: "event.start",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT");
  });

  it("sends an idempotent employee card and records the Feishu receipt", async () => {
    const pool = poolOf([
      [CLAIM, claimed(1)],
      [RECIPIENT, bound],
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(messageOk());
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "app-test",
        appSecret: "secret-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("SENT");

    const message = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(message).toMatchObject({
      receive_id: "ou_testemployee0001",
      msg_type: "interactive",
      uuid: REQUEST,
    });
    expect(JSON.parse(message.content)).toMatchObject({
      header: { title: { content: "鼎江智绩 · 工作已同步" } },
    });
    const settle = callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE);
    expect(settle?.[1]).toEqual([
      "SENT",
      "om_test",
      null,
      TENANT,
      REQUEST,
      0,
      1,
    ]);
    // The fence: an expired worker cannot overwrite a newer attempt.
    expect(String(settle?.[0])).toContain("AND attempts=$7");
  });

  it("fails closed without an active employee binding", async () => {
    const pool = poolOf([
      [CLAIM, claimed(1)],
      [RECIPIENT, { rowCount: 0, rows: [] }],
      [STILL_OURS, { rowCount: 1, rows: [] }],
    ]);
    const fetchImpl = vi.fn();
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe(
      "NOT_CONFIGURED",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const settle = callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE);
    expect(settle?.[1]?.[0]).toBe("NOT_CONFIGURED");
    // Unbound is a durable waiting state, not a hot retry loop.
    expect(Number(settle?.[1]?.[5])).toBeGreaterThan(0);
  });

  it("honours Retry-After instead of retrying a throttled row immediately", async () => {
    const pool = poolOf([
      [CLAIM, claimed(1)],
      [RECIPIENT, bound],
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "7" },
        json: async () => ({ code: 99991400, msg: "too many requests" }),
      });
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("FAILED");
    const settle = callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE);
    expect(settle?.[1]?.[0]).toBe("FAILED");
    expect(Number(settle?.[1]?.[5])).toBe(7);
    expect(String(settle?.[1]?.[2])).toContain("限流");
  });

  it("parks the row as DEAD when the attempt budget is spent", async () => {
    const pool = poolOf([
      [CLAIM, claimed(5)],
      [RECIPIENT, bound],
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ code: 1, msg: "server error" }),
      });
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        maxAttempts: 5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("DEAD");
    const settle = callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE);
    expect(settle?.[1]?.[0]).toBe("DEAD");
    expect(String(settle?.[0])).toContain("dead_at=CASE WHEN $1='DEAD'");
  });

  it("refuses to claim a row that already spent its budget", async () => {
    const pool = poolOf([
      [CLAIM, { rowCount: 0, rows: [] }],
      [CURRENT, { rowCount: 1, rows: [{ status: "FAILED", attempts: 5 }] }],
    ]);
    const fetchImpl = vi.fn();
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        maxAttempts: 5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("DEAD");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callFor(pool.query as ReturnType<typeof vi.fn>, PARK)).toBeDefined();
  });

  it("does nothing for a row that is still inside its backoff window", async () => {
    const pool = poolOf([
      [CLAIM, { rowCount: 0, rows: [] }],
      [CURRENT, { rowCount: 1, rows: [{ status: "FAILED", attempts: 2 }] }],
    ]);
    const fetchImpl = vi.fn();
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("DEFERRED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("yields instead of overwriting a result when its lease was taken over", async () => {
    const pool = poolOf([
      [CLAIM, claimed(1)],
      [RECIPIENT, { rowCount: 0, rows: [] }],
      [STILL_OURS, { rowCount: 0, rows: [] }],
    ]);
    const fetchImpl = vi.fn();
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("DEFERRED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE),
    ).toBeUndefined();
  });

  it("shares one token request across concurrent deliveries", async () => {
    const pool = poolOf([
      [CLAIM, claimed(1)],
      [RECIPIENT, bound],
    ]);
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/auth/v3/") ? tokenOk() : messageOk(),
    );
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await Promise.all([
      notifier.deliver(TENANT, REQUEST),
      notifier.deliver(TENANT, REQUEST),
    ]);

    const tokenCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/auth/v3/"),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refreshes an expired token once and retries the same attempt", async () => {
    const pool = poolOf([
      [CLAIM, claimed(2)],
      [RECIPIENT, bound],
    ]);
    const tokens = ["token-a", "token-b"];
    let issued = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/auth/v3/")) {
        const value = tokens[issued] ?? "token-z";
        issued += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            tenant_access_token: value,
            expire: 3600,
          }),
        };
      }
      const authorization = String(
        (init?.headers as Record<string, string> | undefined)?.authorization,
      );
      return authorization === "Bearer token-a"
        ? {
            ok: false,
            status: 401,
            json: async () => ({ code: 99991663, msg: "token invalid" }),
          }
        : messageOk();
    });
    const notifier = new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "a",
        appSecret: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      pool,
    );

    await expect(notifier.deliver(TENANT, REQUEST)).resolves.toBe("SENT");
    expect(issued).toBe(2);
    const settle = callFor(pool.query as ReturnType<typeof vi.fn>, SETTLE);
    expect(settle?.[1]?.[0]).toBe("SENT");
  });
});
