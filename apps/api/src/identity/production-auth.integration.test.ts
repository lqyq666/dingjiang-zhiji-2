import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl, migrate, assertDatabaseReady } from "../vs01-db";
import { IdentityService, sessionCookieName } from "./identity.service";

const run = process.env.PRODUCTION_INTEGRATION === "1";
(run ? describe : describe.skip)(
  "production identity over real HTTP and nonprivileged PostgreSQL",
  () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const database = `dingjiang_prod_test_${suffix}`;
    const role = `dj_test_${suffix}`;
    const tenant = "company-production-test";
    const password = randomBytes(24).toString("hex");
    let admin: Pool;
    let ownerPool: Pool;
    let runtimePool: Pool;
    let identity: IdentityService;
    let app: INestApplication;
    let base: string;
    let createdRole = false;
    let createdDatabase = false;
    const origin = "https://records.example.test";
    const login = async (username: string) => {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(201);
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    beforeAll(async () => {
      const url = new URL(databaseUrl());
      url.pathname = "/postgres";
      admin = new Pool({ connectionString: url.toString() });
      // Names are generated internally with digits/underscores only.
      await admin.query(`CREATE DATABASE ${database}`);
      createdDatabase = true;
      url.pathname = `/${database}`;
      ownerPool = new Pool({ connectionString: url.toString() });
      await Promise.all([migrate(ownerPool), migrate(ownerPool)]);
      const credential = randomBytes(32).toString("hex");
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${credential}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      createdRole = true;
      await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await ownerPool.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      await ownerPool.query(
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      );
      await ownerPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await ownerPool.query(
        `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON schema_migrations FROM ${role}`,
      );
      await ownerPool.query(
        `REVOKE INSERT,UPDATE,DELETE ON production_import_batches,production_source_files,production_source_rows FROM ${role}`,
      );
      await ownerPool.query(
        `REVOKE UPDATE,DELETE ON production_project_snapshots FROM ${role}`,
      );
      await ownerPool.query(
        `REVOKE INSERT,UPDATE,DELETE ON production_human_approvals FROM ${role}`,
      );
      await ownerPool.query(
        `GRANT UPDATE(consumed_at) ON production_human_approvals TO ${role}`,
      );
      url.username = role;
      url.password = credential;
      vi.stubEnv("DATABASE_URL", url.toString());
      vi.stubEnv("DINGJIANG_DEPLOYMENT_MODE", "production");
      vi.stubEnv("DINGJIANG_TENANT_ID", tenant);
      vi.stubEnv("WEB_ORIGIN", origin);
      vi.stubEnv("DINGJIANG_COMPANY_NAME", "生产验收企业");
      vi.stubEnv("DINGJIANG_TARGET_OTD", "85");
      vi.stubEnv("DINGJIANG_MCP_API_TOKEN", "");
      runtimePool = new Pool({
        connectionString: url.toString(),
        options: `-c app.tenant_id=${tenant}`,
      });
      identity = new IdentityService(runtimePool);
      await assertDatabaseReady(runtimePool);
      await identity.setAccount({
        username: "employee.one",
        displayName: "员工一",
        role: "PMC",
        password,
      });
      await identity.setAccount({
        username: "owner.one",
        displayName: "负责人",
        role: "OWNER",
        password,
      });
      const { AppModule } = await import("../app.module");
      app = await NestFactory.create(AppModule, { logger: false });
      app.setGlobalPrefix("api");
      await app.listen(0, "127.0.0.1");
      base = `${await app.getUrl()}/api`;
    }, 30_000);
    afterAll(async () => {
      await app?.close();
      await identity?.onModuleDestroy();
      await ownerPool?.end();
      if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
      if (createdRole) await admin.query(`DROP ROLE ${role}`);
      await admin?.end();
      vi.unstubAllEnvs();
    });

    it("does not seed a production empty database and rejects elevated database roles", async () => {
      const count = await ownerPool.query(
        "SELECT count(*)::int AS count FROM vs01_orders",
      );
      expect(count.rows[0].count).toBe(0);
      await expect(assertDatabaseReady(ownerPool)).rejects.toThrow(
        "must not own tables or bypass RLS",
      );
    });
    it("blocks anonymous reads, forged roles, and every legacy write before domain execution", async () => {
      expect(
        (
          await fetch(`${base}/vs01/boss`, {
            headers: { "x-vs01-role": "OWNER" },
          })
        ).status,
      ).toBe(401);
      const cookie = await login("employee.one");
      expect(
        (
          await fetch(`${base}/vs01/boss`, {
            headers: { cookie, "x-vs01-role": "OWNER" },
          })
        ).status,
      ).toBe(403);
      const response = await fetch(`${base}/vs01/employee`, {
        headers: { cookie, "x-vs01-role": "OWNER" },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).projects).toEqual([]);
      expect(
        (
          await fetch(`${base}/vs01/reset`, {
            method: "POST",
            headers: {
              cookie,
              "x-vs01-role": "PMC",
              "content-type": "application/json",
            },
            body: JSON.stringify({ actor: "PMC" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${base}/vs16/projects/other/root-cause-workpaper`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(403);
    });
    it("sets secure cookies and rejects cross-origin login/logout", async () => {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ username: "owner.one", password }),
      });
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(
        (
          await fetch(`${base}/auth/logout`, {
            method: "POST",
            headers: { cookie, origin: "https://attacker.invalid" },
          })
        ).status,
      ).toBe(403);
    });
    it("logout and expiry invalidate sessions on the server", async () => {
      const cookie = await login("owner.one");
      expect(
        (await fetch(`${base}/vs01/boss`, { headers: { cookie } })).status,
      ).toBe(200);
      await fetch(`${base}/auth/logout`, {
        method: "POST",
        headers: { cookie, origin },
      });
      expect(
        (await fetch(`${base}/auth/session`, { headers: { cookie } })).status,
      ).toBe(401);
      const expired = await login("owner.one");
      await runtimePool.query(
        "UPDATE app_sessions SET expires_at=now()-interval '1 second'",
      );
      expect(
        (await fetch(`${base}/auth/session`, { headers: { cookie: expired } }))
          .status,
      ).toBe(401);
    });
    it("synchronizes Feishu manager roles and disables explicitly resigned bound members transactionally", async () => {
      await identity.setAccount({
        username: "sync.manager",
        displayName: "同步负责人",
        role: "PMC",
        password,
      });
      await identity.setAccount({
        username: "sync.departed",
        displayName: "离职员工",
        role: "PMC",
        password,
      });
      await identity.bindFeishu("sync.manager", "ou_syncmanager0001");
      await identity.bindFeishu("sync.departed", "ou_syncdeparted001");
      await identity.assignProjects("sync.manager", ["PRJ-SYNC-001"]);
      const managerSession = await identity.login(
        "sync.manager",
        password,
        "127.0.0.11",
      );
      const managerToken = await identity.issueMcpToken("sync.manager", [
        "PRJ-SYNC-001",
      ]);
      const directory = [
        {
          openId: "ou_syncmanager0001",
          active: true,
          tenantManager: true,
        },
        {
          openId: "ou_syncdeparted001",
          active: false,
          tenantManager: false,
        },
      ];

      const preview = await identity.syncFeishuOrganization(directory);
      expect(preview.status).toBe("PREVIEW");
      expect(preview.plan.summary).toMatchObject({
        roleChanges: 1,
        disabledAccounts: 1,
        blockers: 0,
      });
      const applied = await identity.syncFeishuOrganization(
        directory,
        preview.plan.digest,
      );
      expect(applied.status).toBe("APPLIED");
      await expect(identity.session(managerSession.token)).rejects.toThrow(
        "登录已失效",
      );
      await expect(identity.mcpPrincipal(managerToken)).rejects.toThrow(
        "MCP 访问令牌无效",
      );
      expect(
        (await identity.login("sync.manager", password, "127.0.0.12")).user
          .role,
      ).toBe("OWNER");
      await expect(
        identity.login("sync.departed", password, "127.0.0.13"),
      ).rejects.toThrow("账号或密码不正确");
    });
    it("disabling an employee revokes both an existing browser session and MCP credential", async () => {
      const cookie = await login("employee.one");
      const employeeOpenId = "ou_employee00000001";
      await identity.bindFeishu("employee.one", employeeOpenId);
      await expect(
        identity.bindFeishu("owner.one", employeeOpenId),
      ).rejects.toThrow("飞书账号已绑定其他员工");
      await expect(
        identity.issueMcpToken("employee.one", ["PRJ-TEST-001"]),
      ).rejects.toThrow("项目未分配给该员工");
      await identity.assignProjects("employee.one", ["PRJ-TEST-001"]);
      await identity.setAccount({
        username: "employee.two",
        displayName: "员工二",
        role: "PMC",
        password,
      });
      await expect(
        identity.assignProjects("employee.two", ["PRJ-TEST-001"]),
      ).rejects.toThrow("项目已分配给其他员工");
      const staleToken = await identity.issueMcpToken("employee.one", [
        "PRJ-TEST-001",
      ]);
      expect(
        (
          await fetch(`${base}/integration/projects`, {
            headers: { authorization: `Bearer ${staleToken}` },
          })
        ).status,
      ).toBe(200);
      await identity.assignProjects("employee.one", []);
      expect(
        (
          await fetch(`${base}/integration/projects`, {
            headers: { authorization: `Bearer ${staleToken}` },
          })
        ).status,
      ).toBe(401);
      await identity.assignProjects("employee.one", ["PRJ-TEST-001"]);
      const token = await identity.issueMcpToken("employee.one", [
        "PRJ-TEST-001",
      ]);
      await identity.disableAccount("employee.one");
      expect(
        (
          await ownerPool.query(
            "SELECT active FROM app_feishu_user_bindings WHERE tenant_id=$1 AND open_id=$2",
            [tenant, employeeOpenId],
          )
        ).rows[0]?.active,
      ).toBe(false);
      expect(
        (await fetch(`${base}/auth/session`, { headers: { cookie } })).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/integration/projects`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
    });
    it("RLS hides other tenants and rejects their writes using the actual runtime role", async () => {
      const client = await runtimePool.connect();
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT set_config('app.tenant_id','other-enterprise',true)",
        );
        expect((await client.query("SELECT id FROM app_users")).rowCount).toBe(
          0,
        );
        await expect(
          client.query(
            "INSERT INTO app_identity_events (tenant_id,subject_id,event_type) VALUES ($1,'test','TEST')",
            [tenant],
          ),
        ).rejects.toThrow("row-level security");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    it("persists brute-force limits and returns no password/token material", async () => {
      for (let i = 0; i < 10; i++) {
        expect(
          (
            await fetch(`${base}/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/json", origin },
              body: JSON.stringify({
                username: "unknown.user",
                password: "incorrect-password",
              }),
            })
          ).status,
        ).toBe(401);
      }
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          username: "unknown.user",
          password: "incorrect-password",
        }),
      });
      expect(response.status).toBe(429);
      expect(await response.text()).not.toContain(password);
      expect(sessionCookieName).toBe("dingjiang_session");
    });
    it("RC2 actual PostgreSQL: immutable intake, human authorization, concurrent replay, generic project initialization, and pinned source facts", async () => {
      // Runs ONLY through the guarded disposable-database suite, never on a real
      // enterprise DB. No fake SQL/identity/contract substitutes are used here.
      const { parseBundle } = await import("../intake/source-bundle");
      const { importSourceBundle } = await import("../intake/import-service");
      const { approvalDigest } =
        await import("../command-kernel/production-authorization");
      const { workExecutionRequestSchema } =
        await import("@dingjiang/contracts");
      const { WorkExecutionService } =
        await import("../integration/work-execution.service");
      const { Vs01Service } = await import("../vs01.service");
      const csv = (forecast = "2026-09-03", customer = "TEST ONLY") => ({
        "orders.csv": Buffer.from(
          `orderId,customer,promisedDate,forecastDate,status\nACME-001,${customer},2026-09-01,${forecast},OPEN\n`,
        ),
        "bom.csv": Buffer.from(
          "orderId,plannedBomDate,actualBomDate,completionStatus\nACME-001,2026-08-20,2026-08-23,DONE\n",
        ),
        "purchases.csv": Buffer.from(
          "orderId,plannedStartDate,actualStartDate,arrivalRisk\nACME-001,2026-08-21,2026-08-24,HIGH\n",
        ),
      });
      const owner = (
        await ownerPool.query(
          "SELECT id FROM app_users WHERE tenant_id=$1 AND username='owner.one'",
          [tenant],
        )
      ).rows[0].id as string;
      const input = parseBundle(randomUUID(), csv());
      expect(
        (await importSourceBundle(ownerPool, tenant, owner, input)).replayed,
      ).toBe(false);
      expect(
        (await importSourceBundle(ownerPool, tenant, owner, input)).replayed,
      ).toBe(true);
      const raw = await ownerPool.query(
        "SELECT content,sha256 FROM production_source_files WHERE tenant_id=$1 AND batch_id=$2 AND file_name='orders.csv'",
        [tenant, input.batchId],
      );
      expect(Buffer.from(raw.rows[0].content)).toEqual(csv()["orders.csv"]);
      await expect(
        importSourceBundle(
          ownerPool,
          tenant,
          owner,
          parseBundle(input.batchId, csv("2026-09-04")),
        ),
      ).rejects.toThrow("different bytes");
      await expect(
        runtimePool.query(
          "UPDATE production_source_files SET sha256=repeat('a',64)",
        ),
      ).rejects.toThrow();
      await expect(
        runtimePool.query("DELETE FROM production_source_rows"),
      ).rejects.toThrow();
      await expect(
        runtimePool.query(
          "UPDATE production_human_approvals SET approval_digest=repeat('a',64)",
        ),
      ).rejects.toThrow();
      const actorId = await identity.setAccount({
        username: "pmc.source-test",
        displayName: "测试员工",
        role: "PMC",
        password,
      });
      // This temporary flag is ONLY for the isolated production-mode test DB. It
      // is not an accepted-release assertion, a saved config, or a deployment.
      vi.stubEnv("DINGJIANG_PRODUCTION_WRITES", "enabled");
      vi.stubEnv(
        "DINGJIANG_WRITE_ACCEPTANCE_REF",
        `ACCEPTED-TESTONLY-${suffix}`,
      );
      const projectId = "PRJ-ACME-001";
      await identity.assignProjects("pmc.source-test", [projectId]);
      const token = await identity.issueMcpToken("pmc.source-test", [
        projectId,
      ]);
      const principal = await identity.mcpPrincipal(token);
      expect(principal.subjectId).toBe(actorId);
      expect(principal.credentialId).toBeTruthy();
      const work = app.get(WorkExecutionService);
      const domain = app.get(Vs01Service);
      const context = await work.context(principal, projectId);
      const request = workExecutionRequestSchema.parse({
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: context.version,
        reason: "只在可销毁数据库验收",
        payload: {
          stateFingerprint: context.stateFingerprint,
          confirmation: "员工在隔离测试中确认立项",
          operation: { action: "event.start" },
        },
      });
      const authorize = async (req: typeof request) => {
        const envelope = {
          name: "work.execute",
          principal,
          target: { tenantId: tenant, projectId },
          request: req,
        };
        const args = [
          tenant,
          principal.subjectId,
          principal.role,
          principal.credentialId,
          "work.execute",
          req.requestId,
          projectId,
          req.expectedVersion,
          approvalDigest(envelope),
          JSON.stringify(req),
        ];
        const sql =
          "INSERT INTO production_human_approvals(tenant_id,actor_subject_id,actor_role,credential_id,command_name,request_id,project_id,expected_version,approval_digest,display_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)";
        await expect(runtimePool.query(sql, args)).rejects.toThrow();
        await ownerPool.query(sql, args);
      };
      await expect(
        work.execute(principal, projectId, request),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await authorize(request);
      const [a, b] = await Promise.all([
        work.execute(principal, projectId, request),
        work.execute(principal, projectId, request),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      const project = await domain.project(projectId);
      expect(project.phases.map((p) => p.gate.status)).toEqual([
        "OPEN",
        "LOCKED",
        "LOCKED",
        "LOCKED",
        "LOCKED",
        "LOCKED",
        "LOCKED",
      ]);
      expect(
        project.phases
          .flatMap((p) => p.tasks)
          .every(
            (t) =>
              t.status !== "DONE" &&
              t.origin === "LIVE" &&
              !t.completionConfirmation,
          ),
      ).toBe(true);
      expect(
        (
          await ownerPool.query(
            "SELECT count(*)::int AS n FROM production_project_snapshots WHERE tenant_id=$1 AND project_id=$2",
            [tenant, projectId],
          )
        ).rows[0].n,
      ).toBe(1);
      const latestContext = await work.context(principal, projectId);
      const first = project.phases[0]!.tasks.find((t) => t.owner === "PMC")!;
      const stale = workExecutionRequestSchema.parse({
        ...request,
        requestId: randomUUID(),
        expectedVersion: latestContext.version + 1,
        payload: {
          ...request.payload,
          stateFingerprint: latestContext.stateFingerprint,
          operation: {
            action: "workitem.complete",
            workItemId: first.id,
            note: "测试旧版本不得提交",
            outputReference: "真实测试来源记录",
            confirmedAcceptanceCriteria: first.acceptance,
          },
        },
      });
      await authorize(stale);
      await expect(
        work.execute(principal, projectId, stale),
      ).rejects.toMatchObject({ code: "STALE_VERSION" });
      expect(
        (
          await ownerPool.query(
            "SELECT consumed_at FROM production_human_approvals WHERE tenant_id=$1 AND request_id=$2",
            [tenant, stale.requestId],
          )
        ).rows[0].consumed_at,
      ).toBe(null);
      await importSourceBundle(
        ownerPool,
        tenant,
        owner,
        parseBundle(randomUUID(), csv("2026-08-30", "NEW SOURCE")),
      );
      expect((await domain.task("ACME-001")).order.forecastDate).toBe(
        "2026-09-03",
      );
      expect(
        (
          await ownerPool.query(
            "SELECT forecast_date::text FROM vs01_orders WHERE tenant_id=$1 AND order_id='ACME-001'",
            [tenant],
          )
        ).rows[0].forecast_date,
      ).toBe("2026-08-30");
      await expect(
        runtimePool.query(
          "UPDATE production_project_snapshots SET metric_before=100",
        ),
      ).rejects.toThrow();
      await identity.revokeMcpTokens("pmc.source-test");
      await expect(
        work.execute(principal, projectId, request),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      vi.stubEnv("DINGJIANG_PRODUCTION_WRITES", "disabled");
      vi.stubEnv("DINGJIANG_WRITE_ACCEPTANCE_REF", "");
    }, 60_000);
  },
);
