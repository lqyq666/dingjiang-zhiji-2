import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

import { DingjiangIntegrationClient } from "./client";
import { createMcpHandler, type JsonRpcRequest } from "./protocol";

const identityFile = process.env.DINGJIANG_MCP_BUILD_IDENTITY_FILE?.trim();
const readIdentity = (): string => {
  if (!identityFile) return "development";
  try {
    return readFileSync(identityFile, "utf8").trim() || "unknown";
  } catch {
    return "missing";
  }
};
const startupBuildIdentity = readIdentity();
const handler = createMcpHandler(new DingjiangIntegrationClient(), {
  startup: startupBuildIdentity,
  current: readIdentity,
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

const respond = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      respond({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    const response = await handler(request);
    if (response) respond(response);
  })();
});
