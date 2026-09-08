import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { isProduction } from "../runtime-config";
import {
  browserReadRole,
  cookieToken,
  hasExpectedOrigin,
} from "./access-policy";
import {
  IdentityService,
  sessionCookieName,
  type UserIdentity,
} from "./identity.service";

type Request = {
  headers: Record<string, string | undefined>;
  ip?: string;
  path: string;
  method: string;
};
type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge?: number;
};
type Response = {
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options: CookieOptions): void;
};
export type AuthenticatedRequest = Request & { userIdentity?: UserIdentity };
export const sessionToken = (
  request: Pick<Request, "headers">,
): string | undefined => cookieToken(request.headers.cookie, sessionCookieName);

const requireOrigin = (request: Request): void => {
  if (!hasExpectedOrigin(request.headers.origin, process.env.WEB_ORIGIN))
    throw new ForbiddenException("请求来源无效");
};
const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: "strict",
  path: "/",
});

@Controller("auth")
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Get("session")
  async session(@Req() request: Request) {
    if (!isProduction())
      return {
        mode: "demo",
        companyName: process.env.DINGJIANG_COMPANY_NAME ?? "演示企业",
        user: null,
      };
    return {
      mode: "production",
      companyName: process.env.DINGJIANG_COMPANY_NAME,
      user: await this.identity.session(sessionToken(request)),
    };
  }

  @Post("login")
  async login(
    @Body() input: { username?: unknown; password?: unknown },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireOrigin(request);
    const result = await this.identity.login(
      input?.username,
      input?.password,
      request.ip ?? "unknown",
    );
    response.cookie(sessionCookieName, result.token, {
      ...cookieOptions(),
      maxAge: 8 * 60 * 60 * 1000,
    });
    return { user: result.user };
  }

  @Post("logout")
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireOrigin(request);
    await this.identity.logout(sessionToken(request));
    response.clearCookie(sessionCookieName, cookieOptions());
    return { ok: true };
  }
}

/** Production browser sessions can only read; server roles replace untrusted headers.
 * Within one company, records are role-shared. MCP separately restricts projects. */
@Injectable()
export class ProductionAccessGuard implements CanActivate {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isProduction()) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = request.path;
    if (
      /^\/api\/health(?:\/ready)?\/?$/.test(path) ||
      /^\/api\/auth\/(session|login|logout)\/?$/.test(path)
    )
      return true;
    // Every integration route also has IntegrationAuthGuard; browser cookies do not authorize it.
    if (path.startsWith("/api/integration/")) return true;
    const user = await this.identity.session(sessionToken(request));
    request.userIdentity = user;
    delete request.headers["x-vs01-role"];
    if (request.method !== "GET")
      throw new ForbiddenException("业务操作请在 WorkBuddy 中完成");
    const role = browserReadRole(path, user.role);
    if (!role) throw new ForbiddenException("当前账号无权查看此记录");
    request.headers["x-vs01-role"] = role;
    return true;
  }
}
