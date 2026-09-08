import { readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  projectSchema,
  projectAssistantResponseSchema,
  taskDetailSchema,
  taskAssistantResponseSchema,
  type Project,
  type TaskDetail,
} from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { createPool } from "./vs01-db";

const runHttpIntegration =
  process.env.VS15_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs15:http" ||
  process.argv.some((argument) =>
    argument.includes("vs15-http.integration.test.ts"),
  );
const httpDescribe = runHttpIntegration ? describe : describe.skip;

type JsonResponse<T> = { response: Response; data: T };

const materialFields = (requestId: string) => ({
  actor: "PMC",
  situationCode: "CAPACITY_RISK",
  requirementId: "REQ-CAPACITY-LOAD",
  title: "关键产线负荷记录",
  note: "8 月产线工时与负荷率，用于核验产能风险。",
  requestId,
});

const formFor = (
  requestId: string,
  bytes: string,
  fileName = "产线负荷.csv",
  fields = materialFields(requestId),
) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", new Blob([bytes], { type: "text/csv" }), fileName);
  return form;
};

const projectState = (project: Project) => ({
  status: project.status,
  progress: project.progress,
  outcome: project.outcome,
  approvals: project.phases.map((phase) => ({
    code: phase.code,
    gateStatus: phase.gate.status,
    status: phase.status,
    progress: phase.progress,
  })),
});

