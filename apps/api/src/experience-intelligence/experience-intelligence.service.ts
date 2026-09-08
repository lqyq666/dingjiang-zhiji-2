import { runtimeTenantId } from "../runtime-config";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  experienceAiDraftInputSchema,
  experienceAiDraftResponseSchema,
  experienceAnswerInputSchema,
  experienceAnswerResponseSchema,
  experiencePublishReceiptSchema,
  feishuPullInputSchema,
  feishuPullReceiptSchema,
  feishuPushInputSchema,
  feishuPushReceiptSchema,
  formalExperiencePublishInputSchema,
  type ExperienceAiRun,
  type ExperienceAnswerResponse,
  type ExperienceExtractionResult,
  type FeishuPullReceipt,
  type FeishuPushReceipt,
} from "@dingjiang/contracts";

import type { Vs01Service } from "../vs01.service";
import {
  FeishuGatewayError,
  type FeishuReviewGateway,
} from "./feishu/feishu-review.gateway";
import { ExperienceProviderError } from "./providers/coze-experience.provider";
import type { ExperienceAiProvider } from "./contracts";
import {
  ExperienceAiRunReuseError,
  type ExperienceAiRunStore,
} from "./store/experience-ai-run.store";
import {
  ExperienceCommandReuseError,
  type ExperienceCommandStore,
  type ExperienceCommandRoute,
} from "./store/experience-command.store";

export const EXPERIENCE_AI_PROVIDER = "VS17_EXPERIENCE_AI_PROVIDER";
export const FEISHU_REVIEW_GATEWAY = "VS17_FEISHU_REVIEW_GATEWAY";

const tenantId = runtimeTenantId();

@Injectable()
export class ExperienceIntelligenceService {
  constructor(
    private readonly vs01: Vs01Service,
    @Inject(EXPERIENCE_AI_PROVIDER)
    private readonly provider: ExperienceAiProvider,
    @Inject(FEISHU_REVIEW_GATEWAY) private readonly feishu: FeishuReviewGateway,
    private readonly runs: ExperienceAiRunStore,
    private readonly commands: ExperienceCommandStore,
  ) {}

  async draft(projectId: string, input: unknown) {
    const body = experienceAiDraftInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验草稿请求");
    return this.command(
      "VS17_AI_DRAFT",
      body.data.requestId,
      { projectId, ...body.data },
      experienceAiDraftResponseSchema,
      async () => {
        const project = await this.vs01.project(projectId);
        const task = await this.vs01.task(project.sourceTaskId);
        if (project.outcome.status !== "ACCEPTED")
          throw new BadRequestException("必须使用已确认根因和结果生成候选草稿");
        const liveRootCause = project.phases
          .find((phase) => phase.code === "ROOT_CAUSE_VALIDATION")
          ?.tasks.find(
            (item) => item.origin === "LIVE" && item.owner === "PMC",
          );
        let confirmedRootCause: string;
        if (liveRootCause) {
          const workpaper = await this.vs01.rootCauseWorkpaper(projectId);
          if (
            !workpaper.latestConfirmed?.content.conclusion ||
            !workpaper.latestConfirmed.locator
          )
            throw new BadRequestException(
              "必须使用已确认根因和结果生成候选草稿",
            );
          confirmedRootCause = `${workpaper.latestConfirmed.content.conclusion.statement}（${workpaper.latestConfirmed.locator.reference}）`;
        } else {
          if (!task.decision)
            throw new BadRequestException(
              "必须使用已确认根因和结果生成候选草稿",
            );
          confirmedRootCause = task.decision.note;
        }
        const evidence = task.evidence.map((item) => ({
          id: item.id,
          statement: Object.values(item.fields).join("；"),
          sourceObjectId: item.sourceObjectId,
          sourceVersionId: item.sourceVersionId,
          reference: `${item.sourceFile}:${item.sourceRow}`,
        }));
        const extractionInput = {
          projectId,
          businessProblem: project.name,
          confirmedRootCause,
          confirmedOutcome:
            project.outcome.conclusion ??
            project.outcome.evidenceReference ??
            "已确认结果",
          materials: task.materials
            .filter((item) => item.status === "ACTIVE" && item.locator)
            .map((item) => ({
              title: item.title,
              contentPreview: item.file?.contentPreview ?? null,
              verificationStatus: "UNVERIFIED_INPUT" as const,
              sourceObjectId: item.locator!.sourceObjectId,
              sourceVersionId: item.locator!.sourceVersionId,
              reference: item.locator!.reference,
            })),
          evidence,
        };
        const run = await this.newRun(
          "EXTRACT",
          projectId,
          body.data.requestId,
          [
            { kind: "PROJECT", id: projectId },
            ...evidence.map((item) => ({
              kind: "EVIDENCE" as const,
              id: item.id,
            })),
          ],
        );
        if (!run.created) return this.replayDraft(run.run);
        try {
          const execution =
            await this.provider.extractCandidate(extractionInput);
          this.assertDraftEvidence(execution.output, evidence);
          await this.runs.succeed(tenantId, run.run, {
            executeId: execution.executeId,
            debugUrl: execution.debugUrl,
            usage: execution.usage && {
              inputTokens: execution.usage.inputTokens,
              outputTokens: execution.usage.outputTokens,
            },
            structuredOutput: execution.output,
          });
          return {
            run: {
              ...run.run,
              status: "SUCCEEDED" as const,
              structuredOutput: execution.output,
              executeId: execution.executeId,
              debugUrl: execution.debugUrl,
              usage: execution.usage && {
                inputTokens: execution.usage.inputTokens,
                outputTokens: execution.usage.outputTokens,
              },
              completedAt: new Date().toISOString(),
            },
            draft: execution.output,
          };
        } catch (error) {
          await this.runs.fail(tenantId, run.run, {
            code: providerCode(error),
          });
          throw error;
        }
      },
    );
  }

