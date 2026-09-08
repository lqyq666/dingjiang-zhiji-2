import { describe, expect, it, vi } from "vitest";

import { CozeExperienceProvider } from "./coze-experience.provider";
import { DemoExperienceProvider } from "./demo-experience.provider";

const extractionInput = {
  projectId: "PRJ-OTD-001",
  businessProblem: "交付延期",
  confirmedRootCause: "产能负荷超过安全区间",
  confirmedOutcome: "交期已受影响",
  materials: [
    {
      title: "排产摘要",
      contentPreview: "仅供核验的摘要",
      sourceObjectId: "SRC-1",
      sourceVersionId: "SRC-1-V1",
      reference: "排产记录 v1",
      verificationStatus: "UNVERIFIED_INPUT" as const,
    },
  ],
  evidence: [
    {
      id: "E-1",
      statement: "负荷超过安全区间",
      sourceObjectId: "SRC-1",
      sourceVersionId: "SRC-1-V1",
      reference: "排产记录 v1",
    },
  ],
};

const extractionOutput = {
  title: "产能核验经验",
  applicableSituation: "交付延期且存在产能风险",
  businessProblem: "交付延期",
  practice: "核对排产与负荷",
  resultSummary: "形成待审核经验",
  limitations: "需人工确认",
  structuredCard: {
    trigger: "交付延期",
    conditions: ["存在排产记录"],
    actions: [{ order: 1, action: "核对负荷" }],
    rationale: "先确认约束",
    exceptions: [],
    scope: {
      products: ["产品 A"],
      departments: ["PMC"],
      scenarios: ["产能风险"],
    },
    claims: [{ statement: "负荷存在风险", evidenceIds: ["E-1"] }],
    evidenceRefs: [
      {
        sourceObjectId: "SRC-1",
        sourceVersionId: "SRC-1-V1",
        reference: "排产记录 v1",
      },
    ],
    missingInformation: [],
  },
  reviewFocus: ["确认最新排产"],
  classification: "PROPOSAL" as const,
};

const answerOutput = {
  answer: "Coze 真实连接已通过。",
  matches: [],
  missingInformation: ["需要补充可引用的正式经验与当前证据。"],
  shouldClarify: true,
  classification: "PROPOSAL" as const,
};

describe("CozeExperienceProvider", () => {
  it("exposes the exact workflow id before a run is persisted", () => {
    const provider = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
    });

    expect(provider.workflowIdFor("EXTRACT")).toBe("wf-extract");
    expect(provider.workflowIdFor("PUBLISH")).toBe("wf-publish");
    expect(provider.workflowIdFor("ANSWER")).toBe("wf-answer");
  });

  it("sends only the workflow id and safe parameters, then strictly parses Coze data", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: JSON.stringify(extractionOutput),
          debug_url: "https://coze.cn/debug/run",
          execute_id: "exec-1",
          usage: { input_count: 12, output_count: 8, token_count: 20 },
        }),
        { status: 200 },
      ),
    );
    const provider = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher,
    });

    const result = await provider.extractCandidate(extractionInput);

    expect(result).toMatchObject({
      provider: "COZE",
      workflowId: "wf-extract",
      executeId: "exec-1",
      output: { classification: "PROPOSAL", title: "产能核验经验" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.coze.cn/v1/workflow/run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
        }),
        body: JSON.stringify({
          workflow_id: "wf-extract",
          parameters: extractionInput,
        }),
      }),
    );
  });

  it("publishes with the publish workflow and returns Coze receipt metadata for empty or wrapped success data", async () => {
    const input = {
      experienceId: "FORMAL-EXP-001",
      experienceVersionId: "SRC-FORMAL-EXP-001-V2",
      document: "可检索的正式经验正文",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {},
            execute_id: "publish-empty-001",
            debug_url: "https://coze.cn/debug/publish-empty-001",
            usage: { input_count: 3, output_count: 0, token_count: 3 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { output: "{}" },
            execute_id: "publish-wrapped-002",
            debug_url: "https://coze.cn/debug/publish-wrapped-002",
          }),
          { status: 200 },
        ),
      );
    const provider = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher,
    });

    await expect(provider.publishExperience(input)).resolves.toMatchObject({
      provider: "COZE",
      workflowId: "wf-publish",
      executeId: "publish-empty-001",
      debugUrl: "https://coze.cn/debug/publish-empty-001",
      usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 },
    });
    await expect(provider.publishExperience(input)).resolves.toMatchObject({
      provider: "COZE",
      workflowId: "wf-publish",
      executeId: "publish-wrapped-002",
      debugUrl: "https://coze.cn/debug/publish-wrapped-002",
      usage: null,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.coze.cn/v1/workflow/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workflow_id: "wf-publish", parameters: input }),
      }),
    );
  });

  it("rejects invalid or unknown provider output without exposing secrets", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: JSON.stringify({
            ...extractionOutput,
            unexpected: "secret-token",
          }),
        }),
        { status: 200 },
      ),
    );
    const provider = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher,
    });

    await expect(
      provider.extractCandidate(extractionInput),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    await provider.extractCandidate(extractionInput).catch((error: unknown) => {
      expect(String(error)).not.toContain("secret-token");
    });
  });

  it("maps aborts and provider failures to safe structured errors", async () => {
    const timeout = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi
        .fn()
        .mockRejectedValue(new DOMException("request aborted", "AbortError")),
    });
    await expect(
      timeout.extractCandidate(extractionInput),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const failed = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: 500, msg: "Bearer secret-token failed" }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      failed.extractCandidate(extractionInput),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });

  it("accepts only direct data, the common output JSON wrapper, or Coze's text envelope before strict validation", async () => {
    const direct = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 0, data: extractionOutput }), {
          status: 200,
        }),
      ),
    });
    await expect(
      direct.extractCandidate(extractionInput),
    ).resolves.toMatchObject({ output: { title: "产能核验经验" } });

    const wrapped = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 0,
            data: { output: JSON.stringify(extractionOutput) },
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(
      wrapped.extractCandidate(extractionInput),
    ).resolves.toMatchObject({ output: { title: "产能核验经验" } });

    const textEnvelope = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              content_type: 1,
              data: JSON.stringify(answerOutput),
              original_result: null,
              type_for_model: 2,
            },
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(
      textEnvelope.answerQuestion({ question: "当前有哪些可用经验？" }),
    ).resolves.toMatchObject({ output: answerOutput });

    const invalidWrapper = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: 0, data: { result: extractionOutput } }),
            { status: 200 },
          ),
        ),
    });
    await expect(
      invalidWrapper.extractCandidate(extractionInput),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });

    const nestedEnvelope = new CozeExperienceProvider({
      token: "secret-token",
      workflowIds: {
        extract: "wf-extract",
        publish: "wf-publish",
        answer: "wf-answer",
      },
      fetcher: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              content_type: 1,
              data: JSON.stringify(answerOutput),
              unexpected: { output: extractionOutput },
            },
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(
      nestedEnvelope.answerQuestion({ question: "当前有哪些可用经验？" }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
  });
});

describe("DemoExperienceProvider", () => {
  it("returns deterministic and explicitly labelled local PROPOSAL output", async () => {
    const provider = new DemoExperienceProvider();

    const first = await provider.extractCandidate(extractionInput);
    const second = await provider.extractCandidate(extractionInput);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      provider: "DEMO_RULES",
      workflowId: "DEMO_RULES_EXTRACT",
      output: { classification: "PROPOSAL" },
    });
    expect(provider.workflowIdFor("ANSWER")).toBe("DEMO_RULES_ANSWER");
  });
});