httpDescribe("VS15 HTTP traceable material intake", () => {
  let app: INestApplication;
  let api = "";
  let vaultRoot = "";
  let verifier: ReturnType<typeof createPool>;
  let previousVault: string | undefined;
  let previousNoProxy: string | undefined;
  let previousLowerNoProxy: string | undefined;

  const json = async <T>(
    pathName: string,
    role: string | undefined,
    body?: unknown,
  ): Promise<JsonResponse<T>> => {
    const response = await fetch(`${api}${pathName}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(role ? { "x-vs01-role": role } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: (await response.json()) as T };
  };

  const upload = async (
    requestId: string,
    bytes: string,
    role: string | null = "PMC",
    fileName?: string,
  ): Promise<JsonResponse<unknown>> => {
    const response = await fetch(
      `${api}/vs01/tasks/SO-202608136/materials/import`,
      {
        method: "POST",
        headers: role ? { "x-vs01-role": role } : undefined,
        body: formFor(requestId, bytes, fileName),
      },
    );
    return { response, data: (await response.json()) as unknown };
  };

  const uploadForTask = async (
    taskId: string,
    fields: ReturnType<typeof materialFields>,
    bytes: string,
    fileName = "材料.csv",
  ): Promise<JsonResponse<unknown>> => {
    const response = await fetch(
      `${api}/vs01/tasks/${taskId}/materials/import`,
      {
        method: "POST",
        headers: { "x-vs01-role": "PMC" },
        body: formFor(fields.requestId, bytes, fileName, fields),
      },
    );
    return { response, data: (await response.json()) as unknown };
  };

  const sourceFactCounts = async () => {
    const result = await verifier.query(
      "SELECT (SELECT count(*)::int FROM vs01_source_objects WHERE tenant_id = 'tenant-demo' AND id LIKE 'SRC-MATERIAL-%') AS objects, (SELECT count(*)::int FROM vs01_source_versions WHERE tenant_id = 'tenant-demo' AND source_object_id LIKE 'SRC-MATERIAL-%') AS versions, (SELECT count(*)::int FROM vs15_material_contents WHERE tenant_id = 'tenant-demo') AS contents, (SELECT count(*)::int FROM vs01_task_materials WHERE tenant_id = 'tenant-demo' AND kind = 'UPLOADED_FILE') AS materials, (SELECT count(*)::int FROM vs15_material_events WHERE tenant_id = 'tenant-demo') AS events",
    );
    return result.rows[0] as Record<string, number>;
  };

  const vaultCount = async (): Promise<number> => {
    try {
      return (await readdir(vaultRoot)).length;
    } catch {
      return 0;
    }
  };

  beforeAll(async () => {
    previousVault = process.env.VS15_MATERIAL_VAULT_ROOT;
    previousNoProxy = process.env.NO_PROXY;
    previousLowerNoProxy = process.env.no_proxy;
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), "vs15-http-vault-"));
    process.env.VS15_MATERIAL_VAULT_ROOT = vaultRoot;
    // Global fetch should never route a local acceptance test through a system proxy.
    process.env.NO_PROXY = "*";
    process.env.no_proxy = "*";
    verifier = createPool();
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    app.enableCors({
      origin: ["http://127.0.0.1:3010", "http://localhost:3010"],
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "x-vs01-role"],
    });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number } | null;
    if (!address) throw new Error("VS15 HTTP app did not bind a local port");
    api = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app?.close();
    await verifier?.end();
    await rm(vaultRoot, { recursive: true, force: true });
    if (previousVault === undefined)
      delete process.env.VS15_MATERIAL_VAULT_ROOT;
    else process.env.VS15_MATERIAL_VAULT_ROOT = previousVault;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousLowerNoProxy;
  });

  it("keeps file intake authorized, versioned, scoped and non-progressing through public HTTP seams", async () => {
    const reset = await json("/vs01/reset", "PMC", { actor: "PMC" });
    expect(reset.response.status).toBe(201);

    const cors = await fetch(
      `${api}/vs01/tasks/SO-202608136/materials/import`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3010",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-vs01-role",
        },
      },
    );
    expect(cors.status).toBe(204);
    expect(cors.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3010",
    );
    expect(cors.headers.get("access-control-allow-methods")).toContain("POST");
    expect(cors.headers.get("access-control-allow-headers")).toContain(
      "x-vs01-role",
    );

    const beforeRejected = await sourceFactCounts();
    const beforeRejectedVault = await vaultCount();
    const [missingRole, ownerRole] = await Promise.all([
      upload(
        "e730b83e-29d6-4c3c-8677-b31c951bdc10",
        "日期,负荷率\n2026-08-20,92%",
        null,
      ),
      upload(
        "e730b83e-29d6-4c3c-8677-b31c951bdc11",
        "日期,负荷率\n2026-08-20,92%",
        "OWNER",
      ),
    ]);
    expect(missingRole.response.status).toBe(403);
    expect(ownerRole.response.status).toBe(403);
    expect(await sourceFactCounts()).toEqual(beforeRejected);
    expect(await vaultCount()).toBe(beforeRejectedVault);

    const requestId = "e730b83e-29d6-4c3c-8677-b31c951bdc12";
    const csv = "日期,负荷率\n2026-08-20,92%";
    const [first, retry] = await Promise.all([
      upload(requestId, csv),
      upload(requestId, csv),
    ]);
    expect(first.response.status).toBe(201);
    expect(retry.response.status).toBe(201);
    const firstTask = taskDetailSchema.parse(first.data) as TaskDetail;
    const retryTask = taskDetailSchema.parse(retry.data) as TaskDetail;
    const material = firstTask.materials.find(
      (item) =>
        item.kind === "UPLOADED_FILE" &&
        item.requirementId === "REQ-CAPACITY-LOAD",
    );
    expect(material).toMatchObject({
      status: "ACTIVE",
      locator: {
        sourceObjectId: expect.stringMatching(/^SRC-MATERIAL-/),
        sourceVersionId: expect.stringMatching(/^SRC-MATERIAL-VERSION-/),
      },
      file: {
        originalName: "产线负荷.csv",
        extractionStatus: "EXTRACTED",
        contentPreview: csv,
        readableByAi: true,
      },
    });
    expect(
      retryTask.materials.find(
        (item) => item.requirementId === "REQ-CAPACITY-LOAD",
      )?.id,
    ).toBe(material?.id);
    expect(JSON.stringify(firstTask)).not.toContain(vaultRoot);
    expect(await sourceFactCounts()).toEqual({
      objects: 1,
      versions: 1,
      contents: 1,
      materials: 1,
      events: 1,
    });

    const conflict = await upload(requestId, "日期,负荷率\n2026-08-20,88%");
    expect(conflict.response.status).toBe(409);
    expect(await sourceFactCounts()).toEqual({
      objects: 1,
      versions: 1,
      contents: 1,
      materials: 1,
      events: 1,
    });

    const otherTaskUpload = await uploadForTask(
      "SO-202608128",
      {
        actor: "PMC",
        situationCode: "BOM_DELAY",
        requirementId: "REQ-BOM-CHANGE",
        title: "旧订单 BOM 变更清单",
        note: "此材料仅属于 SO-202608128，用于隔离验证。",
        requestId: "e730b83e-29d6-4c3c-8677-b31c951bdc14",
      },
      "版本,状态\nv1,冻结",
      "旧订单BOM.csv",
    );
    expect(otherTaskUpload.response.status).toBe(201);
    const otherTaskMaterial = taskDetailSchema
      .parse(otherTaskUpload.data)
      .materials.find((item) => item.kind === "UPLOADED_FILE");
    if (!otherTaskMaterial)
      throw new Error("Cross-task fixture material was not created");
    expect(await sourceFactCounts()).toEqual({
      objects: 2,
      versions: 2,
      contents: 2,
      materials: 2,
      events: 2,
    });

    if (!material)
      throw new Error("Successful intake did not return its material");
    const download = await fetch(
      `${api}/vs01/tasks/SO-202608136/materials/${material.id}/content`,
      {
        headers: { "x-vs01-role": "PMC" },
      },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toContain(
      "attachment; filename*=UTF-8''",
    );
    expect(download.headers.get("content-type")).toContain("text/csv");
    expect(await download.text()).toBe(csv);
    const crossTaskDownload = await fetch(
      `${api}/vs01/tasks/SO-202608128/materials/${material.id}/content`,
      {
        headers: { "x-vs01-role": "PMC" },
      },
    );
    expect(crossTaskDownload.status).toBe(404);

    const decision = await json("/vs01/tasks/SO-202608136/decision", "PMC", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "为 VS15 HTTP 验收建立咨询任务",
    });
    expect(decision.response.status).toBe(201);
    const created = await json<Project>("/vs01/projects", "PMC", {
      actor: "PMC",
      sourceTaskId: "SO-202608136",
    });
    expect(created.response.status).toBe(201);
    const project = projectSchema.parse(created.data);
    const beforeWithdrawalProjectState = projectState(project);
    const [taskAssistant, projectAssistant] = await Promise.all([
      json("/vs01/tasks/SO-202608136/assistant", "PMC", {
        actor: "PMC",
        intent: "MATERIAL_GAPS",
        question: "请依据当前材料建议下一步",
      }),
      json(`/vs01/projects/${project.id}/assistant`, "PMC", {
        actor: "PMC",
        intent: "MATERIAL_GAPS",
        workflowAction: "INSPECT",
        question: "请依据当前材料建议下一步",
      }),
    ]);
    expect(taskAssistant.response.status).toBe(201);
    const taskAssistantData = taskAssistantResponseSchema.parse(
      taskAssistant.data,
    );
    expect(taskAssistantData).toMatchObject({ classification: "PROPOSAL" });
    expect(projectAssistant.response.status).toBe(201);
    const projectAssistantData = projectAssistantResponseSchema.parse(
      projectAssistant.data,
    );
    expect(
      taskAssistantData.context.materials.map((item) => item.id),
    ).toContain(material.id);
    expect(
      projectAssistantData.context.uploadedMaterials.map((item) => item.id),
    ).toContain(material.id);
    expect(
      taskAssistantData.context.materials.map((item) => item.id),
    ).not.toContain(otherTaskMaterial.id);
    expect(
      projectAssistantData.context.uploadedMaterials.map((item) => item.id),
    ).not.toContain(otherTaskMaterial.id);
    expect(JSON.stringify(projectAssistant.data)).not.toContain(vaultRoot);

    const tooShort = await json(
      `/vs01/tasks/SO-202608136/materials/${material.id}/withdraw`,
      "PMC",
      {
        actor: "PMC",
        reason: "太短",
      },
    );
    expect(tooShort.response.status).toBe(400);
    const withdrawn = await json<TaskDetail>(
      `/vs01/tasks/SO-202608136/materials/${material.id}/withdraw`,
      "PMC",
      {
        actor: "PMC",
        reason: "上传了错误版本，需要改用当日的产线负荷记录。",
      },
    );
    expect(withdrawn.response.status).toBe(201);
    const withdrawnTask = taskDetailSchema.parse(withdrawn.data);
    expect(
      withdrawnTask.materials.find((item) => item.id === material.id),
    ).toMatchObject({
      status: "WITHDRAWN",
      withdrawnReason: "上传了错误版本，需要改用当日的产线负荷记录。",
    });
    expect(
      withdrawnTask.situations
        .flatMap((item) => item.requirements)
        .find((item) => item.id === "REQ-CAPACITY-LOAD"),
    ).toMatchObject({ fulfilled: false });

    const [afterTaskAssistant, afterProjectAssistant, afterProject] =
      await Promise.all([
        json("/vs01/tasks/SO-202608136/assistant", "PMC", {
          actor: "PMC",
          intent: "MATERIAL_GAPS",
        }),
        json(`/vs01/projects/${project.id}/assistant`, "PMC", {
          actor: "PMC",
          intent: "MATERIAL_GAPS",
          workflowAction: "INSPECT",
        }),
        json<Project>(`/vs01/projects/${project.id}`, "PMC"),
      ]);
    expect(afterTaskAssistant.response.status).toBe(201);
    expect(afterProjectAssistant.response.status).toBe(201);
    expect(
      taskAssistantResponseSchema.parse(afterTaskAssistant.data).context
        .coverage.materialCount,
    ).toBe(0);
    expect(
      taskAssistantResponseSchema
        .parse(afterTaskAssistant.data)
        .context.materials.map((item) => item.id),
    ).not.toContain(material.id);
    expect(
      projectAssistantResponseSchema
        .parse(afterProjectAssistant.data)
        .context.uploadedMaterials.map((item) => item.id),
    ).not.toContain(material.id);
    expect(projectState(projectSchema.parse(afterProject.data))).toEqual(
      beforeWithdrawalProjectState,
    );
    expect(await sourceFactCounts()).toEqual({
      objects: 2,
      versions: 2,
      contents: 2,
      materials: 2,
      events: 3,
    });

    const historicalDownload = await fetch(
      `${api}/vs01/tasks/SO-202608136/materials/${material.id}/content`,
      {
        headers: { "x-vs01-role": "PMC" },
      },
    );
    expect(historicalDownload.status).toBe(200);
    expect(await historicalDownload.text()).toBe(csv);

    const unavailableContent = await verifier.query(
      "SELECT c.storage_key FROM vs01_task_materials m JOIN vs15_material_contents c ON c.source_version_id = m.source_version_id AND c.tenant_id = m.tenant_id WHERE m.id = $1 AND m.task_id = 'SO-202608128' AND m.tenant_id = 'tenant-demo'",
      [otherTaskMaterial.id],
    );
    await rm(
      path.join(vaultRoot, String(unavailableContent.rows[0]?.storage_key)),
      { force: true },
    );
    const unavailableDownload = await fetch(
      `${api}/vs01/tasks/SO-202608128/materials/${otherTaskMaterial.id}/content`,
      { headers: { "x-vs01-role": "PMC" } },
    );
    expect(unavailableDownload.status).toBe(503);
    expect(await unavailableDownload.json()).toMatchObject({
      message: "材料文件暂时不可读取，请稍后重试或重新上传",
    });

    const disguise = await upload(
      "e730b83e-29d6-4c3c-8677-b31c951bdc13",
      "这不是 PDF",
      "PMC",
      "伪装.pdf",
    );
    expect(disguise.response.status).toBe(400);
    expect(await sourceFactCounts()).toEqual({
      objects: 2,
      versions: 2,
      contents: 2,
      materials: 2,
      events: 3,
    });
  });
});