  async push(candidateId: string, input: unknown): Promise<FeishuPushReceipt> {
    const body = feishuPushInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的飞书同步请求");
    return this.command(
      "VS17_FEISHU_PUSH",
      body.data.requestId,
      { candidateId, ...body.data },
      feishuPushReceiptSchema,
      async () => {
        return this.vs01.withFeishuCandidatePushLock(candidateId, async () => {
          const item = await this.vs01.pendingExperienceCandidate(candidateId);
          if (
            item.candidate.candidateLocator.sourceVersionId !==
            body.data.expectedCandidateVersionId
          )
            throw new ConflictException("STALE_CANDIDATE");
          if (!item.candidate.structuredCard)
            throw new BadRequestException("候选经验缺少结构化经验卡");
          let receipt: FeishuPushReceipt;
          try {
            receipt = await this.feishu.pushCandidate({
              ...item.candidate,
              candidateId,
              candidateVersionId: body.data.expectedCandidateVersionId,
              projectId: item.project.id,
              structuredCard: item.candidate.structuredCard,
              cozeExecuteId: null,
              dingjiangUrl: null,
            });
          } catch (error) {
            await this.vs01.recordFeishuCandidateSyncFailure(
              candidateId,
              body.data.expectedCandidateVersionId,
            );
            throw error;
          }
          await this.vs01.recordFeishuCandidateSync(
            candidateId,
            body.data.expectedCandidateVersionId,
            receipt.recordId,
          );
          return receipt;
        });
      },
    );
  }

