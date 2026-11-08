import { expect, it, vi } from "vitest";
import type { Pool } from "pg";

import type { ReadModelService } from "../read-model/read-model-service";
import { ExperienceService } from "./experience-service";

const tenantId = "tenant-demo";

it("keeps a pending candidate unchanged when its project is not ready to publish", async () => {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (statement: string) => {
      statements.push(statement);
      if (statement === "BEGIN" || statement === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("SELECT c.*, r.source_object_id")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "EXP-PENDING-001",
              status: "PENDING_REVIEW",
              candidate_source_version_id: "SRC-CANDIDATE-V1",
              project_id: "PRJ-PARTIAL-001",
            },
          ],
        };
      }
      if (statement.includes("SELECT p.status AS project_status")) {
        return {
          rowCount: 1,
          rows: [{ project_status: "RUNNING", result_status: "ACCEPTED" }],
        };
      }
      if (statement.includes("SELECT code, gate_status")) {
        return {
          rowCount: 7,
          rows: [
            { code: "PROJECT_SCOPING", gate_status: "APPROVED" },
            { code: "BASELINE_FACTS", gate_status: "APPROVED" },
            { code: "ROOT_CAUSE_VALIDATION", gate_status: "APPROVED" },
            { code: "SOLUTION_APPROVAL", gate_status: "APPROVED" },
            { code: "EXECUTION_CONTROL", gate_status: "IN_PROGRESS" },
            { code: "RESULT_ACCEPTANCE", gate_status: "APPROVED" },
            { code: "KNOWLEDGE_CAPTURE", gate_status: "PENDING" },
          ],
        };
      }
      throw new Error(`Unexpected query: ${statement}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const readModel = {} as unknown as ReadModelService;
  const service = new ExperienceService(pool, tenantId, readModel);

  await expect(
    service.approveExperienceCandidate("EXP-PENDING-001", {
      actor: "EXPERT_REVIEWER",
      expectedCandidateVersionId: "SRC-CANDIDATE-V1",
    }),
  ).rejects.toMatchObject({
    message:
      "请先进入“总结可复用做法”，完成前置阶段并确认经营结果后再批准候选经验",
  });

  expect(
    statements.some((statement) =>
      statement.includes("INSERT INTO vs01_formal_experiences"),
    ),
  ).toBe(false);
  expect(
    statements.some((statement) =>
      statement.includes(
        "UPDATE vs01_experience_candidates SET status = 'APPROVED'",
      ),
    ),
  ).toBe(false);
  expect(
    statements.find((statement) =>
      statement.includes("SELECT p.status AS project_status"),
    ),
  ).toContain("JOIN vs01_result_validations rv");
  expect(
    statements.find((statement) =>
      statement.includes("SELECT p.status AS project_status"),
    ),
  ).toContain("FOR UPDATE OF p, rv");
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
});
