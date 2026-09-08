import { describe, expect, it, vi } from "vitest";
import type { ExperienceAiRun } from "@dingjiang/contracts";

import {
  ExperienceAiRunReuseError,
  ExperienceAiRunStore,
} from "./experience-ai-run.store";

describe("ExperienceAiRunStore", () => {
  it("persists only RUNNING to SUCCEEDED or FAILED transitions and never stores a provider secret", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const store = new ExperienceAiRunStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    const { run: running, created } = await store.createOrGet({
      tenantId: "tenant-demo",
      projectId: "PRJ-OTD-001",
      purpose: "EXTRACT",
      provider: "COZE",
      workflowId: "wf-extract",
      requestId: "7c3b8ed8-9926-4d6e-8c3b-72f8ce287f1b",
      inputFingerprint: "a".repeat(64),
      inputRefs: [{ kind: "PROJECT", id: "PRJ-OTD-001" }],
    });
    expect(created).toBe(true);
    await store.fail("tenant-demo", running, {
      code: "PROVIDER_FAILED",
      message: "Bearer secret-token failed at C:\\private\\input.txt",
    });

    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["tenant-demo", "PRJ-OTD-001", "EXTRACT", "COZE"]),
    );
    const failureArguments = query.mock.calls[1]?.[1] as unknown[];
    expect(JSON.stringify(failureArguments)).not.toContain("secret-token");
    expect(JSON.stringify(failureArguments)).not.toContain("input.txt");
  });

  it("returns an existing tenant-scoped request run so callers do not invoke a provider twice", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "run-1",
            purpose: "EXTRACT",
            provider: "COZE",
            status: "RUNNING",
            workflow_id: "wf-extract",
            input_fingerprint: "a".repeat(64),
            input_refs: [{ kind: "PROJECT", id: "PRJ-OTD-001" }],
            structured_output: null,
            execute_id: null,
            debug_url: null,
            usage: null,
            error_code: null,
            error_message: null,
            created_at: new Date("2026-08-26T00:00:00.000Z"),
            completed_at: null,
          },
        ],
      });
    const store = new ExperienceAiRunStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    const result = await store.createOrGet({
      tenantId: "tenant-demo",
      projectId: "PRJ-OTD-001",
      purpose: "EXTRACT",
      provider: "COZE",
      workflowId: "wf-extract",
      requestId: "7c3b8ed8-9926-4d6e-8c3b-72f8ce287f1b",
      inputFingerprint: "a".repeat(64),
      inputRefs: [{ kind: "PROJECT", id: "PRJ-OTD-001" }],
    });

    expect(result).toMatchObject({
      created: false,
      run: { id: "run-1", status: "RUNNING" },
    });
  });

  it("rejects a silent zero-row terminal update", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const store = new ExperienceAiRunStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });
    const run: ExperienceAiRun = {
      id: "run-1",
      purpose: "EXTRACT",
      provider: "COZE",
      status: "RUNNING",
      workflowId: "wf-extract",
      inputFingerprint: "a".repeat(64),
      inputRefs: [],
      structuredOutput: null,
      executeId: null,
      debugUrl: null,
      usage: null,
      error: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
    };

    await expect(
      store.succeed("tenant-demo", run, {
        executeId: null,
        debugUrl: null,
        usage: null,
        structuredOutput: null,
      }),
    ).rejects.toThrow("经验智能运行记录状态已变化");
  });

  it("rejects a reused AI run request id whose input fingerprint differs", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "run-1",
            purpose: "EXTRACT",
            provider: "COZE",
            status: "RUNNING",
            workflow_id: "wf-extract",
            input_fingerprint: "b".repeat(64),
            input_refs: [],
            structured_output: null,
            execute_id: null,
            debug_url: null,
            usage: null,
            error_code: null,
            error_message: null,
            created_at: new Date(),
            completed_at: null,
          },
        ],
      });
    const store = new ExperienceAiRunStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    await expect(
      store.createOrGet({
        tenantId: "tenant-demo",
        projectId: "PRJ-OTD-001",
        purpose: "EXTRACT",
        provider: "COZE",
        workflowId: "wf-extract",
        requestId: "7c3b8ed8-9926-4d6e-8c3b-72f8ce287f1b",
        inputFingerprint: "a".repeat(64),
        inputRefs: [],
      }),
    ).rejects.toBeInstanceOf(ExperienceAiRunReuseError);
  });

  it("fails closed when persisted structured output violates the public AI run schema", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "run-1",
            purpose: "EXTRACT",
            provider: "COZE",
            status: "SUCCEEDED",
            workflow_id: "wf-extract",
            input_fingerprint: "a".repeat(64),
            input_refs: [],
            structured_output: { unexpected: true },
            execute_id: null,
            debug_url: null,
            usage: null,
            error_code: null,
            error_message: null,
            created_at: new Date(),
            completed_at: new Date(),
          },
        ],
      });
    const store = new ExperienceAiRunStore();
    Object.defineProperty(store, "pool", { value: { query, end: vi.fn() } });

    await expect(
      store.createOrGet({
        tenantId: "tenant-demo",
        projectId: "PRJ-OTD-001",
        purpose: "EXTRACT",
        provider: "COZE",
        workflowId: "wf-extract",
        requestId: "7c3b8ed8-9926-4d6e-8c3b-72f8ce287f1b",
        inputFingerprint: "a".repeat(64),
        inputRefs: [],
      }),
    ).rejects.toThrow("经验智能运行记录暂不可用");
  });
});
