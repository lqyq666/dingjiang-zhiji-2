import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Pool } from "pg";

import { createPool } from "../vs01-db";

/**
 * Requests per minute, per credential. Both are deployment-tunable: a chatty
 * integration and a batch job do not need the same ceiling.
 */
const DEFAULT_LIMITS = { read: 360, write: 60 } as const;
const WINDOW_RETENTION_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

const LIMIT_ENV = {
  read: "DINGJIANG_RATE_LIMIT_READ_PER_MIN",
  write: "DINGJIANG_RATE_LIMIT_WRITE_PER_MIN",
} as const;

export type RateLimitBucket = keyof typeof DEFAULT_LIMITS;

export const configuredLimit = (bucket: RateLimitBucket): number => {
  const parsed = Number.parseInt(
    process.env[LIMIT_ENV[bucket]]?.trim() ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_LIMITS[bucket];
};

export type RateLimitActor = {
  tenantId: string;
  subjectId: string;
  credentialId?: string;
};

export class RateLimitExceeded extends HttpException {
  constructor(
    readonly bucket: RateLimitBucket,
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      {
        code: "RATE_LIMITED",
        message: `请求过于频繁：每凭证每分钟${bucket === "read" ? "读取" : "写入"}上限 ${limit} 次`,
        retryable: true,
        requiresHuman: false,
      },
      429,
    );
  }
}

const minuteStart = (now: number): Date =>
  new Date(Math.floor(now / 60_000) * 60_000);

/**
 * One atomic upsert per request. Counting inside PostgreSQL is what makes the
 * limit hold across API replicas; a process-local counter would let N replicas
 * serve N times the ceiling. The window is one minute because that is the
 * smallest unit `Retry-After` can honestly describe.
 */
export const countRequest = async (
  pool: Pick<Pool, "query">,
  actor: RateLimitActor,
  bucket: RateLimitBucket,
  now = Date.now(),
): Promise<{ count: number; limit: number; retryAfterSeconds: number }> => {
  const limit = configuredLimit(bucket);
  const windowStart = minuteStart(now);
  // A legacy token has no credential row; the subject keeps the limit in force.
  const actorKey = actor.credentialId ?? actor.subjectId;
  const counted = await pool.query<{ request_count: number }>(
    `INSERT INTO api_rate_limit_windows
       (tenant_id, actor_key, bucket, window_start, request_count)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (tenant_id, actor_key, bucket, window_start)
     DO UPDATE SET request_count = api_rate_limit_windows.request_count + 1
     RETURNING request_count`,
    [actor.tenantId, actorKey, bucket, windowStart],
  );
  return {
    count: counted.rows[0]?.request_count ?? 1,
    limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart.getTime() + 60_000 - now) / 1000),
    ),
  };
};

/** Shared by the service and its tests; the service adds only the pool. */
export const enforceWindow = async (
  pool: Pick<Pool, "query">,
  actor: RateLimitActor,
  bucket: RateLimitBucket,
  now = Date.now(),
): Promise<void> => {
  const { count, limit, retryAfterSeconds } = await countRequest(
    pool,
    actor,
    bucket,
    now,
  );
  if (count > limit)
    throw new RateLimitExceeded(bucket, limit, retryAfterSeconds);
};

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly pool = createPool();
  private readonly logger = new Logger(RateLimitService.name);
  private nextSweepAt = 0;

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async assertWithinLimit(
    actor: RateLimitActor,
    method: string,
  ): Promise<void> {
    const bucket: RateLimitBucket = method === "GET" ? "read" : "write";
    const now = Date.now();
    await enforceWindow(this.pool, actor, bucket, now);
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    // The runtime pool is tenant-bound. Replicas can sweep distinct expired rows.
    try {
      await this.pool.query(
        `WITH expired AS (
           SELECT ctid FROM api_rate_limit_windows
           WHERE tenant_id = $1 AND window_start < $2
           ORDER BY window_start
           LIMIT 5000 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM api_rate_limit_windows AS target
         USING expired WHERE target.tenant_id = $1 AND target.ctid = expired.ctid`,
        [actor.tenantId, minuteStart(now - WINDOW_RETENTION_MS)],
      );
    } catch {
      this.logger.warn("过期限流窗口清理失败，将在下次周期重试");
    }
  }
}
