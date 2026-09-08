import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { databaseUrl, migrations, resetAndSeed } from "./vs01-db";
import { Vs01Service } from "./vs01.service";
import { assertProductionConfig, runtimeTenantId } from "./runtime-config";

afterEach(() => vi.unstubAllEnvs());

describe("production startup boundaries", () => {
  it("does not seed or migrate an empty production database", async () => {
    vi.stubEnv("DINGJIANG_DEPLOYMENT_MODE", "production");
    vi.stubEnv("DINGJIANG_TENANT_ID", "company-one");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: migrations.map((id) => ({ id })) })
      .mockResolvedValueOnce({
        rows: [{ rolsuper: false, rolbypassrls: false, owns_tables: false }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            schema_create: false,
            migration_write: false,
            can_truncate: false,
            tenant: "company-one",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            can_forge: false,
            can_change_digest: false,
            can_consume: true,
            can_import: false,
          },
        ],
      });
    const pool = { query, end: vi.fn() } as unknown as Pool;
    const service = new Vs01Service(undefined, undefined, {
      pool,
      client: undefined as never,
    });
    await service.onModuleInit();
    expect(
      query.mock.calls.some(([sql]) =>
        /^\s*(CREATE|INSERT|TRUNCATE|DELETE|ALTER)\b/i.test(String(sql)),
      ),
    ).toBe(false);
  });

  it("rejects every production seed/reset before connecting", async () => {
    vi.stubEnv("DINGJIANG_DEPLOYMENT_MODE", "production");
    const connect = vi.fn();
    await expect(resetAndSeed({ connect } as unknown as Pool)).rejects.toThrow(
      "disabled in production",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires a real tenant and explicit deployment configuration", () => {
    vi.stubEnv("DINGJIANG_DEPLOYMENT_MODE", "production");
    vi.stubEnv("DINGJIANG_TENANT_ID", "tenant-demo");
    expect(runtimeTenantId).toThrow("demonstration tenant");
    vi.stubEnv("DINGJIANG_TENANT_ID", "company-one");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DINGJIANG_TARGET_OTD", "85");
    expect(assertProductionConfig).toThrow("DATABASE_URL");
  });

  it("never falls back to local demo credentials in production", () => {
    vi.stubEnv("DINGJIANG_DEPLOYMENT_MODE", "production");
    vi.stubEnv("DATABASE_URL", "");
    expect(databaseUrl).toThrow("DATABASE_URL");
  });
});
