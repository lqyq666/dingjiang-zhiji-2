import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { createPool } from "./vs01-db";

const requested =
  process.env.VS18_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs18:http";
const dedicatedDatabase = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) return false;
  try {
    return new URL(value).pathname.replace(/^\//, "").endsWith("_vs18_test");
  } catch {
    return false;
  }
})();

if (requested && !dedicatedDatabase)
  throw new Error(
    "VS18 HTTP integration requires DATABASE_URL for a dedicated local database ending in _vs18_test; refusing to reset or mutate demo data.",
  );

const httpDescribe = requested && dedicatedDatabase ? describe : describe.skip;

type Proposal = {
  id: string;
  approvalKind: "NONE" | "MONEY" | "DIRECTION";
  amount: number | null;
  status: "PROPOSED" | "ACCEPTED" | "PENDING_APPROVAL" | "SUPERSEDED";
  approvalRequestId: string | null;
  feishuDeliveryStatus: string;
};

httpDescribe("VS18 atomic task HTTP acceptance", () => {
  let app: INestApplication;
  let api = "";
  let verifier: ReturnType<typeof createPool>;
  let projectId = "";
  let money: Proposal;
  let direction: Proposal;

  const json = async (path: string, role: string, body?: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-vs01-role": role,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      response,
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  beforeAll(async () => {
    process.env.NO_PROXY = "*";
    process.env.no_proxy = "*";
    delete process.env.FEISHU_PROVIDER_MODE;
    verifier = createPool();
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number } | null;
    if (!address) throw new Error("VS18 HTTP app did not bind a local port");
    api = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app?.close();
    await verifier?.end();
  });

  it("generates durable PROPOSAL tasks, including a MONEY draft with an unknown amount", async () => {
    expect(
      (await json("/vs01/reset", "PMC", { actor: "PMC" })).response.status,
    ).toBe(201);
    expect(
      (
        await json("/vs01/tasks/SO-202608128/decision", "PMC", {
          actor: "PMC",
          type: "CONFIRMED",
          note: "VS18 HTTP acceptance fixture",
        })
      ).response.status,
    ).toBe(201);
    const created = await json("/vs01/projects", "PMC", {
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    expect(created.response.status).toBe(201);
    projectId = String(created.body.id);
    const project = await json(`/vs01/projects/${projectId}`, "PMC");
    const phases = project.body.phases as Array<{
      code: string;
      tasks: Array<{ id: string }>;
    }>;
    const solution = phases.find((phase) => phase.code === "SOLUTION_APPROVAL");
    const moneySource = solution?.tasks[0];
    if (!moneySource)
      throw new Error("VS18 fixture needs a solution work item");
    await verifier.query(
      "UPDATE vs01_project_subtasks SET title = '明确试点采购预算' WHERE id = $1 AND tenant_id = 'tenant-demo'",
      [moneySource.id],
    );

    const generated = await json(
      `/vs18/projects/${projectId}/phases/SOLUTION_APPROVAL/task-proposals/generate`,
      "PMC",
      { actor: "PMC", force: false },
    );
    expect(generated.response.status).toBe(201);
    const items = generated.body.items as Proposal[];
    expect(items).toHaveLength(3);
    money = items.find((item) => item.approvalKind === "MONEY")!;
    expect(money).toMatchObject({
      status: "PROPOSED",
      amount: null,
      approvalRequestId: null,
      feishuDeliveryStatus: "NOT_REQUIRED",
    });
    const refreshed = await json(
      `/vs18/projects/${projectId}/phases/SOLUTION_APPROVAL/task-proposals`,
      "PMC",
    );
    expect(refreshed.response.status).toBe(200);
    expect((refreshed.body.items as Proposal[]).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
  });

  it("accepts ordinary tasks directly, but requires a MONEY amount before creating a durable approval", async () => {
    const listed = await json(
      `/vs18/projects/${projectId}/phases/SOLUTION_APPROVAL/task-proposals`,
      "PMC",
    );
    const ordinary = (listed.body.items as Proposal[]).find(
      (item) => item.approvalKind === "NONE",
    );
    if (!ordinary) throw new Error("VS18 fixture needs an ordinary proposal");
    const accepted = await json(
      `/vs18/task-proposals/${ordinary.id}/accept`,
      "PMC",
      {
        actor: "PMC",
      },
    );
    expect(accepted.response.status).toBe(201);
    expect(accepted.body).toMatchObject({
      id: ordinary.id,
      status: "ACCEPTED",
      approvalRequestId: null,
      feishuDeliveryStatus: "NOT_REQUIRED",
    });

    const missingAmount = await json(
      `/vs18/task-proposals/${money.id}/accept`,
      "PMC",
      {
        actor: "PMC",
      },
    );
    expect(missingAmount.response.status).toBe(400);
    expect(missingAmount.body).toMatchObject({
      message: "金钱任务必须先填写金额",
    });

    const downgraded = await json(
      `/vs18/task-proposals/${money.id}/edit`,
      "PMC",
      {
        actor: "PMC",
        title: "核对试点事项",
        purpose: "核对试点准备情况",
        approvalKind: "NONE",
        amount: null,
      },
    );
    expect(downgraded.response.status).toBe(400);
    expect(downgraded.body).toMatchObject({
      message: "该任务仍需要金钱审批，不能降级为日常任务",
    });

    const edited = await json(`/vs18/task-proposals/${money.id}/edit`, "PMC", {
      actor: "PMC",
      title: "明确试点采购预算",
      purpose: "为试点采购明确可审批预算",
      approvalKind: "MONEY",
      amount: 1200,
    });
    expect(edited.response.status).toBe(201);
    expect(edited.body).toMatchObject({ approvalKind: "MONEY", amount: 1200 });

    const requestedApproval = await json(
      `/vs18/task-proposals/${money.id}/accept`,
      "PMC",
      {
        actor: "PMC",
      },
    );
    expect(requestedApproval.response.status).toBe(201);
    expect(requestedApproval.body).toMatchObject({
      status: "PENDING_APPROVAL",
      approvalRequestId: expect.any(String),
      feishuDeliveryStatus: "NOT_CONFIGURED",
    });
    money = requestedApproval.body as unknown as Proposal;
  });

  it("routes DIRECTION through the same durable approval and limits its decision to OWNER", async () => {
    const listed = await json(
      `/vs18/projects/${projectId}/phases/SOLUTION_APPROVAL/task-proposals`,
      "PMC",
    );
    const proposal = (listed.body.items as Proposal[]).find(
      (item) => item.status === "PROPOSED" && item.approvalKind === "DIRECTION",
    );
    if (!proposal) throw new Error("VS18 fixture needs a DIRECTION proposal");
    const accepted = await json(
      `/vs18/task-proposals/${proposal.id}/accept`,
      "PMC",
      {
        actor: "PMC",
      },
    );
    expect(accepted.response.status).toBe(201);
    expect(accepted.body).toMatchObject({
      status: "PENDING_APPROVAL",
      feishuDeliveryStatus: "NOT_CONFIGURED",
      approvalRequestId: expect.any(String),
    });
    direction = accepted.body as unknown as Proposal;

    const forbidden = await json(
      `/vs18/approvals/${direction.approvalRequestId}/decision`,
      "PMC",
      { actor: "OWNER", decision: "APPROVED", note: "负责人同意" },
    );
    expect(forbidden.response.status).toBe(403);
    const approved = await json(
      `/vs18/approvals/${direction.approvalRequestId}/decision`,
      "OWNER",
      { actor: "OWNER", decision: "APPROVED", note: "负责人同意" },
    );
    expect(approved.response.status).toBe(201);
    expect(approved.body).toMatchObject({
      id: direction.id,
      status: "ACCEPTED",
    });
  });

  it("keeps a CHANGES_REQUESTED approval immutable while allowing a corrected resubmission", async () => {
    const previousRequestId = money.approvalRequestId;
    if (!previousRequestId)
      throw new Error("VS18 fixture needs the prior MONEY approval request");
    const returned = await json(
      `/vs18/approvals/${previousRequestId}/decision`,
      "OWNER",
      {
        actor: "OWNER",
        decision: "CHANGES_REQUESTED",
        note: "请明确试点预算用途",
      },
    );
    expect(returned.response.status).toBe(201);
    expect(returned.body).toMatchObject({ id: money.id, status: "PROPOSED" });
    const corrected = await json(
      `/vs18/task-proposals/${money.id}/edit`,
      "PMC",
      {
        actor: "PMC",
        title: "明确试点采购预算",
        purpose: "补充试点采购预算用途后重新提交负责人审批",
        approvalKind: "MONEY",
        amount: 1200,
      },
    );
    expect(corrected.response.status).toBe(201);
    const resubmitted = await json(
      `/vs18/task-proposals/${money.id}/accept`,
      "PMC",
      { actor: "PMC" },
    );
    expect(resubmitted.response.status).toBe(201);
    expect(resubmitted.body).toMatchObject({
      status: "PENDING_APPROVAL",
      approvalRequestId: expect.any(String),
    });
    const replacementRequestId = String(resubmitted.body.approvalRequestId);
    expect(replacementRequestId).not.toBe(previousRequestId);
    const history = await verifier.query(
      "SELECT id, status FROM vs18_approval_requests WHERE proposal_id = $1 ORDER BY created_at, id",
      [money.id],
    );
    expect(history.rows).toEqual([
      { id: previousRequestId, status: "CHANGES_REQUESTED" },
      { id: replacementRequestId, status: "PENDING" },
    ]);
    const refreshed = await json(
      `/vs18/projects/${projectId}/phases/SOLUTION_APPROVAL/task-proposals`,
      "PMC",
    );
    expect(refreshed.response.status).toBe(200);
    const refreshedItems = refreshed.body.items as Proposal[];
    expect(new Set(refreshedItems.map((item) => item.id)).size).toBe(3);
    expect(refreshedItems.find((item) => item.id === money.id)).toMatchObject({
      approvalRequestId: replacementRequestId,
    });
    money = resubmitted.body as unknown as Proposal;
  });

  it("keeps task proposal events append-only", async () => {
    const event = await verifier.query(
      "SELECT id FROM vs18_task_proposal_events WHERE proposal_id = $1 ORDER BY id LIMIT 1",
      [money.id],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("VS18 acceptance expects a proposal event");
    await expect(
      verifier.query(
        "UPDATE vs18_task_proposal_events SET note = 'mutated' WHERE id = $1",
        [eventId],
      ),
    ).rejects.toThrow("VS18 task proposal events are append-only");
    await expect(
      verifier.query("DELETE FROM vs18_task_proposal_events WHERE id = $1", [
        eventId,
      ]),
    ).rejects.toThrow("VS18 task proposal events are append-only");
  });
});
