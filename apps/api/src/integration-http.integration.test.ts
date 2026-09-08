import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  integrationCurrentWorkItemSchema,
  integrationFailureEnvelopeSchema,
  integrationMaterialListSchema,
  integrationProjectContextSchema,
  integrationProjectListSchema,
  integrationSuccessEnvelopeSchema,
  integrationWorkItemListSchema,
} from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
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
    const versionResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/source-versions/${encodeURIComponent(evidence.sourceVersionId)}`,
      { headers },
    );
    expect(versionResponse.status).toBe(200);

    const materialResponse = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/materials`,
      { headers },
    );
    const materials = integrationSuccessEnvelopeSchema(
      integrationMaterialListSchema,
    ).parse(await materialResponse.json()).data;
    if (materials.items[0]) {
      const preview = await fetch(
        `${api}/integration/projects/PRJ-OTD-001/materials/${encodeURIComponent(materials.items[0].id)}/preview`,
        { headers },
      );
      expect(preview.status).toBe(200);
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

  it("keeps role scopes and tenant identity bound to the server token", async () => {
    const ownerEvidence = await fetch(
      `${api}/integration/projects/PRJ-OTD-001/evidence`,
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(ownerEvidence.status).toBe(403);

    const otherTenantProjects = await fetch(`${api}/integration/projects`, {
      headers: { authorization: `Bearer ${otherTenantToken}` },
    });
    expect(otherTenantProjects.status).toBe(403);
  });
});
