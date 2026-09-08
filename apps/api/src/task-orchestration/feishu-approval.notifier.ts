export type FeishuApprovalNotice = {
  requestId: string;
  projectId: string;
  projectName: string;
  approvalKind: "MONEY" | "DIRECTION";
  title: string;
  purpose: string;
  amount: number | null;
};

export type FeishuApprovalDelivery =
  | { status: "NOT_CONFIGURED"; messageId: null; error: string }
  | { status: "SENT"; messageId: string; error: null }
  | { status: "FAILED"; messageId: null; error: string };

type Options = {
  mode: "FEISHU" | "DEMO_RULES";
  appId?: string;
  appSecret?: string;
  approverOpenId?: string;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
};

export class FeishuApprovalNotifier {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get recipientId(): string | null {
    return this.isConfigured() ? this.options.approverOpenId!.trim() : null;
  }

  async send(input: FeishuApprovalNotice): Promise<FeishuApprovalDelivery> {
    if (!this.isConfigured())
      return {
        status: "NOT_CONFIGURED",
        messageId: null,
        error: "缺少 FEISHU_APPROVER_OPEN_ID 或飞书机器人消息配置",
      };
    try {
      const token = await this.accessToken();
      const response = await this.fetchImpl(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: this.options.approverOpenId!.trim(),
            msg_type: "interactive",
            content: JSON.stringify(this.card(input)),
          }),
        },
      );
      const payload = (await response.json()) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!response.ok || payload.code !== 0 || !payload.data?.message_id)
        return {
          status: "FAILED",
          messageId: null,
          error: this.safeError(payload.msg),
        };
      return {
        status: "SENT",
        messageId: payload.data.message_id,
        error: null,
      };
    } catch (error) {
      return {
        status: "FAILED",
        messageId: null,
        error: this.safeError(
          error instanceof Error ? error.message : "飞书消息发送失败",
        ),
      };
    }
  }

  private isConfigured(): boolean {
    return (
      this.options.mode === "FEISHU" &&
      Boolean(this.options.appId?.trim()) &&
      Boolean(this.options.appSecret?.trim()) &&
      Boolean(this.options.approverOpenId?.trim())
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return this.token.value;
    const response = await this.fetchImpl(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.options.appId!.trim(),
          app_secret: this.options.appSecret!.trim(),
        }),
      },
    );
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token)
      throw new Error(this.safeError(payload.msg));
    this.token = {
      value: payload.tenant_access_token,
      expiresAt:
        Date.now() + Math.max(60, (payload.expire ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  private card(input: FeishuApprovalNotice) {
    const kind = input.approvalKind === "MONEY" ? "金钱事项" : "重大工作方向";
    const amount =
      input.amount === null
        ? ""
        : `\n**金额：** ¥${input.amount.toLocaleString("zh-CN")}`;
    const elements: Array<Record<string, unknown>> = [
      {
        tag: "markdown",
        content: `**项目：** ${this.clean(input.projectName)}\n**类型：** ${kind}${amount}\n**事项：** ${this.clean(input.title)}\n**说明：** ${this.clean(input.purpose)}\n**请求编号：** ${input.requestId}`,
      },
      { tag: "hr" },
      {
        tag: "markdown",
        content: "请由审批人核对后，在鼎江智绩审批中心处理。",
      },
    ];
    if (this.options.publicUrl?.trim())
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "打开审批中心" },
            type: "primary",
            url: `${this.options.publicUrl.replace(/\/$/, "")}/boss?projectId=${encodeURIComponent(input.projectId)}#exception-approvals`,
          },
        ],
      });
    return {
      config: { wide_screen_mode: true },
      header: {
        template: input.approvalKind === "MONEY" ? "red" : "blue",
        title: { tag: "plain_text", content: `待审批 · ${kind}` },
      },
      elements,
    };
  }

  private clean(value: string | undefined): string {
    return (value ?? "").replace(/[<>]/g, "").slice(0, 300);
  }

  private safeError(value: string | undefined): string {
    const safe = this.clean(value || "飞书消息发送失败");
    return safe || "飞书消息发送失败";
  }
}
