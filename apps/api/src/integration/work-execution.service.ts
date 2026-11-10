import { createHash, randomUUID } from "node:crypto";
import {
  NotFoundException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { requiresHumanApproval } from "../command-kernel/production-authorization";
import {
  workExecutionRequestSchema,
  workExecutionPayloadSchema,
  type IntegrationPrincipal,
  type Project,
  type TaskDetail,
  type WorkAction,
  type WorkExecutionRequest,
} from "@dingjiang/contracts";
import {
  GovernedCommandKernel,
  GovernedCommandFailure,
} from "../command-kernel/governed-command-kernel";
import { Vs01Service } from "../vs01.service";
import { RootCauseWorkpaperService } from "../workpapers/root-cause-workpaper.service";
import { createPool } from "../vs01-db";
import { isProduction } from "../runtime-config";
import { sourceTaskFromReservation } from "../projects/production-lifecycle";
import { FeishuWorkNotifier } from "./feishu-work.notifier";
import { hasProjectAccess } from "./integration-access";

const fingerprint = (project: Project | TaskDetail) =>
  createHash("sha256").update(JSON.stringify(project)).digest("hex");
const policy = (action: WorkAction["action"]) => {
  if (["project.approve", "project.return"].includes(action))
    return { scope: "project:approve", role: "OWNER" as const };
  if (["experience.publish", "experience.return"].includes(action))
    return { scope: "experience:publish", role: "EXPERT_REVIEWER" as const };
  return { scope: "workitem:write", role: "PMC" as const };
};
const actions: WorkAction["action"][] = [
  "event.start",
  "progress.record",
  "workitem.complete",
  "workitem.reopen",
  "project.submit",
  "project.approve",
  "project.return",
  "outcome.record",
  "outcome.reopen",
  "experience.submit",
  "experience.resubmit",
  "experience.withdraw",
  "experience.publish",
  "experience.return",
  "workpaper.confirm",
  "workpaper.reopen",
];

@Injectable()
export class WorkExecutionService implements OnModuleDestroy {
  private readonly pool = createPool();
  constructor(
    @Inject(GovernedCommandKernel)
    private readonly kernel: GovernedCommandKernel,
    @Inject(Vs01Service) private readonly domain: Vs01Service,
    @Inject(RootCauseWorkpaperService)
    private readonly workpapers: RootCauseWorkpaperService,
    @Optional()
    @Inject(FeishuWorkNotifier)
    private readonly feishu?: FeishuWorkNotifier,
  ) {}
  async onModuleDestroy() {
    await this.pool.end();
  }

  private async revision(
    client: PoolClient,
    tenantId: string,
    projectId: string,
  ) {
    const result = await client.query(
      "SELECT count(*)::int AS revision FROM governed_command_receipts WHERE tenant_id = $1 AND project_id = $2 AND command_name = 'work.execute'",
      [tenantId, projectId],
    );
    return Number(result.rows[0]?.revision ?? 0);
  }

  private async target(
    domain: Vs01Service,
    projectId: string,
  ): Promise<{ project: Project | null; sourceTask?: TaskDetail }> {
    try {
      return { project: await domain.project(projectId) };
    } catch (error) {
      // Only explicitly whitelisted reservation IDs can open a new source event.
      if (
        !(error instanceof NotFoundException) ||
        !(isProduction()
          ? sourceTaskFromReservation(projectId)
          : /^PRJ-SO-[0-9]+$/.test(projectId))
      )
        throw error;
      return {
        project: null,
        sourceTask: await domain.task(projectId.slice(4)),
      };
    }
  }

  async events(principal: IntegrationPrincipal) {
    const projects = (await this.domain.projectList()).filter((project) =>
      hasProjectAccess(principal, project.id),
    );
    const items: Array<{
      projectId: string;
      sourceTaskId: string;
      title: string;
      status: string;
    }> = projects.map((project) => ({
      projectId: project.id,
      sourceTaskId: project.sourceTaskId,
      title: project.name,
      status: project.status,
    }));
    for (const reserved of principal.projectIds.filter((id) =>
      isProduction()
        ? sourceTaskFromReservation(id) !== null
        : /^PRJ-SO-[0-9]+$/.test(id),
    )) {
      const sourceTaskId = reserved.slice(4);
      if (items.some((item) => item.sourceTaskId === sourceTaskId)) continue;
      try {
        const task = await this.domain.task(sourceTaskId);
        items.push({
          projectId: reserved,
          sourceTaskId,
          title: `${task.order.customer} · ${task.id}`,
          status: task.status,
        });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return { items };
  }

  private async lock(
    client: PoolClient,
    principal: IntegrationPrincipal,
    projectId: string,
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`work.execute:${principal.tenantId}:${projectId}`],
    );
  }

  async context(principal: IntegrationPrincipal, projectId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        principal.tenantId,
      ]);
      await this.lock(client, principal, projectId);
      const target = await this.domain.inCommandTransaction(client, (domain) =>
        this.target(domain, projectId),
      );
      const version = await this.revision(
        client,
        principal.tenantId,
        projectId,
      );
      await client.query("COMMIT");
      const allowedActions = actions.filter((action) => {
        if ((action === "event.start") === Boolean(target.project))
          return false;
        const rule = policy(action);
        return (
          principal.projectIds.includes(projectId) &&
          principal.role === rule.role &&
          principal.scopes.some((scope) => scope === rule.scope)
        );
      });
      return {
        ...target,
        version,
        stateFingerprint: fingerprint(target.project ?? target.sourceTask!),
        allowedActions,
        // Which of the allowed actions need a human approval record. This comes
        // from the same predicate the write path enforces, so the signal cannot
        // drift from the rule it describes.
        approvalRequiredActions: allowedActions.filter((action) =>
          requiresHumanApproval("work.execute", { operation: { action } }),
        ),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(
    principal: IntegrationPrincipal,
    projectId: string,
    input: unknown,
  ) {
    const parsed = workExecutionRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "操作参数不完整，请读取当前事项并补齐必要事实",
        randomUUID(),
      );
    const request = parsed.data;
    const rule = policy(request.payload.operation.action);
    const result = await this.kernel.execute(
      {
        request,
        principal,
        target: { tenantId: principal.tenantId, projectId },
      },
      {
        name: "work.execute",
        requiredScope: rule.scope,
        allowedRoles: [rule.role],
        parsePayload: (payload) => workExecutionPayloadSchema.parse(payload),
        handler: async (transaction) => {
          const client = transaction.client;
          if (!client)
            throw new GovernedCommandFailure(
              "INTERNAL_ERROR",
              "事务连接不可用",
              request.correlationId,
            );
          try {
            // Serialize the source read+fingerprint+project snapshot with intake.
            // Without this, an import could change facts between approval-state
            // comparison and createProject, silently pinning unapproved facts.
            if (
              isProduction() &&
              request.payload.operation.action === "event.start"
            )
              await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                [`${principal.tenantId}:source-intake`],
              );
            await this.lock(client, principal, projectId);
            await client.query(
              "SELECT id FROM vs01_projects WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
              [principal.tenantId, projectId],
            );
            return await this.domain.inCommandTransaction(
              client,
              async (domain) => {
                const target = await this.target(domain, projectId);
                const before = target.project;
                const revision = await this.revision(
                  client,
                  principal.tenantId,
                  projectId,
                );
                if (
                  request.expectedVersion !== revision ||
                  request.payload.stateFingerprint !==
                    fingerprint(before ?? target.sourceTask!)
                )
                  throw new GovernedCommandFailure(
                    "STALE_VERSION",
                    "记录已变化，请重新读取并确认本次操作",
                    request.correlationId,
                  );
                const operation = request.payload.operation;
                if (
                  "workItemId" in operation &&
                  !before?.phases.some((phase) =>
                    phase.tasks.some(
                      (task) => task.id === operation.workItemId,
                    ),
                  )
                )
                  throw new GovernedCommandFailure(
                    "PERMISSION_DENIED",
                    "事项不属于当前项目",
                    request.correlationId,
                  );
                if (!before) {
                  if (operation.action !== "event.start" || !target.sourceTask)
                    throw new GovernedCommandFailure(
                      "CONFLICT",
                      "先确认该事件并开始处理",
                      request.correlationId,
                    );
                  await domain.decideTask(target.sourceTask.id, {
                    actor: "PMC",
                    type: "CONFIRMED",
                    note: request.payload.confirmation,
                  });
                  await domain.createProject(
                    { actor: "PMC", sourceTaskId: target.sourceTask.id },
                    projectId,
                  );
                } else {
                  if (operation.action === "event.start")
                    throw new GovernedCommandFailure(
                      "CONFLICT",
                      "事件已有关联项目，请继续当前项目",
                      request.correlationId,
                    );
                  await this.apply(domain, client, before, request);
                }
                const project = await domain.project(projectId);
                if (operation.action === "event.start")
                  await this.feishu?.enqueue(client, {
                    tenantId: principal.tenantId,
                    userId: principal.subjectId,
                    requestId: request.requestId,
                    projectId,
                    projectName: project.name,
                    action: "event.start",
                  });
                return {
                  version: revision + 1,
                  data: {
                    project,
                    stateFingerprint: fingerprint(project),
                    action: operation.action,
                  },
                  audit: {
                    eventType: "WORK_ACTION_RECORDED",
                    details: {
                      action: operation.action,
                      confirmation: request.payload.confirmation,
                      beforeStatus: before?.status ?? target.sourceTask?.status,
                      afterStatus: project.status,
                    },
                  },
                };
              },
            );
          } catch (error) {
            if (error instanceof GovernedCommandFailure) throw error;
            if (error instanceof HttpException && error.getStatus() < 500)
              throw new GovernedCommandFailure(
                "CONFLICT",
                error.message,
                request.correlationId,
              );
            throw error;
          }
        },
      },
    );
    if (request.payload.operation.action === "event.start")
      await this.feishu
        ?.deliver(principal.tenantId, request.requestId)
        .catch(() => undefined);
    return result;
  }

  private async apply(
    domain: Vs01Service,
    client: PoolClient,
    project: Project,
    request: WorkExecutionRequest,
  ) {
    const operation = request.payload.operation;
    const id = project.id;
    const actor = "PMC" as const;
    switch (operation.action) {
      case "event.start":
        throw new GovernedCommandFailure(
          "CONFLICT",
          "事件已经开始处理",
          request.correlationId,
        );
      case "progress.record":
        return domain.updateSubtask(operation.workItemId, {
          actor,
          status: "IN_PROGRESS",
          note: operation.note,
          outputReference: operation.outputReference,
        });
      case "workitem.complete":
        return domain.updateSubtask(operation.workItemId, {
          actor,
          status: "DONE",
          note: operation.note,
          outputReference: operation.outputReference,
          confirmedAcceptanceCriteria: operation.confirmedAcceptanceCriteria,
        });
      case "workitem.reopen":
        return domain.updateSubtask(operation.workItemId, {
          actor,
          status: "READY",
          note: operation.note,
        });
      case "project.submit":
        return domain.submitProject(id, { actor });
      case "project.approve":
        return domain.approveProject(id, { actor: "OWNER" });
      case "project.return":
        return domain.returnProject(id, {
          actor: "OWNER",
          reason: operation.reason,
        });
      case "outcome.record":
        return domain.submitOutcome(id, { ...operation, actor });
      case "outcome.reopen":
        return domain.reopenOutcome(id, { actor, reason: operation.reason });
      case "experience.submit":
        return domain.createExperienceCandidate(id, { ...operation, actor });
      case "experience.resubmit":
        return domain.resubmitExperienceCandidate(id, { ...operation, actor });
      case "experience.withdraw":
        return domain.withdrawExperienceCandidate(id, {
          actor,
          reason: operation.reason,
        });
      case "experience.publish":
      case "experience.return": {
        if (!project.experienceCandidate)
          throw new GovernedCommandFailure(
            "CONFLICT",
            "项目尚无候选经验",
            request.correlationId,
          );
        const body = { ...operation, actor: "EXPERT_REVIEWER" };
        return operation.action === "experience.publish"
          ? domain.approveExperienceCandidate(
              project.experienceCandidate.id,
              body,
            )
          : domain.returnExperienceCandidate(
              project.experienceCandidate.id,
              body,
            );
      }
      case "workpaper.confirm":
        return this.workpapers.inCommandTransaction(client, (domain) =>
          domain.complete(id, {
            actor,
            requestId: request.requestId,
            expectedRevision: operation.expectedRevision,
            content: operation.content,
            completionNote: operation.completionNote,
            confirmedAcceptanceCriteria: operation.confirmedAcceptanceCriteria,
          }),
        );
      case "workpaper.reopen":
        return this.workpapers.inCommandTransaction(client, (domain) =>
          domain.reopen(id, {
            actor,
            requestId: request.requestId,
            expectedRevision: operation.expectedRevision,
            reason: operation.reason,
          }),
        );
    }
  }
}
