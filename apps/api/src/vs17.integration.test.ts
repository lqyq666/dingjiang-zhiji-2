import type { FeishuReviewPullItem } from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExperienceIntelligenceService } from "./experience-intelligence/experience-intelligence.service";
import { ExperienceAiRunStore } from "./experience-intelligence/store/experience-ai-run.store";
import { ExperienceCommandStore } from "./experience-intelligence/store/experience-command.store";
import { createPool } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const integrationRequested =
  process.env.VS17_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs17";
const dedicatedVs17TestDatabase = (() => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return false;
  try {
    return new URL(databaseUrl).pathname
      .replace(/^\//, "")
      .endsWith("_vs17_test");
  } catch {
    return false;
  }
})();

if (integrationRequested && !dedicatedVs17TestDatabase) {
  throw new Error(
    "VS17 PostgreSQL integration requires DATABASE_URL for a dedicated local database ending in _vs17_test; refusing to reset or mutate demo data.",
  );
}

const run = integrationRequested && dedicatedVs17TestDatabase;
const card = (sourceObjectId: string, sourceVersionId: string) => ({
  trigger: "订单交付发生延迟",
  conditions: ["结果已确认"],
  actions: [{ order: 1, action: "核对证据后执行措施" }],
  rationale: "以可追溯证据支持候选经验。",
  exceptions: ["证据不完整时不得直接采用。"],
  scope: {
    products: ["产品 A"],
    departments: ["生产"],
    scenarios: ["本地集成"],
  },
  claims: [
    { statement: "已核对交期风险。", evidenceIds: ["E-ORDER-202608136"] },
  ],
  evidenceRefs: [{ sourceObjectId, sourceVersionId, reference: "测试定位" }],
  missingInformation: [],
});

