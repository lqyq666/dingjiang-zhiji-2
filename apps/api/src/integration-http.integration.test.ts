import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  integrationCurrentWorkItemSchema,
  integrationEvidenceBundleSchema,
  integrationEvidenceDetailSchema,
  integrationEvidenceListSchema,
  integrationFailureEnvelopeSchema,
  integrationMaterialListSchema,
  integrationMaterialPreviewSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationProjectStateSchema,
  integrationSuccessEnvelopeSchema,
  integrationWorkContextSchema,
  integrationWorkItemListSchema,
  integrationWorkspaceResumeSchema,
  nextActionSchema,
  workExecutionContextSchema,
} from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "./app.module";
import { ReadModelService } from "./read-model/read-model-service";
import { createPool } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const run =
  process.env.INTEGRATION_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:integration:http" ||
  process.argv.some((argument) =>
    argument.includes("integration-http.integration.test.ts"),
  );

(run ? describe : describe.skip)("WorkBuddy Integration API HTTP seam", () => {
  let app: INestApplication;
  let api = "";
  const token = "local-integration-http-test-token";
  const ownerToken = "local-owner-read-test-token";
  const ownerWorkToken = "local-owner-work-test-token";
  const ownerMaterialToken = "local-owner-material-test-token";
  const wildcardToken = "local-wildcard-read-test-token";
  const otherTenantToken = "local-other-tenant-test-token";
  const originalToken = process.env.DINGJIANG_MCP_API_TOKEN;
  const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;

  beforeAll(async () => {
    const business = new Vs01Service();
    await business.onModuleInit();
    try {
      await business.reset({ actor: "PMC" });
      await business.decideTask("SO-202608128", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "建立隔离的 Integration HTTP 测试项目",
      });
      const project = await business.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608128",
      });
      if (project.id !== "PRJ-OTD-001")
        throw new Error(`Unexpected integration fixture project ${project.id}`);
    } finally {
      await business.onModuleDestroy();
    }
    delete process.env.DINGJIANG_MCP_API_TOKEN;
    process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
      {
        token,
        tenantId: "tenant-demo",
        subjectId: "integration-pmc",
        role: "PMC",
        scopes: [
          "project:read",
          "workitem:read",
          "material:read",
          "evidence:read",
          "workpaper:read",
          "experience:read",
        ],
        projectIds: ["PRJ-OTD-001"],
      },
      {
        token: ownerToken,
        tenantId: "tenant-demo",
        subjectId: "integration-owner",
        role: "OWNER",
        scopes: ["project:read"],
        projectIds: ["PRJ-OTD-001"],
      },
      {
        token: ownerWorkToken,
        tenantId: "tenant-demo",
        subjectId: "integration-owner-work",
        role: "OWNER",
        scopes: ["project:read", "workitem:read"],
        projectIds: ["PRJ-OTD-001"],
      },
      {
        token: ownerMaterialToken,
        tenantId: "tenant-demo",
        subjectId: "integration-owner-material",
        role: "OWNER",
        scopes: ["project:read", "workitem:read", "material:read"],
        projectIds: ["PRJ-OTD-001"],
      },
      {
        token: wildcardToken,
        tenantId: "tenant-demo",
        subjectId: "integration-wildcard",
        role: "PMC",
        scopes: ["project:read", "workitem:write"],
        projectIds: ["*"],
      },
      {
        token: otherTenantToken,
        tenantId: "tenant-other",
        subjectId: "integration-other",
        role: "PMC",
        scopes: ["project:read"],
        projectIds: ["*"],
      },
    ]);
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    api = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app.close();
    if (originalToken === undefined) delete process.env.DINGJIANG_MCP_API_TOKEN;
    else process.env.DINGJIANG_MCP_API_TOKEN = originalToken;
    if (originalBindings === undefined)
      delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
    else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = originalBindings;
  });

  it("fails closed with the shared envelope before reading a project", async () => {
    const response = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/context`,
    );
    expect(response.status).toBe(401);
    expect(
      integrationFailureEnvelopeSchema.parse(await response.json()).error.code,
    ).toBe("UNAUTHORIZED");
  });

  it("returns a contract-shaped authorized project context", async () => {
    const response = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/context`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const envelope = integrationSuccessEnvelopeSchema(
      integrationProjectContextSchema,
    ).parse(await response.json());
    expect(envelope.data.project.id).toBe("PRJ-OTD-001");
    expect(envelope.data.sourceTask.evidence.length).toBeGreaterThan(0);

    const state = await fetch(`${api}/integration/projects/PRJ-OTD-001/state`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(state.status).toBe(200);
    const { data } = integrationSuccessEnvelopeSchema(
      integrationProjectStateSchema,
    ).parse(await state.json());
    const { id, name, status, progress, currentStage, outcome } =
      envelope.data.project;
    expect(data).toEqual({
      id,
      name,
      status,
      progress,
      currentStage: currentStage && { ...currentStage, tasks: [] },
      outcome: { ...outcome, locator: null, evidenceReference: null },
      sourceTaskId: envelope.data.sourceTask.id,
    });
  });

  it("keeps project-only reads free of evidence, materials and work-item details", async () => {
    const url = `${api}/integration/projects/PRJ-OTD-001`;
    const headers = { authorization: `Bearer ${ownerToken}` };
    const response = await fetch(`${url}/context`, { headers });
    expect(response.status).toBe(200);
    const { data } = integrationSuccessEnvelopeSchema(
      integrationProjectContextSchema,
    ).parse(await response.json());
    expect(data.sourceTask).toMatchObject({
      facts: [],
      evidence: [],
      materials: [],
      materialGaps: [],
    });
    expect(data.project.phases.flatMap((phase) => phase.tasks)).toEqual([]);
    expect(data.project.latestConfirmedWorkpaper).toBeNull();
    const operations = await fetch(`${url}/operations`, { headers });
    expect(operations.status).toBe(200);
    const operationContext = integrationSuccessEnvelopeSchema(
      workExecutionContextSchema,
    ).parse(await operations.json()).data;
    expect(operationContext.allowedActions).toEqual([]);
    expect(
      operationContext.project?.phases.flatMap((phase) => phase.tasks),
    ).toEqual([]);
    expect(operationContext.project?.node.subtasks).toEqual([]);
    const progress = await fetch(
      `${url}/operations?workItemId=SUB-SOLUTION-001`,
      { headers },
    );
    expect(progress.status).toBe(403);
    expect(await progress.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(
      operationContext.project?.auditTrail.every(
        (item) => Object.keys(item.snapshot).length === 0,
      ),
    ).toBe(true);

    const reserved = "PRJ-SO-202608136";
    const reservedToken = randomUUID();
    vi.stubEnv(
      "DINGJIANG_MCP_TOKEN_BINDINGS_JSON",
      JSON.stringify([
        {
          token: reservedToken,
          tenantId: "tenant-demo",
          subjectId: "reserved-project-scope-test",
          role: "PMC",
          scopes: ["project:read"],
          projectIds: [reserved],
        },
      ]),
    );
    try {
      const reservedResponse = await fetch(
        `${api}/integration/projects/${reserved}/operations`,
        {
          headers: { authorization: `Bearer ${reservedToken}` },
        },
      );
      expect(reservedResponse.status).toBe(200);
      const { data: reservation } = integrationSuccessEnvelopeSchema(
        workExecutionContextSchema,
      ).parse(await reservedResponse.json());
      expect(reservation.project).toBeNull();
      expect(reservation.sourceTask).toMatchObject({
        id: "SO-202608136",
        facts: [],
        evidence: [],
        materials: [],
        situations: [],
      });
      expect(reservation.sourceTask).not.toHaveProperty("order");
      expect(reservation.sourceTask).not.toHaveProperty("analysis");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("derives current project and work item from the token-bound project set", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const projectsResponse = await fetch(`${api}/integration/projects`, {
      headers,
    });
    expect(projectsResponse.status).toBe(200);
    const projects = integrationSuccessEnvelopeSchema(
      integrationProjectListSchema,
    ).parse(await projectsResponse.json()).data;
    expect(projects.items.map((project) => project.id)).toEqual([
      "PRJ-OTD-001",
    ]);
    expect(projects.currentProjectId).toBe("PRJ-OTD-001");

    for (const path of [
      "projects/current",
      "projects/current/work-item",
      "projects/PRJ-OTD-001/state",
      "projects/PRJ-OTD-001/work-items",
    ]) {
      const response = await fetch(`${api}/integration/${path}`, { headers });
      expect(response.status, path).toBe(200);
      expect((await response.json()) as { ok: boolean }).toMatchObject({
        ok: true,
      });
    }
    const pmcCurrent = integrationSuccessEnvelopeSchema(
      integrationCurrentWorkItemSchema,
    ).parse(
      await (
        await fetch(`${api}/integration/projects/current/work-item`, {
          headers,
        })
      ).json(),
    ).data;
    expect(pmcCurrent.item).toMatchObject({ owner: "PMC", status: "READY" });

    const ownerCurrentResponse = await fetch(
      `${api}/integration/projects/current/work-item`,
      { headers: { authorization: `Bearer ${ownerWorkToken}` } },
    );
    expect(ownerCurrentResponse.status).toBe(200);
    const ownerCurrent = integrationSuccessEnvelopeSchema(
      integrationCurrentWorkItemSchema,
    ).parse(await ownerCurrentResponse.json()).data;
    expect(ownerCurrent.item).toBeNull();

    const ownerItemsResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/work-items`,
      { headers: { authorization: `Bearer ${ownerWorkToken}` } },
    );
    const ownerItems = integrationSuccessEnvelopeSchema(
      integrationWorkItemListSchema,
    ).parse(await ownerItemsResponse.json()).data.items;
    expect(ownerItems.length).toBeGreaterThan(0);
    expect(ownerItems.every((item) => item.owner === "OWNER")).toBe(true);
    const workpaper = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/workpaper`,
      { headers },
    );
    expect([200, 404]).toContain(workpaper.status);
    const workpaperBody = (await workpaper.json()) as { ok: boolean };
    expect(workpaperBody.ok).toBe(workpaper.status === 200);
  });

  it("reads the authorized workspace in one response with optional workpaper", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(`${api}/integration/workspace/resume`, {
      headers,
    });
    expect(response.status).toBe(200);
    const { data } = integrationSuccessEnvelopeSchema(
      integrationWorkspaceResumeSchema,
    ).parse(await response.json());
    expect(data).toMatchObject({
      projectId: "PRJ-OTD-001",
      projects: {
        currentProjectId: "PRJ-OTD-001",
        items: [{ id: "PRJ-OTD-001" }],
      },
      currentWorkItem: { item: { owner: "PMC" } },
      nextAction: {
        kind: "WORK_ITEM",
        workItemId: data.currentWorkItem.item?.id,
        classification: "PROPOSAL",
      },
      workpaper: null,
    });
    expect(data.workItems.items.every((item) => item.owner === "PMC")).toBe(
      true,
    );
    expect(data.evidence.items.length).toBeGreaterThan(0);
  });

  it("requires all workspace read scopes and an allowed current project", async () => {
    const scopes = [
      "project:read",
      "workitem:read",
      "evidence:read",
      "material:read",
      "workpaper:read",
    ];
    const bindings = [...scopes, null].map((omitted) => ({
      token: randomUUID(),
      tenantId: "tenant-demo",
      subjectId: "workspace-test",
      role: "OWNER",
      scopes: scopes.filter((scope) => scope !== omitted),
      projectIds: omitted ? ["PRJ-OTD-001"] : ["PRJ-NOT-AUTHORIZED"],
    }));
    vi.stubEnv("DINGJIANG_MCP_TOKEN_BINDINGS_JSON", JSON.stringify(bindings));
    try {
      for (const [index, binding] of bindings.entries()) {
        const response = await fetch(`${api}/integration/workspace/resume`, {
          headers: { authorization: `Bearer ${binding.token}` },
        });
        const missingProject = index === scopes.length;
        expect(response.status, scopes[index]).toBe(missingProject ? 404 : 403);
        expect(
          integrationFailureEnvelopeSchema.parse(await response.json()).error
            .code,
        ).toBe(missingProject ? "NOT_FOUND" : "FORBIDDEN");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the source facts in the project selection's database snapshot", async () => {
    const db = createPool();
    const sourceTaskId = "SO-202608128";
    const writeCustomer = async (customer: string) => {
      await db.query(
        "UPDATE vs01_orders SET customer = $1 WHERE tenant_id = 'tenant-demo' AND order_id = $2",
        [customer, sourceTaskId],
      );
    };
    try {
      const { rows } = await db.query<{ customer: string }>(
        "SELECT customer FROM vs01_orders WHERE tenant_id = 'tenant-demo' AND order_id = $1",
        [sourceTaskId],
      );
      const previous = rows[0]!.customer;
      const changed = `Workspace fixture ${randomUUID()}`;
      const task = ReadModelService.prototype.task;
      const interleaved = vi
        .spyOn(ReadModelService.prototype, "task")
        .mockImplementationOnce(async function (
          this: ReadModelService,
          id: string,
        ) {
          expect(id).toBe(sourceTaskId);
          // This independent connection commits after project selection.
          await writeCustomer(changed);
          return task.call(this, id);
        });
      try {
        const readCustomer = async () => {
          const response = await fetch(`${api}/integration/workspace/resume`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.status).toBe(200);
          const { data } = integrationSuccessEnvelopeSchema(
            integrationWorkspaceResumeSchema,
          ).parse(await response.json());
          return data.evidence.items.find((item) =>
            item.id.startsWith("E-ORDER-"),
          )?.fields.customer;
        };
        expect(await readCustomer()).toBe(previous);
        expect(interleaved).toHaveBeenCalledExactlyOnceWith(sourceTaskId);
        expect(await readCustomer()).toBe(changed);
      } finally {
        interleaved.mockRestore();
        await writeCustomer(previous);
      }
    } finally {
      await db.end();
    }
  });

  it("returns the role-owned current item as the next action", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const currentResponse = await fetch(
      `${api}/integration/projects/current/work-item`,
      { headers },
    );
    expect(currentResponse.status).toBe(200);
    const { projectId, item } = integrationSuccessEnvelopeSchema(
      integrationCurrentWorkItemSchema,
    ).parse(await currentResponse.json()).data;
    if (!item)
      throw new Error("Expected the fixture to have a current work item");

    const response = await fetch(
      `${api}/integration/projects/${projectId}/next-action`,
      { headers },
    );
    expect(response.status).toBe(200);
    const { data } = integrationSuccessEnvelopeSchema(nextActionSchema).parse(
      await response.json(),
    );
    expect(data).toEqual({
      kind: "WORK_ITEM",
      projectId,
      workItemId: item.id,
      title: item.title,
      responsibleRole: item.owner,
      explanation: "当前服务端派生事项优先处理",
      classification: "PROPOSAL",
    });
  });

  it("uses the same first material gap when there is no current work item", async () => {
    const headers = { authorization: `Bearer ${ownerMaterialToken}` };
    const projectId = "PRJ-OTD-001";
    const url = `${api}/integration/projects/${projectId}`;
    const materials = await fetch(`${url}/materials`, { headers });
    expect(materials.status).toBe(200);
    const [gap] = integrationSuccessEnvelopeSchema(
      integrationMaterialListSchema,
    ).parse(await materials.json()).data.gaps;
    if (!gap) throw new Error("Expected the fixture to have a material gap");

    const response = await fetch(`${url}/next-action`, { headers });
    expect(response.status).toBe(200);
    expect(
      integrationSuccessEnvelopeSchema(nextActionSchema).parse(
        await response.json(),
      ).data,
    ).toEqual({
      kind: "MATERIAL_GAP",
      projectId,
      requirementId: gap.requirementId,
      title: gap.label,
      explanation: `材料缺口状态为 ${gap.status}`,
      classification: "PROPOSAL",
    });
  });

  it("rejects a next action outside material or project permissions", async () => {
    for (const [projectId, bearer] of [
      ["PRJ-OTD-001", ownerWorkToken],
      ["PRJ-NOT-AUTHORIZED", token],
    ]) {
      const response = await fetch(
        `${api}/integration/projects/${projectId}/next-action`,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      expect(response.status).toBe(403);
      expect(
        integrationFailureEnvelopeSchema.parse(await response.json()).error
          .code,
      ).toBe("FORBIDDEN");
    }
  });

  it("reads evidence, material and source-version details only inside the project", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const contextResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/context`,
      { headers },
    );
    const context = integrationSuccessEnvelopeSchema(
      integrationProjectContextSchema,
    ).parse(await contextResponse.json()).data;
    const evidence = context.sourceTask.evidence[0]!;
    const evidenceResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/evidence/${encodeURIComponent(evidence.id)}`,
      { headers },
    );
    expect(evidenceResponse.status).toBe(200);
    expect(
      integrationSuccessEnvelopeSchema(integrationEvidenceDetailSchema).parse(
        await evidenceResponse.json(),
      ).data,
    ).toEqual({
      projectId: "PRJ-OTD-001",
      sourceTaskId: context.sourceTask.id,
      item: evidence,
    });
    const versionResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/source-versions/${encodeURIComponent(evidence.sourceVersionId)}`,
      { headers },
    );
    expect(versionResponse.status).toBe(200);

    await app.get(Vs01Service).addTaskMaterial(context.sourceTask.id, {
      actor: "PMC",
      situationCode: "CAPACITY_RISK",
      title: "HTTP 预览权限回归",
      sourceReference: "线下产能记录",
    });
    const materialResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/materials`,
      { headers },
    );
    const materials = integrationSuccessEnvelopeSchema(
      integrationMaterialListSchema,
    ).parse(await materialResponse.json()).data;
    const material = materials.items.find(
      (item) => item.title === "HTTP 预览权限回归",
    );
    if (!material) throw new Error("Expected the registered material");
    const previewPath = `materials/${encodeURIComponent(material.id)}/preview`;
    const projectUrl = `${api}/integration/projects/PRJ-OTD-001`;
    const preview = await fetch(`${projectUrl}/${previewPath}`, { headers });
    expect(preview.status).toBe(200);
    expect(
      integrationSuccessEnvelopeSchema(integrationMaterialPreviewSchema).parse(
        await preview.json(),
      ).data,
    ).toEqual({
      projectId: "PRJ-OTD-001",
      sourceTaskId: context.sourceTask.id,
      bodyAvailable: false,
      material,
    });

    const scopedToken = randomUUID();
    vi.stubEnv(
      "DINGJIANG_MCP_TOKEN_BINDINGS_JSON",
      JSON.stringify([
        {
          token: scopedToken,
          tenantId: "tenant-demo",
          subjectId: "integration-details",
          role: "PMC",
          scopes: ["evidence:read", "material:read"],
          projectIds: ["PRJ-OTD-001"],
        },
      ]),
    );
    try {
      for (const [path, status] of [
        ["evidence", 403],
        [`evidence/${encodeURIComponent(evidence.id)}`, 403],
        [previewPath, 403],
        ["evidence/missing", 404],
        ["materials/missing/preview", 404],
      ] as const) {
        const response = await fetch(`${projectUrl}/${path}`, {
          headers: { authorization: `Bearer ${scopedToken}` },
        });
        expect(response.status, path).toBe(status);
        expect(
          integrationFailureEnvelopeSchema.parse(await response.json()).error
            .code,
        ).toBe(status === 403 ? "FORBIDDEN" : "NOT_FOUND");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a role-scoped work context with only project and work-item permissions", async () => {
    const url = `${api}/integration/projects/PRJ-OTD-001/work-context`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${ownerWorkToken}` },
    });
    expect(response.status).toBe(200);
    const { data } = integrationSuccessEnvelopeSchema(
      integrationWorkContextSchema,
    ).parse(await response.json());
    expect(data).toMatchObject({
      projectId: "PRJ-OTD-001",
      context: { sourceTask: { id: "SO-202608128" } },
      state: { id: "PRJ-OTD-001", sourceTaskId: "SO-202608128" },
      currentWorkItem: { projectId: "PRJ-OTD-001", item: null },
    });
    expect(data.workItems.items.length).toBeGreaterThan(0);
    expect(data.workItems.items.every((item) => item.owner === "OWNER")).toBe(
      true,
    );
    expect(
      (
        await fetch(url, {
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(403);
  });

  it("requires the evidence bundle scopes even when a workpaper is absent", async () => {
    const path = `${api}/integration/projects/PRJ-OTD-001`;
    const scopes = [
      "project:read",
      "evidence:read",
      "material:read",
      "workpaper:read",
    ];
    const bindings = [...scopes, null].map((omitted) => ({
      token: randomUUID(),
      tenantId: "tenant-demo",
      subjectId: "integration-evidence-bundle",
      role: "PMC",
      scopes: scopes.filter((scope) => scope !== omitted),
      projectIds: ["PRJ-OTD-001"],
    }));
    vi.stubEnv("DINGJIANG_MCP_TOKEN_BINDINGS_JSON", JSON.stringify(bindings));
    try {
      const headers = { authorization: `Bearer ${bindings.at(-1)!.token}` };
      const response = await fetch(`${path}/evidence-bundle`, { headers });
      expect(response.status).toBe(200);
      const { data } = integrationSuccessEnvelopeSchema(
        integrationEvidenceBundleSchema,
      ).parse(await response.json());
      expect(data.projectId).toBe("PRJ-OTD-001");
      expect(data.evidence.sourceTaskId).toBe("SO-202608128");
      expect(data.evidence.items.length).toBeGreaterThan(0);
      expect(data.materials.sourceTaskId).toBe(data.evidence.sourceTaskId);
      const workpaper = await fetch(`${path}/workpaper`, { headers });
      expect(workpaper.status).toBe(404);
      expect(data.workpaper).toBeNull();
      for (const [index, binding] of bindings.slice(0, -1).entries()) {
        const denied = await fetch(`${path}/evidence-bundle`, {
          headers: { authorization: `Bearer ${binding.token}` },
        });
        expect(denied.status, scopes[index]).toBe(403);
        expect(
          integrationFailureEnvelopeSchema.parse(await denied.json()).error
            .code,
        ).toBe("FORBIDDEN");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("projects each read scope consistently across aggregate and individual tools", async () => {
    const projectId = "PRJ-OTD-001";
    const url = `${api}/integration/projects/${projectId}`;
    const csv = Buffer.from("day,load\n2026-08-20,scope-matrix-preview");
    const material = await app.get(Vs01Service).importTaskMaterial(
      "SO-202608128",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "Scope matrix CSV",
        requestId: randomUUID(),
      },
      { originalName: "scope-matrix.csv", buffer: csv, size: csv.length },
    );
    const all = [
      "project:read",
      "workitem:read",
      "evidence:read",
      "material:read",
      "workpaper:read",
      "experience:read",
    ];
    const cases = [
      {
        scopes: ["project:read", "workitem:read"],
        projectIds: [projectId],
        tenantId: "tenant-demo",
      },
      ...["evidence:read", "material:read", "workpaper:read", null].map(
        (omitted) => ({
          scopes: all.filter((scope) => scope !== omitted),
          projectIds: [projectId],
          tenantId: "tenant-demo",
        }),
      ),
      {
        scopes: all,
        projectIds: ["PRJ-NOT-AUTHORIZED"],
        tenantId: "tenant-demo",
      },
      { scopes: all, projectIds: [projectId], tenantId: "tenant-other" },
    ];
    const bindings = cases.map((entry) => ({
      ...entry,
      token: randomUUID(),
      subjectId: "scope-matrix",
      role: "PMC",
    }));
    vi.stubEnv("DINGJIANG_MCP_TOKEN_BINDINGS_JSON", JSON.stringify(bindings));
    try {
      for (const binding of bindings) {
        const headers = { authorization: `Bearer ${binding.token}` };
        const read = (path: string) => fetch(`${url}/${path}`, { headers });
        const authorized =
          binding.projectIds.includes(projectId) &&
          binding.tenantId === "tenant-demo";
        const evidence = binding.scopes.includes("evidence:read");
        const materials = binding.scopes.includes("material:read");
        const full =
          evidence && materials && binding.scopes.includes("workpaper:read");
        const [
          contextResponse,
          workResponse,
          evidenceResponse,
          materialResponse,
          resume,
        ] = await Promise.all([
          read("context"),
          read("work-context"),
          read("evidence"),
          read("materials"),
          fetch(`${api}/integration/workspace/resume`, { headers }),
        ]);
        if (!authorized) {
          for (const response of [
            contextResponse,
            workResponse,
            evidenceResponse,
            materialResponse,
            resume,
          ]) {
            expect(response.status).toBe(
              response === resume && binding.tenantId === "tenant-demo"
                ? 404
                : 403,
            );
            expect(
              integrationFailureEnvelopeSchema.parse(await response.json()).ok,
            ).toBe(false);
          }
          continue;
        }
        expect(contextResponse.status).toBe(200);
        expect(workResponse.status).toBe(200);
        expect(evidenceResponse.status).toBe(evidence ? 200 : 403);
        expect(materialResponse.status).toBe(materials ? 200 : 403);
        expect(resume.status).toBe(full ? 200 : 403);
        const { data: context } = integrationSuccessEnvelopeSchema(
          integrationProjectContextSchema,
        ).parse(await contextResponse.json());
        const { data: work } = integrationSuccessEnvelopeSchema(
          integrationWorkContextSchema,
        ).parse(await workResponse.json());
        expect(context.sourceTask.evidence.length > 0).toBe(evidence);
        expect(context.sourceTask.facts.length > 0).toBe(evidence);
        expect(context.sourceTask.materials.length > 0).toBe(materials);
        expect(context.sourceTask.materialGaps.length > 0).toBe(materials);
        expect(work.context.sourceTask.evidence).toEqual(
          context.sourceTask.evidence,
        );
        expect(work.context.sourceTask.facts).toEqual(context.sourceTask.facts);
        expect(
          work.context.sourceTask.materials.map((item) => item.id),
        ).toEqual(context.sourceTask.materials.map((item) => item.id));
        expect(work.context.sourceTask.materialGaps).toEqual(
          context.sourceTask.materialGaps,
        );
        expect(work.workItems.items.every((item) => item.owner === "PMC")).toBe(
          true,
        );
        if (evidence) {
          const { data: list } = integrationSuccessEnvelopeSchema(
            integrationEvidenceListSchema,
          ).parse(await evidenceResponse.json());
          expect(list.items).toEqual(context.sourceTask.evidence);
        } else {
          expect(
            integrationFailureEnvelopeSchema.parse(
              await evidenceResponse.json(),
            ).error.code,
          ).toBe("FORBIDDEN");
        }
        if (materials) {
          const { data: list } = integrationSuccessEnvelopeSchema(
            integrationMaterialListSchema,
          ).parse(await materialResponse.json());
          expect(list.items.map((item) => item.id)).toEqual(
            context.sourceTask.materials.map((item) => item.id),
          );
          expect(
            context.sourceTask.materials.find((item) => item.id === material.id)
              ?.file?.contentPreview,
          ).toContain("scope-matrix-preview");
        } else {
          expect(
            integrationFailureEnvelopeSchema.parse(
              await materialResponse.json(),
            ).error.code,
          ).toBe("FORBIDDEN");
          const preview = await read(`materials/${material.id}/preview`);
          expect(preview.status).toBe(403);
          expect(
            integrationFailureEnvelopeSchema.parse(await preview.json()).error
              .code,
          ).toBe("FORBIDDEN");
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns 403 for an unlisted project before resource lookup", async () => {
    const response = await fetch(
      `${api}/integration/projects/PRJ-NOT-AUTHORIZED/context`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(403);
    expect(
      integrationFailureEnvelopeSchema.parse(await response.json()).error.code,
    ).toBe("FORBIDDEN");
  });

  it("accepts wildcard project reads while requiring an explicit project for writes", async () => {
    const headers = { authorization: `Bearer ${wildcardToken}` };
    const projectsResponse = await fetch(`${api}/integration/projects`, {
      headers,
    });
    expect(projectsResponse.status).toBe(200);
    const projects = integrationSuccessEnvelopeSchema(
      integrationProjectListSchema,
    ).parse(await projectsResponse.json()).data;
    expect(projects.items.map((project) => project.id)).toContain(
      "PRJ-OTD-001",
    );

    const url = `${api}/integration/projects/PRJ-OTD-001/operations`;
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    const operations = integrationSuccessEnvelopeSchema(
      workExecutionContextSchema,
    ).parse(await response.json()).data;
    expect(operations.project?.id).toBe("PRJ-OTD-001");
    expect(operations.allowedActions).toEqual([]);

    const write = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: operations.version,
        reason: "验证显式项目写授权",
        payload: {
          stateFingerprint: operations.stateFingerprint,
          confirmation: "隔离测试中的模拟确认",
          operation: { action: "project.submit" },
        },
      }),
    });
    expect(write.status).toBe(403);
  });

  it("reads the requested project and rejects writing its work item to another authorized project", async () => {
    const business = app.get(Vs01Service);
    const sourceTaskId = "SO-202608136";
    await business.decideTask(sourceTaskId, {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立非当前项目的测试夹具",
    });
    const secondProject = await business.createProject({
      actor: "PMC",
      sourceTaskId,
    });
    const bearer = randomUUID();
    const headers = { authorization: `Bearer ${bearer}` };
    vi.stubEnv(
      "DINGJIANG_MCP_TOKEN_BINDINGS_JSON",
      JSON.stringify([
        {
          token: bearer,
          tenantId: "tenant-demo",
          subjectId: "integration-cross-project",
          role: "PMC",
          scopes: [
            "project:read",
            "workitem:read",
            "workitem:write",
            "material:read",
          ],
          projectIds: ["PRJ-OTD-001", secondProject.id],
        },
      ]),
    );
    try {
      const current = await fetch(
        `${api}/integration/projects/current/work-item`,
        { headers },
      );
      const { projectId: currentProjectId } = integrationSuccessEnvelopeSchema(
        integrationCurrentWorkItemSchema,
      ).parse(await current.json()).data;
      const projectId =
        currentProjectId === secondProject.id
          ? "PRJ-OTD-001"
          : secondProject.id;
      const url = `${api}/integration/projects/${projectId}`;
      const contextResponse = await fetch(`${url}/work-context`, { headers });
      expect(contextResponse.status).toBe(200);
      const { data } = integrationSuccessEnvelopeSchema(
        integrationWorkContextSchema,
      ).parse(await contextResponse.json());
      const item = data.currentWorkItem.item;
      expect(item).toMatchObject({
        projectId,
        owner: "PMC",
        origin: "LIVE",
        status: "READY",
        phaseCode: data.context.project.currentStage?.code,
      });
      expect(data.currentWorkItem.projectId).toBe(projectId);
      const next = await fetch(`${url}/next-action`, { headers });
      expect(next.status).toBe(200);
      expect(
        integrationSuccessEnvelopeSchema(nextActionSchema).parse(
          await next.json(),
        ).data,
      ).toMatchObject({
        kind: "WORK_ITEM",
        projectId,
        workItemId: item?.id,
        classification: "PROPOSAL",
      });

      if (!item) throw new Error("Missing work item in the other project");
      const operationsUrl = `${api}/integration/projects/${currentProjectId}/operations`;
      const readOperations = async (endpoint: string) => {
        const response = await fetch(endpoint, { headers });
        expect(response.status).toBe(200);
        return integrationSuccessEnvelopeSchema(
          workExecutionContextSchema,
        ).parse(await response.json()).data;
      };
      const otherOperationsUrl = `${url}/operations`;
      const before = await readOperations(operationsUrl);
      const otherBefore = await readOperations(otherOperationsUrl);
      expect(before.allowedActions).toContain("progress.record");
      expect(otherBefore.allowedActions).toContain("progress.record");
      const correlationId = randomUUID();
      const response = await fetch(operationsUrl, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-correlation-id": correlationId,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          correlationId,
          expectedVersion: before.version,
          reason: "验证跨项目事项不产生进展",
          payload: {
            stateFingerprint: before.stateFingerprint,
            confirmation: "隔离测试中的模拟确认",
            operation: {
              action: "progress.record",
              workItemId: item.id,
              note: "这条跨项目进展不得落库",
            },
          },
        }),
      });
      expect(response.status).toBe(403);
      expect(
        integrationFailureEnvelopeSchema.parse(await response.json()),
      ).toMatchObject({
        correlationId,
        error: {
          code: "PERMISSION_DENIED",
          message: "事项不属于当前项目",
        },
      });
      expect(await readOperations(operationsUrl)).toEqual(before);
      expect(await readOperations(otherOperationsUrl)).toEqual(otherBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps role scopes and tenant identity bound to the server token", async () => {
    const ownerEvidence = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/evidence`,
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerEvidence.status).toBe(403);

    vi.stubEnv("DINGJIANG_RATE_LIMIT_ENABLED", undefined);
    vi.stubEnv("DINGJIANG_RATE_LIMIT_READ_PER_MIN", "1");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    try {
      const readAsOtherTenant = () =>
        fetch(`${api}/integration/projects`, {
          headers: { authorization: `Bearer ${otherTenantToken}` },
        });
      expect((await readAsOtherTenant()).status).toBe(403);
      expect((await readAsOtherTenant()).status).toBe(403);
    } finally {
      clock.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
