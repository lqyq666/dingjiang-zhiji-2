/** Remote connections need TLS. Loopback HTTP remains available for the existing demo. */
export function validateIntegrationBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith("/") ? value : `${value}/`);
  } catch {
    throw new Error("DINGJIANG_API_BASE_URL 必须是有效 URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/"
  )
    throw new Error(
      "API 地址仅允许 HTTPS /api，或本机 HTTP /api；不得包含凭据、查询参数或片段",
    );
  return url;
}
