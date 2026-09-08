import { requestWithTimeout } from "./request-with-timeout";
import {
  acceptAtomicTaskInputSchema,
  atomicTaskProposalListSchema,
  atomicTaskProposalSchema,
  editAtomicTaskInputSchema,
  generateAtomicTasksInputSchema,
  type AtomicTaskProposal,
  type AtomicTaskProposalList,
  type EditAtomicTaskInput,
} from "@dingjiang/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";
type Schema<T> = { parse(input: unknown): T };

async function request<T>(
  path: string,
  schema: Schema<T>,
  init?: RequestInit,
): Promise<T> {
  return requestWithTimeout(
    `${API_BASE}${path}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-vs01-role": "PMC",
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

export const getAtomicTaskProposals = (
  projectId: string,
  phaseCode: string,
): Promise<AtomicTaskProposalList> =>
  request(
    `/vs18/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseCode)}/task-proposals`,
    atomicTaskProposalListSchema,
  );

export const generateAtomicTaskProposals = (
  projectId: string,
  phaseCode: string,
  force = false,
): Promise<AtomicTaskProposalList> =>
  request(
    `/vs18/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseCode)}/task-proposals/generate`,
    atomicTaskProposalListSchema,
    json(generateAtomicTasksInputSchema.parse({ actor: "PMC", force })),
  );

export const editAtomicTaskProposal = (
  proposalId: string,
  input: Omit<EditAtomicTaskInput, "actor">,
): Promise<AtomicTaskProposal> =>
  request(
    `/vs18/task-proposals/${encodeURIComponent(proposalId)}/edit`,
    atomicTaskProposalSchema,
    json(editAtomicTaskInputSchema.parse({ actor: "PMC", ...input })),
  );

export const acceptAtomicTaskProposal = (
  proposalId: string,
): Promise<AtomicTaskProposal> =>
  request(
    `/vs18/task-proposals/${encodeURIComponent(proposalId)}/accept`,
    atomicTaskProposalSchema,
    json(acceptAtomicTaskInputSchema.parse({ actor: "PMC" })),
  );
