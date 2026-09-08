import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { RootCauseWorkpaperService } from "./root-cause-workpaper.service";
import { WorkpaperProposalCommand } from "./workpaper-proposal-command";

const run = process.env.WORKPAPER_PROPOSAL_INTEGRATION === "1";
const integrationDescribe = run ? describe : describe.skip;

integrationDescribe("workpaper.propose PostgreSQL command", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `dingjiang_workpaper_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let workpapers: RootCauseWorkpaperService;
  let business: Vs01Service;
  let command: WorkpaperProposalCommand;
  let materialId: string;
  const formalExperienceId = "EXP-WORKPAPER-INTEGRATION";
  let projectId: string;
  const principal = {
    tenantId: "tenant-demo",
    subjectId: "workbuddy-pmc-integration",
    role: "PMC" as const,
    scopes: ["workpaper:write"],
    projectIds: [] as string[],
  };

  const request = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedVersion: 0,
    reason: "记录根因核验分析 Proposal",
    correlationId: randomUUID(),
    payload: {
      proposalType: "ROOT_CAUSE_VALIDATION" as const,
      summary: "订单延期可能与产能负荷风险有关",
      reasoning: "当前订单 Evidence 显示延期，仍需补充并核验产能材料。",
      evidenceFindings: [
        {
          evidenceId: "E-ORDER-202608136",
          assertion: "预测交期晚于承诺交期",
        },
      ],
      materialFindings: [
        {
          materialId,
          assertion: "测试材料提示产能负荷风险",
          assessment: "INCONCLUSIVE" as const,
          note: "需要人工复核统计口径",
        },
      ],
      experienceReferences: [
        {
          experienceId: formalExperienceId,
          applicationNote: "仅作为历史排查步骤参考",
        },
      ],
      assumptions: ["订单与后续产能材料应采用同一统计周期"],
      missingInformation: ["缺少班次级产能与工时明细"],
      limitations: "当前分析不能替代 PMC 或 Owner 对根因的人工确认。",
    },
    ...overrides,
  });
  const businessState = async () =>
    (
      await pool.query(
        "SELECT p.status, p.metric_before, p.metric_current, p.metric_target, s.status AS work_item_status FROM vs01_projects p JOIN vs01_project_nodes n ON n.project_id = p.id AND n.tenant_id = p.tenant_id JOIN vs01_project_subtasks s ON s.node_id = n.id AND s.tenant_id = p.tenant_id WHERE p.id = $1 AND s.phase_code = 'ROOT_CAUSE_VALIDATION' AND s.origin = 'LIVE' AND s.owner = 'PMC'",
        [projectId],
      )
    ).rows;

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl());
    adminUrl.pathname = "/postgres";
    admin = new Pool({ connectionString: adminUrl.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(databaseUrl());
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    pool = new Pool({ connectionString: testUrl.toString() });
    await migrate(pool);
    await resetAndSeed(pool);
    workpapers = new RootCauseWorkpaperService();
    business = new Vs01Service(undefined, workpapers);
    await business.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立隔离的根因核验测试项目",
    });
    projectId = (
      await business.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
    principal.projectIds = [projectId];
    await pool.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ('SRC-MATERIAL-WORKPAPER-TEST','tenant-demo','隔离测试产能材料')",
    );
    await pool.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ('SRC-MATERIAL-WORKPAPER-TEST-V1','SRC-MATERIAL-WORKPAPER-TEST','tenant-demo',1)",
    );
    materialId = String(
      (
        await pool.query(
          "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, title, source_reference, note, created_by, source_object_id, source_version_id) VALUES ('tenant-demo','SO-202608136','CAPACITY_RISK','隔离测试产能材料','integration-fixture','仅用于隔离数据库测试','PMC','SRC-MATERIAL-WORKPAPER-TEST','SRC-MATERIAL-WORKPAPER-TEST-V1') RETURNING id",
        )
      ).rows[0]?.id,
    );
    await pool.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ('SRC-CANDIDATE-WORKPAPER-TEST','tenant-demo','隔离测试经验候选')",
    );
    await pool.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ('SRC-CANDIDATE-WORKPAPER-TEST-V1','SRC-CANDIDATE-WORKPAPER-TEST','tenant-demo',1)",
    );
    await pool.query(
      "INSERT INTO vs01_experience_candidates (id, tenant_id, project_id, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, status) VALUES ('CANDIDATE-WORKPAPER-TEST','tenant-demo',$1,'历史产能风险排查','同类延期订单','排查产能风险','先核对班次工时','历史案例中发现风险','隔离测试结果','仅作排查参考','PENDING_REVIEW')",
      [projectId],
    );
    await pool.query(
      "INSERT INTO vs01_experience_candidate_revisions (id, tenant_id, candidate_id, revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id) VALUES ('EXP-REV-WORKPAPER-TEST','tenant-demo','CANDIDATE-WORKPAPER-TEST',1,'历史产能风险排查','同类延期订单','排查产能风险','先核对班次工时','历史案例中发现风险','隔离测试结果','仅作排查参考','SRC-CANDIDATE-WORKPAPER-TEST','SRC-CANDIDATE-WORKPAPER-TEST-V1')",
    );
    await pool.query(
      "INSERT INTO vs01_source_objects (id, tenant_id, file_name) VALUES ('SRC-EXPERIENCE-WORKPAPER-TEST','tenant-demo','隔离测试正式经验')",
    );
    await pool.query(
      "INSERT INTO vs01_source_versions (id, source_object_id, tenant_id, version_number) VALUES ('SRC-EXPERIENCE-WORKPAPER-TEST-V1','SRC-EXPERIENCE-WORKPAPER-TEST','tenant-demo',1)",
    );
    await pool.query(
      "INSERT INTO vs01_formal_experiences (id, tenant_id, candidate_id, source_project_id, source_task_id, status, title, applicable_situation, business_problem, practice, result_summary, limitations, published_by, source_object_id, source_version_id, candidate_source_object_id, candidate_source_version_id, evidence_source_object_id, evidence_source_version_id) VALUES ($1,'tenant-demo',$2,$3,'SO-202608136','PUBLISHED','历史产能风险排查','同类延期订单','排查产能风险','先核对班次工时','历史案例中发现风险','仅作排查参考，不覆盖当前 Evidence','EXPERT_REVIEWER','SRC-EXPERIENCE-WORKPAPER-TEST','SRC-EXPERIENCE-WORKPAPER-TEST-V1',$4,$5,'SRC-MATERIAL-WORKPAPER-TEST','SRC-MATERIAL-WORKPAPER-TEST-V1')",
      [
        formalExperienceId,
        "CANDIDATE-WORKPAPER-TEST",
        projectId,
        "SRC-CANDIDATE-WORKPAPER-TEST",
        "SRC-CANDIDATE-WORKPAPER-TEST-V1",
      ],
    );
    command = new WorkpaperProposalCommand(
      new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
    );
  }, 30_000);

  it("rejects authorization and validation failures without partial state", async () => {
    await expect(
      command.execute(
        { ...principal, scopes: ["workpaper:read"] },
        projectId,
        request(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(
        { ...principal, role: "OWNER" as const },
        projectId,
        request(),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      command.execute(principal, projectId, {
        ...request(),
        payload: {
          ...request().payload,
          materialFindings: [
            {
              materialId: "999999999",
              assertion: "不存在的材料",
              assessment: "INCONCLUSIVE",
              note: "应拒绝",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM vs16_root_cause_workpapers WHERE project_id = $1",
            [projectId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM governed_command_audit_events WHERE command_name = 'workpaper.propose'",
          )
        ).rows[0]?.count,
      ),
    ).toBe(0);
  });

  afterAll(async () => {
    await business?.onModuleDestroy();
    await workpapers?.onModuleDestroy();
    await pool?.end();
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it("writes one immutable PROPOSAL and audit, then reads it through the existing workpaper view", async () => {
    const before = await businessState();
    const input = request();
    const first = await command.execute(principal, projectId, input);
    const replay = await command.execute(principal, projectId, input);
    expect(first).toMatchObject({
      version: 1,
      replayed: false,
      data: {
        projectId,
        status: "PROPOSAL",
        classification: "PROPOSAL",
        version: 1,
        createdBy: principal.subjectId,
      },
    });
    expect(replay).toMatchObject({
      version: 1,
      replayed: true,
      data: { locator: first.data.locator },
    });

    const view = await workpapers.view(projectId);
    expect(view.revision).toBe(1);
    expect(view.current).toMatchObject({
      kind: "PMC_PROPOSAL",
      classification: "PROPOSAL",
      requestId: input.requestId,
      createdBy: principal.subjectId,
      audit: {
        requestId: input.requestId,
        eventType: "WORKPAPER_PROPOSED",
      },
      locator: first.data.locator,
      proposalContext: {
        currentEvidenceTakesPriority: true,
        evidenceReferences: [{ evidenceId: "E-ORDER-202608136" }],
        experienceReferences: [
          {
            experienceId: formalExperienceId,
            limitations: "仅作排查参考，不覆盖当前 Evidence",
            locator: {
              sourceVersionId: "SRC-EXPERIENCE-WORKPAPER-TEST-V1",
            },
            evidenceLocator: {
              sourceVersionId: "SRC-MATERIAL-WORKPAPER-TEST-V1",
            },
          },
        ],
      },
    });
    expect(await businessState()).toEqual(before);
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM governed_command_audit_events WHERE request_id = $1 AND event_type = 'WORKPAPER_PROPOSED'",
            [input.requestId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1);
    await expect(
      pool.query(
        "UPDATE vs16_root_cause_workpaper_versions SET content = content WHERE request_id = $1",
        [input.requestId],
      ),
    ).rejects.toThrow("VS16 workpaper history is append-only");
  });

  it("rejects changed request reuse and stale version without partial state", async () => {
    const reused = request({ expectedVersion: 1 });
    await command.execute(principal, projectId, reused);
    await expect(
      command.execute(principal, projectId, {
        ...reused,
        payload: { ...reused.payload, summary: "同 requestId 的另一份内容" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const before = await workpapers.view(projectId);
    await expect(
      command.execute(principal, projectId, request({ expectedVersion: 1 })),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const after = await workpapers.view(projectId);
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
  });

  it("writes an Evidence-only proposal when no Material is referenced", async () => {
    const base = request({ expectedVersion: 2 });
    const result = await command.execute(principal, projectId, {
      ...base,
      payload: {
        ...base.payload,
        materialFindings: [],
        experienceReferences: [],
      },
    });

    expect(result).toMatchObject({
      version: 3,
      replayed: false,
      data: { status: "PROPOSAL", classification: "PROPOSAL" },
    });
    const view = await workpapers.view(projectId);
    expect(view.current).not.toBeNull();
    expect(view.current!.proposalContext).toMatchObject({
      evidenceReferences: [{ evidenceId: "E-ORDER-202608136" }],
      materialReferences: [],
      experienceReferences: [],
      currentEvidenceTakesPriority: true,
    });
  });

  it("uses an authorized historical root-cause item when no LIVE item exists", async () => {
    await pool.query(
      "UPDATE vs01_project_subtasks SET origin = 'HISTORICAL' WHERE tenant_id = $1 AND phase_code = 'ROOT_CAUSE_VALIDATION' AND node_id IN (SELECT id FROM vs01_project_nodes WHERE tenant_id = $1 AND project_id = $2)",
      [principal.tenantId, projectId],
    );
    const base = request({ expectedVersion: 3 });
    const result = await command.execute(principal, projectId, {
      ...base,
      payload: {
        ...base.payload,
        materialFindings: [],
        experienceReferences: [],
      },
    });

    expect(result).toMatchObject({
      version: 4,
      replayed: false,
      data: {
        projectId,
        status: "PROPOSAL",
        classification: "PROPOSAL",
      },
    });
  });
});
