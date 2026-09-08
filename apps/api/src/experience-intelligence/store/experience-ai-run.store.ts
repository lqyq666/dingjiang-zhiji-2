import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  experienceAiRunSchema,
  type ExperienceAiRun,
  type ExperienceExtractionResult,
  type ExperienceAnswerResult,
} from "@dingjiang/contracts";
import type { Pool } from "pg";

import { createPool } from "../../vs01-db";

class ExperienceAiRunStateError extends Error {}

export class ExperienceAiRunReuseError extends Error {
  constructor() {
    super("REQUEST_ID_REUSED");
    this.name = "ExperienceAiRunReuseError";
  }
}

type CreateExperienceAiRun = {
  tenantId: string;
  projectId: string | null;
  purpose: ExperienceAiRun["purpose"];
  provider: ExperienceAiRun["provider"];
  workflowId: string | null;
  requestId: string;
  inputFingerprint: string;
  inputRefs: ExperienceAiRun["inputRefs"];
};

type CompleteExperienceAiRun = {
  executeId: string | null;
  debugUrl: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  structuredOutput: ExperienceExtractionResult | ExperienceAnswerResult | null;
};

@Injectable()
export class ExperienceAiRunStore implements OnModuleDestroy {
  private readonly pool: Pool = createPool();

  async createOrGet(
    input: CreateExperienceAiRun,
  ): Promise<{ run: ExperienceAiRun; created: boolean }> {
    const run: ExperienceAiRun = {
      id: randomUUID(),
      purpose: input.purpose,
      provider: input.provider,
      status: "RUNNING",
      workflowId: input.workflowId,
      inputFingerprint: input.inputFingerprint,
      inputRefs: input.inputRefs,
      structuredOutput: null,
      executeId: null,
      debugUrl: null,
      usage: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    try {
      const inserted = await this.pool.query(
        "INSERT INTO vs17_experience_ai_runs (id, tenant_id, project_id, purpose, provider, workflow_id, request_id, input_fingerprint, input_refs, structured_output, status, execute_id, debug_url, usage, error_code, error_message, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NULL, 'RUNNING', NULL, NULL, NULL, NULL, NULL, $10, NULL) ON CONFLICT (tenant_id, request_id) DO NOTHING RETURNING id",
        [
          run.id,
          input.tenantId,
          input.projectId,
          run.purpose,
          run.provider,
          run.workflowId,
          input.requestId,
          run.inputFingerprint,
          JSON.stringify(run.inputRefs),
          run.createdAt,
        ],
      );
      if (inserted.rowCount === 1) return { run, created: true };
      const existing = await this.pool.query(
        "SELECT id, purpose, provider, status, workflow_id, input_fingerprint, input_refs, structured_output, execute_id, debug_url, usage, error_code, error_message, created_at, completed_at FROM vs17_experience_ai_runs WHERE tenant_id = $1 AND request_id = $2",
        [input.tenantId, input.requestId],
      );
      if (existing.rowCount !== 1)
        throw new Error("Unable to read idempotent experience AI run");
      const existingRun = this.runFromRow(existing.rows[0] ?? {});
      if (existingRun.inputFingerprint !== input.inputFingerprint)
        throw new ExperienceAiRunReuseError();
      return { run: existingRun, created: false };
    } catch (error) {
      if (
        error instanceof ExperienceAiRunStateError ||
        error instanceof ExperienceAiRunReuseError
      )
        throw error;
      throw this.unavailable(error);
    }
  }

  async succeed(
    tenantId: string,
    run: ExperienceAiRun,
    completed: CompleteExperienceAiRun,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    try {
      const updated = await this.pool.query(
        "UPDATE vs17_experience_ai_runs SET status = 'SUCCEEDED', structured_output = $3::jsonb, execute_id = $4, debug_url = $5, usage = $6::jsonb, error_code = NULL, error_message = NULL, completed_at = $7 WHERE id = $1 AND status = 'RUNNING' AND tenant_id = $2",
        [
          run.id,
          tenantId,
          JSON.stringify(completed.structuredOutput),
          completed.executeId,
          completed.debugUrl,
          JSON.stringify(completed.usage),
          completedAt,
        ],
      );
      if (updated.rowCount !== 1)
        throw new ExperienceAiRunStateError("经验智能运行记录状态已变化");
    } catch (error) {
      if (error instanceof ExperienceAiRunStateError) throw error;
      throw this.unavailable(error);
    }
  }

  async fail(
    tenantId: string,
    run: ExperienceAiRun,
    error: {
      code:
        | "INVALID_PROVIDER_OUTPUT"
        | "PROVIDER_TIMEOUT"
        | "PROVIDER_FAILED"
        | "INDEX_FAILED";
      message?: string;
    },
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    try {
      const updated = await this.pool.query(
        "UPDATE vs17_experience_ai_runs SET status = 'FAILED', structured_output = NULL, error_code = $3, error_message = $4, completed_at = $5 WHERE id = $1 AND status = 'RUNNING' AND tenant_id = $2",
        [
          run.id,
          tenantId,
          error.code,
          safeErrorMessage(error.code),
          completedAt,
        ],
      );
      if (updated.rowCount !== 1)
        throw new ExperienceAiRunStateError("经验智能运行记录状态已变化");
    } catch (storeError) {
      if (storeError instanceof ExperienceAiRunStateError) throw storeError;
      throw this.unavailable(storeError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    void error;
    return new ServiceUnavailableException("经验智能运行记录暂不可用");
  }

  private runFromRow(row: Record<string, unknown>): ExperienceAiRun {
    return experienceAiRunSchema.parse({
      id: String(row.id),
      purpose: row.purpose as ExperienceAiRun["purpose"],
      provider: row.provider as ExperienceAiRun["provider"],
      status: row.status as ExperienceAiRun["status"],
      workflowId: row.workflow_id ? String(row.workflow_id) : null,
      inputFingerprint: String(row.input_fingerprint),
      inputRefs: (row.input_refs ?? []) as ExperienceAiRun["inputRefs"],
      structuredOutput: (row.structured_output ??
        null) as ExperienceAiRun["structuredOutput"],
      executeId: row.execute_id ? String(row.execute_id) : null,
      debugUrl: row.debug_url ? String(row.debug_url) : null,
      usage: (row.usage ?? null) as ExperienceAiRun["usage"],
      error: row.error_code
        ? {
            code: row.error_code as
              | "INVALID_PROVIDER_OUTPUT"
              | "PROVIDER_TIMEOUT"
              | "PROVIDER_FAILED"
              | "INDEX_FAILED",
            message: String(row.error_message ?? "Provider 请求失败"),
          }
        : null,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      completedAt: row.completed_at
        ? new Date(row.completed_at as string | Date).toISOString()
        : null,
    });
  }
}

const safeErrorMessage = (
  code:
    | "INVALID_PROVIDER_OUTPUT"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_FAILED"
    | "INDEX_FAILED",
): string => {
  switch (code) {
    case "INVALID_PROVIDER_OUTPUT":
      return "Provider 输出不符合公共 contract";
    case "PROVIDER_TIMEOUT":
      return "Provider 请求超时";
    case "INDEX_FAILED":
      return "正式经验索引失败";
    case "PROVIDER_FAILED":
      return "Provider 请求失败";
  }
};
