import {
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import { isLoopbackHostname } from "./endpoint-policy";

export const mcpReadScope = "dingjiang:mcp:read";
export const mcpWriteScope = "dingjiang:mcp:write";

const oauthUrl = (value: string | undefined, setting: string): URL => {
  const url = value && URL.canParse(value) ? new URL(value) : undefined;
  if (
    !url ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${setting} must be an HTTPS URL or a loopback HTTP URL`);
  return url;
};

const bindingSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  integrationToken: z.string().regex(/^[!-~]{1,512}$/),
});

const readBindings = (raw: string | undefined): Map<string, string> => {
  const invalid = () =>
    new Error(
      "DINGJIANG_MCP_OAUTH_BINDINGS_JSON must contain unique subjects and Integration credentials",
    );
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    throw invalid();
  }
  const parsed = z.array(bindingSchema).min(1).safeParse(value);
  if (!parsed.success) throw invalid();

  const bySubject = new Map<string, string>();
  const credentials = new Set<string>();
  for (const { subject, integrationToken } of parsed.data) {
    if (
      bySubject.has(subject) ||
      credentials.has(integrationToken) ||
      integrationToken.startsWith("${")
    )
      throw invalid();
    bySubject.set(subject, integrationToken);
    credentials.add(integrationToken);
  }
  return bySubject;
};

export const createMcpOAuth = () => {
  const resource = oauthUrl(
    process.env.DINGJIANG_MCP_HTTP_URL?.trim(),
    "DINGJIANG_MCP_HTTP_URL",
  );
  if (resource.pathname !== "/mcp")
    throw new Error("DINGJIANG_MCP_HTTP_URL must end in /mcp");

  // The issuer claim and discovery metadata use the configured identifier verbatim.
  const issuer = process.env.DINGJIANG_MCP_OAUTH_ISSUER?.trim() ?? "";
  oauthUrl(issuer, "DINGJIANG_MCP_OAUTH_ISSUER");
  const jwks = createRemoteJWKSet(
    oauthUrl(
      process.env.DINGJIANG_MCP_OAUTH_JWKS_URL?.trim(),
      "DINGJIANG_MCP_OAUTH_JWKS_URL",
    ),
    { timeoutDuration: 5_000 },
  );
  const getVerificationKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await jwks(header, token);
    } catch (error) {
      if (
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys
      )
        throw error;
      throw new OAuthError(
        OAuthErrorCode.ServerError,
        "Access token verification unavailable",
      );
    }
  };
  const bindings = readBindings(process.env.DINGJIANG_MCP_OAUTH_BINDINGS_JSON);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);

  const authenticate = requireBearerAuth({
    expectedResource: resource,
    resourceMetadataUrl,
    requiredScopes: [mcpReadScope],
    verifier: {
      async verifyAccessToken(token) {
        const invalid = () =>
          new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
        const { payload } = await jwtVerify(token, getVerificationKey, {
          issuer,
          audience: resource.href,
          algorithms: ["RS256", "ES256"],
          typ: "at+jwt",
          requiredClaims: ["sub", "exp", "client_id"],
        }).catch((error: unknown) => {
          if (error instanceof errors.JOSEError) throw invalid();
          throw error;
        });
        const { sub, exp, client_id: clientId, scope } = payload;
        if (
          typeof sub !== "string" ||
          !sub ||
          typeof exp !== "number" ||
          typeof clientId !== "string" ||
          !clientId
        )
          throw invalid();
        return {
          token,
          clientId,
          scopes:
            typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
          expiresAt: exp,
          resource,
          extra: { subject: sub },
        };
      },
    },
  });

  return {
    resource,
    issuer,
    resourceMetadataUrl,
    authenticate,
    integrationTokenFor(auth: AuthInfo | undefined): string | undefined {
      const subject = auth?.extra?.subject;
      return typeof subject === "string" ? bindings.get(subject) : undefined;
    },
  };
};