  async pull(input: unknown): Promise<FeishuPullReceipt> {
    const body = feishuPullInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的飞书审核拉取请求");
    return this.command(
      "VS17_FEISHU_PULL",
      body.data.requestId,
      body.data,
      feishuPullReceiptSchema,
      async () => {
        const items = await this.feishu.pullReviewDecisions();
        const itemsByCandidate = new Map<string, typeof items>();
        for (const item of items) {
          const candidateItems = itemsByCandidate.get(item.candidateId) ?? [];
          candidateItems.push(item);
          itemsByCandidate.set(item.candidateId, candidateItems);
        }
        const current = await Promise.all(
          [...itemsByCandidate.entries()].map(
            async ([candidateId, candidateItems]) => ({
              candidate: await this.vs01.feishuReviewCandidate(candidateId),
              items: candidateItems,
            }),
          ),
        );
        let applied = 0;
        let skipped = 0;
        const reviews: Array<{
          candidate: (typeof current)[number]["candidate"];
          item: (typeof items)[number];
          skipped: number;
        }> = [];
        for (const entry of current) {
          const currentVersionItems = entry.items.filter(
            (item) =>
              item.candidateVersionId === entry.candidate.candidateVersionId,
          );
          if (currentVersionItems.length === 0)
            throw new ConflictException("STALE_CANDIDATE");

          const decisions = currentVersionItems.filter(
            (item) => item.decision.result !== "PENDING_REVIEW",
          );
          const decisionResults = new Set(
            decisions.map((item) => item.decision.result),
          );
          if (decisionResults.size > 1)
            throw new ConflictException("STALE_CANDIDATE");

          // Older Feishu projections are not current review inputs once the
          // current candidate version is present. Duplicate current-version
          // decisions are reduced to one state-machine command below.
          skipped += entry.items.length - currentVersionItems.length;
          if (decisions.length === 0) {
            skipped += currentVersionItems.length;
            continue;
          }

          const item = decisions[0]!;
          if (
            item.decision.result === "RETURNED" &&
            !item.decision.comment.trim()
          )
            throw new BadRequestException("INVALID_REVIEW");
          if (
            entry.candidate.status !== "PENDING_REVIEW" &&
            entry.candidate.status !== item.decision.result
          )
            throw new ConflictException("STALE_CANDIDATE");
          reviews.push({
            candidate: entry.candidate,
            item,
            skipped: currentVersionItems.length - 1,
          });
        }
        for (const { item, candidate, skipped: duplicateSkips } of reviews) {
          skipped += duplicateSkips;
          if (candidate.status === item.decision.result) {
            skipped += 1;
            continue;
          }
          if (item.decision.result === "APPROVED")
            await this.vs01.approveExperienceCandidate(item.candidateId, {
              actor: "EXPERT_REVIEWER",
              expectedCandidateVersionId: item.candidateVersionId,
            });
          else
            await this.vs01.returnExperienceCandidate(item.candidateId, {
              actor: "EXPERT_REVIEWER",
              expectedCandidateVersionId: item.candidateVersionId,
              reason: item.decision.comment,
            });
          applied += 1;
        }
        return { items, summary: { applied, skipped, failed: 0 } };
      },
    );
  }

