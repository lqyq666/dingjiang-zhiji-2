import { BadRequestException } from "@nestjs/common";
import { expect, it } from "vitest";
import type { Pool } from "pg";

import type { ReadModelService } from "../read-model/read-model-service";
import { TaskDecisionService } from "./task-decision-service";

const tenantId = "tenant-demo";

it("records only the first OPEN-to-DECIDED decision in one transaction", async () => {
  let taskStatus = "OPEN";
  let savedDecision: { type: string; note: string } | null = null;
  const statements: string[] = [];
  const client = {
    query: async (statement: string, values?: unknown[]) => {
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
        return { rows: [{ status: taskStatus }], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO vs01_decisions")) {
        savedDecision = {
          type: String(values?.[2]),
          note: String(values?.[3]),
        };
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO vs01_decision_events")) {
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("UPDATE vs01_tasks SET status = 'DECIDED'")) {
        taskStatus = "DECIDED";
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const readModel = {
    project: async (): Promise<unknown> => undefined,
    task: async (): Promise<unknown> => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = new TaskDecisionService(
    pool,
    tenantId,
    readModel as unknown as ReadModelService,
  );

  readModel.task = async () => ({ id: "SO-202608128" }) as never;

  await service.decideTask("SO-202608128", {
    actor: "PMC",
    type: "CONFIRMED",
    note: "first decision",
  });
  await expect(
    service.decideTask("SO-202608128", {
      actor: "PMC",
      type: "MODIFIED",
      note: "must not replace",
    }),
  ).rejects.toBeInstanceOf(BadRequestException);

  expect(savedDecision).toEqual({
    type: "CONFIRMED",
    note: "first decision",
  });
  expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(
    2,
  );
  expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(
    1,
  );
  expect(
    statements.filter((statement) => statement === "ROLLBACK"),
  ).toHaveLength(1);
});

it("reopens a decided task while preserving a REVERTED audit event", async () => {
  let taskStatus = "DECIDED";
  let currentDecision: { type: string; note: string } | null = {
    type: "MODIFIED",
    note: "现场补充判断",
  };
  let revertedEvent: unknown[] | undefined;
  const statements: string[] = [];
  const client = {
    query: async (statement: string, values?: unknown[]) => {
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
        return { rows: [{ status: taskStatus }], rowCount: 1 };
      }
      if (statement.includes("FROM vs01_projects")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        statement.includes("FROM vs01_decisions") &&
        statement.includes("FOR UPDATE")
      ) {
        return { rows: [currentDecision], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO vs01_decision_events")) {
        revertedEvent = values;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("DELETE FROM vs01_decisions")) {
        currentDecision = null;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("UPDATE vs01_tasks SET status = 'OPEN'")) {
        taskStatus = "OPEN";
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const readModel = {
    project: async (): Promise<unknown> => undefined,
    task: async (): Promise<unknown> => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = new TaskDecisionService(
    pool,
    tenantId,
    readModel as unknown as ReadModelService,
  );

  readModel.task = async () =>
    ({ id: "SO-202608128", status: taskStatus, decision: null }) as never;

  const result = await service.revertTaskDecision("SO-202608128", {
    actor: "PMC",
    reason: "误选了修改，需要重新判断",
  });

  expect(result).toMatchObject({ status: "OPEN", decision: null });
  expect(revertedEvent).toEqual([
    "SO-202608128",
    "tenant-demo",
    "MODIFIED",
    "现场补充判断",
    "误选了修改，需要重新判断",
  ]);
  expect(statements).toContain("COMMIT");
  expect(statements).not.toContain("ROLLBACK");
});

it("rejects a silent decision rollback after a project exists", async () => {
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
        return { rows: [{ status: "DECIDED" }], rowCount: 1 };
      }
      if (statement.includes("FROM vs01_projects")) {
        return { rows: [{ id: "PRJ-OTD-001" }], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
    release: () => undefined,
  };
  const readModel = {
    project: async (): Promise<unknown> => undefined,
    task: async (): Promise<unknown> => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = new TaskDecisionService(
    pool,
    tenantId,
    readModel as unknown as ReadModelService,
  );

  await expect(
    service.revertTaskDecision("SO-202608128", {
      actor: "PMC",
      reason: "误操作",
    }),
  ).rejects.toThrow("不能直接撤销");
  expect(statements).toContain("ROLLBACK");
  expect(
    statements.some((statement) =>
      statement.includes("DELETE FROM vs01_decisions"),
    ),
  ).toBe(false);
});
