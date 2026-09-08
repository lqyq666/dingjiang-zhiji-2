import { assistantRunSchema } from "@dingjiang/contracts";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AssistantService } from "./assistant.service";
import { assistantScopeFromRequest, rejectModelScopeArguments } from "./scope";
import {
  assertEffectivePiTools,
  createPiCustomTools,
  DemoRulesRuntimeAdapter,
  FakeRuntimeAdapter,
  PiRuntimeAdapter,
  piToolAllowlist,
} from "./runtime";

const scope = assistantScopeFromRequest("PRJ-OTD-001", "PMC");

describe("VS12 assistant runtime seam", () => {
  it("uses the prior confirmed root-cause conclusion and the reopened item to give a safe next action", async () => {
    const runtime = new DemoRulesRuntimeAdapter();
    const context = {
      currentWorkContext: vi.fn().mockResolvedValue({
        status: "OK",
        evidenceIds: ["E-CAPACITY"],
        data: {
          project: {
            currentStage: {
              code: "ROOT_CAUSE_VALIDATION",
              name: "核验根因",
              status: "IN_PROGRESS",
              tasks: [
                {
                  id: "ROOT-CAUSE-WORKPAPER",
                  title: "核验产能风险",
                  status: "READY",
                  owner: "PMC",
                  reopenReason: "补充排产记录后重新核验",
                },
              ],
            },
            latestConfirmedWorkpaper: {
              revision: 3,
              conclusion: {
                result: "SUPPORTS",
                statement: "产能负荷超过安全区间是交付延期的主要原因。",
                limitations: "仍需补齐最新排产记录。",
              },
            },
          },
        },
      }),
    };

    const suggestion = await runtime.run({
      scope,
      request: {
        intent: "ASK",
        question:
          "刚刚确认过的根因底稿结论是什么？现在重新打开后我下一步该做什么？",
      },
      context: context as never,
    });

    expect(suggestion).toMatchObject({
      classification: "PROPOSAL",
      provider: "DEMO_RULES",
      evidenceIds: ["E-CAPACITY"],
    });
    expect(suggestion.answer).toContain("历史上已确认的根因结论（v3）");
    expect(suggestion.answer).toContain(
      "产能负荷超过安全区间是交付延期的主要原因。",
    );
    expect(suggestion.answer).toContain("仍需补齐最新排产记录。");
    expect(suggestion.answer).toContain("重新打开");
    expect(suggestion.answer).toContain("下一步：");
    expect(suggestion.answer).toContain("核验产能风险");
    expect(suggestion.answer).not.toContain("。。");
    expect(suggestion.nextAction).toContain("核验产能风险");
    expect(suggestion.nextAction).toContain("员工确认");
  });

  it("returns the context-derived workpaper fallback through the public service seam after Pi is unavailable", async () => {
    const queued = {
      id: "run-workpaper",
      sessionId: "ASST",
      projectId: scope.projectId,
      sourceTaskId: "SO-202608128",
      correlationKey: "manual:workpaper",
      intent: "ASK",
      question: "",
      stageCode: null,
      status: "QUEUED",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      createdAt: "2026-08-21T00:00:00.000Z",
      completedAt: null,
      suggestion: null,
      fallbackReason: null,
    };
    const store = {
      ensureSession: vi.fn().mockResolvedValue("ASST"),
      createRun: vi.fn().mockResolvedValue(queued),
      updateRun: vi.fn(),
      append: vi.fn(),
    };
    const context = {
      currentWorkContext: vi.fn().mockResolvedValue({
        status: "OK",
        evidenceIds: ["E-CAPACITY"],
        data: {
          sourceTask: { id: "SO-202608128" },
          project: {
            currentStage: {
              name: "核验根因",
              tasks: [
                {
                  title: "核验产能风险",
                  status: "READY",
                  owner: "PMC",
                  reopenReason: "补充排产记录",
                },
              ],
            },
            latestConfirmedWorkpaper: {
              revision: 3,
              conclusion: {
                statement: "产能负荷影响交期",
                limitations: "仍需复核排产记录",
              },
            },
          },
        },
      }),
    };
    const pi = {
      provider: "PI" as const,
      run: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    const service = new AssistantService(
      store as never,
      context as never,
      pi,
      new DemoRulesRuntimeAdapter(),
    );

    const run = await service.createRun(scope, {
      intent: "ASK",
      question: "现在怎么做",
    });

    expect(run).toMatchObject({
      status: "FALLBACK",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
    });
    expect(run.suggestion?.answer).toContain("历史上已确认的根因结论（v3）");
    expect(run.suggestion?.answer).toContain("下一步：");
    expect(run.suggestion?.nextAction).toContain("核验产能风险");
    expect(run.suggestion?.nextAction).toContain("员工确认");
  });

  it("creates only PROPOSAL output and retries Pi once before a labelled fallback", async () => {
    const events: string[] = [];
    const store = {
      ensureSession: vi.fn().mockResolvedValue("ASST-PRJ-OTD-001"),
      createRun: vi.fn().mockResolvedValue({
        id: "run-1",
        sessionId: "ASST-PRJ-OTD-001",
        projectId: scope.projectId,
        sourceTaskId: "SO-202608128",
        correlationKey: "manual:run-1",
        intent: "ASK",
        question: "",
        stageCode: null,
        status: "QUEUED",
        provider: "DEMO_RULES",
        classification: "PROPOSAL",
        createdAt: "2026-08-17T00:00:00.000Z",
        completedAt: null,
        suggestion: null,
        fallbackReason: null,
      }),
      updateRun: vi.fn(),
      append: vi.fn(
        async (
          _scope: unknown,
          _session: unknown,
          _run: unknown,
          type: string,
        ) => {
          events.push(type);
          return {};
        },
      ),
    };
    const context = {
      currentWorkContext: vi.fn().mockResolvedValue({
        status: "OK",
        data: {
          sourceTask: { id: "SO-202608128" },
          project: { currentStage: { name: "核清事实" }, phases: [] },
        },
        evidenceIds: ["E-1"],
      }),
    };
    const pi = {
      provider: "PI" as const,
      run: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    const fallback = new FakeRuntimeAdapter({
      classification: "PROPOSAL",
      provider: "PI",
      answer: "建议由员工确认",
      nextAction: "核对材料",
      evidenceIds: ["E-1"],
    });
    const service = new AssistantService(
      store as never,
      context as never,
      pi,
      fallback,
    );

    const run = await service.createRun(scope, { intent: "NEXT_ACTION" });

    expect(pi.run).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "FALLBACK",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
    });
    expect(run.suggestion).toMatchObject({
      classification: "PROPOSAL",
      answer: "建议由员工确认",
    });
    expect(run.suggestion).not.toHaveProperty("fallbackReason");
    expect(assistantRunSchema.parse(run)).toMatchObject({
      fallbackReason: "provider down",
      suggestion: { classification: "PROPOSAL", answer: "建议由员工确认" },
    });
    expect(events).toEqual([
      "RUN_STARTED",
      "STATE_CHANGED",
      "SUGGESTION",
      "RUN_COMPLETED",
    ]);
  });

  it("rejects model-provided authorization scope before a tool can read data", () => {
    expect(() =>
      rejectModelScopeArguments({ projectId: "other-project" }),
    ).toThrow(ForbiddenException);
    expect(() =>
      rejectModelScopeArguments({ tenantId: "other-tenant" }),
    ).toThrow(ForbiddenException);
  });

  it("allows exactly the four read-only Pi tools", () => {
    expect(() => assertEffectivePiTools(piToolAllowlist)).not.toThrow();
    expect(() => assertEffectivePiTools(["read", "get_evidence"])).toThrow(
      /allowlist|builtin/,
    );
  });

  it("never labels a DEMO_RULES suggestion as PI even when the primary adapter returns it", async () => {
    const queued = {
      id: "run-demo",
      sessionId: "ASST",
      projectId: scope.projectId,
      sourceTaskId: "SO-202608128",
      correlationKey: "manual:demo",
      intent: "ASK",
      question: "",
      stageCode: null,
      status: "QUEUED",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      createdAt: "2026-08-17T00:00:00.000Z",
      completedAt: null,
      suggestion: null,
      fallbackReason: null,
    };
    const store = {
      ensureSession: vi.fn().mockResolvedValue("ASST"),
      createRun: vi.fn().mockResolvedValue(queued),
      updateRun: vi.fn(),
      append: vi.fn(),
    };
    const context = {
      currentWorkContext: vi.fn().mockResolvedValue({
        status: "OK",
        data: { sourceTask: { id: "SO-202608128" } },
      }),
    };
    const demo = new FakeRuntimeAdapter({
      classification: "PROPOSAL",
      provider: "DEMO_RULES",
      answer: "本地建议",
      nextAction: "人工确认",
      evidenceIds: [],
    });
    const service = new AssistantService(
      store as never,
      context as never,
      demo,
      demo,
    );
    const run = await service.createRun(scope, { intent: "ASK" });
    expect(run).toMatchObject({
      provider: "DEMO_RULES",
      status: "FALLBACK",
      classification: "PROPOSAL",
    });
  });

  it("refuses a real Pi provider without the explicit authorization boundary", async () => {
    const original = process.env.PI_RUNTIME_ENABLED;
    process.env.PI_RUNTIME_ENABLED = "true";
    await expect(
      new PiRuntimeAdapter().run({
        scope,
        request: { intent: "ASK" },
        context: {} as never,
      }),
    ).rejects.toThrow("PI_PROVIDER_NOT_AUTHORIZED");
    process.env.PI_RUNTIME_ENABLED = original;
  });

  it("binds each Pi custom tool to server-scoped context and returns only allowlisted data", async () => {
    const context = {
      currentWorkContext: vi.fn().mockResolvedValue({
        status: "OK",
        evidenceIds: ["E-CONTEXT"],
        data: {
          project: { name: "交付改善" },
          sourceTask: {
            materials: [{ id: "MAT-1", file: { contentPreview: "受控摘要" } }],
          },
          tenantId: "must-not-leak",
        },
      }),
      recentWorkEvents: vi.fn().mockResolvedValue({
        status: "OK",
        evidenceIds: ["E-EVENT"],
        data: {
          events: [
            { eventType: "MATERIAL_UPLOADED", storageKey: "must-not-leak" },
          ],
        },
      }),
      evidence: vi.fn().mockResolvedValue({
        status: "FORBIDDEN",
        evidenceIds: [],
        data: { path: "must-not-leak" },
      }),
      materialPreview: vi.fn().mockResolvedValue({
        status: "BODY_NOT_AVAILABLE",
        evidenceIds: [],
        data: { id: "MAT-1", storageKey: "must-not-leak" },
      }),
    };
    const tools = createPiCustomTools({ scope, context: context as never });
    const current = await tools[0]!.execute("call-1", {});
    const recent = await tools[1]!.execute("call-2", {});
    const evidence = await tools[2]!.execute("call-3", {
      evidenceId: "E-OTHER-PROJECT",
    });
    const material = await tools[3]!.execute("call-4", { materialId: "MAT-1" });
    expect(context.currentWorkContext).toHaveBeenCalledWith(scope, {});
    expect(context.recentWorkEvents).toHaveBeenCalledWith(scope, {});
    expect(context.evidence).toHaveBeenCalledWith(scope, {
      evidenceId: "E-OTHER-PROJECT",
    });
    expect(context.materialPreview).toHaveBeenCalledWith(scope, {
      materialId: "MAT-1",
    });
    expect(current.content[0]?.text).toContain("受控摘要");
    expect(JSON.stringify([current, recent, evidence, material])).not.toMatch(
      /tenantId|storageKey|path|bytes/i,
    );
    expect(recent.details).toMatchObject({
      status: "OK",
      evidenceIds: ["E-EVENT"],
    });
    expect(evidence.details.status).toBe("FORBIDDEN");
    expect(material.details.status).toBe("BODY_NOT_AVAILABLE");
    await expect(
      tools[0]!.execute("call-5", { projectId: "other" }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      tools[2]!.execute("call-6", { evidenceId: "E-1", role: "OWNER" }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      tools[3]!.execute("call-7", { materialId: "MAT-1", projectId: "other" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("constructs fake Pi tools then stops before any provider prompt is sent", async () => {
    const originalRuntime = process.env.PI_RUNTIME_ENABLED;
    const originalAuthorization = process.env.PI_PROVIDER_AUTHORIZED;
    process.env.PI_RUNTIME_ENABLED = "true";
    process.env.PI_PROVIDER_AUTHORIZED = "true";
    const defined: Array<Record<string, unknown>> = [];
    const adapter = new PiRuntimeAdapter(async () => ({
      DefaultResourceLoader: class {
        constructor(options: Record<string, unknown>) {
          void options;
        }
      },
      defineTool: (tool) => {
        defined.push(tool);
        return tool;
      },
      createAgentSession: vi.fn().mockResolvedValue({}),
    }));
    await expect(
      adapter.run({ scope, request: { intent: "ASK" }, context: {} as never }),
    ).rejects.toThrow("PI_PROVIDER_EXECUTION_NOT_IMPLEMENTED");
    expect(defined.map((tool) => tool.name)).toEqual(piToolAllowlist);
    process.env.PI_RUNTIME_ENABLED = originalRuntime;
    process.env.PI_PROVIDER_AUTHORIZED = originalAuthorization;
  });
});
