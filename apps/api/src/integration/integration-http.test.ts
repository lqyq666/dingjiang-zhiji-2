import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";

import {
  IntegrationAuthGuard,
  IntegrationExceptionFilter,
  type IntegrationRequest,
} from "./integration-http";
import { IntegrationService } from "./integration.service";

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
  it.each([true, false])(
    "reports only server-confirmed missing scopes (scope denial=%s)",
    async (scopeDenial) => {
      let exception: unknown = new ForbiddenException(
        "Bearer secret /internal/path material:write",
      );
      if (scopeDenial) {
        const service = new IntegrationService(
          {} as never,
          {} as never,
          {} as never,
        );
        try {
          await service.createMaterial(
            {
              tenantId: "tenant-demo",
              subjectId: "pmc",
              role: "PMC",
              scopes: ["material:read"],
              projectIds: ["PRJ-A"],
            },
            "PRJ-A",
            {},
          );
          throw new Error("Expected a scope rejection");
        } catch (error) {
          exception = error;
        }
      }
      let body: unknown;
      const response = {
        status: () => response,
        json: (value: unknown) => {
          body = value;
        },
      };
      new IntegrationExceptionFilter().catch(exception, {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {} }),
          getResponse: () => response,
        }),
      } as ArgumentsHost);
      expect(body).toMatchObject({
        error: { code: "FORBIDDEN", retryable: false },
      });
      const error = (body as { error: Record<string, unknown> }).error;
      if (scopeDenial)
        expect(error).toMatchObject({
          requiredScope: "material:write",
          message: expect.stringContaining("material:write"),
        });
      else expect(error).not.toHaveProperty("requiredScope");
      expect(JSON.stringify(body)).not.toMatch(
        /Bearer|secret|internal\/path|无权读取/,
      );
    },
  );

  it("fails closed when the server token is not configured", async () => {
    delete process.env.DINGJIANG_MCP_API_TOKEN;
    const guard = new IntegrationAuthGuard();
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("rejects the wrong token without attaching a principal", async () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer wrong-local-secret" },
    };
    const guard = new IntegrationAuthGuard();
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(request.integrationPrincipal).toBeUndefined();
  });

  it("binds tenant, subject, role and read scopes after authentication", async () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    process.env.DINGJIANG_MCP_PROJECT_IDS = "PRJ-1,PRJ-2";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    const guard = new IntegrationAuthGuard();
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
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

  it("adds only workpaper:write when explicitly enabled for concrete projects", async () => {
    process.env.DINGJIANG_MCP_API_TOKEN = "correct-local-secret";
    process.env.DINGJIANG_MCP_PROJECT_IDS = "PRJ-1";
    process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED = "1";
    const request: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    await expect(
      new IntegrationAuthGuard().canActivate(contextFor(request)),
    ).resolves.toBe(true);
    expect(request.integrationPrincipal).toMatchObject({
      role: "PMC",
      projectIds: ["PRJ-1"],
      scopes: expect.arrayContaining(["workpaper:write"]),
    });

    delete process.env.DINGJIANG_MCP_PROJECT_IDS;
    const wildcardRequest: IntegrationRequest = {
      headers: { authorization: "Bearer correct-local-secret" },
    };
    await expect(
      new IntegrationAuthGuard().canActivate(contextFor(wildcardRequest)),
    ).resolves.toBe(true);
    expect(wildcardRequest.integrationPrincipal?.scopes).not.toContain(
      "workpaper:write",
    );
  });

  it("binds a multi-token identity without trusting caller role headers", async () => {
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
    await expect(
      new IntegrationAuthGuard().canActivate(contextFor(request)),
    ).resolves.toBe(true);
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
