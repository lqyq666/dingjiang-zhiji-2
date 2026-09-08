import type {
  ExperienceAnswerResult,
  ExperienceAiPurpose,
  ExperienceExtractionResult,
  ExperienceAiProvider as ExperienceAiProviderName,
} from "@dingjiang/contracts";

export type SafeSourceReference = {
  sourceObjectId: string;
  sourceVersionId: string;
  reference: string;
};

export type ExperienceExtractionInput = {
  projectId: string;
  businessProblem: string;
  confirmedRootCause: string;
  confirmedOutcome: string;
  materials: Array<
    {
      title: string;
      contentPreview: string | null;
      verificationStatus: "UNVERIFIED_INPUT" | "EMPLOYEE_CHECKED";
    } & SafeSourceReference
  >;
  evidence: Array<{ id: string; statement: string } & SafeSourceReference>;
};

export type ExperiencePublishInput = {
  experienceId: string;
  experienceVersionId: string;
  document: string;
};

export type ExperienceAnswerInput = {
  question: string;
  projectId?: string;
  taskContext?: {
    projectId: string;
    sourceTaskId: string;
    currentStatus: string;
    currentStage: string | null;
    outcomeSummary: string | null;
    sourceVersions: Array<SafeSourceReference & { summary: string }>;
  };
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ProviderExecution<T> = {
  provider: ExperienceAiProviderName;
  workflowId: string;
  output: T;
  executeId: string | null;
  debugUrl: string | null;
  usage: ProviderUsage | null;
};

export type PublishProviderExecution = Omit<ProviderExecution<null>, "output">;

export interface ExperienceAiProvider {
  readonly provider: ExperienceAiProviderName;
  workflowIdFor(purpose: ExperienceAiPurpose): string;
  extractCandidate(
    input: ExperienceExtractionInput,
  ): Promise<ProviderExecution<ExperienceExtractionResult>>;
  publishExperience(
    input: ExperiencePublishInput,
  ): Promise<PublishProviderExecution>;
  answerQuestion(
    input: ExperienceAnswerInput,
  ): Promise<ProviderExecution<ExperienceAnswerResult>>;
}
