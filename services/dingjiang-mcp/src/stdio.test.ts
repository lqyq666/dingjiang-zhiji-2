import { describe, expect, it, vi } from "vitest";

import {
  isReadOnlyToolCall,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol";
import {
  createStdioDispatcher,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_PENDING_REQUESTS,
  resolveMaxLineBytes,
  resolveMaxPendingRequests,
  type StdioHandler,
} from "./stdio";

const line = (id: number | string, method = "ping"): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method });

const success = (id: JsonRpcResponse["id"]): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: {},
});

const toolLine = (id: number | string, name: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name },
  });

const cancel = (requestId: string | number): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, reason: "The caller no longer needs the result" },
  });

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = (
  handler: StdioHandler,
  options: Parameters<typeof createStdioDispatcher>[2] = {},
) => {
  const responses: JsonRpcResponse[] = [];
  const dispatch = createStdioDispatcher(
    handler,
    (payload) => {
      responses.push(payload);
    },
    options,
  );
  return { dispatch, responses };
};

describe("dingjiang-mcp stdio dispatcher", () => {
  it("refuses a line with QUEUE_OVERFLOW instead of growing the queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { dispatch, responses } = setup(
      async (request) => {
        await gate;
        return success(request.id ?? null);
      },
      { maxPendingRequests: 1 },
    );

    dispatch(line(1));
    dispatch(line(2));
    // The overflow is answered immediately and still carries its own id.
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message: "Server busy",
        data: { code: "QUEUE_OVERFLOW", maxPendingRequests: 1 },
      },
    });

    release();
    await dispatch.drain();
    expect(responses[responses.length - 1]?.id).toBe(1);
  });

  it("frees a queue slot once the in-flight request finishes", async () => {
    const { dispatch, responses } = setup(async (request) =>
      success(request.id ?? null),
    );
    dispatch(line(1));
    await dispatch.drain();
    dispatch(line(2));
    await dispatch.drain();
    expect(responses.map((response) => response.id)).toEqual([1, 2]);
  });

  it("keeps a bounded default instead of an unbounded queue", () => {
    expect(DEFAULT_MAX_PENDING_REQUESTS).toBe(64);
    expect(resolveMaxPendingRequests(undefined)).toBe(64);
    expect(resolveMaxPendingRequests("0")).toBe(64);
    expect(resolveMaxPendingRequests("abc")).toBe(64);
    expect(resolveMaxPendingRequests("100000")).toBe(1_024);
  });

  it("keeps response order even when later requests finish first", async () => {
    const delays = new Map<number, number>([
      [1, 30],
      [2, 0],
      [3, 10],
    ]);
    const { dispatch, responses } = setup(async (request) => {
      const id = Number(request.id);
      await new Promise((resolve) => setTimeout(resolve, delays.get(id) ?? 0));
      return success(request.id ?? null);
    });

    dispatch(line(1));
    dispatch(line(2));
    dispatch(line(3));
    await dispatch.drain();

    expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
  });

  it("fills freed read slots without releasing responses out of order", async () => {
    const reads = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    const { dispatch, responses } = setup(
      async (request) => {
        const id = Number(request.id);
        started.push(id);
        await reads[id - 1]!.promise;
        return success(id);
      },
      { maxPendingRequests: 5, isReadOnlyRequest: isReadOnlyToolCall },
    );

    for (let id = 1; id <= reads.length; id++) {
      dispatch(toolLine(id, "workspace.events"));
    }
    await nextTurn();
    const atCapacity = [...started];
    reads[1]!.release();
    await nextTurn();
    const afterOneFinished = [...started];
    const repliesWhileFirstPending = responses.length;
    dispatch(toolLine(6, "workspace.events"));

    for (const read of reads) read.release();
    await dispatch.drain();
    expect(atCapacity).toEqual([1, 2, 3, 4]);
    expect(afterOneFinished).toEqual([1, 2, 3, 4, 5]);
    expect(repliesWhileFirstPending).toBe(0);
    expect(responses[0]).toMatchObject({
      id: 6,
      error: { data: { code: "QUEUE_OVERFLOW" } },
    });
    expect(responses.slice(1).map((response) => response.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("cancels active and queued reads at capacity without cancelling a write", async () => {
    const releaseReads = deferred();
    const started: number[] = [];
    const aborted: number[] = [];
    const writeSignals: Array<AbortSignal | undefined> = [];
    const { dispatch, responses } = setup(
      async (request, signal) => {
        const id = Number(request.id);
        started.push(id);
        if (id === 6) writeSignals.push(signal);
        else {
          await new Promise<void>((resolve) => {
            void releaseReads.promise.then(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                aborted.push(id);
                resolve();
              },
              { once: true },
            );
          });
        }
        return success(id);
      },
      {
        maxPendingRequests: 6,
        isReadOnlyRequest: isReadOnlyToolCall,
      },
    );

    for (let id = 1; id <= 5; id++) dispatch(toolLine(id, "workspace.events"));
    dispatch(toolLine(6, "work.execute"));
    await nextTurn();
    dispatch(cancel(5));
    dispatch(cancel(1));
    dispatch(cancel(6));
    dispatch(cancel("2"));
    dispatch(cancel(99));
    await nextTurn();
    const whileReadsAreActive = [...aborted];

    releaseReads.release();
    await dispatch.drain();
    expect(whileReadsAreActive).toEqual([1]);
    expect(started).toEqual([1, 2, 3, 4, 6]);
    expect(writeSignals).toEqual([undefined]);
    expect(responses.map((response) => response.id)).toEqual([2, 3, 4, 6]);
  });

  it("drops a cancelled reply that finished behind an earlier read", async () => {
    const first = deferred();
    const started: number[] = [];
    const { dispatch, responses } = setup(
      async (request) => {
        const id = Number(request.id);
        started.push(id);
        if (id === 1) await first.promise;
        return success(id);
      },
      { isReadOnlyRequest: isReadOnlyToolCall },
    );
    dispatch(toolLine(1, "workspace.events"));
    dispatch(toolLine(2, "workspace.events"));
    await nextTurn();
    dispatch(cancel(2));

    first.release();
    await dispatch.drain();
    expect(started).toEqual([1, 2]);
    expect(responses.map((response) => response.id)).toEqual([1]);
  });

  it("waits for earlier reads before a write and keeps later calls behind it", async () => {
    const gates = new Map([1, 3, 4].map((id) => [id, deferred()]));
    const started: number[] = [];
    const { dispatch, responses } = setup(
      async (request) => {
        const id = Number(request.id);
        started.push(id);
        await gates.get(id)?.promise;
        return success(id);
      },
      { isReadOnlyRequest: isReadOnlyToolCall },
    );

    dispatch(toolLine(1, "workspace.events"));
    dispatch(toolLine(2, "workspace.events"));
    dispatch(toolLine(3, "work.execute"));
    dispatch(toolLine(4, "evidence.confirm"));
    dispatch(toolLine(5, "work.operations"));
    await nextTurn();
    const duringReads = [...started];

    gates.get(1)!.release();
    await nextTurn();
    dispatch(cancel(3));
    await nextTurn();
    const duringFirstWrite = [...started];
    const repliesDuringFirstWrite = responses.map((response) => response.id);

    gates.get(3)!.release();
    await nextTurn();
    const duringSecondWrite = [...started];
    gates.get(4)!.release();
    await dispatch.drain();

    expect(duringReads).toEqual([1, 2]);
    expect(duringFirstWrite).toEqual([1, 2, 3]);
    expect(repliesDuringFirstWrite).toEqual([1, 2]);
    expect(duringSecondWrite).toEqual([1, 2, 3, 4]);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(responses.map((response) => response.id)).toEqual(started);
  });

  it("never runs two governed calls concurrently", async () => {
    let active = 0;
    let peak = 0;
    const { dispatch } = setup(async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return success(request.id ?? null);
    });

    for (let id = 1; id <= 6; id += 1) dispatch(line(id, "tools/call"));
    await dispatch.drain();

    expect(peak).toBe(1);
  });

  it("converts a thrown handler into -32603 and keeps serving later lines", async () => {
    const onError = vi.fn();
    const { dispatch, responses } = setup(
      async (request) => {
        if (request.id === 1) throw new Error("boom");
        return success(request.id ?? null);
      },
      { onError },
    );

    dispatch(line(1));
    dispatch(line(2));
    await dispatch.drain();

    expect(onError).toHaveBeenCalledOnce();
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      id: 1,
      error: { code: -32603, data: { code: "HANDLER_FAILURE" } },
    });
    expect(responses[1]).toMatchObject({ id: 2, result: {} });
    expect(JSON.stringify(responses[0])).not.toContain("boom");
  });

  it("answers parse errors with -32700 without calling the handler", async () => {
    const handler = vi.fn(async (request: JsonRpcRequest) =>
      success(request.id ?? null),
    );
    const { dispatch, responses } = setup(handler);

    dispatch("{not-json");
    dispatch(line(2));
    await dispatch.drain();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(responses[0]).toMatchObject({
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(responses[1]).toMatchObject({ id: 2, result: {} });
  });

  it("ignores blank lines and notifications without a response", async () => {
    const { dispatch, responses } = setup(async () => undefined);

    dispatch("   ");
    dispatch("");
    dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await dispatch.drain();

    expect(responses).toHaveLength(0);
  });

  it("rejects oversized lines before parsing and before reaching the handler", async () => {
    const handler = vi.fn();
    const { dispatch, responses } = setup(handler, { maxLineBytes: 64 });

    dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "x".repeat(200) },
      }),
    );
    await dispatch.drain();

    expect(handler).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({
      id: null,
      error: {
        code: -32600,
        data: { code: "REQUEST_TOO_LARGE", maxLineBytes: 64 },
      },
    });
  });

  it("waits for asynchronous responders so backpressure cannot reorder writes", async () => {
    const written: number[] = [];
    const dispatch = createStdioDispatcher(
      async (request) => success(request.id ?? null),
      async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        written.push(Number(payload.id));
      },
    );

    dispatch(line(1));
    dispatch(line(2));
    await dispatch.drain();

    expect(written).toEqual([1, 2]);
  });
});

describe("resolveMaxLineBytes", () => {
  it("falls back to the default for missing or invalid values", () => {
    expect(resolveMaxLineBytes(undefined)).toBe(DEFAULT_MAX_LINE_BYTES);
    expect(resolveMaxLineBytes("")).toBe(DEFAULT_MAX_LINE_BYTES);
    expect(resolveMaxLineBytes("abc")).toBe(DEFAULT_MAX_LINE_BYTES);
    expect(resolveMaxLineBytes("-10")).toBe(DEFAULT_MAX_LINE_BYTES);
  });

  it("accepts explicit values and caps absurd configuration", () => {
    expect(resolveMaxLineBytes("4096")).toBe(4096);
    expect(resolveMaxLineBytes("999999999999")).toBe(67_108_864);
  });
});
