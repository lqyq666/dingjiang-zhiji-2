import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answerExperience,
  generateExperienceAiDraft,
  publishFormalExperienceToCoze,
  pullFeishuExperienceReviews,
  pushExperienceCandidateToFeishu,
} from "./vs17-api";

const timestamp = "2026-08-26T08:00:00.000Z";
const locator = {
  sourceObjectId: "SRC-1",
  sourceVersionId: "SV-1",
  reference: "已确认结果摘要",
};
const draft = {
  title: "减少产线切换损耗",
  applicableSituation: "订单波动导致换线频繁",
  businessProblem: "换线损耗影响交期",
  practice: "按产品族合并排产并每班复核",
  resultSummary: "换线次数下降",
  limitations: "只适用于产品工艺接近的场景",
  structuredCard: {
    trigger: "换线次数连续两周增加",
    conditions: ["产品工艺接近"],
    actions: [{ order: 1, action: "按产品族合并排产" }],
    rationale: "减少非必要换线",
    exceptions: ["紧急订单优先"],
    scope: {
      products: ["A 系列"],
      departments: ["生产部"],
      scenarios: ["产能风险"],
    },
    claims: [{ statement: "换线次数下降", evidenceIds: ["EVID-1"] }],
    evidenceRefs: [locator],
    missingInformation: [],
  },
  reviewFocus: ["核验换线次数"],
  classification: "PROPOSAL",
};
const run = {
  id: "RUN-1",
  purpose: "EXTRACT",
  provider: "DEMO_RULES",
  status: "SUCCEEDED",
  workflowId: null,
  inputFingerprint: "fingerprint-1",
  inputRefs: [{ kind: "PROJECT", id: "PRJ-1" }],
  structuredOutput: draft,
  executeId: null,
  debugUrl: null,
  usage: null,
  error: null,
  createdAt: timestamp,
  completedAt: timestamp,
};
const answerResult = {
  answer: "当前正式经验可作为候选参考，仍需人工判断。",
  matches: [
    {
      experienceId: "EXP-1",
      applicability: "MATCH",
      reason: "适用条件与当前订单一致。",
      citations: [locator],
    },
  ],
  missingInformation: [],
  shouldClarify: false,
  classification: "PROPOSAL",
};
const answerRun = {
  ...run,
  purpose: "ANSWER",
  structuredOutput: answerResult,
};

describe("VS17 experience intelligence browser request seam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an AI draft with PMC authorization and strictly parses its response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run, draft }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateExperienceAiDraft("PRJ-1", {
      actor: "PMC",
      requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    });

    expect(result.draft.classification).toBe("PROPOSAL");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs17/projects/PRJ-1/experience-drafts/ai"),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-vs01-role": "PMC",
        }),
      }),
    );
  });

  it("rejects an untrusted draft response before it reaches the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ run, draft: { ...draft, extra: true } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      generateExperienceAiDraft("PRJ-1", {
        actor: "PMC",
        requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
      }),
    ).rejects.toThrow();
  });

  it("keeps the expert role boundary when projecting a candidate to Feishu", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: "DEMO_RULES",
          candidateId: "CAND-1",
          candidateVersionId: "CAND-V1",
          recordId: "FS-REC-1",
          pushedAt: timestamp,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await pushExperienceCandidateToFeishu("CAND-1", {
      actor: "EXPERT_REVIEWER",
      expectedCandidateVersionId: "CAND-V1",
      requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs17/experience-candidates/CAND-1/feishu/push"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vs01-role": "EXPERT_REVIEWER" }),
      }),
    );
  });

  it("pulls Feishu reviews with expert authorization and strictly parses the receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              provider: "DEMO_RULES",
              candidateId: "CAND-1",
              candidateVersionId: "CAND-V1",
              decision: {
                result: "APPROVED",
                comment: "同意",
                reviewer: "专家",
              },
              pulledAt: timestamp,
            },
          ],
          summary: { applied: 1, skipped: 0, failed: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pullFeishuExperienceReviews({
      actor: "EXPERT_REVIEWER",
      requestId: "3b241101-e2bb-4255-8caf-4136c566a963",
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs17/feishu/reviews/pull"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vs01-role": "EXPERT_REVIEWER" }),
      }),
    );
  });

  it("publishes a formal experience index with expert authorization and strictly parses the receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          experienceId: "EXP-1",
          experienceVersionId: "EXP-V1",
          indexStatus: "INDEXED",
          run: { ...run, purpose: "PUBLISH", structuredOutput: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFormalExperienceToCoze("EXP-1", {
      actor: "EXPERT_REVIEWER",
      expectedExperienceVersionId: "EXP-V1",
      requestId: "3b241101-e2bb-4255-8caf-4136c566a964",
    });

    expect(result.indexStatus).toBe("INDEXED");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs17/experiences/EXP-1/coze/publish"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vs01-role": "EXPERT_REVIEWER" }),
      }),
    );
  });

  it("rejects unknown fields in Feishu pull and formal experience index receipts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [],
              summary: { applied: 0, skipped: 0, failed: 0 },
              unexpected: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              experienceId: "EXP-1",
              experienceVersionId: "EXP-V1",
              indexStatus: "INDEXED",
              run: { ...run, purpose: "PUBLISH", structuredOutput: null },
              unexpected: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    await expect(
      pullFeishuExperienceReviews({
        actor: "EXPERT_REVIEWER",
        requestId: "3b241101-e2bb-4255-8caf-4136c566a966",
      }),
    ).rejects.toThrow();
    await expect(
      publishFormalExperienceToCoze("EXP-1", {
        actor: "EXPERT_REVIEWER",
        expectedExperienceVersionId: "EXP-V1",
        requestId: "3b241101-e2bb-4255-8caf-4136c566a967",
      }),
    ).rejects.toThrow();
  });

  it("answers with PMC authorization and strictly parses the proposal response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: answerRun, result: answerResult }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await answerExperience({
      actor: "PMC",
      question: "这个经验适用于新订单吗？",
      requestId: "3b241101-e2bb-4255-8caf-4136c566a965",
    });

    expect(result.result.classification).toBe("PROPOSAL");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/vs17/experience-answer"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vs01-role": "PMC" }),
      }),
    );
  });

  it("surfaces a service error without discarding the caller's form state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: "Coze 调用超时",
            code: "PROVIDER_TIMEOUT",
          }),
          {
            status: 504,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      answerExperience({
        actor: "PMC",
        question: "这个经验适用于新订单吗？",
        requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
      }),
    ).rejects.toMatchObject({
      message: "Coze 调用超时",
      code: "PROVIDER_TIMEOUT",
    });
  });
});
