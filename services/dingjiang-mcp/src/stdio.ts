import type { JsonRpcRequest, JsonRpcResponse } from "./protocol";

export type StdioHandler = (
  request: JsonRpcRequest,
) => Promise<JsonRpcResponse | undefined>;

export type StdioResponder = (
  payload: JsonRpcResponse,
) => void | Promise<void>;

export type StdioDispatcher = ((line: string) => void) & {
  /** Resolves after every line accepted so far has been fully answered. */
  drain(): Promise<void>;
};

export const DEFAULT_MAX_LINE_BYTES = 1_048_576;
const ABSOLUTE_MAX_LINE_BYTES = 67_108_864;

export const resolveMaxLineBytes = (
  value: string | undefined = process.env.DINGJIANG_MCP_MAX_LINE_BYTES,
): number => {
  if (!value) return DEFAULT_MAX_LINE_BYTES;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_LINE_BYTES;
  return Math.min(parsed, ABSOLUTE_MAX_LINE_BYTES);
};

const errorResponse = (
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * JSON-RPC over stdio dispatcher.
 *
 * The previous inline implementation started one detached async task per line,
 * which let governed writes run concurrently, made response order depend on
 * network latency, and turned a rejected handler into an unhandled rejection
 * that left the caller waiting forever. This dispatcher instead:
 * - serialises every request, so governed writes never overlap and responses
 *   keep request order;
 * - converts a thrown handler into `-32603` and keeps serving later lines;
 * - rejects oversized lines before parsing, bounding memory per request;
 * - awaits the responder, so stdout backpressure cannot reorder writes.
 *
 * Diagnostic details go to `onError` (stderr), never into the protocol stream.
 */
export const createStdioDispatcher = (
  handler: StdioHandler,
  respond: StdioResponder,
  options: { maxLineBytes?: number; onError?: (error: unknown) => void } = {},
): StdioDispatcher => {
  const maxLineBytes = options.maxLineBytes ?? resolveMaxLineBytes();
  const onError = options.onError ?? (() => undefined);
  let queue: Promise<void> = Promise.resolve();

  const execute = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
      await respond(
        errorResponse(null, -32600, "Invalid Request", {
          code: "REQUEST_TOO_LARGE",
          maxLineBytes,
        }),
      );
      return;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      await respond(errorResponse(null, -32700, "Parse error"));
      return;
    }
    try {
      const response = await handler(request);
      if (response) await respond(response);
    } catch (error) {
      onError(error);
      await respond(
        errorResponse(request.id ?? null, -32603, "Internal error", {
          code: "HANDLER_FAILURE",
        }),
      );
    }
  };

  const dispatch = ((line: string): void => {
    // A failed line must not poison the queue for the rest of the session.
    queue = queue.then(
      () => execute(line),
      () => execute(line),
    );
  }) as StdioDispatcher;
  dispatch.drain = () => queue;
  return dispatch;
};
