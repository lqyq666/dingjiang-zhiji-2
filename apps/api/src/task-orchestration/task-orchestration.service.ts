import { runtimeTenantId } from "../runtime-config";
import {
  acceptAtomicTaskInputSchema,
  approvalDecisionInputSchema,
  atomicTaskProposalListSchema,
  atomicTaskProposalSchema,
  editAtomicTaskInputSchema,
  generateAtomicTasksInputSchema,
  type AtomicTaskApprovalKind,
  type AtomicTaskProposal,
  type AtomicTaskProposalList,
} from "@dingjiang/contracts";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { createPool } from "../vs01-db";
import type { Vs01Service } from "../vs01.service";
import type { FeishuApprovalNotifier } from "./feishu-approval.notifier";

const tenantId = runtimeTenantId();

@Injectable()
export class TaskOrchestrationService implements OnModuleDestroy {
  private readonly pool: Pool = createPool();

  constructor(
    private readonly projects: Vs01Service,
    private readonly notifier: FeishuApprovalNotifier,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async list(
    projectId: string,
    phaseCode: string,
  ): Promise<AtomicTaskProposalList> {
    await this.phase(projectId, phaseCode);
    return this.listRows(projectId, phaseCode);
  }

  async generate(
    projectId: string,
    phaseCode: string,
    input: unknown,
  ): Promise<AtomicTaskProposalList> {
    const body = generateAtomicTasksInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的任务生成请求");
    const { project, phase } = await this.phase(projectId, phaseCode);
    const existing = await this.listRows(projectId, phaseCode);
    if (!body.data.force && existing.items.length) return existing;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (body.data.force) {
        const superseded = await client.query(
          "UPDATE vs18_task_proposals SET status = 'SUPERSEDED', updated_at = now() WHERE tenant_id = $1 AND project_id = $2 AND phase_code = $3 AND status = 'PROPOSED' RETURNING id",
          [tenantId, projectId, phaseCode],
        );
        for (const row of superseded.rows)
          await this.event(
            client,
            row.id,
            "SUPERSEDED",
            "PMC",
            "用户要求重新生成任务建议",
            { force: true },
          );
      }
      const retained = await client.query(
        "SELECT source_work_item_id FROM vs18_task_proposals WHERE tenant_id = $1 AND project_id = $2 AND phase_code = $3 AND status IN ('ACCEPTED','PENDING_APPROVAL')",
        [tenantId, projectId, phaseCode],
      );
      const retainedIds = new Set(
        retained.rows.map((row) => String(row.source_work_item_id)),
      );
      const candidates = phase.tasks
        .filter((task) => task.status !== "DONE" && !retainedIds.has(task.id))
        .slice(0, Math.max(0, 3 - retainedIds.size));
      for (const task of candidates) {
        const proposalId = randomUUID();
        const approvalKind = this.approvalKind(
          task.title,
          task.purpose,
          task.owner,
        );
        const gaps = task.inputs
          .filter((item) => item.status !== "AVAILABLE")
          .map((item) => item.label);
        const experienceCount = project.experienceReferences.filter(
          (reference) => reference.status === "ACTIVE",
        ).length;
        const basis = gaps.length
          ? `现实缺口：先处理${gaps[0]}，再按当前事项验收。`
          : experienceCount
            ? `结合当前事实与 ${experienceCount} 条正式经验引用生成；经验仅作候选参考。`
            : "根据当前阶段、未完成事项和已有事实生成。";
        const title =
          task.owner === "OWNER" ? "确认是否调整解决方向" : task.title;
        const purpose =
          task.owner === "OWNER"
            ? "核对目标、范围和主要方案是否发生重大方向变化"
            : task.purpose;
        await client.query(
          "INSERT INTO vs18_task_proposals (id, tenant_id, project_id, phase_code, source_work_item_id, title, purpose, basis, approval_kind, amount, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,'PROPOSED')",
          [
            proposalId,
            tenantId,
            projectId,
            phaseCode,
            task.id,
            title,
            purpose,
            basis,
            approvalKind,
          ],
        );
        await this.event(
          client,
          proposalId,
          "GENERATED",
          "SYSTEM",
          "AI 基于当前项目上下文生成原子任务",
          {
            sourceWorkItemId: task.id,
            provider: "DEMO_RULES",
            classification: "PROPOSAL",
            approvalKind,
          },
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listRows(projectId, phaseCode);
  }

  async edit(proposalId: string, input: unknown): Promise<AtomicTaskProposal> {
    const body = editAtomicTaskInputSchema.safeParse(input);
    if (!body.success)
      throw new BadRequestException(
        body.error.issues[0]?.message ?? "无效的任务修改",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT p.*, s.title AS source_title, s.purpose AS source_purpose, s.owner AS source_owner FROM vs18_task_proposals p JOIN vs01_project_subtasks s ON s.id = p.source_work_item_id AND s.tenant_id = p.tenant_id WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p",
        [proposalId, tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("任务建议不存在");
      if (current.rows[0].status !== "PROPOSED")
        throw new ConflictException("只有待同意的任务建议可以修改");
      const requiredApprovalKind = this.approvalKind(
        `${current.rows[0].source_title} ${body.data.title}`,
        `${current.rows[0].source_purpose} ${body.data.purpose}`,
        current.rows[0].source_owner,
      );
      if (
        requiredApprovalKind !== "NONE" &&
        body.data.approvalKind !== requiredApprovalKind
      )
        throw new BadRequestException(
          body.data.approvalKind === "NONE"
            ? `该任务仍需要${this.approvalLabel(requiredApprovalKind)}审批，不能降级为日常任务`
            : `该任务需要${this.approvalLabel(requiredApprovalKind)}审批，不能改为${this.approvalLabel(body.data.approvalKind)}审批`,
        );
      await client.query(
        "UPDATE vs18_task_proposals SET title=$1, purpose=$2, approval_kind=$3, amount=$4, updated_at=now() WHERE id=$5 AND tenant_id=$6",
        [
          body.data.title,
          body.data.purpose,
          body.data.approvalKind,
          body.data.amount,
          proposalId,
          tenantId,
        ],
      );
      await this.event(
        client,
        proposalId,
        "EDITED",
        "PMC",
        "用户修改了 AI 任务建议",
        body.data,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.one(proposalId);
  }

  async accept(
    proposalId: string,
    input: unknown,
  ): Promise<AtomicTaskProposal> {
    if (!acceptAtomicTaskInputSchema.safeParse(input).success)
      throw new BadRequestException("无效的任务同意请求");
    const client = await this.pool.connect();
    let notice: Parameters<FeishuApprovalNotifier["send"]>[0] | null = null;
    let requestId: string | null = null;
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT p.*, pr.name AS project_name FROM vs18_task_proposals p JOIN vs01_projects pr ON pr.id=p.project_id AND pr.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 FOR UPDATE OF p",
        [proposalId, tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("任务建议不存在");
      const row = current.rows[0];
      if (row.status !== "PROPOSED")
        throw new ConflictException("这条任务建议已经处理");
      if (row.approval_kind === "MONEY" && row.amount === null)
        throw new BadRequestException("金钱任务必须先填写金额");
      if (row.approval_kind === "NONE") {
        await client.query(
          "UPDATE vs18_task_proposals SET status='ACCEPTED', updated_at=now() WHERE id=$1",
          [proposalId],
        );
        await this.event(
          client,
          proposalId,
          "ACCEPTED",
          "PMC",
          "用户同意日常任务，无需审批",
          { approvalKind: "NONE" },
        );
      } else {
        requestId = randomUUID();
        await client.query(
          "UPDATE vs18_task_proposals SET status='PENDING_APPROVAL', updated_at=now() WHERE id=$1",
          [proposalId],
        );
        await client.query(
          "INSERT INTO vs18_approval_requests (id, tenant_id, proposal_id, project_id, approval_kind, amount, summary, approver_open_id, feishu_delivery_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NOT_CONFIGURED')",
          [
            requestId,
            tenantId,
            proposalId,
            row.project_id,
            row.approval_kind,
            row.amount,
            `${row.title}：${row.purpose}`,
            this.notifier.recipientId,
          ],
        );
        await this.event(
          client,
          proposalId,
          "APPROVAL_REQUESTED",
          "PMC",
          "金钱或重大方向事项已提交负责人审批",
          { requestId, approvalKind: row.approval_kind },
        );
        notice = {
          requestId,
          projectId: row.project_id,
          projectName: row.project_name,
          approvalKind: row.approval_kind,
          title: row.title,
          purpose: row.purpose,
          amount: row.amount === null ? null : Number(row.amount),
        };
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (notice && requestId) {
      const delivery = await this.notifier.send(notice);
      await this.pool.query(
        "UPDATE vs18_approval_requests SET feishu_delivery_status=$1, feishu_message_id=$2, feishu_error=$3 WHERE id=$4 AND tenant_id=$5",
        [
          delivery.status,
          delivery.messageId,
          delivery.error,
          requestId,
          tenantId,
        ],
      );
    }
    return this.one(proposalId);
  }

  async decide(requestId: string, input: unknown): Promise<AtomicTaskProposal> {
    const body = approvalDecisionInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的审批决定");
    const client = await this.pool.connect();
    let proposalId: string;
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT * FROM vs18_approval_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [requestId, tenantId],
      );
      if (!current.rowCount) throw new NotFoundException("审批请求不存在");
      if (current.rows[0].status !== "PENDING")
        throw new ConflictException("审批请求已经处理");
      proposalId = current.rows[0].proposal_id;
      await client.query(
        "UPDATE vs18_approval_requests SET status=$1, decision_note=$2, decided_at=now() WHERE id=$3",
        [body.data.decision, body.data.note, requestId],
      );
      const proposalStatus =
        body.data.decision === "APPROVED"
          ? "ACCEPTED"
          : body.data.decision === "CHANGES_REQUESTED"
            ? "PROPOSED"
            : "SUPERSEDED";
      await client.query(
        "UPDATE vs18_task_proposals SET status=$1, updated_at=now() WHERE id=$2",
        [proposalStatus, proposalId],
      );
      await this.event(
        client,
        proposalId,
        body.data.decision,
        "OWNER",
        body.data.note,
        { requestId, decision: body.data.decision },
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.one(proposalId);
  }

  private async phase(projectId: string, phaseCode: string) {
    const project = await this.projects.project(projectId);
    const phase = project.phases.find((item) => item.code === phaseCode);
    if (!phase) throw new NotFoundException("项目阶段不存在");
    return { project, phase };
  }

  private approvalKind(
    title: string,
    purpose: string,
    owner: string,
  ): AtomicTaskApprovalKind {
    const text = `${title}${purpose}`;
    if (/(预算|金额|付款|采购|合同|费用|报价|支付|成本)/.test(text))
      return "MONEY";
    if (owner === "OWNER" || /(重大|方向|目标|范围变更|方案定稿)/.test(text))
      return "DIRECTION";
    return "NONE";
  }

  private approvalLabel(kind: AtomicTaskApprovalKind): string {
    return kind === "MONEY" ? "金钱" : "重大方向";
  }

  private async listRows(
    projectId: string,
    phaseCode: string,
  ): Promise<AtomicTaskProposalList> {
    const result = await this.pool.query(
      "SELECT p.*, a.id AS approval_request_id, a.feishu_delivery_status FROM vs18_task_proposals p LEFT JOIN LATERAL (SELECT id, feishu_delivery_status FROM vs18_approval_requests a WHERE a.proposal_id=p.id AND a.tenant_id=p.tenant_id ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC, a.id DESC LIMIT 1) a ON TRUE WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.phase_code=$3 AND p.status <> 'SUPERSEDED' ORDER BY p.created_at, p.id LIMIT 3",
      [tenantId, projectId, phaseCode],
    );
    return atomicTaskProposalListSchema.parse({
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      limit: 3,
      items: result.rows.map((row) => this.toProposal(row)),
    });
  }

  private async one(proposalId: string): Promise<AtomicTaskProposal> {
    const result = await this.pool.query(
      "SELECT p.*, a.id AS approval_request_id, a.feishu_delivery_status FROM vs18_task_proposals p LEFT JOIN LATERAL (SELECT id, feishu_delivery_status FROM vs18_approval_requests a WHERE a.proposal_id=p.id AND a.tenant_id=p.tenant_id ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC, a.id DESC LIMIT 1) a ON TRUE WHERE p.id=$1 AND p.tenant_id=$2",
      [proposalId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundException("任务建议不存在");
    return atomicTaskProposalSchema.parse(this.toProposal(result.rows[0]));
  }

  private toProposal(row: QueryResultRow) {
    return {
      id: row.id,
      projectId: row.project_id,
      phaseCode: row.phase_code,
      sourceWorkItemId: row.source_work_item_id,
      title: row.title,
      purpose: row.purpose,
      basis: row.basis,
      approvalKind: row.approval_kind,
      amount: row.amount === null ? null : Number(row.amount),
      status: row.status,
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      approvalRequestId: row.approval_request_id ?? null,
      feishuDeliveryStatus: row.feishu_delivery_status ?? "NOT_REQUIRED",
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async event(
    client: PoolClient,
    proposalId: string,
    eventType: string,
    actor: string,
    note: string,
    snapshot: unknown,
  ) {
    await client.query(
      "INSERT INTO vs18_task_proposal_events (tenant_id, proposal_id, event_type, actor, note, snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [tenantId, proposalId, eventType, actor, note, JSON.stringify(snapshot)],
    );
  }
}
