import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Vs01ContextAdapter } from "./assistant/context";
import { AssistantStore } from "./assistant/store";
import { createPool } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const runIntegration =
  process.env.VS15_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs15";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS15 PostgreSQL traceable materials", () => {
  let vaultRoot = "";
  let service: Vs01Service;
  let store: AssistantStore;
  let context: Vs01ContextAdapter;
  const verifier = createPool();
  let materialId = "";
  let projectId = "";

  beforeAll(async () => {
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), "vs15-materials-"));
    process.env.VS15_MATERIAL_VAULT_ROOT = vaultRoot;
    service = new Vs01Service();
    store = new AssistantStore();
    context = new Vs01ContextAdapter(service, store);
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
  });

  afterAll(async () => {
    await verifier.end();
    await store?.onModuleDestroy();
    await service?.onModuleDestroy();
    await rm(vaultRoot, { recursive: true, force: true });
    delete process.env.VS15_MATERIAL_VAULT_ROOT;
  });

  it("creates immutable source facts, is idempotent, and never leaks its vault path", async () => {
    const requestId = "4f8be14b-2de9-4cf9-afc7-3097ee4de060";
    const imported = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "关键产线负荷记录",
        note: "8 月产线工时与负荷率",
        requestId,
      },
      {
        originalName: "产线负荷.csv",
        buffer: Buffer.from("日期,负荷率\\n2026-08-20,92%"),
        size: Buffer.byteLength("日期,负荷率\\n2026-08-20,92%"),
      },
    );
    materialId = imported.id;
    expect(imported).toMatchObject({
      kind: "UPLOADED_FILE",
      status: "ACTIVE",
      requirementId: "REQ-CAPACITY-LOAD",
      locator: { sourceObjectId: expect.stringMatching(/^SRC-MATERIAL-/) },
      file: { extractionStatus: "EXTRACTED", readableByAi: true },
    });
    expect(JSON.stringify(imported)).not.toContain(vaultRoot);

    const retry = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "关键产线负荷记录",
        note: "8 月产线工时与负荷率",
        requestId,
      },
      {
        originalName: "产线负荷.csv",
        buffer: Buffer.from("日期,负荷率\\n2026-08-20,92%"),
        size: Buffer.byteLength("日期,负荷率\\n2026-08-20,92%"),
      },
    );
    expect(retry.id).toBe(imported.id);
    await expect(
      service.importTaskMaterial(
        "SO-202608136",
        {
          actor: "PMC",
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          title: "关键产线负荷记录",
          note: "不同内容",
          requestId,
        },
        {
          originalName: "产线负荷.csv",
          buffer: Buffer.from("日期,负荷率\\n2026-08-20,88%"),
          size: Buffer.byteLength("日期,负荷率\\n2026-08-20,88%"),
        },
      ),
    ).rejects.toThrow("相同请求编号不能对应不同材料内容");

    const dbFacts = await verifier.query(
      "SELECT (SELECT count(*) FROM vs01_source_objects WHERE id = $1)::int AS objects, (SELECT count(*) FROM vs01_source_versions WHERE id = $2)::int AS versions, (SELECT count(*) FROM vs15_material_contents WHERE source_version_id = $2)::int AS contents, (SELECT count(*) FROM vs15_material_events WHERE material_id = $3 AND event_type = 'IMPORTED')::int AS events",
      [
        imported.locator?.sourceObjectId,
        imported.locator?.sourceVersionId,
        imported.id,
      ],
    );
    expect(dbFacts.rows[0]).toEqual({
      objects: 1,
      versions: 1,
      contents: 1,
      events: 1,
    });
    const rls = await verifier.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('vs01_task_materials', 'vs15_material_contents', 'vs15_material_events') ORDER BY relname",
    );
    expect(rls.rows).toEqual([
      {
        relname: "vs01_task_materials",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "vs15_material_contents",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "vs15_material_events",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    const ownerRole = "vs15_rls_owner_test";
    await verifier.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    await verifier.query(
      `CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    const ownerClient = await verifier.connect();
    try {
      await ownerClient.query("BEGIN");
      await ownerClient.query(
        `ALTER TABLE vs01_task_materials OWNER TO ${ownerRole}`,
      );
      await ownerClient.query(`SET LOCAL ROLE ${ownerRole}`);
      await expect(
        ownerClient.query(
          "INSERT INTO vs01_task_materials (tenant_id, task_id, situation_code, title, source_reference, note, created_by) VALUES ('tenant-other', 'SO-202608136', 'CAPACITY_RISK', '越权材料', '越权引用', '越权写入', 'PMC')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await ownerClient.query("ROLLBACK").catch(() => undefined);
      ownerClient.release();
      await verifier.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    }
  });

  it("serializes concurrent retry clicks without duplicate source facts", async () => {
    const body = {
      actor: "PMC" as const,
      situationCode: "BOM_DELAY" as const,
      requirementId: "REQ-BOM-CHANGE",
      title: "BOM 变更清单",
      note: "并发重试验收",
      requestId: "5c8be14b-2de9-4cf9-afc7-3097ee4de061",
    };
    const upload = () =>
      service.importTaskMaterial("SO-202608136", body, {
        originalName: "BOM变更.csv",
        buffer: Buffer.from("版本,状态\\nv1,已冻结"),
        size: Buffer.byteLength("版本,状态\\nv1,已冻结"),
      });
    const [first, second] = await Promise.all([upload(), upload()]);
    expect(first.id).toBe(second.id);
    const counts = await verifier.query(
      "SELECT count(*)::int AS materials FROM vs01_task_materials WHERE tenant_id = $1 AND task_id = $2 AND request_id = $3",
      ["tenant-demo", "SO-202608136", body.requestId],
    );
    expect(counts.rows[0]).toEqual({ materials: 1 });

    const conflict = await Promise.allSettled([
      service.importTaskMaterial(
        "SO-202608136",
        { ...body, requestId: "6c8be14b-2de9-4cf9-afc7-3097ee4de062" },
        {
          originalName: "BOM变更.csv",
          buffer: Buffer.from("版本,状态\\nv2,已冻结"),
          size: Buffer.byteLength("版本,状态\\nv2,已冻结"),
        },
      ),
      service.importTaskMaterial(
        "SO-202608136",
        { ...body, requestId: "6c8be14b-2de9-4cf9-afc7-3097ee4de062" },
        {
          originalName: "BOM变更.csv",
          buffer: Buffer.from("版本,状态\\nv3,已冻结"),
          size: Buffer.byteLength("版本,状态\\nv3,已冻结"),
        },
      ),
    ]);
    expect(
      conflict.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      conflict.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      String(
        (
          conflict.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult
        ).reason,
      ),
    ).toContain("相同请求编号不能对应不同材料内容");
  });

  it("keeps material scope isolated and removes withdrawn material only from current AI context", async () => {
    await service.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "VS15 创建项目",
    });
    const project = await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608136",
    });
    projectId = project.id;
    const before = await service.project(projectId);
    const [ownTask, otherTask, assistant] = await Promise.all([
      service.task("SO-202608136"),
      service.task("SO-202608128"),
      service.assistProject(projectId, {
        actor: "PMC",
        intent: "MATERIAL_GAPS",
      }),
    ]);
    expect(
      ownTask.materials.some(
        (material) =>
          material.id === materialId && material.status === "ACTIVE",
      ),
    ).toBe(true);
    expect(
      otherTask.materials.some((material) => material.id === materialId),
    ).toBe(false);
    expect(
      assistant.context.uploadedMaterials.map((material) => material.id),
    ).toContain(materialId);
    expect(JSON.stringify(assistant)).not.toContain(vaultRoot);

    const scope = {
      tenantId: "tenant-demo",
      subjectId: "demo-pmc",
      role: "PMC" as const,
      projectId,
      sourceTaskId: "SO-202608136",
      policyVersion: "VS12-1" as const,
    };
    const current = await context.currentWorkContext(scope);
    expect(JSON.stringify(current)).toContain(materialId);
    expect(JSON.stringify(current)).not.toContain(vaultRoot);

    const withdrawn = await service.withdrawTaskMaterial(
      "SO-202608136",
      materialId,
      { actor: "PMC", reason: "上传了错误版本，需要改用当日记录" },
    );
    expect(withdrawn.status).toBe("WITHDRAWN");
    const [afterProject, afterTask, afterAssistant, afterContext] =
      await Promise.all([
        service.project(projectId),
        service.task("SO-202608136"),
        service.assistProject(projectId, {
          actor: "PMC",
          intent: "MATERIAL_GAPS",
        }),
        context.currentWorkContext(scope),
      ]);
    expect(
      afterTask.materials.find((material) => material.id === materialId),
    ).toMatchObject({
      status: "WITHDRAWN",
      withdrawnReason: "上传了错误版本，需要改用当日记录",
    });
    expect(
      afterAssistant.context.uploadedMaterials.map((material) => material.id),
    ).not.toContain(materialId);
    expect(JSON.stringify(afterContext.data)).not.toContain(
      '"id":"' + materialId + '"',
    );
    expect({
      status: afterProject.status,
      progress: afterProject.progress,
      outcome: afterProject.outcome,
      auditTrail: afterProject.auditTrail,
    }).toEqual({
      status: before.status,
      progress: before.progress,
      outcome: before.outcome,
      auditTrail: before.auditTrail,
    });
    const withdrawnFacts = await verifier.query(
      "SELECT count(*)::int AS events FROM vs15_material_events WHERE material_id = $1 AND event_type = 'WITHDRAWN'",
      [materialId],
    );
    expect(withdrawnFacts.rows[0]).toEqual({ events: 1 });
  });
});
