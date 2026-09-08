import { randomUUID } from "node:crypto";

import type { OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { createPool } from "../vs01-db";

type Options = {
  mode: "FEISHU" | "DEMO_RULES";
  appId?: string;
  appSecret?: string;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
};

type DeliveryStatus = "SENT" | "FAILED" | "NOT_CONFIGURED";

export class FeishuWorkNotifier implements OnModuleDestroy {
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: Options,
    private readonly pool: Pool = createPool(),
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async enqueue(
    client: PoolClient,
    input: {
      tenantId: string;
      userId: string;
      requestId: string;
      projectId: string;
      projectName: string;
      action: "event.start";
    },
  ): Promise<void> {
    if (this.options.mode !== "FEISHU") return;
    await client.query(
      "INSERT INTO app_feishu_work_notifications (id,tenant_id,user_id,request_id,project_id,action,project_name) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,request_id) DO NOTHING",
      [
        randomUUID(),
        input.tenantId,
        input.userId,
        input.requestId,
        input.projectId,
        input.action,
        input.projectName,
      ],
    );
  }

  async deliver(tenantId: string, requestId: string): Promise<DeliveryStatus> {
    if (this.options.mode !== "FEISHU") return "NOT_CONFIGURED";
    const claimed = await this.pool.query(
      "UPDATE app_feishu_work_notifications n SET status='SENDING',attempts=attempts+1,updated_at=now() FROM app_feishu_user_bindings b JOIN app_users u ON u.tenant_id=b.tenant_id AND u.id=b.user_id AND u.active WHERE n.tenant_id=$1 AND n.request_id=$2 AND n.tenant_id=b.tenant_id AND n.user_id=b.user_id AND b.active AND (n.status IN ('PENDING','FAILED','NOT_CONFIGURED') OR (n.status='SENDING' AND n.updated_at < now()-interval '1 minute')) RETURNING n.project_id,n.project_name,n.action,b.open_id",
      [tenantId, requestId],
    );
    if (!claimed.rowCount) {
      const current = await this.pool.query(
        "SELECT status FROM app_feishu_work_notifications WHERE tenant_id=$1 AND request_id=$2",
        [tenantId, requestId],
      );
      if (current.rows[0]?.status === "SENT") return "SENT";
      await this.pool.query(
        "UPDATE app_feishu_work_notifications SET status='NOT_CONFIGURED',error='员工尚未绑定飞书账号',updated_at=now() WHERE tenant_id=$1 AND request_id=$2 AND status<>'SENT'",
        [tenantId, requestId],
      );
      return "NOT_CONFIGURED";
    }

    const row = claimed.rows[0];
    if (!this.options.appId?.trim() || !this.options.appSecret?.trim()) {
      await this.finish(tenantId, requestId, {
        status: "NOT_CONFIGURED",
        messageId: null,
        error: "飞书机器人配置不完整",
      });
      return "NOT_CONFIGURED";
    }

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
            receive_id: row.open_id,
            msg_type: "interactive",
            uuid: requestId,
            content: JSON.stringify(
              this.card(row.project_id, row.project_name),
            ),
          }),
        },
      );
      const payload = (await response.json()) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!response.ok || payload.code !== 0 || !payload.data?.message_id)
        throw new Error(this.safe(payload.msg));
      await this.finish(tenantId, requestId, {
        status: "SENT",
        messageId: payload.data.message_id,
        error: null,
      });
      return "SENT";
    } catch (error) {
      await this.finish(tenantId, requestId, {
        status: "FAILED",
        messageId: null,
        error: this.safe(error instanceof Error ? error.message : undefined),
      });
      return "FAILED";
    }
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
      throw new Error(this.safe(payload.msg));
    this.token = {
      value: payload.tenant_access_token,
      expiresAt:
        Date.now() + Math.max(60, (payload.expire ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  private async finish(
    tenantId: string,
    requestId: string,
    delivery: {
      status: DeliveryStatus;
      messageId: string | null;
      error: string | null;
    },
  ): Promise<void> {
    await this.pool.query(
      "UPDATE app_feishu_work_notifications SET status=$1,message_id=$2,error=$3,sent_at=CASE WHEN $1='SENT' THEN now() ELSE NULL END,updated_at=now() WHERE tenant_id=$4 AND request_id=$5",
      [
        delivery.status,
        delivery.messageId,
        delivery.error,
        tenantId,
        requestId,
      ],
    );
  }

  private card(projectId: string, projectName: string) {
    const elements: Array<Record<string, unknown>> = [
      {
        tag: "markdown",
        content: `**项目：** ${this.safe(projectName)}\n**动作：** 已确认事件并开始处理\n**项目编号：** ${this.safe(projectId)}\n\n请回到 WorkBuddy 询问“我的下一步工作是什么”。`,
      },
    ];
    if (this.options.publicUrl?.trim())
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看项目记录" },
            type: "primary",
            url: `${this.options.publicUrl.replace(/\/$/, "")}/project/${encodeURIComponent(projectId)}`,
          },
        ],
      });
    return {
      config: { wide_screen_mode: true },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "鼎江智绩 · 工作已同步" },
      },
      elements,
    };
  }

  private safe(value: string | undefined): string {
    return (value || "飞书通知失败").replace(/[<>]/g, "").slice(0, 300);
  }
}
