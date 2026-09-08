import { assistantHistorySchema } from "@dingjiang/contracts";
import { describe, expect, it, vi } from "vitest";

import { AssistantStore } from "./store";

describe("VS12 assistant history persistence seam", () => {
  it("projects persisted run metadata outside the strict public suggestion", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "ASST-1",
            source_task_id: "SO-202608128",
            created_at: new Date("2026-08-17T00:00:00.000Z"),
            last_active_at: new Date("2026-08-17T00:00:00.000Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            session_id: "ASST-1",
            project_id: "PRJ-OTD-001",
            source_task_id: "SO-202608128",
            correlation_key: "manual:run-1",
            stage_code: null,
            intent: "ASK",
            question: "下一步？",
            status: "FALLBACK",
            provider: "DEMO_RULES",
            classification: "PROPOSAL",
            created_at: new Date("2026-08-17T00:00:00.000Z"),
            completed_at: new Date("2026-08-17T00:01:00.000Z"),
            suggestion: {
              classification: "PROPOSAL",
              answer: "先核对材料",
              evidenceIds: ["E-1"],
              nextAction: "补齐缺失材料",
            },
            fallback_reason: "Pi runtime unavailable",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ cursor: "7" }] });
    const store = new AssistantStore();
    Object.defineProperty(store, "pool", { value: { query } });

    const history = await store.history({
      tenantId: "tenant-demo",
      subjectId: "demo-pmc",
      role: "PMC",
      projectId: "PRJ-OTD-001",
      sourceTaskId: "SO-202608128",
      policyVersion: "VS12-1",
    });

    expect(assistantHistorySchema.parse(history)).toMatchObject({
      runs: [
        {
          provider: "DEMO_RULES",
          fallbackReason: "Pi runtime unavailable",
          suggestion: {
            classification: "PROPOSAL",
            answer: "先核对材料",
            evidenceIds: ["E-1"],
            nextAction: "补齐缺失材料",
          },
        },
      ],
    });
  });
});
