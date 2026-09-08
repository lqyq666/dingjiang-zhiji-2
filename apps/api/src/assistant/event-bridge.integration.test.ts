import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Vs01Service } from "../vs01.service";
import { createPool } from "../vs01-db";
import { AssistantService } from "./assistant.service";
import { Vs01ContextAdapter } from "./context";
import { AssistantEventBridge } from "./event-bridge";
import { DemoRulesRuntimeAdapter } from "./runtime";
import { AssistantStore } from "./store";

const runIntegration = process.env.VS12_INTEGRATION === "1";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS12 PostgreSQL assistant event bridge", () => {
  const business = new Vs01Service();
  const store = new AssistantStore();
  const assistant = new AssistantService(
    store,
    new Vs01ContextAdapter(business, store),
    {
      provider: "PI",
      async run() {
        throw new Error("test provider unavailable");
      },
    },
    new DemoRulesRuntimeAdapter(),
  );
  const firstWorker = new AssistantEventBridge(store, assistant);
  const secondWorker = new AssistantEventBridge(store, assistant);
  const pool = createPool();

  beforeAll(async () => {
    await business.onModuleInit();
    await business.reset({ actor: "PMC" });
  });

  afterAll(async () => {
    await store.onModuleDestroy();
    await pool.end();
    await business.onModuleDestroy();
  });

  it("turns a real employee completion into one durable proposal without changing business state", async () => {
    await business.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "VS12 集成测试判断",
    });
    let project = await business.createProject({
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    const solution = project.phases.find(
      (phase) => phase.code === "SOLUTION_APPROVAL",
    );
    const workItem = solution?.tasks.find(
      (task) => task.owner === "PMC" && task.status === "READY",
    );
    if (!workItem)
      throw new Error("Missing ready employee-owned solution work item");
    project = await business.updateSubtask(workItem.id, {
      actor: "PMC",
      status: "DONE",
      note: "VS12 真实员工完成事项",
      outputReference: "VS12 完成输出",
      confirmedAcceptanceCriteria: workItem.acceptance,
    });
    const stateAfterEmployeeAction = await business.project(project.id);
    const workEvents = await pool.query(
      "SELECT id, delivery_status FROM vs12_work_events WHERE project_id = $1 ORDER BY id",
      [project.id],
    );
    expect(workEvents.rowCount).toBe(1);
    expect(workEvents.rows[0]?.delivery_status).toBe("PENDING");

    await firstWorker.pollOnce();

    const runs = await pool.query(
      "SELECT status, provider, classification FROM vs12_assistant_runs WHERE project_id = $1",
      [project.id],
    );
    const stream = await pool.query(
      "SELECT type FROM vs12_assistant_stream_events WHERE project_id = $1 ORDER BY cursor",
      [project.id],
    );
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0]).toMatchObject({
      status: "FALLBACK",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
    });
    expect(stream.rows.map((row) => row.type)).toContain("SUGGESTION");
    expect(stream.rows.map((row) => row.type)).toContain("RUN_COMPLETED");
    expect(await business.project(project.id)).toEqual(
      stateAfterEmployeeAction,
    );
    expect(
      (
        await pool.query(
          "SELECT delivery_status FROM vs12_work_events WHERE project_id = $1",
          [project.id],
        )
      ).rows[0]?.delivery_status,
    ).toBe("DELIVERED");
  });

  it("uses SKIP LOCKED and correlation-key uniqueness when two workers consume one transaction", async () => {
    const project = await business.project("PRJ-OTD-001");
    await pool.query("BEGIN");
    try {
      await pool.query(
        "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ('tenant-demo', $1, 'TASK_COMPLETED', 'SOLUTION_APPROVAL', 'VS12 并发领取', 'PMC', '{}'::jsonb)",
        [project.id],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    const pending = await pool.query(
      "SELECT correlation_key FROM vs12_work_events WHERE project_id = $1 AND delivery_status = 'PENDING'",
      [project.id],
    );
    expect(pending.rowCount).toBe(1);
    await Promise.all([firstWorker.pollOnce(), secondWorker.pollOnce()]);
    const correlationKey = String(pending.rows[0]?.correlation_key);
    const runs = await pool.query(
      "SELECT count(*)::int AS count FROM vs12_assistant_runs WHERE correlation_key = $1",
      [correlationKey],
    );
    const delivered = await pool.query(
      "SELECT delivery_status FROM vs12_work_events WHERE correlation_key = $1",
      [correlationKey],
    );
    expect(Number(runs.rows[0]?.count)).toBe(1);
    expect(delivered.rows[0]?.delivery_status).toBe("DELIVERED");
  });

  it("retries a failed runtime once, then records the terminal FAILED dead-letter equivalent without rolling back business facts", async () => {
    const project = await business.project("PRJ-OTD-001");
    await pool.query(
      "INSERT INTO vs01_project_events (tenant_id, project_id, event_type, phase_code, note, actor, snapshot) VALUES ('tenant-demo', $1, 'TASK_COMPLETED', 'SOLUTION_APPROVAL', 'VS12 provider failure', 'PMC', '{}'::jsonb)",
      [project.id],
    );
    const beforeBridge = await business.project(project.id);
    const failingBridge = new AssistantEventBridge(store, {
      async createRunForWorkEvent() {
        throw new Error("provider unavailable");
      },
    } as unknown as AssistantService);
    await failingBridge.pollOnce();
    let failedEvent = await pool.query(
      "SELECT id, delivery_status, attempt_count, last_error FROM vs12_work_events WHERE project_id = $1 AND payload->>'note' = 'VS12 provider failure'",
      [project.id],
    );
    expect(failedEvent.rows[0]).toMatchObject({
      delivery_status: "PENDING",
      attempt_count: 1,
      last_error: "provider unavailable",
    });
    await pool.query(
      "UPDATE vs12_work_events SET available_at = now() WHERE id = $1",
      [failedEvent.rows[0]?.id],
    );
    await failingBridge.pollOnce();
    failedEvent = await pool.query(
      "SELECT delivery_status, attempt_count, last_error FROM vs12_work_events WHERE project_id = $1 AND payload->>'note' = 'VS12 provider failure'",
      [project.id],
    );
    expect(failedEvent.rows[0]).toMatchObject({
      delivery_status: "FAILED",
      attempt_count: 2,
      last_error: "provider unavailable",
    });
    expect(await business.project(project.id)).toEqual(beforeBridge);
  });
});
