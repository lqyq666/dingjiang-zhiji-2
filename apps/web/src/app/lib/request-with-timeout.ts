/** Bound the whole response, including body reading. Never retry writes automatically. */
export async function requestWithTimeout<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("请求超时时间无效");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const mutation = !["GET", "HEAD"].includes(
    (init.method ?? "GET").toUpperCase(),
  );
  try {
    const response = await fetch(url, {
      ...init,
      credentials: init.credentials ?? "same-origin",
      signal: controller.signal,
    });
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      !url.endsWith("/auth/login") &&
      !url.endsWith("/auth/session")
    ) {
      window.dispatchEvent(new Event("dingjiang:session-expired"));
    }
    return await read(response);
  } catch (error) {
    // Caller cancellation is not a server timeout and must retain its AbortError.
    if (init.signal?.aborted && !timedOut) throw error;
    if (timedOut)
      throw new Error(
        mutation
          ? "等待超时。操作可能已保存，请重新查看当前记录后再决定是否提交。"
          : "读取超时，请检查连接后重新加载。",
        { cause: error },
      );
    if (error instanceof TypeError)
      throw new Error(
        mutation
          ? "连接中断，尚未取得操作结果。请重新查看记录后再决定是否提交。"
          : "无法连接服务，请检查连接后重新加载。",
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}