(run ? describe : describe.skip)(
  "VS17 PostgreSQL evidence and Feishu re-entry",
  () => {
    const vs01 = new Vs01Service();
    const pool = createPool();
    const runs = new ExperienceAiRunStore();
    const commands = new ExperienceCommandStore();
    let project128 = "";
    let project136 = "";
    let approved: { id: string; version: string };
    let returned: { id: string; version: string };

    const readyForCandidate = async (projectId: string) => {
      await pool.query(
        "UPDATE vs01_project_subtasks SET status = 'DONE', completion_note = 'VS17 隔离夹具完成', output_reference = 'VS17 隔离夹具输出', completed_at = now(), confirmed_at = now(), confirmed_by = owner, completion_basis = CASE WHEN owner = 'OWNER' THEN 'ROLE_DECISION' ELSE 'ASSIGNEE_CONFIRMED' END, confirmed_acceptance = acceptance WHERE tenant_id = 'tenant-demo' AND node_id IN (SELECT id FROM vs01_project_nodes WHERE project_id = $1)",
        [projectId],
      );
      await pool.query(
        "UPDATE vs01_project_phases SET gate_status = CASE WHEN code = 'KNOWLEDGE_CAPTURE' THEN 'PENDING' ELSE 'APPROVED' END, returned_reason = NULL WHERE project_id = $1 AND tenant_id = 'tenant-demo'",
        [projectId],
      );
      await pool.query(
        "UPDATE vs01_projects SET status = 'KNOWLEDGE_CAPTURE' WHERE id = $1 AND tenant_id = 'tenant-demo'",
        [projectId],
      );
      await pool.query(
        "UPDATE vs01_result_validations SET status = 'ACCEPTED', current = 83, conclusion = '本地集成已确认结果', evidence_reference = '本地集成结果证据', source_object_id = 'SRC-ORDERS', source_version_id = 'SRC-ORDERS-V1', accepted_at = now() WHERE project_id = $1 AND tenant_id = 'tenant-demo'",
        [projectId],
      );
    };
    const insertPending = async (projectId: string, id: string) => {
      await pool.query(
        "INSERT INTO vs01_experience_candidates (id, tenant_id, project_id, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, status, revision) VALUES ($1,'tenant-demo',$2,'VS17 审核候选','本地集成','交付延期','核对证据','结果确认','证据','限制','SRC-ORDERS','SRC-ORDERS-V1','PENDING_REVIEW',1)",
        [id, projectId],
      );
      await pool.query(
        "INSERT INTO vs01_experience_candidate_revisions (id, tenant_id, candidate_id, revision, title, applicable_situation, business_problem, practice, result_summary, evidence_reference, limitations, source_object_id, source_version_id, structured_card) VALUES ($1,'tenant-demo',$2,1,'VS17 审核候选','本地集成','交付延期','核对证据','结果确认','证据','限制','SRC-ORDERS','SRC-ORDERS-V1',$3::jsonb)",
        [`REV-${id}`, id, JSON.stringify(card("SRC-ORDERS", "SRC-ORDERS-V1"))],
      );
    };

    beforeAll(async () => {
      await vs01.onModuleInit();
      await vs01.reset({ actor: "PMC" });
      await vs01.decideTask("SO-202608128", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "VS17 fixture",
      });
      await vs01.decideTask("SO-202608136", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "VS17 fixture",
      });
      project128 = (
        await vs01.createProject({ actor: "PMC", sourceTaskId: "SO-202608128" })
      ).id;
      project136 = (
        await vs01.createProject({ actor: "PMC", sourceTaskId: "SO-202608136" })
      ).id;
      await Promise.all([
        readyForCandidate(project128),
        readyForCandidate(project136),
      ]);
    });
    afterAll(async () => {
      await commands.onModuleDestroy();
      await runs.onModuleDestroy();
      await pool.end();
      await vs01.onModuleDestroy();
    });

    it("accepts the current source-task fact locator but rejects an invented locator atomically", async () => {
      const before = await pool.query(
        "SELECT count(*)::int AS count FROM vs01_experience_candidates WHERE project_id = $1",
        [project136],
      );
      const bytes = Buffer.from("日期,备注\n2026-08-26,仅归属另一咨询任务");
      const otherMaterial = await vs01.importTaskMaterial(
        "SO-202608128",
        {
          actor: "PMC",
          situationCode: "BOM_DELAY",
          requirementId: "REQ-BOM-CHANGE",
          title: "另一项目材料",
          note: "用于 VS17 跨项目证据拒绝",
          requestId: "17111111-1111-4111-8111-111111111121",
        },
        {
          originalName: "other-project.csv",
          buffer: bytes,
          size: bytes.length,
        },
      );
      if (!otherMaterial.locator)
        throw new Error("Expected traceable other-project material locator");
      await expect(
        vs01.createExperienceCandidate(project136, {
          actor: "PMC",
          title: "伪造定位",
          applicableSituation: "本地集成",
          businessProblem: "交付延期",
          practice: "核对证据",
          resultSummary: "结果确认",
          limitations: "仅测试",
          structuredCard: card("SRC-NOT-FOUND", "SRC-VERSION-NOT-FOUND"),
        }),
      ).rejects.toThrow("候选经验结构卡包含无效、跨项目或不可追溯的证据定位");
      await expect(
        vs01.createExperienceCandidate(project136, {
          actor: "PMC",
          title: "跨项目材料",
          applicableSituation: "本地集成",
          businessProblem: "交付延期",
          practice: "核对证据",
          resultSummary: "结果确认",
          limitations: "仅测试",
          structuredCard: card(
            otherMaterial.locator.sourceObjectId,
            otherMaterial.locator.sourceVersionId,
          ),
        }),
      ).rejects.toThrow("候选经验结构卡包含无效、跨项目或不可追溯的证据定位");
      await expect(
        vs01.createExperienceCandidate(project136, {
          actor: "PMC",
          title: "伪造事实证据",
          applicableSituation: "本地集成",
          businessProblem: "交付延期",
          practice: "核对证据",
          resultSummary: "结果确认",
          limitations: "仅测试",
          structuredCard: {
            ...card("SRC-ORDERS", "SRC-ORDERS-V1"),
            claims: [
              {
                statement: "伪造事实",
                evidenceIds: ["E-ORDER-NOT-THIS-PROJECT"],
              },
            ],
          },
        }),
      ).rejects.toThrow("候选经验结构卡包含不属于当前任务的事实证据");
      const after = await pool.query(
        "SELECT count(*)::int AS count FROM vs01_experience_candidates WHERE project_id = $1",
        [project136],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      const created = await vs01.createExperienceCandidate(project136, {
        actor: "PMC",
        title: "授权事实定位",
        applicableSituation: "本地集成",
        businessProblem: "交付延期",
        practice: "核对证据",
        resultSummary: "结果确认",
        limitations: "仅测试",
        structuredCard: card("SRC-ORDERS", "SRC-ORDERS-V1"),
      });
      approved = {
        id: created.experienceCandidate!.id,
        version: created.experienceCandidate!.candidateLocator.sourceVersionId,
      };
      expect(
        created.experienceCandidate?.structuredCard?.evidenceRefs,
      ).toHaveLength(1);
    });

    it("serializes concurrent same-version pushes and releases the integration lock after a failed projection without changing business facts", async () => {
      let active = 0;
      let maxActive = 0;
      let failNext = false;
      const gateway = {
        pushCandidate: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (failNext) {
              failNext = false;
              throw new Error("simulated provider failure");
            }
            return {
              provider: "DEMO_RULES" as const,
              candidateId: approved.id,
              candidateVersionId: approved.version,
              recordId: "demo-vs17",
              pushedAt: "2026-08-26T00:00:00.000Z",
            };
          } finally {
            active -= 1;
          }
        },
      };
      const intelligence = new ExperienceIntelligenceService(
        vs01,
        { provider: "DEMO_RULES" } as never,
        gateway as never,
        runs,
        commands,
      );
      await Promise.all([
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111116",
          expectedCandidateVersionId: approved.version,
        }),
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111117",
          expectedCandidateVersionId: approved.version,
        }),
      ]);
      expect(maxActive).toBe(1);
      await expect(
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111116",
          expectedCandidateVersionId: approved.version,
        }),
      ).resolves.toMatchObject({ recordId: "demo-vs17" });
      await expect(
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111116",
          expectedCandidateVersionId: "SRC-OTHER-VERSION",
        }),
      ).rejects.toThrow("REQUEST_ID_REUSED");
      const beforeFailure = await pool.query(
        "SELECT status, revision, title, source_version_id FROM vs01_experience_candidates WHERE id = $1",
        [approved.id],
      );
      failNext = true;
      await expect(
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111118",
          expectedCandidateVersionId: approved.version,
        }),
      ).rejects.toThrow();
      const afterFailure = await pool.query(
        "SELECT status, revision, title, source_version_id, feishu_sync_status FROM vs01_experience_candidates WHERE id = $1",
        [approved.id],
      );
      expect(afterFailure.rows[0]).toMatchObject({
        ...beforeFailure.rows[0],
        feishu_sync_status: "FAILED",
      });
      await expect(
        intelligence.push(approved.id, {
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111119",
          expectedCandidateVersionId: approved.version,
        }),
      ).resolves.toMatchObject({ recordId: "demo-vs17" });
    });

    it("uses the real state machine once per Feishu outcome, skips matching repeats, and preserves conflicting terminal state", async () => {
      await insertPending(project128, `EXP-${project128}`);
      returned = { id: `EXP-${project128}`, version: "SRC-ORDERS-V1" };
      let decisions: FeishuReviewPullItem[] = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: returned.version,
          decision: {
            result: "RETURNED",
            comment: "请补充边界",
            reviewer: "专家",
          },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      const intelligence = new ExperienceIntelligenceService(
        vs01,
        { provider: "DEMO_RULES" } as never,
        { pullReviewDecisions: async () => decisions } as never,
        runs,
        commands,
      );
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111111",
        }),
      ).resolves.toMatchObject({ summary: { applied: 1, skipped: 0 } });
      const beforeInvalidResubmit = await pool.query(
        "SELECT status, revision FROM vs01_experience_candidates WHERE id = $1",
        [returned.id],
      );
      await expect(
        vs01.resubmitExperienceCandidate(project128, {
          actor: "PMC",
          expectedCandidateVersionId: returned.version,
          title: "错误重提",
          applicableSituation: "本地集成",
          businessProblem: "交付延期",
          practice: "核对证据",
          resultSummary: "结果确认",
          limitations: "仅测试",
          structuredCard: {
            ...card("SRC-ORDERS", "SRC-ORDERS-V1"),
            claims: [
              { statement: "伪造", evidenceIds: ["E-ORDER-NOT-THIS-PROJECT"] },
            ],
          },
        }),
      ).rejects.toThrow("候选经验结构卡包含不属于当前任务的事实证据");
      await expect(
        pool.query(
          "SELECT status, revision FROM vs01_experience_candidates WHERE id = $1",
          [returned.id],
        ),
      ).resolves.toMatchObject({ rows: [beforeInvalidResubmit.rows[0]] });
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111112",
        }),
      ).resolves.toMatchObject({ summary: { applied: 0, skipped: 1 } });
      const terminal = await vs01.feishuReviewCandidate(returned.id);
      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: returned.version,
          decision: { result: "APPROVED", comment: "冲突", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111113",
        }),
      ).rejects.toThrow("STALE_CANDIDATE");
      await expect(vs01.feishuReviewCandidate(returned.id)).resolves.toEqual(
        terminal,
      );
      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: "SRC-STALE-VERSION",
          decision: { result: "RETURNED", comment: "过期", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111120",
        }),
      ).rejects.toThrow("STALE_CANDIDATE");
      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: approved.id,
          candidateVersionId: approved.version,
          decision: { result: "APPROVED", comment: "同意", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111114",
        }),
      ).resolves.toMatchObject({ summary: { applied: 1, skipped: 0 } });
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111115",
        }),
      ).resolves.toMatchObject({ summary: { applied: 0, skipped: 1 } });
    });

    it("ignores historical Feishu projections when a current version exists, while rejecting stale and conflicting current reviews", async () => {
      const sourceVersion = "SRC-ORDERS-V1";
      await vs01.resubmitExperienceCandidate(project128, {
        actor: "PMC",
        expectedCandidateVersionId: returned.version,
        title: "VS17 历史投影回归候选",
        applicableSituation: "本地集成",
        businessProblem: "交付延期",
        practice: "核对证据",
        resultSummary: "结果确认",
        limitations: "仅测试",
        structuredCard: {
          ...card("SRC-ORDERS", sourceVersion),
          claims: [
            {
              statement: "已核对交期风险。",
              evidenceIds: ["E-ORDER-202608128"],
            },
          ],
        },
      });
      const version = (await vs01.feishuReviewCandidate(returned.id))
        .candidateVersionId;
      let decisions: FeishuReviewPullItem[] = [];
      const intelligence = new ExperienceIntelligenceService(
        vs01,
        { provider: "DEMO_RULES" } as never,
        { pullReviewDecisions: async () => decisions } as never,
        runs,
        commands,
      );

      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: "SRC-STALE-VERSION",
          decision: {
            result: "RETURNED",
            comment: "历史投影",
            reviewer: "专家",
          },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: version,
          decision: { result: "APPROVED", comment: "同意", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111122",
        }),
      ).resolves.toMatchObject({ summary: { applied: 1, skipped: 1 } });
      await expect(
        vs01.feishuReviewCandidate(returned.id),
      ).resolves.toMatchObject({
        status: "APPROVED",
      });

      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: "SRC-STALE-VERSION",
          decision: { result: "APPROVED", comment: "过期", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111123",
        }),
      ).rejects.toThrow("STALE_CANDIDATE");
      await expect(
        vs01.feishuReviewCandidate(returned.id),
      ).resolves.toMatchObject({
        status: "APPROVED",
      });

      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: version,
          decision: { result: "APPROVED", comment: "同意", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: version,
          decision: { result: "APPROVED", comment: "重复", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111124",
        }),
      ).resolves.toMatchObject({ summary: { applied: 0, skipped: 2 } });
      await expect(
        vs01.feishuReviewCandidate(returned.id),
      ).resolves.toMatchObject({
        status: "APPROVED",
      });

      decisions = [
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: version,
          decision: { result: "APPROVED", comment: "同意", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
        {
          provider: "DEMO_RULES",
          candidateId: returned.id,
          candidateVersionId: version,
          decision: { result: "RETURNED", comment: "退回", reviewer: "专家" },
          pulledAt: "2026-08-26T00:00:00.000Z",
        },
      ];
      await expect(
        intelligence.pull({
          actor: "EXPERT_REVIEWER",
          requestId: "17111111-1111-4111-8111-111111111125",
        }),
      ).rejects.toThrow("STALE_CANDIDATE");
      await expect(
        vs01.feishuReviewCandidate(returned.id),
      ).resolves.toMatchObject({ status: "APPROVED" });
    });
  },
);
