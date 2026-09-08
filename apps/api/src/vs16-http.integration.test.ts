import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  projectSchema,
  validationWorkpaperViewSchema,
} from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { Vs01Service } from "./vs01.service";

const businessState = (project: unknown) => {
  const parsed = projectSchema.parse(project);
  return {
    status: parsed.status,
    progress: parsed.progress,
    phases: parsed.phases.map((phase) => ({
      code: phase.code,
      status: phase.status,
      gate: phase.gate.status,
      tasks: phase.tasks.map((task) => ({ id: task.id, status: task.status })),
    })),
  };
};

const json = async (
  url: string,
  role: string | undefined,
  init: RequestInit = {},
) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(role ? { "x-vs01-role": role } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
};

const runHttpIntegration =
  process.env.VS16_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs16:http";
const httpDescribe = runHttpIntegration ? describe : describe.skip;

httpDescribe("VS16 HTTP root cause workpaper", () => {
  let app: INestApplication;
  let api = "";
  let projectId = "";
  let materialId = "";

  beforeAll(async () => {
    process.env.NO_PROXY = "*";
    process.env.no_proxy = "*";
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    api = `http://127.0.0.1:${address.port}/api`;
    const service = app.get(Vs01Service);
    await service.reset({ actor: "PMC" });
    materialId = (
      await service.importTaskMaterial(
        "SO-202608136",
        {
          actor: "PMC",
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          title: "HTTP 产能记录",
          note: "VS16 HTTP 验收",
          requestId: "06111111-1111-4111-8111-111111111121",
        },
        {
          originalName: "http-产能.csv",
          buffer: Buffer.from("日期,负荷率\n2026-08-20,92%"),
          size: 31,
        },
      )
    ).id;
    await service.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "HTTP 建立任务",
    });
    projectId = (
      await service.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("enforces PMC role and exposes only the contract-safe candidate view", async () => {
    const path = `/vs16/projects/${projectId}/root-cause-workpaper`;
    const forbidden = await fetch(`${api}${path}`);
    expect(forbidden.status).toBe(403);
    const initial = await fetch(`${api}${path}`, {
      headers: { "x-vs01-role": "PMC" },
    });
    expect(initial.status).toBe(200);
    validationWorkpaperViewSchema.parse(await initial.json());
    const candidate = await fetch(`${api}${path}/candidate-runs`, {
      method: "POST",
      headers: { "x-vs01-role": "PMC", "content-type": "application/json" },
      body: JSON.stringify({
        actor: "PMC",
        requestId: "06111111-1111-4111-8111-111111111122",
        expectedRevision: 0,
        materialIds: [materialId],
      }),
    });
    expect(candidate.status).toBe(201);
    const body = validationWorkpaperViewSchema.parse(await candidate.json());
    expect(body.current?.classification).toBe("PROPOSAL");
    expect(JSON.stringify(body)).not.toContain("storage_key");
    expect(JSON.stringify(body)).not.toContain("C:\\");
    expect(JSON.stringify(body)).not.toMatch(
      /(?:storageKey|tenantId|byteSize|bytes|path)/i,
    );
  });

  it("returns structured stale/idempotency behavior and keeps assistant and candidates read-only", async () => {
    const path = `/vs16/projects/${projectId}/root-cause-workpaper`;
    const before = await json(`${api}/vs01/projects/${projectId}`, "PMC");
    expect(before.response.status).toBe(200);
    const beforeState = businessState(before.body);
    const candidateBody = {
      actor: "PMC",
      requestId: "06111111-1111-4111-8111-111111111123",
      expectedRevision: 1,
      materialIds: [materialId],
    };
    const first = await json(`${api}${path}/candidate-runs`, "PMC", {
      method: "POST",
      body: JSON.stringify(candidateBody),
    });
    expect(first.response.status).toBe(201);
    const firstView = validationWorkpaperViewSchema.parse(first.body);
    const retry = await json(`${api}${path}/candidate-runs`, "PMC", {
      method: "POST",
      body: JSON.stringify(candidateBody),
    });
    expect(retry.response.status).toBe(201);
    expect(validationWorkpaperViewSchema.parse(retry.body).revision).toBe(
      firstView.revision,
    );

    const stale = await json(`${api}${path}/candidate-runs`, "PMC", {
      method: "POST",
      body: JSON.stringify({
        ...candidateBody,
        requestId: "06111111-1111-4111-8111-111111111124",
        expectedRevision: 1,
      }),
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "STALE_WORKPAPER" });

    const assistant = await json(
      `${api}/vs12/projects/${projectId}/assistant/runs`,
      "PMC",
      {
        method: "POST",
        body: JSON.stringify({
          intent: "ASK",
          question: "请只根据当前根因核验材料给出下一步建议",
        }),
      },
    );
    expect(assistant.response.status).toBe(201);
    expect(assistant.body).toMatchObject({ classification: "PROPOSAL" });
    const after = await json(`${api}/vs01/projects/${projectId}`, "PMC");
    expect(after.response.status).toBe(200);
    expect(businessState(after.body)).toEqual(beforeState);
  });

  it("does not expose a VS16 workpaper across another consultation project", async () => {
    const service = app.get(Vs01Service);
    await service.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "HTTP 验证其他咨询项目隔离。",
    });
    const otherProject = await service.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    const response = await fetch(
      `${api}/vs16/projects/${otherProject.id}/root-cause-workpaper`,
      { headers: { "x-vs01-role": "PMC" } },
    );
    expect(response.status).toBe(404);
  });
});
