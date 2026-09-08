import { describe, expect, it, vi } from "vitest";

import {
  FeishuReviewGateway,
  type FeishuFetch,
  type FeishuGatewayError,
} from "./feishu-review.gateway";

const projection = {
  candidateId: "EXP-OTD-001",
  candidateVersionId: "SRC-EXPERIENCE-001-V1",
  projectId: "PRJ-OTD-001",
  title: "缩短交付等待时间",
  applicableSituation: "订单积压时",
  businessProblem: "交付延期",
  practice: "先排查瓶颈",
  resultSummary: "等待时间下降",
  limitations: "需要持续复核",
  structuredCard: {
    trigger: "交付延期",
    conditions: ["订单积压"],
    actions: [{ order: 1, action: "检查瓶颈" }],
    rationale: "先定位约束",
    exceptions: ["缺少基线"],
    scope: {
      products: ["产品 A"],
      departments: ["生产"],
      scenarios: ["高峰期"],
    },
    claims: [{ statement: "瓶颈会造成延期", evidenceIds: ["EVID-001"] }],
    evidenceRefs: [
      {
        sourceObjectId: "SRC-OBJECT-001",
        sourceVersionId: "SRC-VERSION-001",
        reference: "产线日报",
      },
    ],
    missingInformation: ["确认基线"],
  },
  cozeExecuteId: "execute-001",
  dingjiangUrl: "http://localhost:3000/projects/PRJ-OTD-001",
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function configuredGateway(fetchImpl: FeishuFetch) {
  return new FeishuReviewGateway({
    mode: "FEISHU",
    appId: "cli_demo_app",
    appSecret: "very-secret-value",
    baseAppToken: "bascn_demo",
    reviewTableId: "tblDemo",
    timeoutMs: 1_000,
    fetchImpl,
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
}

describe("FeishuReviewGateway", () => {
  it("gets and caches a tenant token, then creates the candidate projection with Chinese fields", async () => {
    const fetchImpl = vi
      .fn<FeishuFetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, data: { items: [] } }))
      .mockResolvedValueOnce(
        response({ code: 0, data: { record: { record_id: "rec_001" } } }),
      )
      .mockResolvedValueOnce(response({ code: 0, data: { items: [] } }))
      .mockResolvedValueOnce(
        response({ code: 0, data: { record: { record_id: "rec_002" } } }),
      );
    const gateway = configuredGateway(fetchImpl);

    await expect(gateway.pushCandidate(projection)).resolves.toEqual({
      provider: "FEISHU",
      candidateId: projection.candidateId,
      candidateVersionId: projection.candidateVersionId,
      recordId: "rec_001",
      pushedAt: "2026-08-26T00:00:00.000Z",
    });
    await gateway.pushCandidate({ ...projection, candidateId: "EXP-OTD-002" });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[2]?.[0]).toContain(
      "/bitable/v1/apps/bascn_demo/tables/tblDemo/records",
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.headers?.Authorization).toBe(
      "Bearer tenant-token",
    );
    expect(String(fetchImpl.mock.calls[2]?.[1]?.body)).toContain(
      '"候选ID":"EXP-OTD-001"',
    );
    expect(String(fetchImpl.mock.calls[2]?.[1]?.body)).toContain(
      '"推荐动作":"1. 检查瓶颈"',
    );
  });

  it("updates the existing Bitable record when the candidate and version projection was already pushed", async () => {
    const fetchImpl = vi
      .fn<FeishuFetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({ code: 0, data: { items: [{ record_id: "rec_existing" }] } }),
      )
      .mockResolvedValueOnce(
        response({ code: 0, data: { record: { record_id: "rec_existing" } } }),
      );

    await configuredGateway(fetchImpl).pushCandidate(projection);

    expect(fetchImpl.mock.calls[1]?.[0]).toContain("/records/search");
    expect(fetchImpl.mock.calls[2]?.[0]).toContain("/records/rec_existing");
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe("PUT");
  });

  it("pulls only review input fields and never returns a Bitable-edited candidate body", async () => {
    const fetchImpl = vi
      .fn<FeishuFetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [
              {
                record_id: "rec_001",
                fields: {
                  候选ID: [
                    { type: "text", text: "EXP-OTD-" },
                    { type: "text", text: "001" },
                  ],
                  候选版本: [{ type: "text", text: "SRC-EXPERIENCE-001-V1" }],
                  审核结果: "批准",
                  审核意见: [
                    { type: "text", text: "证据" },
                    { type: "text", text: "充分" },
                  ],
                  审核人: [{ type: "text", text: "王专家" }],
                  标题: "飞书中被篡改的正文",
                },
              },
            ],
            has_more: false,
          },
        }),
      );

    await expect(
      configuredGateway(fetchImpl).pullReviewDecisions(),
    ).resolves.toEqual([
      {
        provider: "FEISHU",
        candidateId: "EXP-OTD-001",
        candidateVersionId: "SRC-EXPERIENCE-001-V1",
        decision: {
          result: "APPROVED",
          comment: "证据充分",
          reviewer: "王专家",
        },
        pulledAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
  });

  it("rejects illegal reviews and redacts provider secrets from errors", async () => {
    const fetchImpl = vi
      .fn<FeishuFetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [
              {
                record_id: "rec_001",
                fields: {
                  候选ID: "EXP-OTD-001",
                  候选版本: "SRC-EXPERIENCE-001-V1",
                  审核结果: "通过且发布",
                  审核意见: "very-secret-value",
                  审核人: "王专家",
                },
              },
            ],
          },
        }),
      );

    const error = await configuredGateway(fetchImpl)
      .pullReviewDecisions()
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject<Partial<FeishuGatewayError>>({
      code: "INVALID_REVIEW",
    });
    expect(String(error)).not.toContain("very-secret-value");
  });

  it("rejects non-text or extended Bitable text fragments", async () => {
    const fetchImpl = vi
      .fn<FeishuFetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [
              {
                record_id: "rec_001",
                fields: {
                  候选ID: [
                    { type: "text", text: "EXP-OTD-001", extra: "not allowed" },
                  ],
                  候选版本: "SRC-EXPERIENCE-001-V1",
                  审核结果: "批准",
                  审核人: "王专家",
                },
              },
            ],
          },
        }),
      );

    await expect(
      configuredGateway(fetchImpl).pullReviewDecisions(),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });

  it("aborts an overdue provider request and exposes only a timeout code", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FeishuFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("very-secret-value")),
          );
        }),
    );
    const gateway = configuredGateway(fetchImpl);
    const pending = gateway.pullReviewDecisions();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });

  it("uses explicitly labelled deterministic demo receipts and decisions without network calls", async () => {
    const fetchImpl = vi.fn<FeishuFetch>();
    const gateway = new FeishuReviewGateway({
      mode: "DEMO_RULES",
      timeoutMs: 1_000,
      fetchImpl,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    await expect(gateway.pushCandidate(projection)).resolves.toMatchObject({
      provider: "DEMO_RULES",
    });
    await expect(gateway.pullReviewDecisions()).resolves.toMatchObject([
      {
        provider: "DEMO_RULES",
        decision: { result: "PENDING_REVIEW", reviewer: "DEMO_RULES" },
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
