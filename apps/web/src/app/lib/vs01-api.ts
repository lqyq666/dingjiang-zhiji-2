import { requestWithTimeout } from "./request-with-timeout";
import {
  assistantFeedbackReceiptSchema,
  assistantFeedbackListSchema,
  bossDashboardSchema,
  employeeDashboardSchema,
  expertDashboardSchema,
  experienceLifecycleHistoryListSchema,
  evidenceConfirmationRequestSchema,
  evidenceConfirmationResultSchema,
  evidenceProposalReviewListSchema,
  experienceLibrarySchema,
  formalExperienceSchema,
  projectAssistantResponseSchema,
  projectSchema,
  taskDetailSchema,
  taskAssistantResponseSchema,
  type BossDashboard,
  type AssistantFeedbackInput,
  type AssistantFeedbackRecord,
  type AssistantFeedbackReceipt,
  type AssistantFeedbackWithdrawInput,
  type DecisionInput,
  type DecisionRevertInput,
  type EmployeeDashboard,
  type ExperienceCandidateInput,
  type ExperienceCandidateApproveInput,
  type ExperienceCandidateResubmitInput,
  type ExperienceCandidateReturnInput,
  type ExperienceCandidateWithdrawInput,
  type ExperienceLibrary,
  type EvidenceConfirmationRequest,
  type EvidenceProposalReview,
  type ExperienceLifecycleHistoryList,
  type ExpertDashboard,
  type ExperienceReferenceInput,
  type ExperienceReferenceWithdrawInput,
  type FormalExperience,
  type FormalExperienceRetractInput,
  type OutcomeReopenInput,
  type OutcomeSubmitInput,
  type Project,
  type ProjectAssistantRequest,
  type ProjectAssistantResponse,
  type ProjectSubtaskStatusInput,
  type TaskMaterialInput,
  taskMaterialImportFieldsSchema,
  taskMaterialWithdrawInputSchema,
  materialVerificationRequestSchema,
  type TaskMaterialImportFields,
  type TaskMaterialWithdrawInput,
  type MaterialVerificationRequest,
  type TaskDetail,
  type TaskAssistantRequest,
  type TaskAssistantResponse,
} from "@dingjiang/contracts";

type ParseSchema<T> = { parse(input: unknown): T };
type DemoRole = "PMC" | "OWNER" | "EXPERT_REVIEWER";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

async function request<T>(
  path: string,
  schema: ParseSchema<T>,
  role: DemoRole,
  init?: RequestInit,
): Promise<T> {
  return requestWithTimeout(
    `${API_BASE}${path}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-vs01-role": role,
        ...init?.headers,
      },
    },
    async (response) => {
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof payload.message === "string"
            ? payload.message
            : `请求失败（${response.status}）`;
        throw new Error(message);
      }

      return schema.parse(payload);
    },
    60_000,
  );
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

const multipart = async <T>(
  path: string,
  schema: ParseSchema<T>,
  role: DemoRole,
  body: FormData,
): Promise<T> => {
  return requestWithTimeout(
    `${API_BASE}${path}`,
    {
      method: "POST",
      cache: "no-store",
      headers: { "x-vs01-role": role },
      body,
    },
    async (response) => {
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof payload.message === "string"
            ? payload.message
            : `请求失败（${response.status}）`;
        throw new Error(message);
      }
      return schema.parse(payload);
    },
    60_000,
  );
};

export const getEmployeeDashboard = (): Promise<EmployeeDashboard> =>
  request("/vs01/employee", employeeDashboardSchema, "PMC");

export const getTask = (taskId: string): Promise<TaskDetail> =>
  request(`/vs01/tasks/${encodeURIComponent(taskId)}`, taskDetailSchema, "PMC");

export const assistTask = (
  taskId: string,
  input: TaskAssistantRequest,
): Promise<TaskAssistantResponse> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/assistant`,
    taskAssistantResponseSchema,
    "PMC",
    json(input),
  );

export const decideTask = (
  taskId: string,
  input: DecisionInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/decision`,
    taskDetailSchema,
    "PMC",
    json(input),
  );

export const revertTaskDecision = (
  taskId: string,
  input: DecisionRevertInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/decision/revert`,
    taskDetailSchema,
    "PMC",
    json(input),
  );

export const registerTaskMaterial = (
  taskId: string,
  input: TaskMaterialInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/materials`,
    taskDetailSchema,
    "PMC",
    json(input),
  );

/** Browser-owned requestId makes an interrupted upload safe to retry. */
export const taskMaterialImportFormData = (
  input: TaskMaterialImportFields,
  file: File,
): FormData => {
  const fields = taskMaterialImportFieldsSchema.parse(input);
  const body = new FormData();
  body.set("actor", fields.actor);
  body.set("situationCode", fields.situationCode);
  body.set("requirementId", fields.requirementId);
  body.set("title", fields.title);
  body.set("note", fields.note);
  body.set("requestId", fields.requestId);
  body.set("file", file, file.name);
  return body;
};

export const importTaskMaterial = (
  taskId: string,
  input: TaskMaterialImportFields,
  file: File,
): Promise<TaskDetail> => {
  const body = taskMaterialImportFormData(input, file);
  return multipart(
    `/vs01/tasks/${encodeURIComponent(taskId)}/materials/import`,
    taskDetailSchema,
    "PMC",
    body,
  );
};

export const withdrawTaskMaterial = (
  taskId: string,
  materialId: string,
  input: TaskMaterialWithdrawInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(materialId)}/withdraw`,
    taskDetailSchema,
    "PMC",
    json(taskMaterialWithdrawInputSchema.parse(input)),
  );

export const verifyTaskMaterial = (
  projectId: string,
  materialId: string,
  input: MaterialVerificationRequest,
): Promise<TaskDetail> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/verification`,
    taskDetailSchema,
    "PMC",
    json(materialVerificationRequestSchema.parse(input)),
  );

export const getEvidenceProposals = (
  projectId: string,
): Promise<EvidenceProposalReview[]> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/evidence/proposals`,
    evidenceProposalReviewListSchema,
    "PMC",
  );

