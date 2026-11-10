import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export const oauthRead = "dingjiang:mcp:read";
export const oauthWrite = "dingjiang:mcp:write";
const supportedScopes = [oauthRead, oauthWrite];
const clientId = "dingjiang-local-e2e";
const callback = "http://127.0.0.1:9488/callback";
const kid = "local-test-key";

type Grant = {
  subject: string;
  resource: string;
  scope: string;
  challenge: string;
};
const s256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const json = (response: ServerResponse, status: number, body: object) =>
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(body));

/** Local test issuer with seeded identities, one-use authorization codes and PKCE. */
export const startOAuthTestIssuer = async (resources: readonly string[]) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map<string, Grant>();
  let jwksAvailable = true;

  const server = createServer(async (request, response) => {
    try {
      const { pathname, searchParams } = new URL(request.url ?? "/", issuer);
      if (
        pathname === "/.well-known/oauth-authorization-server" &&
        request.method === "GET"
      ) {
        json(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: supportedScopes,
        });
        return;
      }
      if (pathname === "/jwks" && request.method === "GET") {
        if (jwksAvailable) json(response, 200, { keys: [jwk] });
        else json(response, 503, { error: "temporarily_unavailable" });
        return;
      }
      if (pathname === "/authorize" && request.method === "GET") {
        const subject = searchParams.get("login_hint");
        const resource = searchParams.get("resource");
        const scope = searchParams.get("scope");
        const challenge = searchParams.get("code_challenge");
        const state = searchParams.get("state");
        if (
          searchParams.get("response_type") !== "code" ||
          searchParams.get("client_id") !== clientId ||
          searchParams.get("redirect_uri") !== callback ||
          searchParams.get("code_challenge_method") !== "S256" ||
          !challenge ||
          !state ||
          !scope ||
          !scope.split(" ").every((value) => supportedScopes.includes(value)) ||
          !resource ||
          !resources.includes(resource) ||
          !subject ||
          !["e2e-pmc", "e2e-api-readonly", "e2e-unbound"].includes(subject)
        ) {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        const code = randomUUID();
        codes.set(code, { subject, resource, scope, challenge });
        const redirect = new URL(callback);
        redirect.search = new URLSearchParams({
          code,
          state,
          iss: issuer,
        }).toString();
        response.writeHead(302, { location: redirect.href }).end();
        return;
      }
      if (pathname === "/token" && request.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > 8192) {
            json(response, 413, { error: "invalid_request" });
            return;
          }
          chunks.push(chunk);
        }
        const form = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        const verifier = form.get("code_verifier");
        if (
          !grant ||
          !verifier ||
          s256(verifier) !== grant.challenge ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== clientId ||
          form.get("redirect_uri") !== callback ||
          form.get("resource") !== grant.resource
        ) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        const iat = Math.floor(Date.now() / 1000);
        const claims = encode({
          iss: issuer,
          aud: grant.resource,
          sub: grant.subject,
          client_id: clientId,
          scope: grant.scope,
          jti: randomUUID(),
          iat,
          exp: iat + 300,
        });
        const input = `${encode({ alg: "RS256", typ: "at+jwt", kid })}.${claims}`;
        const signature = sign(
          "sha256",
          Buffer.from(input),
          privateKey,
        ).toString("base64url");
        json(response, 200, {
          access_token: `${input}.${signature}`,
          token_type: "Bearer",
          expires_in: 300,
          scope: grant.scope,
        });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch {
      json(response, 500, { error: "server_error" });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test issuer address");
  const issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    jwksUrl: `${issuer}/jwks`,
    setJwksAvailable(available: boolean) {
      jwksAvailable = available;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

export const obtainOAuthToken = async (
  issuer: string,
  resource: string,
  scopes: readonly string[],
  subject = "e2e-pmc",
): Promise<string> => {
  const metadataResponse = await fetch(
    `${issuer}/.well-known/oauth-authorization-server`,
  );
  if (!metadataResponse.ok) throw new Error("OAuth issuer discovery failed");
  const metadata = (await metadataResponse.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    code_challenge_methods_supported: string[];
  };
  if (
    metadata.issuer !== issuer ||
    !metadata.code_challenge_methods_supported.includes("S256")
  )
    throw new Error("Unexpected OAuth issuer metadata");

  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    resource,
    scope: scopes.join(" "),
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
    login_hint: subject,
    state,
  }).toString();
  const authorized = await fetch(authorize, { redirect: "manual" });
  const location = authorized.headers.get("location");
  if (authorized.status !== 302 || !location)
    throw new Error("OAuth authorization failed");
  const returned = new URL(location);
  const code = returned.searchParams.get("code");
  if (
    `${returned.origin}${returned.pathname}` !== callback ||
    returned.searchParams.get("state") !== state ||
    returned.searchParams.get("iss") !== issuer ||
    !code
  )
    throw new Error("Invalid OAuth callback");

  const exchanged = await fetch(metadata.token_endpoint, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: callback,
      resource,
      code,
      code_verifier: verifier,
    }),
  });
  const payload = (await exchanged.json()) as {
    access_token?: string;
    token_type?: string;
  };
  if (!exchanged.ok || payload.token_type !== "Bearer" || !payload.access_token)
    throw new Error("OAuth code exchange failed");
  return payload.access_token;
};
