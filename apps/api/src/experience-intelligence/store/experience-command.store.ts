import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { createPool } from "../../vs01-db";

export type ExperienceCommandRoute =
  | "VS17_AI_DRAFT"
  | "VS17_FEISHU_PUSH"
  | "VS17_FEISHU_PULL"
  | "VS17_COZE_PUBLISH"
  | "VS17_ANSWER";

type CreateExperienceCommand = {
  tenantId: string;
  route: ExperienceCommandRoute;
  requestId: string;
  payloadFingerprint: string;
};

export type ExperienceCommandReceipt = {
  id: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  response: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export class ExperienceCommandReuseError extends Error {
  constructor() {
    super("REQUEST_ID_REUSED");
    this.name = "ExperienceCommandReuseError";
  }
}

@Injectable()
export class ExperienceCommandStore implements OnModuleDestroy {
  private readonly pool: Pool = createPool();

  async createOrGet(
    input: CreateExperienceCommand,
  ): Promise<{ receipt: ExperienceCommandReceipt; created: boolean }> {
    const receipt: ExperienceCommandReceipt = {
      id: randomUUID(),
      status: "RUNNING",
      response: null,
      errorCode: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    try {
      const inserted = await this.pool.query(
        "INSERT INTO vs17_experience_command_receipts (id, tenant_id, route, request_id, payload_fingerprint, status, created_at) VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6) ON CONFLICT (tenant_id, route, request_id) DO NOTHING RETURNING id",
        [
          receipt.id,
          input.tenantId,
          input.route,
          input.requestId,
          input.payloadFingerprint,
          receipt.createdAt,
        ],
      );
      if (inserted.rowCount === 1) return { receipt, created: true };
      const existing = await this.pool.query(
        "SELECT id, payload_fingerprint, status, response, error_code, created_at, completed_at FROM vs17_experience_command_receipts WHERE tenant_id = $1 AND route = $2 AND request_id = $3",
        [input.tenantId, input.route, input.requestId],
      );
      if (existing.rowCount !== 1)
        throw new Error("Unable to read idempotent experience command");
      const row = existing.rows[0] ?? {};
      if (String(row.payload_fingerprint) !== input.payloadFingerprint)
        throw new ExperienceCommandReuseError();
      return { receipt: receiptFromRow(row), created: false };
    } catch (error) {
      if (error instanceof ExperienceCommandReuseError) throw error;
      throw this.unavailable(error);
    }
  }

  async succeed(
    tenantId: string,
    receipt: ExperienceCommandReceipt,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.complete(tenantId, receipt, "SUCCEEDED", response, null);
  }

  async fail(
    tenantId: string,
    receipt: ExperienceCommandReceipt,
    errorCode: string,
  ): Promise<void> {
    await this.complete(tenantId, receipt, "FAILED", null, errorCode);
  }

  private async complete(
    tenantId: string,
    receipt: ExperienceCommandReceipt,
    status: "SUCCEEDED" | "FAILED",
    response: Record<string, unknown> | null,
    errorCode: string | null,
  ): Promise<void> {
    try {
      const updated = await this.pool.query(
        "UPDATE vs17_experience_command_receipts SET status = $3, response = $4::jsonb, error_code = $5, completed_at = $6 WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'",
        [
          receipt.id,
          tenantId,
          status,
          response === null ? null : JSON.stringify(response),
          errorCode,
          new Date().toISOString(),
        ],
      );
      if (updated.rowCount !== 1) throw new Error("经验智能命令状态已变化");
    } catch (error) {
      if (error instanceof Error && error.message === "经验智能命令状态已变化")
        throw error;
      throw this.unavailable(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    void error;
    return new ServiceUnavailableException("经验智能命令记录暂不可用");
  }
}

const receiptFromRow = (
  row: Record<string, unknown>,
): ExperienceCommandReceipt => ({
  id: String(row.id),
  status: row.status as ExperienceCommandReceipt["status"],
  response: (row.response ?? null) as Record<string, unknown> | null,
  errorCode: row.error_code ? String(row.error_code) : null,
  createdAt: new Date(row.created_at as string | Date).toISOString(),
  completedAt: row.completed_at
    ? new Date(row.completed_at as string | Date).toISOString()
    : null,
});
