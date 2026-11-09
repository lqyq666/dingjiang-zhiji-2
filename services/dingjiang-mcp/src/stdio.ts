import type { JsonRpcRequest, JsonRpcResponse } from "./protocol";

export type StdioHandler = (
  request: JsonRpcRequest,
) => Promise<JsonRpcResponse | undefined>;

export type StdioResponder = (payload: JsonRpcResponse) => void | Promise<void>;

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

/**
 * How many lines may wait for the serial queue. The queue exists so governed
 * writes never overlap; it must not become unbounded memory when a handler is
 * slow. 64 is well above any real Agent's in-flight count.
 */
export const DEFAULT_MAX_PENDING_REQUESTS = 64;
const ABSOLUTE_MAX_PENDING_REQUESTS = 1_024;

export const resolveMaxPendingRequests = (
  value: string | undefined = process.env.DINGJIANG_MCP_MAX_PENDING_REQUESTS,
): number => {
  if (!value) return DEFAULT_MAX_PENDING_REQUESTS;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_MAX_PENDING_REQUESTS;
  return Math.min(parsed, ABSOLUTE_MAX_PENDING_REQUESTS);
};

/** Best effort: an overflowing line still deserves its own request id back. */
const idOfLine = (line: string): string | number | null => {
  try {
    const id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
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
  options: {
    maxLineBytes?: number;
    maxPendingRequests?: number;
    onError?: (error: unknown) => void;
  } = {},
): StdioDispatcher => {
  const maxLineBytes = options.maxLineBytes ?? resolveMaxLineBytes();
  const maxPendingRequests =
    options.maxPendingRequests ?? resolveMaxPendingRequests();
  const onError = options.onError ?? (() => undefined);
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

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
    if (pending >= maxPendingRequests) {
      // Refuse instead of queueing. An unbounded queue turns a slow handler into
      // unbounded memory, and the caller would wait the same amount of time for
      // a reply it can already predict.
      void respond(
        errorResponse(idOfLine(line), -32000, "Server busy", {
          code: "QUEUE_OVERFLOW",
          maxPendingRequests,
        }),
      );
      return;
    }
    pending += 1;
    const run = () =>
      execute(line).finally(() => {
        pending -= 1;
      });
    // A failed line must not poison the queue for the rest of the session.
    queue = queue.then(run, run);
  }) as StdioDispatcher;
  dispatch.drain = () => queue;
  return dispatch;
};
