import { describe, expect, it, vi } from "vitest";

import { FeishuSchemaClient } from "./feishu-client";
import type { FeishuSchemaApiError } from "./feishu-client";
import { feishuSchemaManifest } from "./manifest";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function client(fetchImpl: typeof fetch) {
  return new FeishuSchemaClient({
    appId: "cli-test",
    appSecret: "do-not-log-this-secret",
    baseAppToken: "bascn-test",
    reviewTableId: "tblReview",
    fetchImpl,
  });
}

describe("Feishu schema client", () => {
  it("reads a schema snapshot without calling a Bitable write endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [{ table_id: "tblReview", name: "VS17 经验审核" }],
            has_more: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [
              { field_id: "fldCandidate", field_name: "候选ID", type: 1 },
            ],
            has_more: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            items: [
              { view_id: "vewReview", view_name: "待审核", view_type: "grid" },
            ],
            has_more: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({ code: 0, data: { total: 3, items: [] } }),
      );

    await expect(client(fetchImpl).snapshot()).resolves.toMatchObject({
      tables: [{ id: "tblReview", recordCount: 3 }],
    });

    const bitableCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/bitable/"),
    );
    expect(bitableCalls).toHaveLength(4);
    expect(bitableCalls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("uses tenant auth and creates a complete table without returning credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({ code: 0, data: { table_id: "tbl-created" } }),
      );
    const table = feishuSchemaManifest[1];
    if (!table) throw new Error("approval table manifest missing");

    await expect(client(fetchImpl).createTable(table)).resolves.toBe(
      "tbl-created",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const write = fetchImpl.mock.calls[1];
    expect(write?.[0]).toContain("/bitable/v1/apps/bascn-test/tables");
    expect(String(write?.[1]?.body)).toContain('"name":"负责人决策台"');
    expect(String(write?.[1]?.body)).not.toContain("do-not-log-this-secret");
  });

  it("returns an actionable code without exposing provider payloads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          tenant_access_token: "tenant-token",
          expire: 7200,
        }),
      )
      .mockResolvedValueOnce(
        response({ code: 1254003, msg: "do-not-log-this-secret" }),
      );
    const table = feishuSchemaManifest[2];
    if (!table) throw new Error("quality table manifest missing");

    const error = await client(fetchImpl)
      .createTable(table)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject<Partial<FeishuSchemaApiError>>({
      code: "API_FAILED",
    });
    expect(String(error)).not.toContain("do-not-log-this-secret");
  });
});
