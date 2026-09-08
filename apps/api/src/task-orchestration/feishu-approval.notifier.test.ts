import { describe, expect, it, vi } from "vitest";

import { FeishuApprovalNotifier } from "./feishu-approval.notifier";

const notice = {
  requestId: "4a585fe1-2320-4b35-933a-6737b556ea76",
  projectId: "PRJ-OTD-001",
  projectName: "订单交付改善",
  approvalKind: "MONEY" as const,
  title: "批准现场试验预算",
  purpose: "采购试验物料",
  amount: 1200,
};

describe("FeishuApprovalNotifier", () => {
  it("fails closed without an explicit approver open_id", async () => {
    const fetchImpl = vi.fn();
    const notifier = new FeishuApprovalNotifier({
      mode: "FEISHU",
      appId: "app",
      appSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(notifier.send(notice)).resolves.toMatchObject({
      status: "NOT_CONFIGURED",
      messageId: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a tenant token and sends one interactive card to the configured user", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
            expire: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { message_id: "om_message" } }),
          { status: 200 },
        ),
      );
    const notifier = new FeishuApprovalNotifier({
      mode: "FEISHU",
      appId: "app",
      appSecret: "secret",
      approverOpenId: "ou_approver",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(notifier.send(notice)).resolves.toEqual({
      status: "SENT",
      messageId: "om_message",
      error: null,
    });
    const messageRequest = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(messageRequest.body)) as {
      receive_id: string;
      msg_type: string;
      content: string;
    };
    expect(body.receive_id).toBe("ou_approver");
    expect(body.msg_type).toBe("interactive");
    expect(body.content).toContain("金钱事项");
    expect(body.content).not.toContain("secret");
  });
});