export const reviewEvidenceProposal = (
  projectId: string,
  proposalId: string,
  input: EvidenceConfirmationRequest,
) =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/evidence/proposals/${encodeURIComponent(proposalId)}/review`,
    evidenceConfirmationResultSchema,
    "PMC",
    json(evidenceConfirmationRequestSchema.parse(input)),
  );

const contentFileName = (contentDisposition: string | null): string | null => {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** File bytes stay outside JSON and are authorized with the same browser role header. */
export const downloadTaskMaterial = async (
  taskId: string,
  materialId: string,
): Promise<{ blob: Blob; fileName: string | null }> => {
  return requestWithTimeout(
    `${API_BASE}/vs01/tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(materialId)}/content`,
    { cache: "no-store", headers: { "x-vs01-role": "PMC" } },
    async (response) => {
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof payload.message === "string"
            ? payload.message
            : `下载材料失败（${response.status}）`;
        throw new Error(message);
      }
      return {
        blob: await response.blob(),
        fileName: contentFileName(response.headers.get("content-disposition")),
      };
    },
    120_000,
  );
};

export const createProject = (sourceTaskId: string): Promise<Project> =>
  request(
    "/vs01/projects",
    projectSchema,
    "PMC",
    json({ sourceTaskId, actor: "PMC" }),
  );

export const submitProject = (projectId: string): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/submit`,
    projectSchema,
    "PMC",
    json({ actor: "PMC" }),
  );

export const getBossDashboard = (): Promise<BossDashboard> =>
  request("/vs01/boss", bossDashboardSchema, "OWNER");

export const getProject = (
  projectId: string,
  role: DemoRole = "PMC",
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}`,
    projectSchema,
    role,
  );

export const assistProject = (
  projectId: string,
  input: ProjectAssistantRequest,
): Promise<ProjectAssistantResponse> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/assistant`,
    projectAssistantResponseSchema,
    "PMC",
    json(input),
  );

export const createAssistantFeedback = (
  projectId: string,
  input: AssistantFeedbackInput,
): Promise<AssistantFeedbackReceipt> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/assistant-feedback`,
    assistantFeedbackReceiptSchema,
    "PMC",
    json(input),
  );

export const getAssistantFeedback = (
  projectId: string,
): Promise<AssistantFeedbackRecord[]> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/assistant-feedback`,
    assistantFeedbackListSchema,
    "PMC",
  );

