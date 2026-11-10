import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

import { DingjiangIntegrationClient } from "./client";
import {
  createMcpHandler,
  isReadOnlyToolCall,
  type JsonRpcResponse,
} from "./protocol";
import { createStdioDispatcher } from "./stdio";

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
const handler = createMcpHandler(
  new DingjiangIntegrationClient(),
  { startup: startupBuildIdentity, current: readIdentity },
  (signal) => new DingjiangIntegrationClient(signal),
);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

const respond = async (payload: JsonRpcResponse): Promise<void> => {
  if (!process.stdout.write(`${JSON.stringify(payload)}\n`)) {
    await new Promise<void>((resolve) => {
      process.stdout.once("drain", resolve);
    });
  }
};

const dispatch = createStdioDispatcher(handler, respond, {
  isReadOnlyRequest: isReadOnlyToolCall,
  onError: (error) => {
    process.stderr.write(
      `dingjiang-mcp handler failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  },
});

input.on("line", dispatch);
