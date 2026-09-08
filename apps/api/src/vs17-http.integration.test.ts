import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";

const run =
  process.env.VS17_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs17:http";
(run ? describe : describe.skip)("VS17 HTTP authorization seam", () => {
  let app: INestApplication;
  let api = "";
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    api = `http://127.0.0.1:${address.port}/api`;
  });
  afterAll(async () => {
    await app.close();
  });
  it("rejects an unauthorized draft before any provider call", async () => {
    const response = await fetch(
      `${api}/vs17/projects/PRJ-OTD-001/experience-drafts/ai`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-vs01-role": "OWNER" },
        body: JSON.stringify({
          actor: "PMC",
          requestId: "17111111-1111-4111-8111-111111111111",
        }),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("strictly rejects missing or unknown structured-card fields while allowing a valid payload to reach the domain seam", async () => {
    const base = {
      actor: "PMC",
      title: "HTTP 结构化候选",
      applicableSituation: "本地集成",
      businessProblem: "交付延期",
      practice: "核对证据",
      resultSummary: "结果确认",
      limitations: "仅测试",
    };
    const post = (body: unknown) =>
      fetch(`${api}/vs01/projects/PRJ-NOT-FOUND/experience-candidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vs01-role": "PMC" },
        body: JSON.stringify(body),
      });
    expect((await post(base)).status).toBe(400);
    expect(
      (await post({ ...base, structuredCard: {}, unexpected: true })).status,
    ).toBe(400);
    const valid = await post({
      ...base,
      structuredCard: {
        trigger: "交付延期",
        conditions: ["结果已确认"],
        actions: [{ order: 1, action: "核对证据" }],
        rationale: "可追溯",
        exceptions: ["证据缺失"],
        scope: {
          products: ["产品 A"],
          departments: ["生产"],
          scenarios: ["本地"],
        },
        claims: [{ statement: "已核对", evidenceIds: ["E-ORDER-202608136"] }],
        evidenceRefs: [
          {
            sourceObjectId: "SRC-ORDERS",
            sourceVersionId: "SRC-ORDERS-V1",
            reference: "订单",
          },
        ],
        missingInformation: [],
      },
    });
    expect(valid.status).toBe(404);
  });
});
