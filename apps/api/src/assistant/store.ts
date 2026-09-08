import { runtimeTenantId } from "../runtime-config";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type {
  AssistantHistory,
  AssistantRun,
  AssistantRunRequest,
  AssistantScope,
  AssistantStreamEvent,
  AssistantStreamType,
  AssistantWorkEvent,
} from "./contracts";
import { createPool } from "../vs01-db";

@Injectable()
export class AssistantStore implements OnModuleDestroy {
  private readonly pool: Pool = createPool();

  async ensureSession(scope: AssistantScope): Promise<string> {
    if (!scope.sourceTaskId)
      throw new Error("Assistant session requires a source task");
    const id = `ASST-${scope.projectId}-${scope.role}-${scope.subjectId}-${scope.policyVersion}`;
    try {
      const result = await this.pool.query(
        "INSERT INTO vs12_assistant_sessions (id, tenant_id, subject_id, role, project_id, source_task_id, policy_version) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, project_id, subject_id, role, policy_version) DO UPDATE SET source_task_id = EXCLUDED.source_task_id, last_active_at = now() RETURNING id",
        [
          id,
          scope.tenantId,
          scope.subjectId,
          scope.role,
          scope.projectId,
          scope.sourceTaskId,
          scope.policyVersion,
        ],
      );
      const persistedId = result.rows[0]?.id;
      if (typeof persistedId !== "string")
        throw new Error("Unable to read the persisted assistant session id");
      return persistedId;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async createRun(
    sessionId: string,
    scope: AssistantScope & { sourceTaskId: string },
    request: AssistantRunRequest,
  ): Promise<AssistantRun> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const correlationKey = `manual:${id}`;
    try {
      await this.pool.query(
        "INSERT INTO vs12_assistant_runs (id, tenant_id, session_id, project_id, source_task_id, correlation_key, stage_code, intent, question, status, provider, classification) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'QUEUED', 'DEMO_RULES', 'PROPOSAL')",
        [
          id,
          scope.tenantId,
          sessionId,
          scope.projectId,
          scope.sourceTaskId,
          correlationKey,
          request.stageCode ?? null,
          request.intent ?? "ASK",
          request.question ?? "",
        ],
      );
      return {
        id,
        sessionId,
        projectId: scope.projectId,
        sourceTaskId: scope.sourceTaskId,
        correlationKey,
        intent: request.intent ?? "ASK",
        question: request.question ?? "",
        stageCode: request.stageCode ?? null,
        status: "QUEUED",
        provider: "DEMO_RULES",
        classification: "PROPOSAL",
        createdAt,
        completedAt: null,
        suggestion: null,
        fallbackReason: null,
      };
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async createWorkEventRun(
    sessionId: string,
    scope: AssistantScope & { sourceTaskId: string },
    event: AssistantWorkEvent,
  ): Promise<{ run: AssistantRun; created: boolean }> {
    const id = randomUUID();
    try {
      const inserted = await this.pool.query(
        "INSERT INTO vs12_assistant_runs (id, tenant_id, session_id, project_id, source_task_id, correlation_key, stage_code, intent, question, status, provider, classification) VALUES ($1, $2, $3, $4, $5, $6, $7, 'WORK_EVENT', '', 'QUEUED', 'DEMO_RULES', 'PROPOSAL') ON CONFLICT (session_id, correlation_key) DO NOTHING RETURNING id, created_at",
        [
          id,
          scope.tenantId,
          sessionId,
          scope.projectId,
          scope.sourceTaskId,
          event.correlationKey,
          event.stageCode,
        ],
      );
      if (inserted.rowCount === 1) {
        return {
          created: true,
          run: this.runFromRow({
            id,
            session_id: sessionId,
            project_id: scope.projectId,
            source_task_id: scope.sourceTaskId,
            correlation_key: event.correlationKey,
            stage_code: event.stageCode,
            intent: "WORK_EVENT",
            question: "",
            status: "QUEUED",
            provider: "DEMO_RULES",
            classification: "PROPOSAL",
            created_at: inserted.rows[0]?.created_at ?? new Date(),
            completed_at: null,
            suggestion: null,
            fallback_reason: null,
          }),
        };
      }
      const existing = await this.pool.query(
        "SELECT id, session_id, project_id, source_task_id, correlation_key, stage_code, intent, question, status, provider, classification, created_at, completed_at, suggestion, fallback_reason FROM vs12_assistant_runs WHERE tenant_id = $1 AND session_id = $2 AND correlation_key = $3",
        [scope.tenantId, sessionId, event.correlationKey],
      );
      if (existing.rowCount !== 1)
        throw new Error("Unable to read idempotent assistant run");
      return { created: false, run: this.runFromRow(existing.rows[0] ?? {}) };
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async claimWorkEvents(maximumCount: number): Promise<AssistantWorkEvent[]> {
    try {
      const result = await this.pool.query(
        "SELECT id, tenant_id, project_id, source_task_id, correlation_key, event_type, stage_code, actor_role, payload FROM vs12_claim_pending_work_events($1)",
        [maximumCount],
      );
      return result.rows.map((row) => this.workEventFromRow(row));
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async recoverExpiredWorkEvents(): Promise<number> {
    try {
      const result = await this.pool.query(
        "UPDATE vs12_work_events SET delivery_status = 'PENDING', locked_at = NULL, available_at = now() WHERE delivery_status = 'PROCESSING' AND locked_at < now() - interval '30 seconds'",
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async markWorkEventsDelivered(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.pool.query(
        "UPDATE vs12_work_events SET delivery_status = 'DELIVERED', delivered_at = now(), locked_at = NULL, last_error = NULL WHERE id = ANY($1::bigint[]) AND delivery_status = 'PROCESSING'",
        [ids],
      );
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async retryOrFailWorkEvents(
    ids: readonly string[],
    error: unknown,
  ): Promise<void> {
    if (ids.length === 0) return;
    const reason =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Assistant bridge failed";
    try {
      await this.pool.query(
        "UPDATE vs12_work_events SET delivery_status = CASE WHEN attempt_count >= 2 THEN 'FAILED' ELSE 'PENDING' END, available_at = CASE WHEN attempt_count >= 2 THEN available_at ELSE now() + interval '1 second' END, locked_at = NULL, last_error = $2 WHERE id = ANY($1::bigint[]) AND delivery_status = 'PROCESSING'",
        [ids, reason],
      );
    } catch (storeError) {
      throw this.unavailable(storeError);
    }
  }

  async updateRun(run: AssistantRun): Promise<void> {
    try {
      await this.pool.query(
        "UPDATE vs12_assistant_runs SET status = $3, provider = $4, suggestion = $5::jsonb, fallback_reason = $6, completed_at = $7 WHERE id = $1 AND tenant_id = $2",
        [
          run.id,
          runtimeTenantId(),
          run.status,
          run.provider,
          JSON.stringify(
            run.suggestion && {
              classification: run.suggestion.classification,
              answer: run.suggestion.answer,
              evidenceIds: run.suggestion.evidenceIds,
              nextAction: run.suggestion.nextAction,
            },
          ),
          run.fallbackReason,
          run.completedAt,
        ],
      );
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async append(
    scope: AssistantScope,
    sessionId: string,
    run: AssistantRun | null,
    type: AssistantStreamType,
    payload: Record<string, unknown>,
  ): Promise<AssistantStreamEvent> {
    const occurredAt = new Date().toISOString();
    try {
      const inserted = await this.pool.query(
        "INSERT INTO vs12_assistant_stream_events (tenant_id, session_id, run_id, project_id, stage_code, type, payload) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING cursor, created_at",
        [
          scope.tenantId,
          sessionId,
          run?.id,
          scope.projectId,
          run?.stageCode ?? null,
          type,
          JSON.stringify(payload),
        ],
      );
      const row = inserted.rows[0] ?? {};
      return {
        cursor: String(row.cursor),
        sessionId,
        runId: run?.id ?? null,
        stageCode: run?.stageCode ?? null,
        occurredAt: new Date(row.created_at ?? occurredAt).toISOString(),
        type,
        payload,
      };
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async history(scope: AssistantScope): Promise<AssistantHistory> {
    try {
      const session = await this.pool.query(
        "SELECT id, source_task_id, created_at, last_active_at FROM vs12_assistant_sessions WHERE tenant_id = $1 AND project_id = $2 AND subject_id = $3 AND role = $4 AND policy_version = $5",
        [
          scope.tenantId,
          scope.projectId,
          scope.subjectId,
          scope.role,
          scope.policyVersion,
        ],
      );
      if (session.rowCount === 0)
        return {
          session: {
            id: `ASST-${scope.projectId}-${scope.role}-${scope.subjectId}-${scope.policyVersion}`,
            scope: { ...scope, sourceTaskId: "" },
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
          },
          runs: [],
          latestCursor: "0",
        };
      const result = await this.pool.query(
        "SELECT r.id, r.session_id, r.project_id, r.source_task_id, r.correlation_key, r.stage_code, r.intent, r.question, r.status, r.provider, r.classification, r.created_at, r.completed_at, r.suggestion, r.fallback_reason FROM vs12_assistant_runs r WHERE r.tenant_id = $1 AND r.session_id = $2 ORDER BY r.created_at",
        [scope.tenantId, session.rows[0]?.id],
      );
      const cursor = await this.pool.query(
        "SELECT COALESCE(max(cursor), 0)::text AS cursor FROM vs12_assistant_stream_events WHERE tenant_id = $1 AND session_id = $2",
        [scope.tenantId, session.rows[0]?.id],
      );
      return {
        session: {
          id: String(session.rows[0]?.id),
          scope: {
            ...scope,
            sourceTaskId: String(session.rows[0]?.source_task_id),
          },
          createdAt: new Date(session.rows[0]?.created_at).toISOString(),
          lastActiveAt: new Date(session.rows[0]?.last_active_at).toISOString(),
        },
        runs: result.rows.map((row) => this.runFromRow(row)),
        latestCursor: String(cursor.rows[0]?.cursor ?? "0"),
      };
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async events(
    scope: AssistantScope,
    after: string | undefined,
  ): Promise<AssistantStreamEvent[]> {
    try {
      const result = await this.pool.query(
        "SELECT cursor, session_id, run_id, stage_code, type, payload, created_at FROM vs12_assistant_stream_events WHERE tenant_id = $1 AND session_id IN (SELECT id FROM vs12_assistant_sessions WHERE tenant_id = $1 AND project_id = $2 AND subject_id = $3 AND role = $4 AND policy_version = $5) AND cursor > $6::bigint ORDER BY cursor",
        [
          scope.tenantId,
          scope.projectId,
          scope.subjectId,
          scope.role,
          scope.policyVersion,
          after ?? "0",
        ],
      );
      return result.rows.map((row) => ({
        cursor: String(row.cursor),
        sessionId: String(row.session_id),
        runId: row.run_id ? String(row.run_id) : null,
        stageCode: row.stage_code ? String(row.stage_code) : null,
        occurredAt: new Date(row.created_at).toISOString(),
        type: row.type,
        payload: row.payload ?? {},
      }));
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  async recentWorkEvents(scope: AssistantScope): Promise<AssistantWorkEvent[]> {
    try {
      const result = await this.pool.query(
        "SELECT id, tenant_id, project_id, source_task_id, correlation_key, event_type, stage_code, actor_role, payload FROM vs12_work_events WHERE tenant_id = $1 AND project_id = $2 AND source_task_id = $3 ORDER BY id DESC LIMIT 20",
        [scope.tenantId, scope.projectId, scope.sourceTaskId],
      );
      return result.rows.map((row) => this.workEventFromRow(row));
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    const detail =
      error instanceof Error ? error.message : "unknown persistence error";
    return new ServiceUnavailableException(`岗位助手存储暂不可用：${detail}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private runFromRow(row: Record<string, unknown>): AssistantRun {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      projectId: String(row.project_id),
      sourceTaskId: String(row.source_task_id),
      correlationKey: String(row.correlation_key),
      intent: String(row.intent),
      question: String(row.question),
      stageCode: row.stage_code ? String(row.stage_code) : null,
      status: row.status as AssistantRun["status"],
      provider: row.provider as AssistantRun["provider"],
      classification: "PROPOSAL",
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      completedAt: row.completed_at
        ? new Date(row.completed_at as string | Date).toISOString()
        : null,
      suggestion: row.suggestion
        ? {
            classification: "PROPOSAL",
            answer: String(
              (row.suggestion as Record<string, unknown>).answer ?? "",
            ),
            evidenceIds: Array.isArray(
              (row.suggestion as Record<string, unknown>).evidenceIds,
            )
              ? ((row.suggestion as Record<string, unknown>)
                  .evidenceIds as string[])
              : [],
            nextAction: String(
              (row.suggestion as Record<string, unknown>).nextAction ?? "",
            ),
          }
        : null,
      fallbackReason: row.fallback_reason ? String(row.fallback_reason) : null,
    };
  }

  private workEventFromRow(row: Record<string, unknown>): AssistantWorkEvent {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      projectId: String(row.project_id),
      sourceTaskId: String(row.source_task_id),
      correlationKey: String(row.correlation_key),
      eventType: String(row.event_type),
      stageCode: row.stage_code ? String(row.stage_code) : null,
      actorRole: row.actor_role as AssistantWorkEvent["actorRole"],
      payload: (row.payload ?? {}) as Record<string, unknown>,
    };
  }
}
