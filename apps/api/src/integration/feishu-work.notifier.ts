import { randomUUID } from "node:crypto";

import type { OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { createPool } from "../vs01-db";

type Options = {
  mode: "FEISHU" | "DEMO_RULES";
  appId?: string;
  appSecret?: string;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
  /** Total delivery attempts before a row is parked as DEAD. */
  maxAttempts?: number;
};

/**
 * `DEFERRED` means "not due yet" — the row is healthy, its backoff simply has
 * not elapsed, so this sweep deliberately did nothing. It is distinct from
 * `FAILED`, which means an attempt was made and lost.
 */
type DeliveryStatus =
  "SENT" | "FAILED" | "NOT_CONFIGURED" | "DEAD" | "DEFERRED";

type Attempt = {
  projectId: string;
  projectName: string;
  attempt: number;
};

type Recipient =
  { kind: "OPEN_ID"; openId: string } | { kind: "UNBOUND" } | { kind: "STALE" };

/**
 * Feishu rate limiting and credential expiry are normal outcomes, not
 * exceptions: the app is throttled with 429 or one of Feishu's own frequency
 * codes, and an access token can expire between the cache check and the call.
 */
const RATE_LIMIT_HTTP = 429;
const RATE_LIMIT_CODES = new Set([11232, 99991400]);
const AUTH_CODES = new Set([99991661, 99991663]);
const DEFAULT_MAX_ATTEMPTS = 5;
const CONFIG_RETRY_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 300;
const DEFAULT_RATE_LIMIT_SECONDS = 60;

export class FeishuWorkNotifier implements OnModuleDestroy {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private token: { value: string; expiresAt: number } | null = null;
  /** Single-flight: concurrent deliveries share one token request. */
  private tokenInFlight: Promise<string> | null = null;

  constructor(
    private readonly options: Options,
    private readonly pool: Pool = createPool(),
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async enqueue(
    client: PoolClient,
    input: {
      tenantId: string;
      userId: string;
      requestId: string;
      projectId: string;
      projectName: string;
      action: "event.start";
    },
  ): Promise<void> {
    if (this.options.mode !== "FEISHU") return;
    await client.query(
      "INSERT INTO app_feishu_work_notifications (id,tenant_id,user_id,request_id,project_id,action,project_name) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,request_id) DO NOTHING",
      [
        randomUUID(),
        input.tenantId,
        input.userId,
        input.requestId,
        input.projectId,
        input.action,
        input.projectName,
      ],
    );
  }

  async deliver(tenantId: string, requestId: string): Promise<DeliveryStatus> {
    if (this.options.mode !== "FEISHU") return "NOT_CONFIGURED";
    const claimed = await this.claim(tenantId, requestId);
    if (typeof claimed === "string") return claimed;
    if (claimed === null) return "NOT_CONFIGURED";
    const { projectId, projectName, attempt } = claimed;

    const recipient = await this.recipient(tenantId, requestId, attempt);
    if (recipient.kind === "STALE") {
      // Our lease was taken over by a worker that saw it expire. Writing now
      // would overwrite a newer result, so this attempt yields instead.
      return "DEFERRED";
    }
    if (recipient.kind === "UNBOUND") {
      return this.settle(tenantId, requestId, attempt, {
        status: "NOT_CONFIGURED",
        error: "员工尚未绑定飞书账号",
        retryAfterSeconds: CONFIG_RETRY_SECONDS,
      });
    }
    if (!this.options.appId?.trim() || !this.options.appSecret?.trim()) {
      return this.settle(tenantId, requestId, attempt, {
        status: "NOT_CONFIGURED",
        error: "飞书机器人配置不完整",
        retryAfterSeconds: CONFIG_RETRY_SECONDS,
      });
    }

    try {
      const payload = { requestId, projectId, projectName };
      let response = await this.send(
        await this.accessToken(),
        recipient.openId,
        payload,
      );
      if (this.isAuthFailure(response)) {
        // A second failure after a fresh token is a real failure, not a clock
        // problem, so the retry happens once and inside the same attempt.
        this.token = null;
        response = await this.send(
          await this.accessToken(),
          recipient.openId,
          payload,
        );
      }
      if (this.succeeded(response)) {
        return this.settle(tenantId, requestId, attempt, {
          status: "SENT",
          messageId: response.payload?.data?.message_id ?? null,
          error: null,
        });
      }
      const throttled = this.isRateLimited(response);
      return this.settle(tenantId, requestId, attempt, {
        status: "FAILED",
        error: this.safe(
          `${throttled ? "限流：" : ""}${response.payload?.msg ?? `HTTP ${response.status}`}`,
        ),
        retryAfterSeconds: throttled
          ? this.retryAfterSeconds(response)
          : this.backoffSeconds(attempt),
      });
    } catch (error) {
      return this.settle(tenantId, requestId, attempt, {
        status: "FAILED",
        error: this.safe(error instanceof Error ? error.message : undefined),
        retryAfterSeconds: this.backoffSeconds(attempt),
      });
    }
  }

  /**
   * Lease one due row and spend one attempt on it.
   *
   * `attempts < maxAttempts` is what ends a permanent failure — once the budget
   * is spent the row is no longer claimable. `next_attempt_at <= now()` keeps a
   * throttled row out of the next sweep. The returned `attempt` is the fencing
   * token every later write carries.
   */
  private async claim(
    tenantId: string,
    requestId: string,
  ): Promise<Attempt | DeliveryStatus | null> {
    const claimed = await this.pool.query(
      "UPDATE app_feishu_work_notifications SET status='SENDING',attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND request_id=$2 AND attempts < $3 AND next_attempt_at <= now() AND (status IN ('PENDING','FAILED','NOT_CONFIGURED') OR (status='SENDING' AND updated_at < now()-interval '1 minute')) RETURNING project_id,project_name,attempts",
      [tenantId, requestId, this.maxAttempts],
    );
    if (claimed.rowCount) {
      const row = claimed.rows[0] as {
        project_id: string;
        project_name: string;
        attempts: number;
      };
      return {
        projectId: row.project_id,
        projectName: row.project_name,
        attempt: Number(row.attempts),
      };
    }

    const current = await this.pool.query(
      "SELECT status,attempts FROM app_feishu_work_notifications WHERE tenant_id=$1 AND request_id=$2",
      [tenantId, requestId],
    );
    const row = current.rows[0] as
      { status: DeliveryStatus; attempts: number } | undefined;
    if (!row) return null;
    if (row.status === "SENT") return "SENT";
    if (row.status === "DEAD") return "DEAD";
    if (Number(row.attempts) >= this.maxAttempts) {
      await this.park(
        tenantId,
        requestId,
        Number(row.attempts),
        "尝试次数已用尽",
      );
      return "DEAD";
    }
    // Healthy but waiting for its backoff to elapse.
    return "DEFERRED";
  }

  private async recipient(
    tenantId: string,
    requestId: string,
    attempt: number,
  ): Promise<Recipient> {
    const result = await this.pool.query(
      "SELECT b.open_id FROM app_feishu_work_notifications n JOIN app_feishu_user_bindings b ON b.tenant_id=n.tenant_id AND b.user_id=n.user_id AND b.active JOIN app_users u ON u.tenant_id=n.tenant_id AND u.id=n.user_id AND u.active WHERE n.tenant_id=$1 AND n.request_id=$2 AND n.attempts=$3",
      [tenantId, requestId, attempt],
    );
    const row = result.rows[0] as { open_id: string } | undefined;
    if (row) return { kind: "OPEN_ID", openId: row.open_id };
    // No binding and no row for our attempt means the lease moved on.
    const stillOurs = await this.pool.query(
      "SELECT 1 FROM app_feishu_work_notifications WHERE tenant_id=$1 AND request_id=$2 AND attempts=$3",
      [tenantId, requestId, attempt],
    );
    return stillOurs.rowCount ? { kind: "UNBOUND" } : { kind: "STALE" };
  }

  private async send(
    token: string,
    openId: string,
    input: { requestId: string; projectId: string; projectName: string },
  ) {
    const raw = await this.fetchImpl(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: openId,
          msg_type: "interactive",
          uuid: input.requestId,
          content: JSON.stringify(
            this.card(input.projectId, input.projectName),
          ),
        }),
      },
    );
    const payload = (await raw.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    };
    return { ok: Boolean(raw.ok), status: raw.status, raw, payload };
  }

  private succeeded(response: {
    ok: boolean;
    payload?: { code?: number; data?: { message_id?: string } };
  }): boolean {
    return Boolean(
      response.ok &&
      response.payload?.code === 0 &&
      response.payload?.data?.message_id,
    );
  }

  private isAuthFailure(response: {
    status: number;
    payload?: { code?: number };
  }): boolean {
    return (
      response.status === 401 ||
      (response.payload?.code !== undefined &&
        AUTH_CODES.has(response.payload.code))
    );
  }

  private isRateLimited(response: {
    status: number;
    payload?: { code?: number };
  }): boolean {
    return (
      response.status === RATE_LIMIT_HTTP ||
      (response.payload?.code !== undefined &&
        RATE_LIMIT_CODES.has(response.payload.code))
    );
  }

  /** `Retry-After` is authoritative when present; otherwise fall back. */
  private retryAfterSeconds(response: {
    raw?: { headers?: { get?(name: string): string | null } };
  }): number {
    const header = response.raw?.headers?.get?.("retry-after");
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.min(Math.ceil(seconds), MAX_BACKOFF_SECONDS);
    return DEFAULT_RATE_LIMIT_SECONDS;
  }

  private backoffSeconds(attempt: number): number {
    return Math.min(2 ** Math.min(attempt, 8), MAX_BACKOFF_SECONDS);
  }

  /**
   * Write the outcome of one attempt and decide whether it ends the row.
   *
   * `AND attempts=$7` is the fence: if this lease expired and another worker
   * claimed the row, the update matches nothing and the newer result stands.
   */
  private async settle(
    tenantId: string,
    requestId: string,
    attempt: number,
    delivery: {
      status: "SENT" | "FAILED" | "NOT_CONFIGURED";
      messageId?: string | null;
      error: string | null;
      retryAfterSeconds?: number;
    },
  ): Promise<DeliveryStatus> {
    const status: DeliveryStatus =
      delivery.status === "SENT"
        ? "SENT"
        : attempt >= this.maxAttempts
          ? "DEAD"
          : delivery.status;
    await this.pool.query(
      "UPDATE app_feishu_work_notifications SET status=$1,message_id=$2,error=$3,sent_at=CASE WHEN $1='SENT' THEN now() ELSE NULL END,dead_at=CASE WHEN $1='DEAD' THEN now() ELSE NULL END,next_attempt_at=CASE WHEN $1 IN ('FAILED','NOT_CONFIGURED') THEN now()+make_interval(secs=>$6) ELSE next_attempt_at END,updated_at=now() WHERE tenant_id=$4 AND request_id=$5 AND attempts=$7",
      [
        status,
        delivery.messageId ?? null,
        delivery.error,
        tenantId,
        requestId,
        delivery.retryAfterSeconds ?? 0,
        attempt,
      ],
    );
    return status;
  }

  private async park(
    tenantId: string,
    requestId: string,
    attempt: number,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE app_feishu_work_notifications SET status='DEAD',dead_at=now(),error=COALESCE(error,$3),updated_at=now() WHERE tenant_id=$1 AND request_id=$2 AND attempts=$4 AND status<>'SENT'",
      [tenantId, requestId, reason, attempt],
    );
  }

  /**
   * Cached token with single-flight refresh. Ten deliveries that all miss the
   * cache must produce one token request, not ten: Feishu throttles app-level
   * token issuance, and a burst of expiries is exactly when it happens.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return this.token.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const response = await this.fetchImpl(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.options.appId!.trim(),
          app_secret: this.options.appSecret!.trim(),
        }),
      },
    );
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token)
      throw new Error(this.safe(payload.msg));
    this.token = {
      value: payload.tenant_access_token,
      expiresAt:
        Date.now() + Math.max(60, (payload.expire ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  private card(projectId: string, projectName: string) {
    const elements: Array<Record<string, unknown>> = [
      {
        tag: "markdown",
        content: `**项目：** ${this.safe(projectName)}\n**动作：** 已确认事件并开始处理\n**项目编号：** ${this.safe(projectId)}\n\n请回到 WorkBuddy 询问“我的下一步工作是什么”。`,
      },
    ];
    if (this.options.publicUrl?.trim())
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看项目记录" },
            type: "primary",
            url: `${this.options.publicUrl.replace(/\/$/, "")}/project/${encodeURIComponent(projectId)}`,
          },
        ],
      });
    return {
      config: { wide_screen_mode: true },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "鼎江智绩 · 工作已同步" },
      },
      elements,
    };
  }

  private safe(value: string | undefined): string {
    return (value || "飞书通知失败").replace(/[<>]/g, "").slice(0, 300);
  }
}
