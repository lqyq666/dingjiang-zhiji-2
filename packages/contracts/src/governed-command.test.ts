import { describe, expect, it } from "vitest";

import {
  governedCommandEnvelopeSchema,
  governedCommandErrorSchema,
  governedCommandRequestSchema,
  governedCommandResultSchema,
} from "./governed-command";

const request = {
  requestId: "10000000-0000-4000-8000-000000000001",
  expectedVersion: 3,
  reason: "核对后提交受治理变更",
  payload: { value: 4 },
  correlationId: "20000000-0000-4000-8000-000000000001",
};

describe("governed command contract", () => {
  it("parses the public command fields and a server-bound principal envelope", () => {
    expect(governedCommandRequestSchema.parse(request)).toEqual(request);
    expect(
      governedCommandEnvelopeSchema.parse({
        name: "kernel.test.increment",
        request,
        principal: {
          tenantId: "tenant-demo",
          subjectId: "pmc-1",
          role: "PMC",
          scopes: ["kernel:test"],
          projectIds: ["PRJ-1"],
        },
        target: { tenantId: "tenant-demo", projectId: "PRJ-1" },
      }),
    ).toMatchObject({
      principal: { subjectId: "pmc-1", role: "PMC" },
      request: { expectedVersion: 3 },
    });
  });

  it("rejects caller privilege injection and secret-shaped content", () => {
    for (const injected of [
      { tenantId: "tenant-other" },
      { subjectId: "owner-1" },
      { role: "OWNER" },
      { scopes: ["*"] },
      { projectIds: ["*"] },
      { sql: "select 1" },
      { shell: "whoami" },
      { url: "https://example.test" },
      { filePath: "C:\\secret.txt" },
    ])
      expect(() =>
        governedCommandRequestSchema.parse({ ...request, ...injected }),
      ).toThrow();
    expect(() =>
      governedCommandRequestSchema.parse({
        ...request,
        payload: { apiToken: "test-secret-sentinel" },
      }),
    ).toThrow();
    expect(() =>
      governedCommandRequestSchema.parse({
        ...request,
        reason: "Bearer test-secret-sentinel",
      }),
    ).toThrow();
  });

  it("keeps versioned success and stable structured errors", () => {
    expect(
      governedCommandResultSchema.parse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        version: 4,
        replayed: false,
        data: { value: 4 },
      }),
    ).toMatchObject({ version: 4, replayed: false });
    expect(
      governedCommandErrorSchema.parse({
        code: "STALE_VERSION",
        message: "版本已变化",
        retryable: false,
        correlationId: request.correlationId,
      }).code,
    ).toBe("STALE_VERSION");
  });

  it("rejects secret-shaped fields in a command response", () => {
    expect(() =>
      governedCommandResultSchema.parse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        version: 4,
        replayed: false,
        data: { nested: { accessToken: "test-secret-sentinel" } },
      }),
    ).toThrow();
  });
});
