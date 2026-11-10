import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { workExecutionContextSchema } from "@dingjiang/contracts";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createTestPool } from "../testing/test-pool";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type {
  IntegrationPrincipal,
  WorkAction,
  WorkExecutionRequest,
} from "@dingjiang/contracts";
import { databaseUrl, migrate, resetAndSeed } from "../vs01-db";
import { Vs01Service } from "../vs01.service";
import { RootCauseWorkpaperService } from "../workpapers/root-cause-workpaper.service";
import { GovernedCommandKernel } from "../command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "../command-kernel/postgres-governed-command-store";
import { WorkExecutionService } from "./work-execution.service";
import type { FeishuWorkNotifier } from "./feishu-work.notifier";

const run = process.env.WORK_EXECUTION_INTEGRATION === "1";
(run ? describe : describe.skip)(
  "WorkBuddy operations in isolated PostgreSQL",
  () => {
    const originalUrl = process.env.DATABASE_URL;
    const name = `dingjiang_work_execution_${process.pid}_${Date.now()}`;
    let admin: Pool;
    let pool: Pool;
    let domain: Vs01Service;
    let papers: RootCauseWorkpaperService;
    let service: WorkExecutionService;
    let projectId: string;
    const feishu = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue("SENT"),
    } as unknown as FeishuWorkNotifier;
    const principal: IntegrationPrincipal = {
      tenantId: "tenant-demo",
      subjectId: "workbuddy-integration-pmc",
      role: "PMC",
      scopes: ["project:read", "workitem:write"],
      projectIds: [],
    };
    const owner = (): IntegrationPrincipal => ({
      ...principal,
      subjectId: "owner-integration",
      role: "OWNER",
      scopes: ["project:read", "project:approve"],
    });
    const expert = (): IntegrationPrincipal => ({
      ...principal,
      subjectId: "expert-integration",
      role: "EXPERT_REVIEWER",
      scopes: ["project:read", "experience:publish"],
    });
    const request = async (
      operation: WorkAction,
    ): Promise<WorkExecutionRequest> => {
      const context = await service.context(principal, projectId);
      return {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: context.version,
        reason: "隔离测试业务动作",
        payload: {
          stateFingerprint: context.stateFingerprint,
          confirmation: "隔离测试中明确确认本次业务动作",
          operation,
        },
      };
    };
    const execute = async (operation: WorkAction, actor = principal) =>
      service.execute(actor, projectId, await request(operation));
    const completePhase = async (code: string) => {
      const project = await domain.project(projectId);
      const tasks = project.phases
        .find((phase) => phase.code === code)!
        .tasks.filter((task) => task.owner === "PMC" && task.status !== "DONE");
      for (const task of tasks)
        await execute({
          action: "workitem.complete",
          workItemId: task.id,
          note: "已按验收标准完成隔离测试事项",
          outputReference: "隔离测试产出记录",
          confirmedAcceptanceCriteria: task.acceptance,
        });
    };
    beforeAll(async () => {
      const base = new URL(databaseUrl());
      base.pathname = "/postgres";
      admin = createTestPool(base.toString());
      await admin.query(`CREATE DATABASE ${name}`);
      base.pathname = `/${name}`;
      process.env.DATABASE_URL = base.toString();
      pool = createTestPool(base.toString());
      await migrate(pool);
      await resetAndSeed(pool);
      papers = new RootCauseWorkpaperService();
      domain = new Vs01Service(undefined, papers);
      await domain.decideTask("SO-202608128", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "隔离测试确认",
      });
      projectId = (
        await domain.createProject({
          actor: "PMC",
          sourceTaskId: "SO-202608128",
        })
      ).id;
      principal.projectIds = [projectId];
      service = new WorkExecutionService(
        new GovernedCommandKernel(new PostgresGovernedCommandStore(pool)),
        domain,
        papers,
        feishu,
      );
    }, 30000);
    afterAll(async () => {
      await service?.onModuleDestroy();
      await domain?.onModuleDestroy();
      await papers?.onModuleDestroy();
      await pool?.end();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      }
    });
    it("rejects missing permission, wrong project and role escalation before domain mutation", async () => {
      const input = await request({ action: "project.approve" });
      await expect(
        service.execute(principal, projectId, input),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        service.execute(
          { ...principal, scopes: ["project:read"] },
          projectId,
          await request({ action: "project.submit" }),
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        service.execute(
          { ...principal, projectIds: ["OTHER"] },
          projectId,
          input,
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    it("serializes concurrent updates, replays a lost response and rejects changed request content", async () => {
      const task = (await domain.project(projectId)).phases
        .find((p) => p.code === "SOLUTION_APPROVAL")!
        .tasks.find((t) => t.owner === "PMC")!;
      const input = await request({
        action: "progress.record",
        workItemId: task.id,
        note: "隔离测试进展记录",
        outputReference: "",
      });
      const results = await Promise.allSettled([
        service.execute(principal, projectId, input),
        service.execute(principal, projectId, {
          ...input,
          requestId: randomUUID(),
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "STALE_VERSION" },
      });
      const winner = results[0]?.status === "fulfilled";
      if (winner) {
        expect(
          await service.execute(principal, projectId, input),
        ).toMatchObject({ replayed: true, version: 1 });
        await expect(
          service.execute(principal, projectId, {
            ...input,
            reason: "修改过的隔离测试理由",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }
    });
    it("executes an in-flight duplicate requestId exactly once", async () => {
      const task = (await domain.project(projectId)).phases
        .find((phase) => phase.code === "SOLUTION_APPROVAL")!
        .tasks.find((item) => item.owner === "PMC" && item.status === "READY")!;
      const input = await request({
        action: "progress.record",
        workItemId: task.id,
        note: "同一请求编号被并发重发的进展记录",
        outputReference: "",
      });

      // A client retried while the first attempt was still in flight, so all
      // four requests arrive before any receipt exists. Sequential replay is
      // easy; this is the case that needs the advisory lock. Without it both
      // attempts pass the receipt lookup and race to insert.
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          service.execute(principal, projectId, input),
        ),
      );

      expect(
        results.filter((result) => result.replayed === false),
      ).toHaveLength(1);
      expect(results.filter((result) => result.replayed === true)).toHaveLength(
        3,
      );
      // Every caller must be told the same resulting version, not four
      // different ones.
      expect(new Set(results.map((result) => result.version)).size).toBe(1);

      const receipts = await pool.query(
        "SELECT count(*)::int AS count FROM governed_command_receipts WHERE request_id = $1",
        [input.requestId],
      );
      expect(Number(receipts.rows[0]?.count)).toBe(1);
      const facts = await pool.query(
        "SELECT count(*)::int AS count FROM vs01_project_subtasks WHERE id = $1 AND progress_note = $2",
        [task.id, "同一请求编号被并发重发的进展记录"],
      );
      expect(Number(facts.rows[0]?.count)).toBe(1);
    });
    it("rolls back domain changes when the command cannot persist a receipt", async () => {
      const before = await domain.project(projectId);
      const task = before.phases
        .find((p) => p.code === "SOLUTION_APPROVAL")!
        .tasks.find((t) => t.owner === "PMC")!;
      const store = new PostgresGovernedCommandStore(pool);
      const failing = new WorkExecutionService(
        new GovernedCommandKernel({
          execute: (input) =>
            store.execute({
              ...input,
              run: async (transaction) => {
                await input.run(transaction);
                throw new Error("simulated receipt failure");
              },
            }),
        }),
        domain,
        papers,
      );
      try {
        await expect(
          failing.execute(
            principal,
            projectId,
            await request({
              action: "progress.record",
              workItemId: task.id,
              note: "这一条进展必须回滚",
              outputReference: "",
            }),
          ),
        ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
        expect(await domain.project(projectId)).toEqual(before);
      } finally {
        await failing.onModuleDestroy();
      }
    });
    it("starts a whitelisted source event once and confirms its root-cause workpaper through the same transaction", async () => {
      const reserved = "PRJ-SO-202608136";
      principal.projectIds.push(reserved);
      const context = await service.context(principal, reserved);
      expect(context.project).toBeNull();
      expect(context.allowedActions).toEqual(["event.start"]);
      // Starting an event needs a human approval record; progress.record is the
      // only exempted action, so the signal must not list it.
      expect(context.approvalRequiredActions).toEqual(["event.start"]);
      const start: WorkExecutionRequest = {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: 0,
        reason: "处理已授权的新事件",
        payload: {
          stateFingerprint: context.stateFingerprint,
          confirmation: "确认事实后开始处理本事件",
          operation: { action: "event.start" },
        },
      };
      const started = await service.execute(principal, reserved, start);
      expect(started.data.project).toMatchObject({
        id: reserved,
        sourceTaskId: "SO-202608136",
      });
      expect(feishu.enqueue).toHaveBeenCalledOnce();
      expect(feishu.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: principal.tenantId,
          userId: principal.subjectId,
          requestId: start.requestId,
          projectId: reserved,
          action: "event.start",
        }),
      );
      expect(feishu.deliver).toHaveBeenCalledOnce();
      expect(await service.execute(principal, reserved, start)).toMatchObject({
        replayed: true,
      });
      expect(feishu.enqueue).toHaveBeenCalledOnce();
      expect(feishu.deliver).toHaveBeenCalledTimes(2);
      const active = await service.context(principal, reserved);
      const rootTask = active
        .project!.phases.find(
          (phase) => phase.code === "ROOT_CAUSE_VALIDATION",
        )!
        .tasks.find((task) => task.owner === "PMC" && task.status === "READY")!;
      const progress = await service.execute(principal, reserved, {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: active.version,
        reason: "记录当前根因核验事项的进展",
        payload: {
          stateFingerprint: active.stateFingerprint,
          confirmation: "确认保存核验进展，不确认根因结论",
          operation: {
            action: "progress.record",
            workItemId: rootTask.id,
            note: "已核对演示订单交期，正在核对延期原因",
            outputReference: "",
          },
        },
      });
      expect(progress.version).toBe(active.version + 1);
      const recorded = await service.context(principal, reserved);
      const root = recorded.project!.phases.find(
        (phase) => phase.code === "ROOT_CAUSE_VALIDATION",
      )!;
      expect(root.gate.status).toBe("OPEN");
      expect(root.tasks.find((task) => task.id === rootTask.id)).toMatchObject({
        status: "IN_PROGRESS",
        progressUpdate: { note: "已核对演示订单交期，正在核对延期原因" },
      });
      expect((await papers.view(reserved)).status).not.toBe("CONFIRMED");
      for (const operation of [
        {
          action: "workitem.complete",
          workItemId: rootTask.id,
          note: "不能绕过根因核验",
          outputReference: "未经核验的结论",
          confirmedAcceptanceCriteria: rootTask.acceptance,
        },
        {
          action: "progress.record",
          workItemId: recorded
            .project!.phases.find(
              (phase) => phase.code === "SOLUTION_APPROVAL",
            )!
            .tasks.find((task) => task.owner === "PMC")!.id,
          note: "不能提前操作尚未解锁的方案事项",
          outputReference: "",
        },
      ] satisfies WorkAction[]) {
        await expect(
          service.execute(principal, reserved, {
            requestId: randomUUID(),
            correlationId: randomUUID(),
            expectedVersion: recorded.version,
            reason: "核验阶段边界测试",
            payload: {
              stateFingerprint: recorded.stateFingerprint,
              confirmation: "只在隔离库验证错误动作被拒绝",
              operation,
            },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }
      expect((await service.context(principal, reserved)).version).toBe(
        recorded.version,
      );
      const material = await domain.importTaskMaterial(
        "SO-202608136",
        {
          actor: "PMC",
          situationCode: "CAPACITY_RISK",
          requirementId: "REQ-CAPACITY-LOAD",
          title: "隔离测试产能记录",
          note: "仅用于测试",
          requestId: randomUUID(),
        },
        {
          originalName: "capacity.csv",
          buffer: Buffer.from("日期,负荷率\n2026-08-20,92%"),
          size: Buffer.byteLength("日期,负荷率\n2026-08-20,92%"),
        },
      );
      const before = await papers.view(reserved);
      const candidate = await papers.candidate(reserved, {
        actor: "PMC",
        requestId: randomUUID(),
        expectedRevision: before.revision,
        materialIds: [material.id],
      });
      const content = candidate.current!.content;
      const ready = await service.context(principal, reserved);
      const result = await service.execute(principal, reserved, {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: ready.version,
        reason: "按来源材料核对结论",
        payload: {
          stateFingerprint: ready.stateFingerprint,
          confirmation: "已核对材料和验收标准，确认根因结论",
          operation: {
            action: "workpaper.confirm",
            expectedRevision: candidate.revision,
            completionNote: "材料与结论已核对",
            confirmedAcceptanceCriteria: candidate.workItem.acceptanceCriteria,
            content: {
              ...content,
              materialFindings: content.materialFindings.map((item) => ({
                ...item,
                verificationStatus: "EMPLOYEE_CHECKED",
                assessment: "SUPPORTS",
                note: "已核对隔离测试原文",
              })),
              conclusion: {
                result: "SUPPORTS",
                statement: "产能负荷支持延期原因分析",
                limitations: "仅限隔离测试场景",
                nextChecks: ["进入方案设计阶段"],
              },
            },
          },
        },
      });
      expect(result.data.project).toMatchObject({
        phases: expect.arrayContaining([
          expect.objectContaining({
            code: "ROOT_CAUSE_VALIDATION",
            gate: expect.objectContaining({ status: "APPROVED" }),
          }),
        ]),
      });
      expect((await papers.view(reserved)).status).toBe("CONFIRMED");
    });
    it("runs solution → owner decision → execution → measured result → expert publication with audited facts", async () => {
      await completePhase("SOLUTION_APPROVAL");
      await execute({ action: "project.submit" });
      await execute({ action: "project.approve" }, owner());
      await completePhase("EXECUTION_CONTROL");
      expect((await domain.project(projectId)).status).toBe(
        "RESULT_VALIDATION",
      );
      await completePhase("RESULT_ACCEPTANCE");
      await execute({
        action: "outcome.record",
        currentOtd: 88,
        evidenceReference: "隔离测试统计结果",
        conclusion: "准交率达到目标",
        note: "依据隔离测试记录确认",
      });
      await completePhase("KNOWLEDGE_CAPTURE");
      await execute({
        action: "experience.submit",
        title: "隔离测试经验",
        applicableSituation: "相同订单延期情况",
        businessProblem: "订单交付延期",
        practice: "按节点核验并记录完成事实",
        resultSummary: "准交率达到百分之八十八",
        limitations: "仅适用于隔离测试",
      });
      const candidate = (await domain.project(projectId)).experienceCandidate!;
      await execute(
        {
          action: "experience.publish",
          expectedCandidateVersionId:
            candidate.candidateLocator.sourceVersionId,
        },
        expert(),
      );
      expect((await domain.project(projectId)).status).toBe("COMPLETED");
      const audit = await pool.query(
        "SELECT actor_subject_id, actor_role FROM governed_command_audit_events WHERE project_id = $1",
        [projectId],
      );
      expect(audit.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor_subject_id: "owner-integration",
            actor_role: "OWNER",
          }),
          expect.objectContaining({
            actor_subject_id: "expert-integration",
            actor_role: "EXPERT_REVIEWER",
          }),
        ]),
      );
    }, 30000);
    it("exposes the new operations through authenticated Integration HTTP and denies read-only tokens", async () => {
      const previous = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
      process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
        {
          ...principal,
          scopes: ["project:read"],
          token: "isolated-read-only-operations-token",
        },
        {
          ...principal,
          scopes: [...principal.scopes, "workitem:read"],
          token: "isolated-mcp-write-operations-token",
        },
      ]);
      const app = await NestFactory.create(AppModule, { logger: false });
      try {
        app.setGlobalPrefix("api");
        await app.listen(0, "127.0.0.1");
        const address = app.getHttpServer().address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/api/integration/projects/${projectId}/operations`;
        const headers = {
          authorization: "Bearer isolated-read-only-operations-token",
          "content-type": "application/json",
        };
        expect((await fetch(url)).status).toBe(401);
        const read = await fetch(url, { headers });
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({
          ok: true,
          data: { project: { id: projectId }, allowedActions: [] },
        });
        const write = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(await request({ action: "project.submit" })),
        });
        expect(write.status).toBe(403);
        expect(await write.json()).toMatchObject({
          ok: false,
          error: { code: "PERMISSION_DENIED" },
        });
        const child = spawn(
          process.execPath,
          [
            resolve(
              __dirname,
              "../../../../services/dingjiang-mcp/dist/server.js",
            ),
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              DINGJIANG_API_BASE_URL: `http://127.0.0.1:${address.port}/api`,
              DINGJIANG_MCP_API_TOKEN: "isolated-mcp-write-operations-token",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const lines = createInterface({ input: child.stdout });
        const iterator = lines[Symbol.asyncIterator]();
        let rpcId = 0;
        const rpc = async (method: string, params: unknown) => {
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) +
              "\n",
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const line = await Promise.race([
              iterator.next(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("MCP response deadline")),
                  10000,
                );
              }),
            ]);
            if (line.done)
              throw new Error("MCP process exited before responding");
            return JSON.parse(line.value);
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          const initialized = await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "isolated-operation-test", version: "1" },
          });
          expect(initialized.result.serverInfo.version).toBe("0.7.0");
          expect((await rpc("tools/list", {})).result.tools).toHaveLength(13);
          const targetId = "PRJ-SO-202608136";
          const initial = await rpc("tools/call", {
            name: "work.operations",
            arguments: { projectId: targetId },
          });
          const context = workExecutionContextSchema.parse(
            initial.result.structuredContent,
          );
          const item = context
            .project!.phases.find(
              (phase) => phase.code === "SOLUTION_APPROVAL",
            )!
            .tasks.find((task) => task.owner === "PMC")!;
          const result = await rpc("tools/call", {
            name: "work.execute",
            arguments: {
              projectId: targetId,
              requestId: randomUUID(),
              correlationId: randomUUID(),
              expectedVersion: context.version,
              reason: "验证真实 MCP 状态同步",
              payload: {
                stateFingerprint: context.stateFingerprint,
                confirmation: "记录通过 MCP 提交的本次进展",
                operation: {
                  action: "progress.record",
                  workItemId: item.id,
                  note: "通过 stdio MCP 留存的隔离测试进展",
                  outputReference: "",
                },
              },
            },
          });
          expect(result.result.structuredContent).toMatchObject({
            version: context.version + 1,
            replayed: false,
          });
          const after = await rpc("tools/call", {
            name: "work.operations",
            arguments: { projectId: targetId },
          });
          const current = workExecutionContextSchema.parse(
            after.result.structuredContent,
          );
          expect(current.version).toBe(context.version + 1);
          expect(
            current
              .project!.phases.flatMap((phase) => phase.tasks)
              .find((task) => task.id === item.id)?.progressUpdate?.note,
          ).toBe("通过 stdio MCP 留存的隔离测试进展");
        } finally {
          lines.close();
          child.stdin.end();
          child.kill();
        }
      } finally {
        await app.close();
        if (previous === undefined)
          delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
        else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = previous;
      }
    }, 30000);
  },
);
