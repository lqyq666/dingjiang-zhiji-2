import { expect, it } from "vitest";
import type { Pool } from "pg";

import type { ReadModelService } from "../read-model/read-model-service";
import { ProjectLifecycleService } from "./project-lifecycle-service";

const tenantId = "tenant-demo";

it("creates seven phase templates and keeps the result/knowledge work locked", () => {
  const pool = {} as unknown as Pool;
  const readModel = {} as unknown as ReadModelService;
  const service = new ProjectLifecycleService(
    pool,
    tenantId,
    readModel,
  ) as unknown as {
    taskTemplates: () => Array<{
      phaseCode: string;
      status: string;
      inputs: unknown[];
      acceptance: unknown[];
    }>;
    activePhaseForProject: (status: string) => string | null;
  };
  const templates = service.taskTemplates();
  expect(new Set(templates.map((task) => task.phaseCode)).size).toBe(7);
  expect(
    templates
      .filter((task) => task.phaseCode === "PROJECT_SCOPING")
      .every((task) => task.status === "DONE"),
  ).toBe(true);
  expect(
    templates
      .filter((task) => task.phaseCode === "RESULT_ACCEPTANCE")
      .every((task) => task.status === "LOCKED"),
  ).toBe(true);
  expect(
    templates.every(
      (task) => task.inputs.length > 0 && task.acceptance.length > 0,
    ),
  ).toBe(true);
  expect(service.activePhaseForProject("RUNNING")).toBe("EXECUTION_CONTROL");
  expect(service.activePhaseForProject("RESULT_VALIDATION")).toBe(
    "RESULT_ACCEPTANCE",
  );
  expect(service.activePhaseForProject("COMPLETED")).toBeNull();
});

it("uses consulting-specific IPO instructions instead of one generic task shape", () => {
  const pool = {} as unknown as Pool;
  const readModel = {} as unknown as ReadModelService;
  const service = new ProjectLifecycleService(
    pool,
    tenantId,
    readModel,
  ) as unknown as {
    taskTemplates: () => Array<{
      id: string;
      inputs: Array<{ label: string; status: string }>;
      process: Array<{ label: string }>;
      expectedOutput: string;
      acceptance: string[];
    }>;
  };
  const templates = service.taskTemplates();
  const solution = templates.find((task) => task.id === "SUB-SOLUTION-001");
  const execution = templates.find((task) => task.id === "SUB-BOM-002");
  const knowledge = templates.find((task) => task.id === "SUB-KNOWLEDGE-003");
  expect(solution?.process.map((step) => step.label)).toContain(
    "比较预期影响、成本与风险",
  );
  expect(solution?.expectedOutput).toBe("BOM 治理方案比较表");
  expect(execution?.inputs).toContainEqual({
    label: "缺失 BOM/变更资料",
    status: "MISSING",
    reference: null,
  });
  expect(knowledge?.inputs).toContainEqual({
    label: "未核验产能风险",
    status: "UNVERIFIED",
    reference: null,
  });
  expect(knowledge?.acceptance).toContain("候选经验标为待专家审核");
});

