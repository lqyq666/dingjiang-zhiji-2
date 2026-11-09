import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDir = join(process.cwd(), "src");

/**
 * A second transport (Streamable HTTP, for example) is only cheap if the
 * protocol handler stays a pure request -> response function. Process IO or a
 * stdio import inside protocol.ts would force a rewrite of the dispatcher.
 */
describe("transport boundary", () => {
  it("keeps process IO and stdio wiring out of the protocol handler", () => {
    const protocol = readFileSync(join(sourceDir, "protocol.ts"), "utf8");
    for (const forbidden of [
      "process.stdin",
      "process.stdout",
      "node:readline",
      'from "./stdio"',
    ])
      expect(protocol, `protocol.ts 不应出现 ${forbidden}`).not.toContain(
        forbidden,
      );
  });

  it("keeps the server entry point to wiring only", () => {
    const server = readFileSync(join(sourceDir, "server.ts"), "utf8");
    expect(server).toContain("createMcpHandler");
    expect(server).toContain("createStdioDispatcher");
    expect(server).not.toContain("callTool");
    expect(server).not.toContain("tools/list");
  });
});
