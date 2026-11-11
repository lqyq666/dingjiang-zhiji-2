import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createMcpHandler,
  dingjiangCompatibilityTools,
  dingjiangTools,
  legacyProtocolVersion,
  outputContractToolCount,
  registeredToolNames,
  serverVersion,
  type IntegrationClient,
  type ToolDescriptor,
} from "./protocol";

const allTools: ToolDescriptor[] = [
  ...new Map(
    [...dingjiangTools, ...dingjiangCompatibilityTools].map((tool) => [
      tool.name,
      tool,
    ]),
  ).values(),
];

const declaredToolNames = allTools.map((tool) => tool.name).sort();

// The stub exercises dispatch without an HTTP dependency.
const stubClient = (): IntegrationClient =>
  new Proxy(
    {},
    {
      get: () => async () => ({}),
    },
  ) as unknown as IntegrationClient;

const invoke = (tool: string) =>
  createMcpHandler(stubClient())({
    jsonrpc: "2.0",
    id: `drift-${tool}`,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  });

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

describe("agent eval task set", () => {
  const { tasks } = JSON.parse(
    readFileSync(join(process.cwd(), "evals/agent/tasks.json"), "utf8"),
  ) as {
    tasks: Array<{
      id: string;
      identity: string;
      prompt: string;
      expect: { tools: string[]; success: string };
    }>;
  };

  it("keeps 30 unique tasks that only reference declared tools", () => {
    expect(tasks).toHaveLength(30);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(30);
    for (const task of tasks) {
      expect(task.prompt.trim().length, `${task.id} 缺 prompt`).toBeGreaterThan(
        0,
      );
      expect(
        task.expect.success.trim().length,
        `${task.id} 缺判定标准`,
      ).toBeGreaterThan(0);
      // A renamed or removed tool must fail here, not in a manual run.
      for (const tool of task.expect.tools)
        expect(
          declaredToolNames.includes(tool),
          `${task.id} 引用了未声明的工具 ${tool}`,
        ).toBe(true);
    }
  });
});

describe("MCP tool contract drift guard", () => {
  it("keeps the handler registry and the declared surface identical", () => {
    expect([...registeredToolNames].sort()).toEqual(declaredToolNames);
  });

  it("keeps every declared tool reachable through the dispatcher", async () => {
    for (const tool of declaredToolNames)
      expect(await invoke(tool), tool).toHaveProperty("result");
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

describe("MCP tool input contracts", () => {
  it("publishes the progress command inputs without requiring its defaulted output reference", () => {
    const tool = allTools.find(({ name }) => name === "work.execute");

    expect(tool?.inputSchema).toMatchObject({
      properties: {
        requestId: { format: "uuid" },
        correlationId: { format: "uuid" },
        payload: {
          properties: {
            operation: {
              oneOf: expect.arrayContaining([
                expect.objectContaining({
                  properties: expect.objectContaining({
                    action: { type: "string", const: "progress.record" },
                    note: expect.objectContaining({ type: "string" }),
                  }),
                  required: ["action", "workItemId", "note"],
                  additionalProperties: false,
                }),
              ]),
            },
          },
        },
      },
    });
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
    expect(withoutContract).toEqual([]);
    expect(outputContractToolCount).toBe(28);
  });

  it("declares object schemas that actually constrain named fields", () => {
    for (const tool of allTools) {
      if (!tool.outputSchema) continue;
      expect(tool.outputSchema.type).toBe("object");
      const variants = Array.isArray(tool.outputSchema.anyOf)
        ? (tool.outputSchema.anyOf as NonNullable<
            ToolDescriptor["outputSchema"]
          >[])
        : [tool.outputSchema];
      for (const variant of variants) {
        const properties = variant.properties;
        expect(typeof properties).toBe("object");
        expect(Object.keys(properties as object).length).toBeGreaterThan(0);
        expect(variant.additionalProperties).toBe(false);
      }
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

  it("answers with its only revision even for a hostile probe", async () => {
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
      ).toBe(legacyProtocolVersion);
    }
  });

  it("ships the governance contract in the initialize result", async () => {
    const handler = createMcpHandler(stubClient());
    const response = await handler({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: legacyProtocolVersion },
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

  it("snapshots the deployment surface at handler creation", async () => {
    const previous = process.env.DINGJIANG_MCP_TOOL_SURFACE;
    const listWith = async (surface: string | undefined) => {
      if (surface === undefined) delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
      else process.env.DINGJIANG_MCP_TOOL_SURFACE = surface;
      const handler = createMcpHandler(stubClient());
      await handler({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: legacyProtocolVersion },
      });
      const response = await handler({
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      return (response as { result: { tools: ToolDescriptor[] } }).result.tools;
    };
    try {
      expect(await listWith(undefined)).toHaveLength(13);
      expect(await listWith("compatibility")).toHaveLength(23);
    } finally {
      if (previous === undefined) delete process.env.DINGJIANG_MCP_TOOL_SURFACE;
      else process.env.DINGJIANG_MCP_TOOL_SURFACE = previous;
    }
  });
});
