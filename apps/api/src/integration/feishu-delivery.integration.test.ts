import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl, migrate } from "../vs01-db";
import { FeishuWorkNotifier } from "./feishu-work.notifier";

/**
 * Delivery semantics that only PostgreSQL can confirm.
 *
 * The unit tests use a mocked pool, so they prove the query is shaped right but
 * not that it behaves right. These cases run the real claim/settle statements:
 * a throttled row must stay unclaimable until its backoff elapses, a row must
 * stop consuming the sweep once its attempt budget is spent, and a worker whose
 * lease was taken over must not be able to write its own result.
 */
const run = process.env.FEISHU_DELIVERY_INTEGRATION === "1";
const runDescribe = run ? describe : describe.skip;

const TENANT = "tenant-feishu-it";
const USER = "11111111-1111-4111-8111-111111111111";
const OPEN_ID = "ou_it_employee_0001";

const uuidFor = (index: number) =>
  `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;

const messageOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { message_id: "om_it" } }),
});

const tokenOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: 0,
    tenant_access_token: "it-token",
    expire: 3600,
  }),
});

const throttled = (retryAfter: string) => ({
  ok: false,
  status: 429,
  headers: { get: () => retryAfter },
  json: async () => ({ code: 99991400, msg: "too many requests" }),
});

runDescribe("Feishu delivery queue against PostgreSQL", () => {
  const database = `dingjiang_feishu_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  const originalUrl = process.env.DATABASE_URL;

  const notifierWith = (fetchImpl: typeof fetch, maxAttempts = 5) =>
    new FeishuWorkNotifier(
      {
        mode: "FEISHU",
        appId: "app-it",
        appSecret: "secret-it",
        maxAttempts,
        fetchImpl,
      },
      pool,
    );

  const enqueue = async (requestId: string) => {
    await pool.query(
      "INSERT INTO app_feishu_work_notifications (id,tenant_id,user_id,request_id,project_id,action,project_name) VALUES ($1,$2,$3,$4,$5,'event.start',$6)",
      [requestId, TENANT, USER, requestId, "PRJ-SO-IT-001", "验收客户 · IT"],
    );
  };

  const stateOf = async (requestId: string) => {
    const result = await pool.query(
      "SELECT status,attempts,dead_at,next_attempt_at > now() AS waiting,error FROM app_feishu_work_notifications WHERE tenant_id=$1 AND request_id=$2",
      [TENANT, requestId],
    );
    return result.rows[0] as {
      status: string;
      attempts: number;
      dead_at: Date | null;
      waiting: boolean;
      error: string | null;
    };
  };

  /** Clear the backoff so the next sweep is allowed to try immediately. */
  const makeDue = async (requestId: string) => {
    await pool.query(
      "UPDATE app_feishu_work_notifications SET next_attempt_at=now() WHERE tenant_id=$1 AND request_id=$2",
      [TENANT, requestId],
    );
  };

  beforeAll(async () => {
    const base = new URL(databaseUrl());
    base.pathname = "/postgres";
    admin = new Pool({ connectionString: base.toString() });
    await admin.query(`CREATE DATABASE ${database}`);
    base.pathname = `/${database}`;
    process.env.DATABASE_URL = base.toString();
    pool = new Pool({ connectionString: base.toString() });
    await migrate(pool);

    await pool.query(
      "INSERT INTO app_users (id,tenant_id,username,display_name,password_hash,role,active) VALUES ($1,$2,'it-employee','IT 员工','x','PMC',true)",
      [USER, TENANT],
    );
    await pool.query(
      "INSERT INTO app_feishu_user_bindings (tenant_id,user_id,open_id,active) VALUES ($1,$2,$3,true)",
      [TENANT, USER, OPEN_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });

  it("keeps a throttled row out of the next sweep until Retry-After elapses", async () => {
    const requestId = uuidFor(1);
    await enqueue(requestId);
    const fetchImpl = async (url: string) =>
      String(url).includes("/auth/v3/") ? tokenOk() : throttled("30");
    const notifier = notifierWith(fetchImpl as unknown as typeof fetch);

    await expect(notifier.deliver(TENANT, requestId)).resolves.toBe("FAILED");
    const throttledState = await stateOf(requestId);
    expect(throttledState.status).toBe("FAILED");
    expect(throttledState.attempts).toBe(1);
    expect(throttledState.waiting).toBe(true);

    // The row is healthy but not due: a second sweep must not call Feishu.
    let calls = 0;
    const counting = notifierWith((async (url: string) => {
      calls += 1;
      return String(url).includes("/auth/v3/") ? tokenOk() : messageOk();
    }) as unknown as typeof fetch);
    await expect(counting.deliver(TENANT, requestId)).resolves.toBe("DEFERRED");
    expect(calls).toBe(0);
  });

  it("stops spending attempts once the budget is gone and parks the row as DEAD", async () => {
    const requestId = uuidFor(2);
    await enqueue(requestId);
    const failing = notifierWith(
      (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ code: 1, msg: "server error" }),
      })) as unknown as typeof fetch,
      2,
    );

    await expect(failing.deliver(TENANT, requestId)).resolves.toBe("FAILED");
    await makeDue(requestId);
    await expect(failing.deliver(TENANT, requestId)).resolves.toBe("DEAD");

    const parked = await stateOf(requestId);
    expect(parked.status).toBe("DEAD");
    expect(parked.attempts).toBe(2);
    expect(parked.dead_at).not.toBeNull();

    // A dead row must never reach Feishu again.
    let calls = 0;
    const counting = notifierWith((async () => {
      calls += 1;
      return messageOk();
    }) as unknown as typeof fetch);
    await expect(counting.deliver(TENANT, requestId)).resolves.toBe("DEAD");
    expect(calls).toBe(0);
  });

  it("does not let a worker whose lease was taken over overwrite the newer result", async () => {
    const requestId = uuidFor(3);
    await enqueue(requestId);

    // While the message call is in flight another worker claims the row, which
    // is exactly what a lease expiring mid-request looks like.
    const racing = notifierWith((async (url: string) => {
      if (String(url).includes("/auth/v3/")) return tokenOk();
      await pool.query(
        "UPDATE app_feishu_work_notifications SET status='SENT',attempts=attempts+1,message_id='om_newer',updated_at=now() WHERE tenant_id=$1 AND request_id=$2",
        [TENANT, requestId],
      );
      return messageOk();
    }) as unknown as typeof fetch);

    await expect(racing.deliver(TENANT, requestId)).resolves.toBe("SENT");
    const result = await pool.query(
      "SELECT attempts,message_id FROM app_feishu_work_notifications WHERE tenant_id=$1 AND request_id=$2",
      [TENANT, requestId],
    );
    // The stale worker's settle matched no row, so the takeover survives.
    expect(result.rows[0]).toMatchObject({
      attempts: 2,
      message_id: "om_newer",
    });
  });

  it("refuses a row that was left FAILED with its budget already spent", async () => {
    const requestId = uuidFor(5);
    await enqueue(requestId);
    // The state a crash between "record the failure" and "park the row" leaves
    // behind: still FAILED, but no attempt budget left.
    await pool.query(
      "UPDATE app_feishu_work_notifications SET status='FAILED',attempts=2,error='earlier failure' WHERE tenant_id=$1 AND request_id=$2",
      [TENANT, requestId],
    );

    let calls = 0;
    const notifier = notifierWith(
      (async () => {
        calls += 1;
        return messageOk();
      }) as unknown as typeof fetch,
      2,
    );

    await expect(notifier.deliver(TENANT, requestId)).resolves.toBe("DEAD");
    expect(calls).toBe(0);
    const parked = await stateOf(requestId);
    expect(parked.status).toBe("DEAD");
    expect(parked.dead_at).not.toBeNull();
  });

  it("delivers once and answers SENT without calling Feishu again", async () => {
    const requestId = uuidFor(4);
    await enqueue(requestId);
    const fetchImpl = async (url: string) =>
      String(url).includes("/auth/v3/") ? tokenOk() : messageOk();
    const notifier = notifierWith(fetchImpl as unknown as typeof fetch);

    await expect(notifier.deliver(TENANT, requestId)).resolves.toBe("SENT");
    const sent = await stateOf(requestId);
    expect(sent.status).toBe("SENT");

    let calls = 0;
    const counting = notifierWith((async () => {
      calls += 1;
      return messageOk();
    }) as unknown as typeof fetch);
    await expect(counting.deliver(TENANT, requestId)).resolves.toBe("SENT");
    expect(calls).toBe(0);
  });
});
