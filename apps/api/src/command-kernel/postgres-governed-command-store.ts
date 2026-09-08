import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { governedCommandResultSchema } from "@dingjiang/contracts";

import { createPool } from "../vs01-db";
import { isProduction } from "../runtime-config";
import {
  approvalDigest,
  requiresHumanApproval,
  principalStillAuthorized,
} from "./production-authorization";
import {
  GovernedCommandFailure,
  type GovernedCommandStore,
  type GovernedCommandTransaction,
} from "./governed-command-kernel";

type ReceiptRow = {
  payload_fingerprint: string;
  correlation_id: string;
  result_version: number;
  response: Record<string, unknown>;
};

export class PostgresGovernedCommandStore implements GovernedCommandStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(pool?: Pool) {
    this.pool = pool ?? createPool();
    this.ownsPool = pool === undefined;
  }

  async execute(input: Parameters<GovernedCommandStore["execute"]>[0]) {
    const client = await this.pool.connect();
    const correlationId = input.envelope.request.correlationId;
    let commitStarted = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        input.envelope.target.tenantId,
      ]);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          [
            input.envelope.target.tenantId,
            input.envelope.name,
            input.envelope.request.requestId,
          ].join(":"),
        ],
      );

      if (isProduction()) {
        const principal = input.envelope.principal;
        if (!principal.credentialId)
          throw new GovernedCommandFailure(
            "UNAUTHORIZED",
            "需要有效的个人 MCP 凭证",
            correlationId,
          );
        const account = await client.query(
          "SELECT role FROM app_users WHERE id=$1 AND tenant_id=$2 AND active=true FOR SHARE",
          [principal.subjectId, principal.tenantId],
        );
        const credential = await client.query(
          "SELECT scopes,project_ids FROM app_mcp_credentials WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND active=true AND expires_at>clock_timestamp() FOR SHARE",
          [principal.credentialId, principal.tenantId, principal.subjectId],
        );
        const current =
          account.rows[0] && credential.rows[0]
            ? { ...account.rows[0], ...credential.rows[0] }
            : undefined;
        if (!principalStillAuthorized(input.envelope, current))
          throw new GovernedCommandFailure(
            "PERMISSION_DENIED",
            "账号或凭证权限已经变化，请重新获取上下文",
            correlationId,
          );
      }

      const existing = await client.query<ReceiptRow>(
        "SELECT payload_fingerprint, correlation_id, result_version, response FROM governed_command_receipts WHERE tenant_id = $1 AND command_name = $2 AND request_id = $3",
        [
          input.envelope.target.tenantId,
          input.envelope.name,
          input.envelope.request.requestId,
        ],
      );
      const receipt = existing.rows[0];
      if (receipt) {
        if (receipt.payload_fingerprint !== input.payloadFingerprint)
          throw new GovernedCommandFailure(
            "CONFLICT",
            "requestId 已用于不同命令内容",
            correlationId,
          );
        commitStarted = true;
        await client.query("COMMIT");
        return {
          requestId: input.envelope.request.requestId,
          correlationId: receipt.correlation_id,
          version: Number(receipt.result_version),
          replayed: true,
          data: receipt.response,
        };
      }

      if (
        isProduction() &&
        requiresHumanApproval(
          input.envelope.name,
          input.envelope.request.payload,
        )
      ) {
        const e = input.envelope;
        const approved = await client.query(
          "UPDATE production_human_approvals SET consumed_at=clock_timestamp() WHERE tenant_id=$1 AND command_name=$2 AND request_id=$3 AND actor_subject_id=$4 AND actor_role=$5 AND credential_id=$6 AND project_id=$7 AND expected_version=$8 AND approval_digest=$9 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id",
          [
            e.target.tenantId,
            e.name,
            e.request.requestId,
            e.principal.subjectId,
            e.principal.role,
            e.principal.credentialId,
            e.target.projectId,
            e.request.expectedVersion,
            approvalDigest(e),
          ],
        );
        if (approved.rowCount !== 1)
          throw new GovernedCommandFailure(
            "PERMISSION_DENIED",
            "该操作需要员工在独立维护控制台核对并授权；AI confirmation 文本不构成授权",
            correlationId,
          );
      }
      const outcome = await input.run(this.transaction(client));
      const result = governedCommandResultSchema.parse({
        requestId: input.envelope.request.requestId,
        correlationId,
        version: outcome.version,
        replayed: false,
        data: outcome.data,
      });
      const receiptId = randomUUID();
      const values = [
        receiptId,
        input.envelope.target.tenantId,
        input.envelope.name,
        input.envelope.request.requestId,
        input.envelope.target.projectId,
        input.envelope.principal.subjectId,
        input.envelope.principal.role,
        input.envelope.request.expectedVersion,
        result.version,
        input.envelope.request.reason,
        input.payloadFingerprint,
        correlationId,
      ] as const;
      await client.query(
        "INSERT INTO governed_command_receipts (id, tenant_id, command_name, request_id, project_id, actor_subject_id, actor_role, expected_version, result_version, reason, payload_fingerprint, correlation_id, response) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
        [...values, JSON.stringify(result.data)],
      );
      await client.query(
        "INSERT INTO governed_command_audit_events (id, tenant_id, command_receipt_id, command_name, request_id, project_id, actor_subject_id, actor_role, reason, expected_version, result_version, correlation_id, payload_fingerprint, event_type, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
        [
          randomUUID(),
          input.envelope.target.tenantId,
          receiptId,
          input.envelope.name,
          input.envelope.request.requestId,
          input.envelope.target.projectId,
          input.envelope.principal.subjectId,
          input.envelope.principal.role,
          input.envelope.request.reason,
          input.envelope.request.expectedVersion,
          result.version,
          correlationId,
          input.payloadFingerprint,
          outcome.audit.eventType,
          JSON.stringify(outcome.audit.details),
        ],
      );
      commitStarted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await this.rollback(client);
      if (error instanceof GovernedCommandFailure) throw error;
      throw new GovernedCommandFailure(
        "INTERNAL_ERROR",
        commitStarted
          ? "提交结果待确认；请使用完全相同的 requestId 与内容查询或重试，不要另建请求"
          : "命令未完成；请检查状态后使用原请求编号重试",
        correlationId,
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private transaction(client: PoolClient): GovernedCommandTransaction {
    return {
      client,
      query: async (text, values) => {
        const result = await client.query(
          text,
          values as unknown[] | undefined,
        );
        return { rowCount: result.rowCount, rows: result.rows };
      },
    };
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original failure remains authoritative and secret-safe.
    }
  }
}
