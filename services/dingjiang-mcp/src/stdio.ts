import type { JsonRpcRequest, JsonRpcResponse } from "./protocol";

export type StdioHandler = (
  request: JsonRpcRequest,
  signal?: AbortSignal,
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

/** Maximum accepted requests, including in-flight calls and buffered replies. */
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

const MAX_CONCURRENT_READS = 4;
type ParsedLine = { request: JsonRpcRequest } | { error: JsonRpcResponse };

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

const parseLine = (line: string, maxLineBytes: number): ParsedLine => {
  if (Buffer.byteLength(line, "utf8") > maxLineBytes)
    return {
      error: errorResponse(null, -32600, "Invalid Request", {
        code: "REQUEST_TOO_LARGE",
        maxLineBytes,
      }),
    };

  try {
    return { request: JSON.parse(line) as JsonRpcRequest };
  } catch {
    return { error: errorResponse(null, -32700, "Parse error") };
  }
};

type RequestId = string | number;

const requestId = (id: unknown): RequestId | null =>
  typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? id
    : null;

const cancelledRequestId = (params: unknown): RequestId | null => {
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return null;
  const { requestId: id, reason } = params as {
    requestId?: unknown;
    reason?: unknown;
  };
  return reason === undefined || typeof reason === "string"
    ? requestId(id)
    : null;
};

/** Runs read calls concurrently between serial requests and flushes replies in input order. */
export const createStdioDispatcher = (
  handler: StdioHandler,
  respond: StdioResponder,
  options: {
    maxLineBytes?: number;
    maxPendingRequests?: number;
    isReadOnlyRequest?: (request: JsonRpcRequest) => boolean;
    onError?: (error: unknown) => void;
  } = {},
): StdioDispatcher => {
  const maxLineBytes = options.maxLineBytes ?? resolveMaxLineBytes();
  const maxPendingRequests =
    options.maxPendingRequests ?? resolveMaxPendingRequests();
  const onError = options.onError ?? (() => undefined);
  let replies: Promise<void> = Promise.resolve();
  // Each read group starts after the preceding serial request and its reply.
  let serialBarrier = replies;
  let pending = 0;
  let activeReads = 0;
  const waitingReaders: Array<() => void> = [];
  const cancellableReads = new Map<RequestId, AbortController>();

  const send = async (response: JsonRpcResponse): Promise<void> => {
    try {
      await respond(response);
    } catch (error) {
      onError(error);
    }
  };

  const execute = async (
    request: JsonRpcRequest,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | undefined> => {
    if (signal?.aborted) return;
    try {
      return await handler(request, signal);
    } catch (error) {
      if (signal?.aborted) return;
      onError(error);
      return errorResponse(requestId(request?.id), -32603, "Internal error", {
        code: "HANDLER_FAILURE",
      });
    }
  };

  const executeRead = async (request: JsonRpcRequest, signal: AbortSignal) => {
    if (signal.aborted) return;
    if (activeReads >= MAX_CONCURRENT_READS)
      await new Promise<void>((resolve) => waitingReaders.push(resolve));
    else activeReads++;

    try {
      return await execute(request, signal);
    } finally {
      // Transfer the slot directly to the oldest waiting read.
      const next = waitingReaders.shift();
      if (next) next();
      else activeReads--;
    }
  };

  const enqueueReply = (
    run: () => Promise<JsonRpcResponse | undefined> | JsonRpcResponse,
    read?: { id: RequestId; signal: AbortSignal },
  ) => {
    pending++;
    const flush = async () => {
      try {
        const response = await run();
        if (response && !read?.signal.aborted) await send(response);
      } finally {
        if (read) cancellableReads.delete(read.id);
        pending--;
      }
    };
    replies = replies.then(flush, flush);
  };

  const dispatch = ((line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseLine(trimmed, maxLineBytes);
    const request = "request" in parsed ? parsed.request : undefined;
    if (
      request?.jsonrpc === "2.0" &&
      request.id === undefined &&
      typeof request.method === "string"
    ) {
      // Notifications use no queue slot and never emit a reply.
      if (request.method === "notifications/cancelled") {
        const id = cancelledRequestId(request.params);
        if (id !== null) cancellableReads.get(id)?.abort();
      }
      return;
    }

    const id = requestId(request?.id);
    if (pending >= maxPendingRequests) {
      void send(
        errorResponse(id, -32000, "Server busy", {
          code: "QUEUE_OVERFLOW",
          maxPendingRequests,
        }),
      );
      return;
    }

    if (
      request &&
      id !== null &&
      !cancellableReads.has(id) &&
      options.isReadOnlyRequest?.(request)
    ) {
      const controller = new AbortController();
      cancellableReads.set(id, controller);
      const { signal } = controller;
      const run = () => executeRead(request, signal);
      const result = serialBarrier.then(run, run);
      enqueueReply(() => result, { id, signal });
    } else {
      enqueueReply(() =>
        "error" in parsed ? parsed.error : execute(parsed.request),
      );
      serialBarrier = replies;
    }
  }) as StdioDispatcher;
  dispatch.drain = () => replies;
  return dispatch;
};
