import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithTimeout } from "./request-with-timeout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("request deadlines and recovery", () => {
  it("releases a stalled write without retrying or claiming it failed to save", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = requestWithTimeout(
      "/save",
      { method: "POST" },
      (r) => r.json(),
      20,
    );
    const assertion = expect(result).rejects.toThrow("操作可能已保存");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
    // An independent read still works after the timeout.
    fetcher.mockImplementationOnce(async () => new Response('{"ok":true}'));
    await expect(
      requestWithTimeout("/read", {}, (r) => r.json()),
    ).resolves.toEqual({ ok: true });
  });
  it("covers a body that stalls after response headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => ({
        json: () =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(new Error("body aborted")),
            ),
          ),
      })),
    );
    const assertion = expect(
      requestWithTimeout("/read", {}, (r) => r.json(), 20),
    ).rejects.toThrow("读取超时");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });
  it("preserves API errors and clears its timer on success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    await expect(
      requestWithTimeout("/read", {}, async () => {
        throw new Error("无权访问");
      }),
    ).rejects.toThrow("无权访问");
    expect(vi.getTimerCount()).toBe(0);
  });
});