  async publish(experienceId: string, input: unknown) {
    const body = formalExperiencePublishInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的正式经验同步请求");
    return this.command(
      "VS17_COZE_PUBLISH",
      body.data.requestId,
      { experienceId, ...body.data },
      experiencePublishReceiptSchema,
      async () => {
        const experience = await this.vs01.experience(experienceId);
        if (
          experience.locator.sourceVersionId !==
          body.data.expectedExperienceVersionId
        )
          throw new ConflictException("FORMAL_EXPERIENCE_REQUIRED");
        await this.vs01.recordFormalExperienceIndex(
          experienceId,
          "INDEX_PENDING",
        );
        const run = await this.newRun(
          "PUBLISH",
          experience.sourceProjectId,
          body.data.requestId,
          [{ kind: "FORMAL_EXPERIENCE", id: experienceId }],
        );
        if (!run.created)
          return {
            experienceId,
            experienceVersionId: experience.locator.sourceVersionId,
            indexStatus: "INDEX_PENDING" as const,
            run: run.run,
          };
        try {
          const execution = await this.provider.publishExperience({
            experienceId,
            experienceVersionId: experience.locator.sourceVersionId,
            document: experienceDocument(experience),
          });
          await this.runs.succeed(tenantId, run.run, {
            executeId: execution.executeId,
            debugUrl: execution.debugUrl,
            usage: execution.usage && {
              inputTokens: execution.usage.inputTokens,
              outputTokens: execution.usage.outputTokens,
            },
            structuredOutput: null,
          });
          await this.vs01.recordFormalExperienceIndex(
            experienceId,
            "INDEXED",
            execution,
          );
          return {
            experienceId,
            experienceVersionId: experience.locator.sourceVersionId,
            indexStatus: "INDEXED" as const,
            run: {
              ...run.run,
              status: "SUCCEEDED" as const,
              executeId: execution.executeId,
              debugUrl: execution.debugUrl,
              completedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          await this.runs.fail(tenantId, run.run, { code: "INDEX_FAILED" });
          await this.vs01.recordFormalExperienceIndex(
            experienceId,
            "INDEX_FAILED",
          );
          throw error;
        }
      },
    );
  }

  async answer(input: unknown): Promise<ExperienceAnswerResponse> {
    const body = experienceAnswerInputSchema.safeParse(input);
    if (!body.success) throw new BadRequestException("无效的经验问答请求");
    return this.command(
      "VS17_ANSWER",
      body.data.requestId,
      body.data,
      experienceAnswerResponseSchema,
      async () => {
        let taskContext;
        if (body.data.projectId) {
          const project = await this.vs01.project(body.data.projectId);
          const task = await this.vs01.task(project.sourceTaskId);
          taskContext = {
            projectId: project.id,
            sourceTaskId: project.sourceTaskId,
            currentStatus: project.status,
            currentStage: project.status,
            outcomeSummary: project.outcome.conclusion,
            sourceVersions: task.evidence.map((item) => ({
              sourceObjectId: item.sourceObjectId,
              sourceVersionId: item.sourceVersionId,
              reference: `${item.sourceFile}:${item.sourceRow}`,
              summary: Object.values(item.fields).join("；"),
            })),
          };
        }
        const run = await this.newRun(
          "ANSWER",
          body.data.projectId ?? null,
          body.data.requestId,
          body.data.projectId
            ? [{ kind: "PROJECT", id: body.data.projectId }]
            : [],
        );
        if (!run.created) return this.replayAnswer(run.run);
        try {
          const execution = await this.provider.answerQuestion({
            question: body.data.question,
            projectId: body.data.projectId,
            taskContext,
          });
          if (
            execution.output.matches.length === 0 &&
            (!execution.output.shouldClarify ||
              execution.output.missingInformation.length === 0)
          )
            throw new BadRequestException("INVALID_PROVIDER_OUTPUT");
          for (const match of execution.output.matches)
            await this.assertAnswerMatch(match);
          await this.runs.succeed(tenantId, run.run, {
            executeId: execution.executeId,
            debugUrl: execution.debugUrl,
            usage: execution.usage && {
              inputTokens: execution.usage.inputTokens,
              outputTokens: execution.usage.outputTokens,
            },
            structuredOutput: execution.output,
          });
          return {
            run: {
              ...run.run,
              status: "SUCCEEDED" as const,
              structuredOutput: execution.output,
              executeId: execution.executeId,
              debugUrl: execution.debugUrl,
              usage: execution.usage && {
                inputTokens: execution.usage.inputTokens,
                outputTokens: execution.usage.outputTokens,
              },
              completedAt: new Date().toISOString(),
            },
            result: execution.output,
          };
        } catch (error) {
          await this.runs.fail(tenantId, run.run, {
            code: providerCode(error),
          });
          throw error;
        }
      },
    );
  }

  private async command<T>(
    route: ExperienceCommandRoute,
    requestId: string,
    payload: unknown,
    schema: { parse(value: unknown): T },
    action: () => Promise<T>,
  ): Promise<T> {
    let existing;
    try {
      existing = await this.commands.createOrGet({
        tenantId,
        route,
        requestId,
        payloadFingerprint: fingerprint(payload),
      });
    } catch (error) {
      if (error instanceof ExperienceCommandReuseError)
        throw new ConflictException("REQUEST_ID_REUSED");
      throw error;
    }
    if (!existing.created) {
      if (existing.receipt.status === "SUCCEEDED")
        return schema.parse(existing.receipt.response);
      if (existing.receipt.status === "FAILED")
        throw frozen(existing.receipt.errorCode ?? "PROVIDER_FAILED");
      throw frozen("COMMAND_IN_PROGRESS");
    }
    try {
      const result = schema.parse(await action());
      await this.commands.succeed(
        tenantId,
        existing.receipt,
        result as Record<string, unknown>,
      );
      return result;
    } catch (error) {
      await this.commands.fail(tenantId, existing.receipt, codeOf(error));
      throw externalError(error);
    }
  }

  private async newRun(
    purpose: ExperienceAiRun["purpose"],
    projectId: string | null,
    requestId: string,
    inputRefs: ExperienceAiRun["inputRefs"],
  ) {
    try {
      return await this.runs.createOrGet({
        tenantId,
        projectId,
        purpose,
        provider: this.provider.provider,
        workflowId:
          (
            this.provider as ExperienceAiProvider & {
              workflowIdFor?: (value: ExperienceAiRun["purpose"]) => string;
            }
          ).workflowIdFor?.(purpose) ?? null,
        requestId,
        inputFingerprint: fingerprint(inputRefs),
        inputRefs,
      });
    } catch (error) {
      if (error instanceof ExperienceAiRunReuseError)
        throw new ConflictException("REQUEST_ID_REUSED");
      throw error;
    }
  }

  private replayDraft(run: ExperienceAiRun) {
    if (run.status !== "SUCCEEDED" || !run.structuredOutput)
      throw new ConflictException("命令正在处理中");
    return { run, draft: run.structuredOutput as ExperienceExtractionResult };
  }
  private replayAnswer(run: ExperienceAiRun) {
    if (run.status !== "SUCCEEDED" || !run.structuredOutput)
      throw new ConflictException("命令正在处理中");
    return {
      run,
      result: run.structuredOutput as ExperienceAnswerResponse["result"],
    };
  }
  private assertDraftEvidence(
    output: ExperienceExtractionResult,
    evidence: Array<{
      id: string;
      sourceObjectId: string;
      sourceVersionId: string;
    }>,
  ) {
    const ids = new Set(evidence.map((item) => item.id));
    const refs = new Set(
      evidence.map((item) => `${item.sourceObjectId}:${item.sourceVersionId}`),
    );
    if (
      output.structuredCard.claims.some((claim) =>
        claim.evidenceIds.some((id) => !ids.has(id)),
      ) ||
      output.structuredCard.evidenceRefs.some(
        (ref) => !refs.has(`${ref.sourceObjectId}:${ref.sourceVersionId}`),
      )
    )
      throw new BadRequestException("INVALID_PROVIDER_OUTPUT");
  }
  private async assertAnswerMatch(
    match: ExperienceAnswerResponse["result"]["matches"][number],
  ) {
    const experience = await this.vs01.experience(match.experienceId);
    const allowed = new Set(
      [
        ...[
          experience.locator,
          experience.candidateLocator,
          experience.evidenceLocator,
        ],
        ...(experience.structuredCard?.evidenceRefs ?? []),
      ].map(
        (locator) => `${locator.sourceObjectId}:${locator.sourceVersionId}`,
      ),
    );
    if (
      match.citations.some(
        (citation) =>
          !allowed.has(
            `${citation.sourceObjectId}:${citation.sourceVersionId}`,
          ),
      )
    )
      throw new BadRequestException("INVALID_PROVIDER_OUTPUT");
  }
}

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const providerCode = (
  error: unknown,
): "INVALID_PROVIDER_OUTPUT" | "PROVIDER_TIMEOUT" | "PROVIDER_FAILED" =>
  error instanceof ExperienceProviderError ? error.code : "PROVIDER_FAILED";
const codeOf = (error: unknown) =>
  error instanceof FeishuGatewayError
    ? error.code
    : error instanceof ExperienceProviderError
      ? error.code
      : error instanceof HttpException
        ? (responseCode(error) ?? "PROVIDER_FAILED")
        : "PROVIDER_FAILED";
const externalError = (error: unknown) =>
  error instanceof FeishuGatewayError ||
  error instanceof ExperienceProviderError
    ? frozen(error.code)
    : error;
const responseCode = (error: HttpException): string | null => {
  const response = error.getResponse();
  if (typeof response === "string") return response;
  if (
    typeof response === "object" &&
    response &&
    "code" in response &&
    typeof response.code === "string"
  )
    return response.code;
  if (
    typeof response === "object" &&
    response &&
    "message" in response &&
    typeof response.message === "string"
  )
    return response.message;
  return null;
};
const frozen = (code: string): HttpException =>
  new HttpException(
    { code, message: code },
    code === "FORBIDDEN" || code === "SCOPE_VIOLATION"
      ? HttpStatus.FORBIDDEN
      : code === "NOT_FOUND"
        ? HttpStatus.NOT_FOUND
        : code === "INVALID_PROVIDER_OUTPUT" || code === "INVALID_REVIEW"
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : code === "PROVIDER_TIMEOUT"
            ? HttpStatus.GATEWAY_TIMEOUT
            : code === "STALE_CANDIDATE" ||
                code === "FORMAL_EXPERIENCE_REQUIRED" ||
                code === "REQUEST_ID_REUSED" ||
                code === "COMMAND_IN_PROGRESS"
              ? HttpStatus.CONFLICT
              : HttpStatus.BAD_GATEWAY,
  );
const experienceDocument = (
  experience: Awaited<ReturnType<Vs01Service["experience"]>>,
) =>
  `经验ID：${experience.id}\n版本：${experience.locator.sourceVersionId}\n标题：${experience.title}\n适用情境：${experience.applicableSituation}\n采取做法：${experience.practice}\n结果摘要：${experience.resultSummary}\n限制：${experience.limitations}`;
