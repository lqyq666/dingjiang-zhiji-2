import { describe, expect, it, vi } from "vitest";

import {
  GovernedCommandFailure,
  GovernedCommandKernel,
  type GovernedCommandStore,
} from "./governed-command-kernel";

const request = {
  requestId: "30000000-0000-4000-8000-000000000001",
  expectedVersion: 1,
  reason: "提交测试变更",
  payload: { value: 2 },
  correlationId: "40000000-0000-4000-8000-000000000001",
};
const principal = {
  tenantId: "tenant-demo",
  subjectId: "pmc-1",
  role: "PMC" as const,
  scopes: ["kernel:test"],
  projectIds: ["PRJ-1"],
};
const target = { tenantId: "tenant-demo", projectId: "PRJ-1" };
const definition = {
  name: "kernel.test.increment",
  requiredScope: "kernel:test",
  allowedRoles: ["PMC"] as const,
  parsePayload: (payload: Record<string, unknown>) => {
    if (
      Object.keys(payload).length !== 1 ||
      typeof payload.value !== "number" ||
      !Number.isInteger(payload.value) ||
      payload.value <= 0
    )
      throw new Error("invalid payload");
    return { value: payload.value };
  },
  handler: vi.fn(),
};

const successfulStore = (): GovernedCommandStore => ({
  execute: vi.fn(async (input) => ({
    requestId: input.envelope.request.requestId,
    correlationId: input.envelope.request.correlationId,
    version: 2,
    replayed: false,
    data: { value: 2 },
  })),
});

describe("GovernedCommandKernel", () => {
  it("executes an authorized, server-scoped command", async () => {
    const store = successfulStore();
    const result = await new GovernedCommandKernel(store).execute(
      { request, principal, target },
      definition,
    );
    expect(result).toMatchObject({ version: 2, replayed: false });
    expect(store.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["unauthorized", { ...principal, scopes: ["project:read"] }],
    ["wrong tenant", { ...principal, tenantId: "tenant-other" }],
    ["wrong project", { ...principal, projectIds: ["PRJ-OTHER"] }],
  ])(
    "fails closed for %s before touching the store",
    async (_label, identity) => {
      const store = successfulStore();
      await expect(
        new GovernedCommandKernel(store).execute(
          { request, principal: identity, target },
          definition,
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(store.execute).not.toHaveBeenCalled();
    },
  );

  it("returns INVALID_REQUEST without echoing secret-shaped invalid input", async () => {
    const store = successfulStore();
    let failure: unknown;
    try {
      await new GovernedCommandKernel(store).execute(
        {
          request: {
            ...request,
            payload: { value: -1, apiToken: "test-secret-sentinel" },
          },
          principal,
          target,
        },
        definition,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GovernedCommandFailure);
    expect(failure).toMatchObject({ code: "INVALID_REQUEST" });
    expect(JSON.stringify(failure)).not.toContain("test-secret-sentinel");
    expect(store.execute).not.toHaveBeenCalled();
  });
});
