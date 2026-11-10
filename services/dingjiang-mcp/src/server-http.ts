import { createServer } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  specTypeSchemas,
} from "@modelcontextprotocol/server";

import { DingjiangIntegrationClient } from "./client";
import { createMcpOAuth, mcpReadScope, mcpWriteScope } from "./oauth";
import {
  createMcpToolAccess,
  legacyProtocolVersion,
  mcpServerInfo,
  modernProtocolVersion,
  modernResultOverheadBytes,
} from "./protocol";
import { createSessionProfile } from "./session-profile";
import { callTool } from "./tools/dispatch";

const maxRequestBodySize = 1024 * 1024;

const start = () => {
  const oauth = createMcpOAuth();
  const startupProfile = createSessionProfile();
  const port = Number(process.env.DINGJIANG_MCP_HTTP_PORT ?? "3002");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      "DINGJIANG_MCP_HTTP_PORT must be an integer from 1 to 65535",
    );

  const metadataPath = new URL(oauth.resourceMetadataUrl).pathname;
  const metadata = {
    resource: oauth.resource.href,
    authorization_servers: [oauth.issuer],
    scopes_supported: startupProfile.readOnly
      ? [mcpReadScope]
      : [mcpReadScope, mcpWriteScope],
    bearer_methods_supported: ["header"],
  };

  const prepareToolAccess = (readOnly: boolean) => {
    const access = createMcpToolAccess({ ...startupProfile, readOnly });
    return {
      ...access,
      tools: access.tools.map((tool) => {
        const parsed = specTypeSchemas.Tool["~standard"].validate(tool);
        if (parsed.issues)
          throw new Error(`Invalid MCP tool descriptor: ${tool.name}`);
        return parsed.value;
      }),
    };
  };
  const configured = prepareToolAccess(startupProfile.readOnly);
  const readOnly = startupProfile.readOnly
    ? configured
    : prepareToolAccess(true);

  const mcp = createMcpHandler(
    ({ authInfo, era }) => {
      const integrationToken = oauth.integrationTokenFor(authInfo);
      if (!integrationToken || !authInfo)
        throw new Error("Missing verified MCP identity");

      const { tools, instructions, canCall } = authInfo.scopes.includes(
        mcpWriteScope,
      )
        ? configured
        : readOnly;
      const server = new Server(mcpServerInfo, {
        capabilities: { tools: {} },
        instructions,
        supportedProtocolVersions: [
          modernProtocolVersion,
          legacyProtocolVersion,
        ],
      });
      server.setRequestHandler("tools/list", () => ({ tools }));
      server.setRequestHandler("tools/call", async ({ params }, context) => {
        const { name, arguments: args } = params;
        const result = canCall(name)
          ? await callTool(
              new DingjiangIntegrationClient(
                context.mcpReq.signal,
                integrationToken,
              ),
              name,
              args,
              era === "modern" ? modernResultOverheadBytes : 0,
            )
          : undefined;
        if (!result)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid params",
            {
              code: "UNKNOWN_TOOL",
              tool: name,
            },
          );
        return result;
      });
      return server;
    },
    { maxRequestBodySize },
  );

  const handle = toNodeHandler(
    {
      async fetch(request, options) {
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== oauth.resource.origin)
          return new Response("Forbidden", { status: 403 });

        const url = new URL(request.url);
        if (url.pathname === metadataPath)
          return request.method === "GET"
            ? Response.json(metadata)
            : new Response(null, { status: 405, headers: { Allow: "GET" } });
        if (url.pathname !== oauth.resource.pathname)
          return new Response("Not found", { status: 404 });
        if (url.search)
          return new Response("Invalid endpoint", { status: 400 });

        const auth = await oauth.authenticate(request);
        const response =
          auth instanceof Response
            ? auth
            : !oauth.integrationTokenFor(auth)
              ? Response.json({ error: "access_denied" }, { status: 403 })
              : await mcp.fetch(request, { ...options, authInfo: auth });
        response.headers.set("Cache-Control", "no-store");
        return response;
      },
    },
    { maxRequestBodySize },
  );

  const server = createServer((request, response) => {
    if (
      request.headers.host?.toLowerCase() !== oauth.resource.host.toLowerCase()
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    void handle(request, response);
  });
  server.on("close", () => void mcp.close());
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`dingjiang-mcp HTTP listening on 127.0.0.1:${port}\n`);
  });
};

start();
