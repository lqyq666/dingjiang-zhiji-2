import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";

import {
  governedCommandEnvelopeSchema,
  governedCommandResultSchema,
  type GovernedCommandEnvelope,
  type GovernedCommandErrorCode,
  type GovernedCommandRequest,
  type GovernedCommandResult,
  type GovernedPrincipal,
} from "@dingjiang/contracts";

type Role = GovernedPrincipal["role"];

export type GovernedCommandTransaction = {
  readonly client?: PoolClient;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
};

export type GovernedCommandOutcome = {
  version: number;
  data: Record<string, unknown>;
  audit: {
    eventType: string;
    details: Record<string, unknown>;
  };
};

export type GovernedCommandDefinition<TPayload = Record<string, unknown>> = {
  name: string;
  requiredScope: string;
  allowedRoles: readonly Role[];
  parsePayload(payload: Record<string, unknown>): TPayload;
  handler(
    transaction: GovernedCommandTransaction,
    context: {
      principal: GovernedPrincipal;
      target: { tenantId: string; projectId: string };
      request: GovernedCommandRequest;
      payload: TPayload;
    },
  ): Promise<GovernedCommandOutcome>;
};

export type GovernedCommandStore = {
  execute(input: {
    envelope: GovernedCommandEnvelope;
    payloadFingerprint: string;
    run(
      transaction: GovernedCommandTransaction,
    ): Promise<GovernedCommandOutcome>;
  }): Promise<GovernedCommandResult>;
};

export class GovernedCommandFailure extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: GovernedCommandErrorCode,
    message: string,
    readonly correlationId: string,
    retryable = false,
  ) {
    super(message);
    this.name = "GovernedCommandFailure";
    this.retryable = retryable;
  }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const fingerprint = (envelope: GovernedCommandEnvelope): string =>
  createHash("sha256")
    .update(
      canonical({
        name: envelope.name,
        request: {
          expectedVersion: envelope.request.expectedVersion,
          reason: envelope.request.reason,
          payload: envelope.request.payload,
        },
        actor: {
          tenantId: envelope.principal.tenantId,
          subjectId: envelope.principal.subjectId,
          role: envelope.principal.role,
        },
        target: envelope.target,
      }),
    )
    .digest("hex");

export class GovernedCommandKernel {
  constructor(private readonly store: GovernedCommandStore) {}

  async execute<TPayload>(
    input: {
      request: GovernedCommandRequest;
      principal: GovernedPrincipal;
      target: { tenantId: string; projectId: string };
    },
    definition: GovernedCommandDefinition<TPayload>,
  ): Promise<GovernedCommandResult> {
    const correlationId = input.request?.correlationId ?? randomUUID();
    let envelope: GovernedCommandEnvelope;
    try {
      envelope = governedCommandEnvelopeSchema.parse({
        name: definition.name,
        ...input,
      });
    } catch {
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "命令不符合统一 contract",
        correlationId,
      );
    }

    const { principal, target } = envelope;
    if (
      principal.tenantId !== target.tenantId ||
      !principal.projectIds.includes(target.projectId) ||
      !principal.scopes.includes(definition.requiredScope) ||
      !definition.allowedRoles.includes(principal.role)
    )
      throw new GovernedCommandFailure(
        "PERMISSION_DENIED",
        "服务端身份无权执行该命令",
        envelope.request.correlationId,
      );

    let payload: TPayload;
    try {
      payload = definition.parsePayload(envelope.request.payload);
    } catch {
      throw new GovernedCommandFailure(
        "INVALID_REQUEST",
        "命令 payload 未通过领域 contract",
        envelope.request.correlationId,
      );
    }

    return governedCommandResultSchema.parse(
      await this.store.execute({
        envelope,
        payloadFingerprint: fingerprint(envelope),
        run: (transaction) =>
          definition.handler(transaction, {
            principal,
            target,
            request: envelope.request,
            payload,
          }),
      }),
    );
  }
}
