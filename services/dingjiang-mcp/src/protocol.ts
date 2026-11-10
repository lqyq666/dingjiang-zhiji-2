import { createSessionProfile, type SessionProfile } from "./session-profile";
import {
  dingjiangCompatibilityTools,
  dingjiangTools,
  isReadOnlyTool,
} from "./tools/catalog";
import { callTool, type IntegrationClient } from "./tools/dispatch";

export {
  dingjiangCompatibilityTools,
  dingjiangTools,
  type ToolAnnotations,
  type ToolDescriptor,
} from "./tools/catalog";
export { registeredToolNames, type IntegrationClient } from "./tools/dispatch";
export { outputContractToolCount } from "./tools/schemas";

/**
 * Reported in `serverInfo`. Defined once and used by the handler, so the
 * announced identity cannot lag the constant; `package.json` carries the
 * release number for packaging, and the two are bumped together.
 */
export const serverVersion = "0.7.0";
export const legacyProtocolVersion = "2025-06-18";
export const modernProtocolVersion = "2026-07-28";

const protocolVersionKey = "io.modelcontextprotocol/protocolVersion";
const clientCapabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const clientInfoKey = "io.modelcontextprotocol/clientInfo";
export const mcpServerInfo = { name: "dingjiang-mcp", version: serverVersion };
const modernResultFields = {
  resultType: "complete",
  _meta: { "io.modelcontextprotocol/serverInfo": mcpServerInfo },
};
// Merging adds the fields and a comma, omitting their two braces.
export const modernResultOverheadBytes =
  Buffer.byteLength(JSON.stringify(modernResultFields), "utf8") - 1;
const privateWithoutCaching = { ttlMs: 0, cacheScope: "private" };

const factsInstruction =
  "鼎江智绩治理型 MCP。PostgreSQL 是唯一业务事实源；工具返回的是服务端已授权的事实快照。";
const proposalInstruction =
  "AI 归纳出的任何结论一律是 PROPOSAL，不得表述为 FACT、根因或已确认结论。";

const readOnlyInstructions = [
  factsInstruction,
  "当前 MCP 工具面仅提供只读查询。回答时请引用工具返回的来源定位。",
  proposalInstruction,
].join("\n");

/** Governance instructions provided in discovery or the legacy handshake. */
export const serverInstructions = [
  factsInstruction,
  "",
  "必须遵守：",
  `1. ${proposalInstruction}`,
  "2. 调用 work.execute / material.verify / evidence.confirm / workpaper.propose / material.create / evidence.propose 前，先读 work.operations 取得最新 expectedVersion 与 allowedActions，向用户展示具体影响并取得本次确认；confirmation 保存用户原话，不得代写。",
  "3. 超时或网络错误不得更换 requestId 重试，必须复用原 requestId 核对服务端状态。",
  "4. 方案定稿仅 OWNER，经验发布仅 EXPERT_REVIEWER；工具不因调用方声明而放宽角色。",
].join("\n");

export const createMcpToolAccess = (profile: SessionProfile) => {
  const surface =
    profile.toolSurface === "compatibility"
      ? dingjiangCompatibilityTools
      : dingjiangTools;
  return {
    tools: profile.readOnly
      ? surface.filter((tool) => isReadOnlyTool(tool.name))
      : surface,
    instructions: profile.readOnly ? readOnlyInstructions : serverInstructions,
    canCall: (name: string) => !profile.readOnly || isReadOnlyTool(name),
  };
};

type JsonRpcId = string | number | null;
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: { code: number; message: string; data?: unknown };
    };

/**
 * A JSON-RPC level failure, distinct from a tool result.
 *
 * The specification separates "your request was malformed" (-32600), "the
 * method or its parameters are wrong" (-32601 / -32602) and "the handler
 * broke" (-32603) from "the tool ran and reported a business failure", which
 * belongs in the result with `isError: true`. Collapsing the two makes a client
 * retry a request that can never succeed.
 */
const protocolError = (
  id: string | number | null,
  code: number,
  message: string,
  dataCode: string,
  extra: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, data: { code: dataCode, ...extra } },
});

const methodNotFound = (id: JsonRpcId): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32601, message: "Method not found" },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type ToolCallParams = { name?: unknown };

export const isReadOnlyToolCall = (request: JsonRpcRequest): boolean => {
  if (request.jsonrpc !== "2.0" || request.method !== "tools/call")
    return false;
  const name = (request.params as ToolCallParams | undefined)?.name;
  return typeof name === "string" && isReadOnlyTool(name);
};

