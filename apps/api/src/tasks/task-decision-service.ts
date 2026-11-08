import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {
  decisionInputSchema,
  decisionRevertInputSchema,
  type TaskDetail,
} from "@dingjiang/contracts";
import type { ReadModelService } from "../read-model/read-model-service";

/**
 * Deciding a task, and taking that decision back.
 *
 * A decision is a fact about who confirmed what, so it is written under
 * the same transaction discipline as every other governed write. The revert
 * exists because a mistaken confirmation has to be correctable without
 * deleting the record of it.
 */
export class TaskDecisionService {
  private readonly pool: Pool;
  private readonly commandTransaction?: PoolClient;
  private readonly tenantId: string;
  private readonly readModel: ReadModelService;

  constructor(
    pool: Pool,
    tenantId: string,
    readModel: ReadModelService,
    commandTransaction?: PoolClient,
  ) {
    this.pool = pool;
    this.tenantId = tenantId;
    this.readModel = readModel;
    this.commandTransaction = commandTransaction;
  }

  private get database() {
    return this.commandTransaction ?? this.pool;
  }

  async decideTask(id: string, input: unknown): Promise<TaskDetail> {
    const decision = decisionInputSchema.safeParse(input);
    if (!decision.success) throw new BadRequestException("无效的任务决策");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const task = await client.query(
        "SELECT status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "OPEN")
        throw new BadRequestException("任务当前不能再次决策");
      await client.query(
        "INSERT INTO vs01_decisions (task_id, tenant_id, type, note, decided_by, decided_at) VALUES ($1, $2, $3, $4, 'PMC', now())",
        [id, this.tenantId, decision.data.type, decision.data.note],
      );
      await client.query(
        "INSERT INTO vs01_decision_events (task_id, tenant_id, event_type, decision_type, decision_note, reason, actor) VALUES ($1, $2, 'DECIDED', $3, $4, NULL, 'PMC')",
        [id, this.tenantId, decision.data.type, decision.data.note],
      );
      const updated = await client.query(
        "UPDATE vs01_tasks SET status = 'DECIDED' WHERE id = $1 AND tenant_id = $2 AND status = 'OPEN'",
        [id, this.tenantId],
      );
      if (updated.rowCount !== 1)
        throw new BadRequestException("任务当前不能再次决策");
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.readModel.task(id);
  }

  async revertTaskDecision(id: string, input: unknown): Promise<TaskDetail> {
    const body = decisionRevertInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的撤销请求");
    const client = this.commandTransaction ?? (await this.pool.connect());
    try {
      if (!this.commandTransaction) await client.query("BEGIN");
      const task = await client.query(
        "SELECT status FROM vs01_tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (task.rowCount === 0) throw new NotFoundException("任务不存在");
      if (task.rows[0]?.status !== "DECIDED")
        throw new BadRequestException("任务当前没有可撤销的判断");
      const project = await client.query(
        "SELECT id FROM vs01_projects WHERE source_task_id = $1 AND tenant_id = $2 LIMIT 1",
        [id, this.tenantId],
      );
      if (project.rowCount !== 0)
        throw new BadRequestException(
          "判断已形成关联项目，不能直接撤销；请先处理下游项目",
        );
      const current = await client.query(
        "SELECT type, note FROM vs01_decisions WHERE task_id = $1 AND tenant_id = $2 FOR UPDATE",
        [id, this.tenantId],
      );
      if (current.rowCount === 0)
        throw new BadRequestException("任务当前没有可撤销的判断");
      await client.query(
        "INSERT INTO vs01_decision_events (task_id, tenant_id, event_type, decision_type, decision_note, reason, actor) VALUES ($1, $2, 'REVERTED', $3, $4, $5, 'PMC')",
        [
          id,
          this.tenantId,
          current.rows[0]?.type,
          current.rows[0]?.note,
          body.data.reason,
        ],
      );
      await client.query(
        "DELETE FROM vs01_decisions WHERE task_id = $1 AND tenant_id = $2",
        [id, this.tenantId],
      );
      const reopened = await client.query(
        "UPDATE vs01_tasks SET status = 'OPEN' WHERE id = $1 AND tenant_id = $2 AND status = 'DECIDED'",
        [id, this.tenantId],
      );
      if (reopened.rowCount !== 1)
        throw new BadRequestException("任务判断未能撤销");
      if (!this.commandTransaction) await client.query("COMMIT");
    } catch (error) {
      if (!this.commandTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.commandTransaction) client.release();
    }
    return this.readModel.task(id);
  }
}
