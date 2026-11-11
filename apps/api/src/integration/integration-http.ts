import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import type {
  ArgumentsHost,
  CanActivate,
  ExecutionContext,
} from "@nestjs/common";
import {
  Catch,
  ForbiddenException,
  HttpException,
  Injectable,
  Inject,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ExceptionFilter } from "@nestjs/common";
import {
  integrationTokenBindingsSchema,
  type IntegrationError,
  type IntegrationPrincipal,
} from "@dingjiang/contracts";
import { GovernedCommandFailure } from "../command-kernel/governed-command-kernel";
import { governedCommandHttpError } from "../command-kernel/governed-command-http";
import { isProduction } from "../runtime-config";
import { productionWritesEnabled } from "../production-write-policy";
import {
  RateLimitExceeded,
  RateLimitService,
  type RateLimitActor,
} from "./rate-limit.service";
import { IdentityService } from "../identity/identity.service";
import {
  IntegrationScopeDenied,
  requireIntegrationTenant,
} from "./integration-access";

export type IntegrationRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  integrationPrincipal?: IntegrationPrincipal;
  integrationCorrelationId?: string;
};

type IntegrationResponse = {
  status(code: number): IntegrationResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
};

const firstHeader = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

export const integrationCorrelationId = (
  request: IntegrationRequest,
): string => {
  if (request.integrationCorrelationId) return request.integrationCorrelationId;
  const requested = firstHeader(request.headers["x-correlation-id"]);
  request.integrationCorrelationId =
    requested &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requested,
    )
      ? requested
      : randomUUID();
  return request.integrationCorrelationId;
};

const sameSecret = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};

const legacyPrincipal = (): IntegrationPrincipal => {
  const configuredProjects = process.env.DINGJIANG_MCP_PROJECT_IDS?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const projectIds = configuredProjects?.length ? configuredProjects : ["*"];
  const governedWriteEnabled =
    process.env.DINGJIANG_WORKPAPER_PROPOSE_ENABLED === "1" &&
    projectIds.length > 0 &&
    !projectIds.includes("*");
  const materialCreateEnabled =
    process.env.DINGJIANG_MATERIAL_CREATE_ENABLED === "1" &&
    projectIds.length > 0 &&
    !projectIds.includes("*");
  const evidenceProposeEnabled =
    process.env.DINGJIANG_EVIDENCE_PROPOSE_ENABLED === "1" &&
    projectIds.length > 0 &&
    !projectIds.includes("*");
  return {
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
      ...(governedWriteEnabled ? (["workpaper:write"] as const) : []),
      ...(materialCreateEnabled ? (["material:write"] as const) : []),
      ...(evidenceProposeEnabled ? (["evidence:write"] as const) : []),
    ],
    projectIds,
  };
};

const principalForToken = (actual: string): IntegrationPrincipal | null => {
  const rawBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON?.trim();
  if (rawBindings) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBindings);
    } catch {
      throw new ServiceUnavailableException(
        "Integration token bindings 配置无效",
      );
    }
    const bindings = integrationTokenBindingsSchema.safeParse(payload);
    if (!bindings.success)
      throw new ServiceUnavailableException(
        "Integration token bindings 配置无效",
      );
    const matched = bindings.data.find((binding) =>
      sameSecret(actual, binding.token),
    );
    if (!matched) return null;
    return {
      tenantId: matched.tenantId,
      subjectId: matched.subjectId,
      role: matched.role,
      scopes: matched.scopes,
      projectIds: matched.projectIds,
    };
  }
  const expected = process.env.DINGJIANG_MCP_API_TOKEN?.trim();
  if (!expected)
    throw new ServiceUnavailableException("Integration API 访问令牌未配置");
  return sameSecret(actual, expected) ? legacyPrincipal() : null;
};

