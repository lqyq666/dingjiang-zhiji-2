import { z } from "zod";

const id = z.string().trim().min(1).max(200);

export const atomicTaskApprovalKindSchema = z.enum([
  "NONE",
  "MONEY",
  "DIRECTION",
]);
export const atomicTaskProposalStatusSchema = z.enum([
  "PROPOSED",
  "ACCEPTED",
  "PENDING_APPROVAL",
  "SUPERSEDED",
]);
export const feishuApprovalDeliveryStatusSchema = z.enum([
  "NOT_REQUIRED",
  "NOT_CONFIGURED",
  "SENT",
  "FAILED",
]);

export const atomicTaskProposalSchema = z.object({
  id: z.string().uuid(),
  projectId: id,
  phaseCode: id,
  sourceWorkItemId: id,
  title: z.string().trim().min(2).max(120),
  purpose: z.string().trim().min(2).max(300),
  basis: z.string().trim().min(2).max(500),
  approvalKind: atomicTaskApprovalKindSchema,
  amount: z.number().nonnegative().nullable(),
  status: atomicTaskProposalStatusSchema,
  provider: z.literal("DEMO_RULES"),
  classification: z.literal("PROPOSAL"),
  approvalRequestId: z.string().uuid().nullable(),
  feishuDeliveryStatus: feishuApprovalDeliveryStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const atomicTaskProposalListSchema = z.object({
  provider: z.literal("DEMO_RULES"),
  classification: z.literal("PROPOSAL"),
  limit: z.literal(3),
  items: z.array(atomicTaskProposalSchema).max(3),
});

export const generateAtomicTasksInputSchema = z.object({
  actor: z.literal("PMC"),
  force: z.boolean().default(false),
});

export const editAtomicTaskInputSchema = z
  .object({
    actor: z.literal("PMC"),
    title: z.string().trim().min(2).max(120),
    purpose: z.string().trim().min(2).max(300),
    approvalKind: atomicTaskApprovalKindSchema,
    amount: z.number().nonnegative().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.approvalKind === "MONEY" && value.amount === null)
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "金钱审批需要填写金额",
      });
    if (value.approvalKind !== "MONEY" && value.amount !== null)
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "只有金钱审批可以填写金额",
      });
  });

export const acceptAtomicTaskInputSchema = z.object({
  actor: z.literal("PMC"),
});
export const approvalDecisionInputSchema = z.object({
  actor: z.literal("OWNER"),
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]),
  note: z.string().trim().min(2).max(500),
});

export type AtomicTaskApprovalKind = z.infer<
  typeof atomicTaskApprovalKindSchema
>;
export type AtomicTaskProposal = z.infer<typeof atomicTaskProposalSchema>;
export type AtomicTaskProposalList = z.infer<
  typeof atomicTaskProposalListSchema
>;
export type GenerateAtomicTasksInput = z.infer<
  typeof generateAtomicTasksInputSchema
>;
export type EditAtomicTaskInput = z.infer<typeof editAtomicTaskInputSchema>;
export type AcceptAtomicTaskInput = z.infer<typeof acceptAtomicTaskInputSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>;
