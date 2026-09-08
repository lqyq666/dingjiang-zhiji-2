import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPool, migrate } from "../vs01-db";
import {
  GovernedCommandFailure,
  GovernedCommandKernel,
  type GovernedCommandDefinition,
} from "./governed-command-kernel";
import { PostgresGovernedCommandStore } from "./postgres-governed-command-store";

const integrationDescribe =
  process.env.GOVERNED_COMMAND_INTEGRATION === "1" ? describe : describe.skip;

integrationDescribe("PostgreSQL governed command kernel", () => {
  let pool: Pool;
  let kernel: GovernedCommandKernel;
  const tenantId = "tenant-demo";
  const projectId = "PRJ-KERNEL-TEST";
  const principal = {
    tenantId,
    subjectId: "pmc-kernel-test",
    role: "PMC" as const,
    scopes: ["kernel:test"],
    projectIds: [projectId],
  };
  const target = { tenantId, projectId };

  const definition: GovernedCommandDefinition<{ delta: number }> = {
    name: "kernel.test.increment",
    requiredScope: "kernel:test",
    allowedRoles: ["PMC"],
    parsePayload: (payload) => {
      if (
        Object.keys(payload).length !== 1 ||
        typeof payload.delta !== "number" ||
        !Number.isInteger(payload.delta) ||
        payload.delta < 1 ||
        payload.delta > 5
      )
        throw new Error("delta must be 1..5");
      return { delta: payload.delta };
    },
    handler: async (transaction, context) => {
      const current = await transaction.query(
        "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2 FOR UPDATE",
        [context.target.tenantId, context.target.projectId],
      );
      const row = current.rows[0];
      if (!row)
        throw new GovernedCommandFailure(
          "PERMISSION_DENIED",
          "目标不在服务端范围内",
          context.request.correlationId,
        );
      if (Number(row.version) !== context.request.expectedVersion)
        throw new GovernedCommandFailure(
          "STALE_VERSION",
          "对象版本已变化",
          context.request.correlationId,
        );
      const nextVersion = Number(row.version) + 1;
      const nextValue = Number(row.value) + context.payload.delta;
      await transaction.query(
        "UPDATE m4_kernel_test_targets SET version = $3, value = $4 WHERE tenant_id = $1 AND project_id = $2",
        [
          context.target.tenantId,
          context.target.projectId,
          nextVersion,
          nextValue,
        ],
      );
      return {
        version: nextVersion,
        data: { value: nextValue },
        audit: {
          eventType: "KERNEL_TEST_INCREMENTED",
          details: { delta: context.payload.delta },
        },
      };
    },
  };

  const command = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 1,
    reason: "验证统一命令事务",
    payload: { delta: 2 },
    correlationId: randomUUID(),
    ...overrides,
  });

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    await pool.query(
      "CREATE TABLE IF NOT EXISTS m4_kernel_test_targets (tenant_id text NOT NULL, project_id text NOT NULL, version integer NOT NULL, value integer NOT NULL, PRIMARY KEY (tenant_id, project_id))",
    );
    await pool.query("TRUNCATE m4_kernel_test_targets");
    await pool.query(
      "INSERT INTO m4_kernel_test_targets (tenant_id, project_id, version, value) VALUES ($1,$2,1,0)",
      [tenantId, projectId],
    );
    kernel = new GovernedCommandKernel(new PostgresGovernedCommandStore(pool));
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS m4_kernel_test_targets");
    await pool.end();
  });

  it("commits one business mutation and one immutable audit, then replays duplicates", async () => {
    const firstRequest = command();
    const first = await kernel.execute(
      { request: firstRequest, principal, target },
      definition,
    );
    const replay = await kernel.execute(
      { request: firstRequest, principal, target },
      definition,
    );
    expect(first).toMatchObject({
      version: 2,
      replayed: false,
      data: { value: 2 },
    });
    expect(replay).toMatchObject({
      version: 2,
      replayed: true,
      data: { value: 2 },
    });
    expect(
      (
        await pool.query(
          "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
          [tenantId, projectId],
        )
      ).rows[0],
    ).toMatchObject({ version: 2, value: 2 });
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM governed_command_audit_events WHERE request_id = $1",
            [firstRequest.requestId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1);
  });

  it("rejects changed payload reuse and stale expectedVersion without writes", async () => {
    const reused = command({ expectedVersion: 2 });
    await kernel.execute({ request: reused, principal, target }, definition);
    await expect(
      kernel.execute(
        { request: { ...reused, payload: { delta: 3 } }, principal, target },
        definition,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      kernel.execute(
        { request: command({ expectedVersion: 1 }), principal, target },
        definition,
      ),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(
      Number(
        (
          await pool.query(
            "SELECT value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
            [tenantId, projectId],
          )
        ).rows[0]?.value,
      ),
    ).toBe(4);
  });

  it("rolls back the business mutation when audit insertion fails", async () => {
    const before = (
      await pool.query(
        "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
        [tenantId, projectId],
      )
    ).rows[0];
    const failing: GovernedCommandDefinition<{ delta: number }> = {
      ...definition,
      name: "kernel.test.audit-failure",
      handler: async (transaction, context) => {
        const nextVersion = Number(before?.version) + 1;
        await transaction.query(
          "UPDATE m4_kernel_test_targets SET version = $3, value = value + $4 WHERE tenant_id = $1 AND project_id = $2",
          [tenantId, projectId, nextVersion, context.payload.delta],
        );
        return {
          version: nextVersion,
          data: { value: Number(before?.value) + context.payload.delta },
          audit: { eventType: "", details: {} },
        };
      },
    };
    await expect(
      kernel.execute(
        {
          request: command({ expectedVersion: Number(before?.version) }),
          principal,
          target,
        },
        failing,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      (
        await pool.query(
          "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
          [tenantId, projectId],
        )
      ).rows[0],
    ).toEqual(before);
  });

  it("rolls back when a handler attempts to return secret-shaped data", async () => {
    const before = (
      await pool.query(
        "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
        [tenantId, projectId],
      )
    ).rows[0];
    const leaking: GovernedCommandDefinition<{ delta: number }> = {
      ...definition,
      name: "kernel.test.secret-regression",
      handler: async (transaction, context) => {
        const nextVersion = Number(before?.version) + 1;
        await transaction.query(
          "UPDATE m4_kernel_test_targets SET version = $3, value = value + $4 WHERE tenant_id = $1 AND project_id = $2",
          [tenantId, projectId, nextVersion, context.payload.delta],
        );
        return {
          version: nextVersion,
          data: { accessToken: "test-secret-sentinel" },
          audit: { eventType: "KERNEL_TEST_LEAKED", details: {} },
        };
      },
    };
    let failure: unknown;
    try {
      await kernel.execute(
        {
          request: command({ expectedVersion: Number(before?.version) }),
          principal,
          target,
        },
        leaking,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(failure)).not.toContain("test-secret-sentinel");
    expect(
      (
        await pool.query(
          "SELECT version, value FROM m4_kernel_test_targets WHERE tenant_id = $1 AND project_id = $2",
          [tenantId, projectId],
        )
      ).rows[0],
    ).toEqual(before);
  });

  it("enforces RLS and rejects mutation of command history", async () => {
    const flags = await pool.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('governed_command_receipts','governed_command_audit_events') ORDER BY relname",
    );
    expect(flags.rows).toHaveLength(2);
    expect(
      flags.rows.every(
        (row) =>
          row.relrowsecurity === true && row.relforcerowsecurity === true,
      ),
    ).toBe(true);
    await expect(
      pool.query("DELETE FROM governed_command_audit_events"),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM governed_command_receipts"),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE governed_command_audit_events SET reason = 'attempted overwrite'",
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE governed_command_receipts SET reason = 'attempted overwrite'",
      ),
    ).rejects.toThrow();
  });
});