export const withdrawAssistantFeedback = (
  projectId: string,
  feedbackId: string,
  input: AssistantFeedbackWithdrawInput,
): Promise<AssistantFeedbackReceipt> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/assistant-feedback/${encodeURIComponent(feedbackId)}/withdraw`,
    assistantFeedbackReceiptSchema,
    "PMC",
    json(input),
  );

export const approveProject = (projectId: string): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/approve`,
    projectSchema,
    "OWNER",
    json({ actor: "OWNER" }),
  );

export const returnProject = (
  projectId: string,
  reason: string,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/return`,
    projectSchema,
    "OWNER",
    json({ actor: "OWNER", reason }),
  );

export const updateProjectSubtask = (
  subtaskId: string,
  input: ProjectSubtaskStatusInput,
): Promise<Project> =>
  request(
    `/vs01/project-subtasks/${encodeURIComponent(subtaskId)}/status`,
    projectSchema,
    "PMC",
    json(input),
  );

export const submitOutcome = (
  projectId: string,
  input: OutcomeSubmitInput,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/outcome`,
    projectSchema,
    "PMC",
    json(input),
  );

export const reopenOutcome = (
  projectId: string,
  input: OutcomeReopenInput,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/outcome/reopen`,
    projectSchema,
    "PMC",
    json(input),
  );

export const createExperienceCandidate = (
  projectId: string,
  input: ExperienceCandidateInput,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/experience-candidate`,
    projectSchema,
    "PMC",
    json(input),
  );

export const withdrawExperienceCandidate = (
  projectId: string,
  input: ExperienceCandidateWithdrawInput,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/experience-candidate/withdraw`,
    projectSchema,
    "PMC",
    json(input),
  );

export const resubmitExperienceCandidate = (
  projectId: string,
  input: ExperienceCandidateResubmitInput,
): Promise<Project> =>
  request(
    `/vs01/projects/${encodeURIComponent(projectId)}/experience-candidate/resubmit`,
    projectSchema,
    "PMC",
    json(input),
  );

export const getExpertDashboard = (): Promise<ExpertDashboard> =>
  request(
    "/vs01/expert/experience-reviews",
    expertDashboardSchema,
    "EXPERT_REVIEWER",
  );

export const getExperienceLifecycleHistory =
  (): Promise<ExperienceLifecycleHistoryList> =>
    request(
      "/vs01/expert/experience-history",
      experienceLifecycleHistoryListSchema,
      "EXPERT_REVIEWER",
    );

export const approveExperienceCandidate = (
  candidateId: string,
  input: ExperienceCandidateApproveInput,
): Promise<FormalExperience> =>
  request(
    `/vs01/experience-candidates/${encodeURIComponent(candidateId)}/approve`,
    formalExperienceSchema,
    "EXPERT_REVIEWER",
    json(input),
  );

export const returnExperienceCandidate = (
  candidateId: string,
  input: ExperienceCandidateReturnInput,
): Promise<Project> =>
  request(
    `/vs01/experience-candidates/${encodeURIComponent(candidateId)}/return`,
    projectSchema,
    "EXPERT_REVIEWER",
    json(input),
  );

export const getExperienceLibrary = (
  query = "",
  role: Extract<DemoRole, "PMC" | "EXPERT_REVIEWER"> = "PMC",
): Promise<ExperienceLibrary> =>
  request(
    `/vs01/experiences?query=${encodeURIComponent(query)}`,
    experienceLibrarySchema,
    role,
  );

export const createTaskExperienceReference = (
  taskId: string,
  input: ExperienceReferenceInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/experience-references`,
    taskDetailSchema,
    "PMC",
    json(input),
  );

export const withdrawTaskExperienceReference = (
  taskId: string,
  referenceId: string,
  input: ExperienceReferenceWithdrawInput,
): Promise<TaskDetail> =>
  request(
    `/vs01/tasks/${encodeURIComponent(taskId)}/experience-references/${encodeURIComponent(referenceId)}/withdraw`,
    taskDetailSchema,
    "PMC",
    json(input),
  );

export const retractFormalExperience = (
  experienceId: string,
  input: FormalExperienceRetractInput,
): Promise<FormalExperience> =>
  request(
    `/vs01/experiences/${encodeURIComponent(experienceId)}/retract`,
    formalExperienceSchema,
    "EXPERT_REVIEWER",
    json(input),
  );

export const resetDemo = (): Promise<EmployeeDashboard> =>
  request(
    "/vs01/reset",
    employeeDashboardSchema,
    "PMC",
    json({ actor: "PMC" }),
  );
