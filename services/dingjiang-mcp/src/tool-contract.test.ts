import { describe, expect, it } from "vitest";

import {
  createMcpHandler,
  dingjiangCompatibilityTools,
  dingjiangTools,
  dispatchedToolNames,
  latestProtocolVersion,
  outputContractToolCount,
  serverVersion,
  supportedProtocolVersions,
  type IntegrationClient,
  type ToolDescriptor,
} from "./protocol";

const declaredToolNames = [
  ...new Set(
    [...dingjiangTools, ...dingjiangCompatibilityTools].map(
      (tool) => tool.name,
    ),
  ),
].sort();

const allTools: ToolDescriptor[] = [
  ...new Map(
    [...dingjiangTools, ...dingjiangCompatibilityTools].map((tool) => [
      tool.name,
      tool,
    ]),
  ).values(),
];

// Any method is a valid read stub: the assertion only cares whether dispatch
// reached an implementation or fell through to UNKNOWN_TOOL.
const stubClient = (): IntegrationClient =>
  new Proxy(
    {},
    {
      get: () => async () => ({}),
    },
  ) as unknown as IntegrationClient;

const invoke = async (tool: string) => {
  const client = stubClient();
  const response = await createMcpHandler(client)({
    jsonrpc: "2.0",
    id: `drift-${tool}`,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  });
  const text =
    (response as { result?: { content?: Array<{ text?: string }> } }).result
      ?.content?.[0]?.text ?? "";
  return text;
};

/**
 * A governed write is identifiable from its input contract alone: the governed
 * command envelope always requires an idempotency key (`requestId`) and an
 * optimistic-concurrency token (`expectedVersion`). Deriving the write set from
 * the schema — instead of restating the tool names here — means an annotation
 * cannot be corrected into agreement with a copy of itself.
 */
const declaresGovernedWriteEnvelope = (tool: ToolDescriptor): boolean => {
  const required = tool.inputSchema.required;
  return (
    Array.isArray(required) &&
    required.includes("requestId") &&
    required.includes("expectedVersion")
  );
};

describe("MCP tool contract drift guard", () => {
  it("declares and implements exactly the same tool names", () => {
    expect([...dispatchedToolNames].sort()).toEqual(declaredToolNames);
  });

  it("keeps every declared tool reachable through the dispatcher", async () => {
    const unknown: string[] = [];
    for (const tool of declaredToolNames) {
      const text = await invoke(tool);
      if (text.includes("UNKNOWN_TOOL")) unknown.push(tool);
    }
    expect(unknown).toEqual([]);
  });

  it("keeps both tool surfaces fully implemented", async () => {
    expect(dingjiangTools.length).toBe(13);
    expect(dingjiangCompatibilityTools.length).toBe(23);
    for (const tool of [...dingjiangTools, ...dingjiangCompatibilityTools])
      expect(dispatchedToolNames.has(tool.name)).toBe(true);
  });

  it("resolves shared tools from one registry entry, not from copies", () => {
    for (const name of [
      "work.execute",
      "workpaper.propose",
      "material.create",
      "evidence.propose",
    ]) {
      const business = dingjiangTools.find((tool) => tool.name === name);
      const compatibility = dingjiangCompatibilityTools.find(
        (tool) => tool.name === name,
      );
      expect(business).toBeDefined();
      expect(compatibility).toBe(business);
    }
    expect(allTools).toHaveLength(28);
  });
});

describe("MCP tool governance annotations", () => {
  it("annotates every declared tool with a usable title", () => {
    for (const tool of allTools) {
      expect(tool.annotations.title.trim().length).toBeGreaterThan(0);
      // A title that repeats the identifier tells the host UI nothing.
      expect(tool.annotations.title).not.toBe(tool.name);
    }
    expect(allTools).toHaveLength(28);
  });

  it("never labels a governed write as read-only", () => {
    const mislabelled = allTools
      .filter(
        (tool) =>
          declaresGovernedWriteEnvelope(tool) === tool.annotations.readOnlyHint,
      )
      .map((tool) => tool.name);
    expect(mislabelled).toEqual([]);
  });

  it("labels exactly the governed write envelope as destructive", () => {
    const writes = allTools
      .filter((tool) => !tool.annotations.readOnlyHint)
      .map((tool) => tool.name)
      .sort();
    expect(writes).toEqual([
      "evidence.confirm",
      "evidence.propose",
      "material.create",
      "material.verify",
      "work.execute",
      "workpaper.propose",
    ]);
    for (const tool of allTools)
      expect(tool.annotations.destructiveHint).toBe(
        !tool.annotations.readOnlyHint,
      );
  });

  it("keeps every tool closed-world and replay-safe", () => {
    for (const tool of allTools) {
      // Every tool reaches the first-party Integration API under the caller's
      // token. Claiming an open world would let a host treat governed facts as
      // untrusted web content.
      expect(tool.annotations.openWorldHint).toBe(false);
      // Reads are trivially idempotent; writes are idempotent because
      // requestId is the idempotency key in the governed command contract.
      expect(tool.annotations.idempotentHint).toBe(true);
    }
  });
});

