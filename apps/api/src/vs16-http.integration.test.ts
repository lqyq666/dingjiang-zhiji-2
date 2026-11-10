import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  integrationFailureEnvelopeSchema,
  integrationProjectContextSchema,
  integrationSuccessEnvelopeSchema,
  integrationValidationWorkpaperSchema,
  integrationWorkContextSchema,
  integrationWorkspaceResumeSchema,
  projectSchema,
  validationWorkpaperViewSchema,
} from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

  it("includes an existing workpaper inside the authorized workspace read", async () => {
    const token = "local-workspace-workpaper-test-token";
    const workpaperOnly = "local-workpaper-only-test-token";
    vi.stubEnv(
      "DINGJIANG_MCP_TOKEN_BINDINGS_JSON",
      JSON.stringify([
        {
          token,
          tenantId: "tenant-demo",
          subjectId: "workspace-workpaper-test",
          role: "PMC",
          scopes: [
            "project:read",
            "workitem:read",
            "evidence:read",
            "material:read",
            "workpaper:read",
          ],
          projectIds: [projectId],
        },
        {
          token: workpaperOnly,
          tenantId: "tenant-demo",
          subjectId: "workpaper-only-test",
          role: "PMC",
          scopes: ["workpaper:read"],
          projectIds: [projectId],
        },
      ]),
    );
    try {
      const headers = { authorization: `Bearer ${token}` };
      const [resumed, individual] = await Promise.all([
        fetch(`${api}/integration/workspace/resume`, { headers }),
        fetch(`${api}/integration/projects/${projectId}/workpaper`, {
          headers,
        }),
      ]);
      expect(resumed.status).toBe(200);
      expect(individual.status).toBe(200);
      const snapshot = integrationSuccessEnvelopeSchema(
        integrationWorkspaceResumeSchema,
      ).parse(await resumed.json()).data;
      const { data: workpaper } = integrationSuccessEnvelopeSchema(
        validationWorkpaperViewSchema,
      ).parse(await individual.json());
      expect(snapshot.workpaper).toMatchObject({
        id: workpaper.id,
        projectId,
        revision: workpaper.revision,
        current: workpaper.current,
      });
      expect(snapshot.workpaper).not.toHaveProperty("history");

      const direct = await json(
        `${api}/vs16/projects/${projectId}/root-cause-workpaper`,
        "PMC",
      );
      expect(direct.response.status).toBe(200);
      expect(workpaper).toEqual(
        validationWorkpaperViewSchema.parse(direct.body),
      );
      expect(workpaper.history).toHaveLength(1);
      expect(
        workpaper.context.materials.map((item) => item.materialId),
      ).toEqual([materialId]);
      expect(workpaper.context.materialGaps).toEqual([]);

      const denied = await fetch(
        `${api}/integration/projects/${projectId}/workpaper`,
        {
          headers: { authorization: `Bearer ${workpaperOnly}` },
        },
      );
      expect(denied.status).toBe(403);
      expect(
        integrationFailureEnvelopeSchema.parse(await denied.json()).error.code,
      ).toBe("FORBIDDEN");
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("applies input scopes to a confirmed workpaper and its work-item locator", async () => {
    const root = `${api}/vs16/projects/${projectId}/root-cause-workpaper`;
    const draftResponse = await json(root, "PMC");
    expect(draftResponse.response.status).toBe(200);
    const draft = validationWorkpaperViewSchema.parse(draftResponse.body);
    const content = draft.current?.content;
    if (!content) throw new Error("Missing real workpaper candidate");
    const complete = await json(`${root}/complete`, "PMC", {
      method: "POST",
      body: JSON.stringify({
        actor: "PMC",
        requestId: randomUUID(),
        expectedRevision: draft.revision,
        completionNote: "范围回归使用的员工确认记录",
        confirmedAcceptanceCriteria: draft.workItem.acceptanceCriteria,
        content: {
          ...content,
          materialFindings: content.materialFindings.map((item) => ({
            ...item,
            assessment: "SUPPORTS",
            verificationStatus: "EMPLOYEE_CHECKED",
          })),
          conclusion: {
            result: "SUPPORTS",
            statement: "scope-matrix-confirmed-workpaper",
            limitations: "本地合成测试材料",
            nextChecks: [],
          },
        },
      }),
    });
    expect(complete.response.status).toBe(201);
    const confirmed = validationWorkpaperViewSchema.parse(
      complete.body,
    ).latestConfirmed;
    if (!confirmed) throw new Error("Missing confirmed workpaper version");

    const scopes = [
      "project:read",
      "workitem:read",
      "evidence:read",
      "material:read",
      "workpaper:read",
    ];
    const omissions = [
      null,
      "evidence:read",
      "material:read",
      "workpaper:read",
      "workitem:read",
    ];
    const bindings = omissions.map((omitted) => ({
      token: randomUUID(),
      tenantId: "tenant-demo",
      subjectId: "confirmed-workpaper-scope-test",
      role: "PMC",
      scopes: scopes.filter((scope) => scope !== omitted),
      projectIds: [projectId],
    }));
    vi.stubEnv("DINGJIANG_MCP_TOKEN_BINDINGS_JSON", JSON.stringify(bindings));
    try {
      for (const [index, { token }] of bindings.entries()) {
        const omitted = omissions[index];
        const base = `${api}/integration/projects/${projectId}`;
        const read = (path: string) =>
          fetch(`${base}/${path}`, {
            headers: { authorization: `Bearer ${token}` },
          });
        const canReadWorkpaper =
          omitted === null || omitted === "workitem:read";
        const [context, workContext, paper, locator] = await Promise.all([
          read("context"),
          read("work-context"),
          read("workpaper"),
          read(
            `source-versions/${encodeURIComponent(confirmed.locator.sourceVersionId)}`,
          ),
        ]);
        expect(context.status).toBe(200);
        const { data } = integrationSuccessEnvelopeSchema(
          integrationProjectContextSchema,
        ).parse(await context.json());
        expect(data.project.latestConfirmedWorkpaper).toEqual(
          canReadWorkpaper
            ? expect.objectContaining({
                revision: confirmed.revision,
                locator: confirmed.locator,
                conclusion: confirmed.content.conclusion,
              })
            : null,
        );
        expect(workContext.status).toBe(
          omitted === "workitem:read" ? 403 : 200,
        );
        if (workContext.ok) {
          const { data: work } = integrationSuccessEnvelopeSchema(
            integrationWorkContextSchema,
          ).parse(await workContext.json());
          expect(work.context.project.latestConfirmedWorkpaper).toEqual(
            data.project.latestConfirmedWorkpaper,
          );
          if (!canReadWorkpaper)
            expect(
              work.workItems.items.find((item) => item.id === draft.workItem.id)
                ?.output.locator,
            ).toBeNull();
        }
        expect(locator.status).toBe(
          canReadWorkpaper ? 200 : omitted === "evidence:read" ? 403 : 404,
        );
        expect(paper.status).toBe(canReadWorkpaper ? 200 : 403);
        if (paper.ok) {
          const { data: view } = integrationSuccessEnvelopeSchema(
            integrationValidationWorkpaperSchema,
          ).parse(await paper.json());
          expect(view.latestConfirmed?.locator).toEqual(confirmed.locator);
          expect(view.workItem).toEqual(
            omitted === "workitem:read"
              ? null
              : expect.objectContaining({ id: draft.workItem.id }),
          );
        } else {
          expect(
            integrationFailureEnvelopeSchema.parse(await paper.json()).error
              .code,
          ).toBe("FORBIDDEN");
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
