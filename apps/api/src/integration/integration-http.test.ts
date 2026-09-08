import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";

import {
  IntegrationAuthGuard,
  IntegrationExceptionFilter,
  type IntegrationRequest,
} from "./integration-http";

const originalToken = process.env.DINGJIANG_MCP_API_TOKEN;
const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
const originalProjectIds = process.env.DINGJIANG_MCP_PROJECT_IDS;
const originalWorkpaperWrite = process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED;

const contextFor = (request: IntegrationRequest): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as never;

afterEach(() => {
  if (originalToken === undefined) delete process.env.DINGJIANG_MCP_API_TOKEN;
  else process.env.DINGJIANG_MCP_API_TOKEN = originalToken;
  if (originalBindings === undefined)
    delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
  else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = originalBindings;
  if (originalProjectIds === undefined)
    delete process.env.DINGJIANG_MCP_PROJECT_IDS;
  else process.env.DINGJIANG_MCP_PROJECT_IDS = originalProjectIds;
  if (originalWorkpaperWrite === undefined)
    delete process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED;
  else process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED = originalWorkpaperWrite;
});

describe("Integration HTTP authorization boundary", () => {
  it("fails closed when the server token is not configured", () => {
    delete process.env.DINGJIANG_MCP_API_TOKEN;
    const guard = new IntegrationAuthGuard();
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it("rejects the wrong token without attaching a principal", () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer wrong-local-secret" },
    };
    const guard = new IntegrationAuthGuard();
    expect(() => guard.canActivate(contextFor(request))).toThrow(
      UnauthorizedException,
    );
    expect(request.integrationPrincipal).toBeUndefined();
  });

  it("binds tenant, subject, role and read scopes after authentication", () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    process.env.DINGJIANG_MCP_PROJECT_IDS = "PRJ-1,PRJ-2";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    const guard = new IntegrationAuthGuard();
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.integrationPrincipal).toEqual({
      tenantId: "tenant-demo",
      subjectId: "demo-pmc",
      role: "PMC",
      scopes: [
        "project:read",
        "workitem:read",
        "material:read",
        "evidence:read",
        "workpaper:read",
        "experience:read",
      ],
      projectIds: ["PRJ-1", "PRJ-2"],
    });
  });

  it("adds only workpaper:write when explicitly enabled for concrete projects", () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    process.env.DINGJIANG_MCP_PROJECT_IDS = "PRJ-1";
    process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED = "1";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    expect(new IntegrationAuthGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.integrationPrincipal).toMatchObject({
      role: "PMC",
      projectIds: ["PRJ-1"],
      scopes: expect.arrayContaining(["workpaper:write"]),
    });

    delete process.env.DINGJIANG_MCP_PROJECT_IDS;
    const wildcardRequest: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    expect(
      new IntegrationAuthGuard().canActivate(contextFor(wildcardRequest)),
    ).toBe(true);
    expect(wildcardRequest.integrationPrincipal?.scopes).not.toContain(
      "workpaper:write",
    );
  });

  it("binds a multi-token identity without trusting caller role headers", () => {
    delete process.env.DINGJIANG_MCP_API_TOKEN;
    process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
      {
        token: "owner-local-secret-0001",
        tenantId: "tenant-demo",
        subjectId: "owner-1",
        role: "OWNER",
        scopes: ["project:read"],
        projectIds: ["PRJ-ONLY"],
      },
    ]);
    const request: IntegrationRequest = {
      headers: {
        authorization: "Bearer owner-local-secret-0001",
        "x-role": "EXPERT_REVIEWER",
      },
    };
    expect(new IntegrationAuthGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.integrationPrincipal).toEqual({
      tenantId: "tenant-demo",
      subjectId: "owner-1",
      role: "OWNER",
      scopes: ["project:read"],
      projectIds: ["PRJ-ONLY"],
    });
  });

  it("returns the uniform failure envelope without exposing the secret", () => {
    const request: IntegrationRequest = { headers: {} };
    let status = 0;
    let body: unknown;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ArgumentsHost;
    new IntegrationExceptionFilter().catch(
      new UnauthorizedException("Bearer super-secret"),
      host,
    );
    expect(status).toBe(401);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        retryable: false,
        requiresHuman: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });
});