describe("MCP tool output contracts", () => {
  it("declares an output contract for every tool with a single integration payload", () => {
    const withoutContract = allTools
      .filter((tool) => !tool.outputSchema)
      .map((tool) => tool.name)
      .sort();
    // The aggregates assemble several payloads into one object. They are
    // listed here on purpose: adding a tool without an output contract must be
    // a deliberate act, not an omission.
    expect(withoutContract).toEqual([
      "evidence.bundle",
      "work.context",
      "workspace.resume",
    ]);
    expect(outputContractToolCount).toBe(25);
  });

  it("declares object schemas that actually constrain named fields", () => {
    for (const tool of allTools) {
      if (!tool.outputSchema) continue;
      expect(tool.outputSchema.type).toBe("object");
      const properties = tool.outputSchema.properties;
      expect(typeof properties).toBe("object");
      expect(Object.keys(properties as object).length).toBeGreaterThan(0);
      // A contract that admits anything validates nothing.
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("MCP protocol surface", () => {
  it("keeps the tool order stable across listings", async () => {
    const handler = createMcpHandler(stubClient());
    const list = async () => {
      const response = await handler({
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      return (response as { result: { tools: ToolDescriptor[] } }).result.tools;
    };
    const first = await list();
    const second = await list();
    // Deterministic order lets a client reuse the tool block across turns
    // instead of re-reading a reshuffled list every request.
    expect(second.map((tool) => tool.name)).toEqual(
      first.map((tool) => tool.name),
    );
    expect(first.map((tool) => tool.name)).toEqual(
      dingjiangTools.map((tool) => tool.name),
    );
  });

  it("negotiates the revision the caller asked for and gates fields by it", async () => {
    expect(supportedProtocolVersions).toContain(latestProtocolVersion);
    const legacy = supportedProtocolVersions.find(
      (revision) => revision !== latestProtocolVersion,
    );
    expect(legacy).toBeDefined();

    const handler = createMcpHandler(stubClient());
    const initialize = await handler({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: legacy },
    });
    const negotiated = (initialize as { result: { protocolVersion: string } })
      .result.protocolVersion;
    expect(negotiated).toBe(legacy);

    const listed = await handler({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
    });
    const tools = (listed as { result: { tools: ToolDescriptor[] } }).result
      .tools;
    // A revision without `outputSchema` must not receive one: the client would
    // validate against a contract its own revision cannot express.
    expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
    expect(
      tools.every((tool) => tool.annotations?.readOnlyHint !== undefined),
    ).toBe(true);
  });

  it("answers with the newest revision for an unknown or hostile request", async () => {
    for (const protocolVersion of [
      "1999-01-01",
      "toString",
      "__proto__",
      20250618,
      null,
    ]) {
      const handler = createMcpHandler(stubClient());
      const response = await handler({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion },
      });
      expect(
        (response as { result: { protocolVersion: string } }).result
          .protocolVersion,
      ).toBe(latestProtocolVersion);
    }
  });

  it("ships the governance contract in the initialize result", async () => {
    const handler = createMcpHandler(stubClient());
    const response = await handler({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: latestProtocolVersion },
    });
    const result = (
      response as {
        result: { instructions?: string; serverInfo: { version: string } };
      }
    ).result;
    expect(result.serverInfo.version).toBe(serverVersion);
    // Clients put `instructions` in the model context, so the invariant has to
    // be stated there rather than assumed from each host's prompt.
    expect(result.instructions).toContain("PROPOSAL");
    expect(result.instructions).toContain("requestId");
    expect(result.instructions).toContain("OWNER");
  });

  it("serves two hosts with different surfaces from one process", async () => {
    const previous = process.env.DINGJIANG_MCP_TOOL_SURFACE;
    process.env.DINGJIANG_MCP_TOOL_SURFACE = "compatibility";
    try {
      const listFor = async (clientInfo: unknown) => {
        const handler = createMcpHandler(stubClient());
        await handler({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: { protocolVersion: latestProtocolVersion, clientInfo },
        });
        const response = await handler({
          jsonrpc: "2.0",
          id: "list",
          method: "tools/list",
        });
        return (response as { result: { tools: ToolDescriptor[] } }).result
          .tools;
      };

      const business = await listFor({
        name: "WorkBuddy",
        version: "5.3.14",
      });
      const compatibility = await listFor({
        name: "UnrelatedHost",
        version: "1.0",
      });
      // The old implementation read a process-wide env var, so one process
      // could only ever serve one of these two surfaces.
      expect(business).toHaveLength(13);
      expect(compatibility).toHaveLength(23);
    } finally {
      if (previous === undefined) delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
      else process.env.DINGJIANG_MCP_TOOL_SURFACE = previous;
    }
  });
});
