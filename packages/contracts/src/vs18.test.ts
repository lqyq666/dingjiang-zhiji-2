import { describe, expect, it } from "vitest";

import {
  atomicTaskProposalListSchema,
  editAtomicTaskInputSchema,
} from "./vs18";

describe("VS18 atomic task contracts", () => {
  it("caps one generation result at three task proposals", () => {
    const item = {
      id: "4a585fe1-2320-4b35-933a-6737b556ea76",
      projectId: "PRJ-1",
      phaseCode: "BASELINE_FACTS",
      sourceWorkItemId: "TASK-1",
      title: "核对延期事实",
      purpose: "确认延期天数和来源",
      basis: "根据当前事实生成",
      approvalKind: "NONE",
      amount: null,
      status: "PROPOSED",
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      approvalRequestId: null,
      feishuDeliveryStatus: "NOT_REQUIRED",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(() =>
      atomicTaskProposalListSchema.parse({
        provider: "DEMO_RULES",
        classification: "PROPOSAL",
        limit: 3,
        items: [item, item, item, item],
      }),
    ).toThrow();
  });

  it("requires an amount only for money approvals", () => {
    expect(
      editAtomicTaskInputSchema.safeParse({
        actor: "PMC",
        title: "批准预算",
        purpose: "购买试验材料",
        approvalKind: "MONEY",
        amount: null,
      }).success,
    ).toBe(false);
    expect(
      editAtomicTaskInputSchema.safeParse({
        actor: "PMC",
        title: "核对事实",
        purpose: "确认记录",
        approvalKind: "NONE",
        amount: null,
      }).success,
    ).toBe(true);
  });
});
