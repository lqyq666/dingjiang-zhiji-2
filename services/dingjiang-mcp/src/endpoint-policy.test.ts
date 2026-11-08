import { describe, expect, it } from "vitest";

import { validateIntegrationBaseUrl } from "./endpoint-policy";

describe("validateIntegrationBaseUrl", () => {
  it.each([
    "http://127.0.0.1:3001/api",
    "http://127.0.0.2:3001/api",
    "http://127.255.255.254:3001/api",
    "http://localhost:3001/api",
    "http://LOCALHOST:3001/api",
    "http://[::1]:3001/api",
    "https://127.0.0.1:3001/api",
    "https://dingjiang.example.com/api",
  ])("accepts %s", (value) => {
    expect(validateIntegrationBaseUrl(value).pathname).toBe("/api/");
  });

  it.each([
    "http://128.0.0.1:3001/api",
    "http://10.0.0.5/api",
    "http://192.168.1.10:3001/api",
    "http://127.0.0.1.evil.com/api",
    "http://evil.com/api",
    "ftp://127.0.0.1:3001/api",
  ])("rejects cleartext or non-loopback traffic: %s", (value) => {
    expect(() => validateIntegrationBaseUrl(value)).toThrow(
      "仅允许 HTTPS /api，或本机 HTTP /api",
    );
  });

  it.each([
    "http://user:pass@127.0.0.1:3001/api",
    "http://127.0.0.1:3001/api?debug=1",
    "http://127.0.0.1:3001/api#fragment",
    "http://127.0.0.1:3001/",
    "http://127.0.0.1:3001/api/v2",
    "https://dingjiang.example.com/",
  ])(
    "rejects credentials, query, fragment and unexpected paths: %s",
    (value) => {
      expect(() => validateIntegrationBaseUrl(value)).toThrow(
        "仅允许 HTTPS /api，或本机 HTTP /api",
      );
    },
  );

  it("rejects malformed URLs and out-of-range octets", () => {
    expect(() => validateIntegrationBaseUrl("not a url")).toThrow(
      "DINGJIANG_API_BASE_URL 必须是有效 URL",
    );
    expect(() =>
      validateIntegrationBaseUrl("http://127.0.0.256:3001/api"),
    ).toThrow();
  });

  it("normalises a missing trailing slash so relative integration paths resolve", () => {
    const url = validateIntegrationBaseUrl("http://127.0.0.1:3001/api");
    expect(new URL("integration/projects", url).pathname).toBe(
      "/api/integration/projects",
    );
  });
});