@Injectable()
export class IntegrationAuthGuard implements CanActivate {
  constructor(
    @Optional()
    @Inject(IdentityService)
    private readonly identity?: IdentityService,
    @Optional()
    @Inject(RateLimitService)
    private readonly rateLimits?: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    integrationCorrelationId(request);
    const authorization = firstHeader(request.headers.authorization);
    const actual = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const method = request.method ?? "GET";
    if (isProduction()) {
      if (!this.identity)
        throw new ServiceUnavailableException("Identity service unavailable");
      const principal = await this.identity.mcpPrincipal(actual);
      if (request.method !== "GET" && !productionWritesEnabled())
        throw new ServiceUnavailableException(
          "生产业务写入尚未通过验收，当前只读",
        );
      request.integrationPrincipal = principal;
      await this.enforceRateLimit(principal, method);
      return true;
    }
    const principal = principalForToken(actual);
    if (!actual || !principal)
      throw new UnauthorizedException("Integration API 访问令牌无效");
    requireIntegrationTenant(principal.tenantId);
    request.integrationPrincipal = principal;
    await this.enforceRateLimit(principal, method);
    return true;
  }

  /**
   * Counting happens after authentication: an unauthenticated request has no
   * credential to charge, and it already fails at the guard above.
   */
  private async enforceRateLimit(
    actor: RateLimitActor,
    method: string,
  ): Promise<void> {
    if (!this.rateLimits) return;
    // On by default; an operator can set DINGJIANG_RATE_LIMIT_ENABLED=0 to
    // shed the ceiling during an incident, but silence is not the default.
    if (process.env.DINGJIANG_RATE_LIMIT_ENABLED === "0") return;
    await this.rateLimits.assertWithinLimit(actor, method);
  }
}

export const integrationPrincipal = (
  request: IntegrationRequest,
): IntegrationPrincipal => {
  if (!request.integrationPrincipal)
    throw new ForbiddenException("Integration principal 不存在");
  return request.integrationPrincipal;
};

const errorFor = (
  exception: unknown,
): { status: number; error: IntegrationError } => {
  if (exception instanceof GovernedCommandFailure) {
    return governedCommandHttpError(exception);
  }
  if (exception instanceof UnauthorizedException)
    return {
      status: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "访问令牌缺失或无效",
        retryable: false,
        requiresHuman: true,
      },
    };
  if (exception instanceof ForbiddenException)
    return {
      status: 403,
      error: {
        code: "FORBIDDEN",
        message:
          exception instanceof IntegrationScopeDenied
            ? `Integration API 拒绝：当前身份缺少 ${exception.requiredScope} 权限`
            : "当前身份无权执行该操作",
        ...(exception instanceof IntegrationScopeDenied
          ? { requiredScope: exception.requiredScope }
          : {}),
        retryable: false,
        requiresHuman: true,
      },
    };
  if (exception instanceof ServiceUnavailableException)
    return {
      status: 503,
      error: {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "Integration API 暂时不可用",
        retryable: false,
        requiresHuman: true,
      },
    };
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404)
      return {
        status,
        error: {
          code: "NOT_FOUND",
          message: "授权范围内未找到该资源",
          retryable: false,
          requiresHuman: false,
        },
      };
    if (status === 400)
      return {
        status,
        error: {
          code: "INVALID_REQUEST",
          message: "请求参数不符合 Integration contract",
          retryable: false,
          requiresHuman: false,
        },
      };
    if (status === 429)
      return {
        status,
        error: {
          code: "RATE_LIMITED",
          message: "请求过于频繁，请按 Retry-After 重试",
          retryable: true,
          requiresHuman: false,
        },
      };
  }
  return {
    status: 500,
    error: {
      code: "INTERNAL_ERROR",
      message: "Integration API 处理失败",
      retryable: false,
      requiresHuman: true,
    },
  };
};

@Catch()
export class IntegrationExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<IntegrationRequest>();
    const response = http.getResponse<IntegrationResponse>();
    const mapped = errorFor(exception);
    if (exception instanceof RateLimitExceeded)
      response.setHeader("Retry-After", String(exception.retryAfterSeconds));
    response.status(mapped.status).json({
      ok: false,
      error: mapped.error,
      correlationId: integrationCorrelationId(request),
    });
  }
}