export type McpBuildIdentity = {
  startup: string;
  current(): string;
};

/** The stdio session uses the same startup policy for discovery and dispatch. */
export const createMcpHandler = (
  client: IntegrationClient,
  identity: McpBuildIdentity = {
    startup: "development",
    current: () => "development",
  },
  clientForRead: (signal: AbortSignal) => IntegrationClient = () => client,
) => {
  const { tools, instructions, canCall } = createMcpToolAccess(
    createSessionProfile(),
  );
  let era: "legacy" | "modern" | undefined;

  return async (
    request: JsonRpcRequest,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | undefined> => {
    // Validate the JSON-RPC envelope before the dispatcher sees it. A payload
    // that is not an object, carries a non-scalar id, omits the version, or
    // has a non-string method is a protocol error, not a tool failure.
    if (!isRecord(request))
      return protocolError(null, -32600, "Invalid Request", "INVALID_ENVELOPE");

    const rawId = (request as { id?: unknown }).id;
    if (rawId === undefined) return undefined; // notification: no response
    if (
      rawId !== null &&
      typeof rawId !== "string" &&
      typeof rawId !== "number"
    )
      return protocolError(null, -32600, "Invalid Request", "INVALID_ID");
    const id = rawId as string | number | null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
      return protocolError(id, -32600, "Invalid Request", "INVALID_ENVELOPE");
    const params = request.params;
    if (params !== undefined && !isRecord(params))
      return protocolError(id, -32602, "Invalid params", "INVALID_PARAMS");

    const discover = request.method === "server/discover";
    const rawMeta = params?._meta;
    const meta = isRecord(rawMeta) ? rawMeta : {};
    const modern =
      era === "modern" ||
      discover ||
      Object.hasOwn(meta, protocolVersionKey) ||
      Object.hasOwn(meta, clientCapabilitiesKey) ||
      Object.hasOwn(meta, clientInfoKey);

    if (modern) {
      if (era === "legacy") return methodNotFound(id);
      if (typeof id !== "string" && !Number.isInteger(id))
        return protocolError(null, -32600, "Invalid Request", "INVALID_ID");
      const requested = meta[protocolVersionKey];
      if (
        typeof requested !== "string" ||
        !isRecord(meta[clientCapabilitiesKey])
      )
        return protocolError(
          id,
          -32602,
          "Invalid _meta envelope",
          "INVALID_PROTOCOL_META",
        );
      if (requested !== modernProtocolVersion)
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported: [modernProtocolVersion], requested },
          },
        };
    }

    const reply = (result: Record<string, unknown>): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result: modern ? { ...result, ...modernResultFields } : result,
    });

    try {
      const deployedBuildIdentity = identity.current();
      if (deployedBuildIdentity !== identity.startup)
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "WorkBuddy MCP process is stale; start a new session",
            data: {
              code: "SESSION_MCP_PROCESS_STALE",
              startupBuildIdentity: identity.startup,
              deployedBuildIdentity,
              requiresNewSession: true,
            },
          },
        };
      if (discover)
        return reply({
          supportedVersions: [modernProtocolVersion],
          capabilities: { tools: {} },
          instructions,
          ...privateWithoutCaching,
        });

      // Discovery alone is a probe. The first other request chooses the era,
      // but modern requests still have to carry a valid envelope each time.
      era ??= modern ? "modern" : "legacy";
      if (!modern && request.method === "initialize")
        return reply({
          protocolVersion: legacyProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...mcpServerInfo, buildIdentity: identity.startup },
          instructions,
        });
      if (!modern && request.method === "ping") return reply({});
      if (request.method === "tools/list") {
        if (modern && params?.cursor !== undefined)
          return protocolError(id, -32602, "Invalid cursor", "INVALID_CURSOR");
        return reply(modern ? { tools, ...privateWithoutCaching } : { tools });
      }
      if (request.method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments;
        if (modern && args !== undefined && !isRecord(args))
          return protocolError(id, -32602, "Invalid params", "INVALID_PARAMS");
        const result =
          typeof toolName === "string" && canCall(toolName)
            ? await callTool(
                signal ? clientForRead(signal) : client,
                toolName,
                args,
                modern ? modernResultOverheadBytes : 0,
              )
            : undefined;
        if (result === undefined)
          return protocolError(id, -32602, "Invalid params", "UNKNOWN_TOOL", {
            tool: typeof toolName === "string" ? toolName : null,
          });
        return reply(result);
      }
      return methodNotFound(id);
    } catch {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error" },
      };
    }
  };
};