it("serializes project creation against decision rollback with the task row lock", async () => {
  const statements: string[] = [];
  const client = {
    query: async (statement: string) => {
      statements.push(statement);
      if (
        statement === "BEGIN" ||
        statement === "COMMIT" ||
        statement === "ROLLBACK"
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        statement.includes("FROM vs01_tasks") &&
        statement.includes("FOR UPDATE")
      ) {
        return {
          rows: [{ id: "SO-202608128", status: "DECIDED" }],
          rowCount: 1,
        };
      }
      if (statement.includes("SELECT id FROM vs01_projects"))
        return { rows: [], rowCount: 0 };
      if (statement.includes("FROM vs01_orders o"))
        return {
          rows: [
            {
              order_id: "SO-202608128",
              promised_date: "2026-08-18",
              forecast_date: "2026-08-23",
              bom_delay: 4,
              purchase_delay: 3,
            },
          ],
          rowCount: 1,
        };
      if (statement.includes("FROM vs01_orders WHERE"))
        return {
          rows: [
            {
              order_id: "SO-202608128",
              promised_date: "2026-08-18",
              forecast_date: "2026-08-23",
              source_row: 2,
              source_version_id: "SRC-ORDERS-V1",
            },
          ],
          rowCount: 1,
        };
      if (
        statement.includes("INSERT INTO vs01_projects") ||
        statement.includes("INSERT INTO vs01_project_nodes") ||
        statement.includes("INSERT INTO vs01_project_phases") ||
        statement.includes("INSERT INTO vs01_result_validations") ||
        statement.includes("INSERT INTO vs01_project_subtasks") ||
        statement.includes("INSERT INTO vs01_source_objects") ||
        statement.includes("INSERT INTO vs01_source_versions")
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const readModel = {
    project: async () => ({ id: "PRJ-OTD-001" }) as never,
  } as unknown as ReadModelService;
  const service = new ProjectLifecycleService(pool, tenantId, readModel);

  await service.createProject({
    actor: "PMC",
    sourceTaskId: "SO-202608128",
  });

  expect(
    statements.some(
      (statement) =>
        statement.includes("FROM vs01_tasks") &&
        statement.includes("FOR UPDATE"),
    ),
  ).toBe(true);
  expect(statements).toContain("COMMIT");
});

it("derives node progress from completed subtasks and can reopen work", async () => {
  let status = "READY";
  const events: string[] = [];
  const progresses: number[] = [];
  const auditSnapshots: string[] = [];
  let completionNote = "";
  let outputReference: string | null = null;
  let sourceObjectId: string | null = null;
  let sourceVersionId: string | null = null;
  let completedAt: string | null = null;
  const client = {
    query: async (statement: string, values?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
        return { rows: [], rowCount: 0 };
      if (statement.includes("FROM vs01_project_subtasks s"))
        return {
          rows: [
            {
              subtask_status: status,
              node_id: "NODE-BOM-001",
              project_id: "PRJ-OTD-001",
              project_status: "RUNNING",
              phase_code: "EXECUTION_CONTROL",
              origin: "LIVE",
              owner: "PMC",
              acceptance: ["口径或范围明确", "输出可追溯"],
              completion_note: completionNote,
              output_reference: outputReference,
              output_source_object_id: sourceObjectId,
              output_source_version_id: sourceVersionId,
              completed_at: completedAt,
            },
          ],
          rowCount: 1,
        };
      if (statement.startsWith("UPDATE vs01_project_subtasks")) {
        status = String(values?.[2]);
        completionNote = String(values?.[3]);
        if (status === "DONE") {
          outputReference = String(values?.[4]);
          sourceObjectId = String(values?.[5]);
          sourceVersionId = String(values?.[6]);
          completedAt = "2026-08-16T10:00:00.000Z";
        }
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO vs01_project_subtask_events")) {
        events.push(String(values?.[2]));
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO vs01_project_events")) {
        auditSnapshots.push(String(values?.[5]));
        return { rows: [], rowCount: 1 };
      }
      if (
        statement.includes("INSERT INTO vs01_source_objects") ||
        statement.includes("INSERT INTO vs01_source_versions")
      )
        return { rows: [], rowCount: 1 };
      if (statement.includes("count(*) FILTER"))
        return {
          rows: [{ total: 4, completed: status === "DONE" ? 1 : 0 }],
          rowCount: 1,
        };
      if (statement.startsWith("UPDATE vs01_project_nodes")) {
        progresses.push(Number(values?.[2]));
        return { rows: [], rowCount: 1 };
      }
      if (statement.startsWith("UPDATE vs01_project_phases"))
        return { rows: [], rowCount: 1 };
      if (statement.includes("INSERT INTO vs01_node_updates"))
        return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const readModel = {
    project: async () => ({ id: "PRJ-OTD-001" }) as never,
  } as unknown as ReadModelService;
  const service = new ProjectLifecycleService(pool, tenantId, readModel);

  await service.updateSubtask("SUB-BOM-001", {
    actor: "PMC",
    status: "IN_PROGRESS",
    note: "正在核对分类依据",
    outputReference: "分类草稿 v0",
  });
  await service.updateSubtask("SUB-BOM-001", {
    actor: "PMC",
    status: "DONE",
    note: "已复核分类清单",
    outputReference: "BOM 分类清单 v1",
    confirmedAcceptanceCriteria: ["口径或范围明确", "输出可追溯"],
  });
  await service.updateSubtask("SUB-BOM-001", {
    actor: "PMC",
    status: "READY",
    note: "发现遗漏，重新打开",
  });

  expect(progresses).toEqual([0, 25, 0]);
  expect(events).toEqual(["PROGRESS_SAVED", "COMPLETED", "REOPENED"]);
  const reopened = JSON.parse(auditSnapshots[2] ?? "{}");
  expect(reopened.before).toMatchObject({
    status: "DONE",
    completionNote: "已复核分类清单",
    outputReference: "BOM 分类清单 v1",
    completedAt: "2026-08-16T10:00:00.000Z",
  });
  expect(reopened.before.locator).toMatchObject({
    sourceObjectId: expect.stringMatching(/^SRC-PROJECT-/),
    sourceVersionId: expect.stringMatching(/^SRC-PROJECT-VERSION-/),
    reference: "BOM 分类清单 v1",
  });
});

it("opens result validation when the employee confirms the final execution item", async () => {
  const statements: string[] = [];
  const projectEvents: unknown[][] = [];
  const client = {
    query: async (statement: string, values?: unknown[]) => {
      statements.push(statement);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
        return { rows: [], rowCount: 0 };
      if (statement.includes("FROM vs01_project_subtasks s"))
        return {
          rows: [
            {
              subtask_status: "READY",
              node_id: "NODE-BOM-001",
              project_id: "PRJ-OTD-001",
              project_status: "RUNNING",
              phase_code: "EXECUTION_CONTROL",
              origin: "LIVE",
              owner: "PMC",
              acceptance: ["口径或范围明确", "输出可追溯"],
            },
          ],
          rowCount: 1,
        };
      if (statement.startsWith("UPDATE vs01_project_subtasks"))
        return { rows: [], rowCount: 1 };
      if (statement.includes("INSERT INTO vs01_project_events") && values)
        projectEvents.push(values);
      if (
        statement.includes("INSERT INTO vs01_project_subtask_events") ||
        statement.includes("INSERT INTO vs01_project_events") ||
        statement.includes("INSERT INTO vs01_source_objects") ||
        statement.includes("INSERT INTO vs01_source_versions") ||
        statement.startsWith("UPDATE vs01_project_nodes") ||
        statement.includes("INSERT INTO vs01_node_updates") ||
        statement.startsWith("UPDATE vs01_projects") ||
        statement.startsWith("UPDATE vs01_project_phases")
      )
        return { rows: [], rowCount: 1 };
      if (statement.includes("count(*) FILTER"))
        return { rows: [{ total: 4, completed: 4 }], rowCount: 1 };
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const readModel = {
    project: async () => ({ id: "PRJ-OTD-001" }) as never,
  } as unknown as ReadModelService;
  const service = new ProjectLifecycleService(pool, tenantId, readModel);

  await service.updateSubtask("SUB-BOM-004", {
    actor: "PMC",
    status: "DONE",
    note: "执行任务全部完成",
    outputReference: "治理规则发布记录",
    confirmedAcceptanceCriteria: ["口径或范围明确", "输出可追溯"],
  });

  expect(statements).toContain(
    "UPDATE vs01_project_phases SET gate_status = 'APPROVED', returned_reason = NULL WHERE project_id = $1 AND tenant_id = $2 AND code = 'EXECUTION_CONTROL'",
  );
  expect(
    statements.some((statement) => statement.includes("RESULT_VALIDATION")),
  ).toBe(true);
  expect(
    statements.some(
      (statement) =>
        statement.includes("RESULT_ACCEPTANCE") &&
        statement.includes("status = 'READY'"),
    ),
  ).toBe(true);
  expect(
    projectEvents.some(
      (values) =>
        values[2] === "EXECUTION_CONFIRMED_BY_EMPLOYEE" &&
        values[3] === "EXECUTION_CONTROL",
    ),
  ).toBe(true);
});

it("returns an execution review without unlocking result work", async () => {
  const statements: string[] = [];
  const client = {
    query: async (statement: string) => {
      statements.push(statement);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement))
        return { rows: [], rowCount: 0 };
      if (statement.includes("FROM vs01_project_nodes"))
        return { rows: [{ id: "NODE-BOM-001" }], rowCount: 1 };
      if (statement.includes("FROM vs01_projects p JOIN vs01_project_phases"))
        return {
          rows: [{ project_status: "RUNNING", gate_status: "PENDING" }],
          rowCount: 1,
        };
      if (
        statement.startsWith("UPDATE vs01_project_phases") ||
        statement.includes("INSERT INTO vs01_project_events")
      )
        return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const readModel = {
    project: async () => ({ id: "PRJ-OTD-001" }) as never,
  } as unknown as ReadModelService;
  const service = new ProjectLifecycleService(pool, tenantId, readModel);

  await service.reviewExecutionPhase("PRJ-OTD-001", {
    actor: "PMC",
    decision: "RETURN",
    reason: "最后一项输出需要补充",
  });

  expect(statements.some((statement) => statement.includes("RETURNED"))).toBe(
    true,
  );
  expect(
    statements.some((statement) => statement.includes("RESULT_ACCEPTANCE")),
  ).toBe(false);
});
