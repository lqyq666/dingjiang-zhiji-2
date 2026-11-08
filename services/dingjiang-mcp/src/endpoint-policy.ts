/** Remote connections need TLS. Loopback HTTP remains available for the existing demo. */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

// The whole 127.0.0.0/8 range is loopback, not just 127.0.0.1. Matching only the
// single address rejected legitimate local setups, while a loose "starts with
// 127" check would let look-alike hosts through, so octets are validated.
const isIpv4Loopback = (host: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 127;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || isIpv4Loopback(host);
};

export function validateIntegrationBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith("/") ? value : `${value}/`);
  } catch {
    throw new Error("DINGJIANG_API_BASE_URL 必须是有效 URL");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
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
