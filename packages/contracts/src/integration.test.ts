import { describe, expect, it } from "vitest";

import {
  integrationFailureEnvelopeSchema,
  integrationPrincipalSchema,
  integrationSuccessEnvelopeSchema,
} from "./integration";

describe("WorkBuddy Integration contracts", () => {
  it("binds authorization scope to a server-side principal", () => {
    expect(
      integrationPrincipalSchema.parse({
        tenantId: "tenant-demo",
        subjectId: "demo-pmc",
        role: "PMC",
        scopes: ["project:read", "evidence:read", "experience:read"],
        projectIds: ["PRJ-1"],
      }),
    ).toBeTruthy();
    expect(
      integrationPrincipalSchema.safeParse({
        tenantId: "tenant-demo",
        subjectId: "demo-pmc",
        role: "PMC",
        scopes: ["database:write"],
        projectIds: ["PRJ-1"],
      }).success,
    ).toBe(false);
  });

  it("requires a correlation id on both envelope branches", () => {
    const correlationId = "e43f698c-d10d-4d58-b53d-876f93d1535d";
    expect(
      integrationSuccessEnvelopeSchema(integrationPrincipalSchema).parse({
        ok: true,
        data: {
          tenantId: "tenant-demo",
          subjectId: "demo-pmc",
          role: "PMC",
          scopes: ["project:read"],
          projectIds: ["PRJ-1"],
        },
        correlationId,
      }).ok,
    ).toBe(true);
    expect(
      integrationFailureEnvelopeSchema.parse({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "缺少访问令牌",
          retryable: false,
          requiresHuman: true,
        },
        correlationId,
      }).ok,
    ).toBe(false);
  });
});
