import type {
  ExperienceAnswerResult,
  ExperienceExtractionResult,
} from "@dingjiang/contracts";

import type {
  ExperienceAiProvider,
  ExperienceAnswerInput,
  ExperienceExtractionInput,
  ExperiencePublishInput,
  ProviderExecution,
  PublishProviderExecution,
} from "../contracts";

/** Deterministic local fallback; it never represents a Coze execution. */
export class DemoExperienceProvider implements ExperienceAiProvider {
  readonly provider = "DEMO_RULES" as const;

  workflowIdFor(purpose: "EXTRACT" | "PUBLISH" | "ANSWER"): string {
    return `DEMO_RULES_${purpose}`;
  }

  async extractCandidate(
    input: ExperienceExtractionInput,
  ): Promise<ProviderExecution<ExperienceExtractionResult>> {
    const evidence = input.evidence[0];
    if (!evidence)
      throw new Error("DEMO_RULES requires one authorized evidence reference");
    return {
      provider: this.provider,
      workflowId: this.workflowIdFor("EXTRACT"),
      executeId: null,
      debugUrl: null,
      usage: null,
      output: {
        title: `候选经验：${input.businessProblem}`,
        applicableSituation: input.businessProblem,
        businessProblem: input.businessProblem,
        practice: "按证据定位核对当前情况，由 PMC 编辑后决定是否提交候选经验。",
        resultSummary: "本地规则仅生成待人工审核的候选草稿。",
        limitations: "DEMO_RULES 不替代事实核验、员工判断或正式经验审批。",
        structuredCard: {
          trigger: input.confirmedRootCause,
          conditions: [input.confirmedOutcome],
          actions: [{ order: 1, action: "核对当前证据与适用条件" }],
          rationale: "候选经验必须由已授权证据支持，并由员工承担最终判断。",
          exceptions: ["证据不完整或不适用时，不应直接沿用。"],
          scope: {
            products: [],
            departments: ["PMC"],
            scenarios: [input.businessProblem],
          },
          claims: [
            { statement: input.confirmedRootCause, evidenceIds: [evidence.id] },
          ],
          evidenceRefs: [
            {
              sourceObjectId: evidence.sourceObjectId,
              sourceVersionId: evidence.sourceVersionId,
              reference: evidence.reference,
            },
          ],
          missingInformation: ["需由 PMC 确认当前项目是否满足上述条件。"],
        },
        reviewFocus: ["确认适用条件、证据与例外情况。"],
        classification: "PROPOSAL",
      },
    };
  }

  async publishExperience(
    input: ExperiencePublishInput,
  ): Promise<PublishProviderExecution> {
    void input;
    return {
      provider: this.provider,
      workflowId: this.workflowIdFor("PUBLISH"),
      executeId: null,
      debugUrl: null,
      usage: null,
    };
  }

  async answerQuestion(
    input: ExperienceAnswerInput,
  ): Promise<ProviderExecution<ExperienceAnswerResult>> {
    return {
      provider: this.provider,
      workflowId: this.workflowIdFor("ANSWER"),
      executeId: null,
      debugUrl: null,
      usage: null,
      output: {
        answer: `DEMO_RULES 建议：先补充与“${input.question}”相关的正式经验和当前证据，再由员工判断。`,
        matches: [],
        missingInformation: ["当前本地规则未检索正式经验库。"],
        shouldClarify: true,
        classification: "PROPOSAL",
      },
    };
  }
}
