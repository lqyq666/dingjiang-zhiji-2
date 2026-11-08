import { describe, expect, it } from "vitest";

import {
  createMcpHandler,
  dingjiangCompatibilityTools,
  dingjiangTools,
  dispatchedToolNames,
  type IntegrationClient,
} from "./protocol";

const declaredToolNames = [
  ...new Set(
    [...dingjiangTools, ...dingjiangCompatibilityTools].map(
      (tool) => tool.name,
    ),
  ),
].sort();

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
});
