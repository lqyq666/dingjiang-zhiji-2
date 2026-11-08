import { Pool } from "pg";
import type { PoolConfig } from "pg";

/**
 * A PostgreSQL pool for integration tests.
 *
 * The production `createPool` already keeps an idle-connection failure from
 * becoming an unhandled EventEmitter error. Test pools need the same guard:
 * their teardown terminates backends with `pg_terminate_backend` and drops
 * the database, which can kill an idle connection while the process is still
 * shutting down. Without a handler that surfaces as an unhandled error and
 * fails an otherwise green suite.
 */
export const createTestPool = (
  connectionString: string,
  config: PoolConfig = {},
): Pool => {
  const pool = new Pool({ ...config, connectionString });
  pool.on("error", () => undefined);
  return pool;
};
