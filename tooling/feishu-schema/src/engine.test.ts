import { describe, expect, it, vi } from "vitest";

import {
  applyFeishuSchema,
  FeishuSchemaConflictError,
  planFeishuSchema,
  verifyFeishuSchema,
  type FeishuSchemaSnapshot,
} from "./engine";
import { feishuSchemaManifest } from "./manifest";

const reviewManifest = feishuSchemaManifest[0]!;

function reviewSnapshot(
  overrides: Partial<FeishuSchemaSnapshot["tables"][number]> = {},
) {
  return {
    id: "tblReview",
    name: "VS17 经验审核",
    recordCount: 3,
    fields: reviewManifest.fields.map((field, index) => ({
      id: `fld-${index}`,
      name: field.name,
      kind: field.kind,
      options: field.options ?? [],
    })),
    views: reviewManifest.views.map((name, index) => ({
      id: `vew-${index}`,
      name,
      type: "grid",
    })),
    ...overrides,
  };
}

describe("Feishu schema engine", () => {
  it("plans only missing tables without invoking a writer", () => {
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      { tables: [reviewSnapshot()] },
      { FEISHU_REVIEW_TABLE_ID: "tblReview" },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.destructiveChanges).toBe(0);
    expect(plan.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "EXISTS",
          logicalResource: "experience_candidate_review",
          resource: "table",
        }),
        expect.objectContaining({
          status: "CREATE_TABLE",
          logicalResource: "owner_decision",
        }),
        expect.objectContaining({
          status: "CREATE_FIELD",
          logicalResource: "owner_decision",
          name: "审批请求ID",
        }),
        expect.objectContaining({
          status: "CREATE_VIEW",
          logicalResource: "owner_decision",
          name: "待决策",
        }),
        expect.objectContaining({
          status: "CREATE_TABLE",
          logicalResource: "knowledge_quality",
        }),
      ]),
    );
    expect(plan.actions).toMatchObject([
      { type: "create_table", table: { name: "负责人决策台" } },
      { type: "create_table", table: { name: "知识质量运营台" } },
    ]);
  });

  it("fails closed on an existing field type conflict", async () => {
    const review = reviewSnapshot();
    const fields = review.fields.map((field) =>
      field.name === "候选ID" ? { ...field, kind: "number" as const } : field,
    );
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      { tables: [{ ...review, fields }] },
      { FEISHU_REVIEW_TABLE_ID: "tblReview" },
    );
    expect(plan.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "TYPE_CONFLICT",
          resource: "field",
          name: "候选ID",
        }),
      ]),
    );
    const writer = {
      createTable: vi.fn(),
      createField: vi.fn(),
      createView: vi.fn(),
    };
    await expect(applyFeishuSchema(plan, writer)).rejects.toBeInstanceOf(
      FeishuSchemaConflictError,
    );
    expect(writer.createTable).not.toHaveBeenCalled();
  });

  it("reports managed and unmanaged resources without planning destructive reconciliation", () => {
    const review = reviewSnapshot();
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      {
        tables: [
          {
            ...review,
            fields: [
              ...review.fields.filter((field) => field.name !== "Scope"),
              {
                id: "fld-remote",
                name: "仅飞书维护",
                kind: "text",
                options: [],
              },
            ],
            views: [
              ...review.views.filter((view) => view.name !== "同步异常"),
              { id: "vew-remote", name: "个人临时视图", type: "grid" },
            ],
          },
        ],
      },
      { FEISHU_REVIEW_TABLE_ID: "tblReview" },
    );

    expect(plan.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "EXISTS",
          resource: "field",
          name: "候选ID",
        }),
        expect.objectContaining({
          status: "CREATE_FIELD",
          resource: "field",
          name: "Scope",
        }),
        expect.objectContaining({
          status: "CREATE_VIEW",
          resource: "view",
          name: "同步异常",
        }),
        expect.objectContaining({
          status: "UNMANAGED_REMOTE_FIELD",
          name: "仅飞书维护",
        }),
        expect.objectContaining({
          status: "UNMANAGED_REMOTE_VIEW",
          name: "个人临时视图",
        }),
      ]),
    );
    expect(plan.actions).toHaveLength(4);
    expect(plan.destructiveChanges).toBe(0);
  });

  it("blocks when the configured existing review table cannot be found", () => {
    const plan = planFeishuSchema(
      feishuSchemaManifest,
      { tables: [] },
      { FEISHU_REVIEW_TABLE_ID: "tbl-missing" },
    );

    expect(plan.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "BLOCKED",
          logicalResource: "experience_candidate_review",
          resource: "table",
        }),
      ]),
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.destructiveChanges).toBe(0);
  });

  it("creates each missing resource once and a second complete plan is empty", async () => {
    const initial = planFeishuSchema(
      feishuSchemaManifest,
      { tables: [reviewSnapshot()] },
      { FEISHU_REVIEW_TABLE_ID: "tblReview" },
    );
    const writer = {
      createTable: vi.fn(
        async (table: { name: string }) => `tbl-${table.name}`,
      ),
      createField: vi.fn(async () => "fld-new"),
      createView: vi.fn(
        async (_tableId: string, viewName: string) => `vew-${viewName}`,
      ),
    };
    const applied = await applyFeishuSchema(initial, writer);
    expect(writer.createTable).toHaveBeenCalledTimes(2);
    expect(writer.createField).not.toHaveBeenCalled();
    expect(writer.createView).toHaveBeenCalledTimes(9);
    expect(applied).toHaveLength(11);

    const completeSnapshot: FeishuSchemaSnapshot = {
      tables: feishuSchemaManifest.map((table, tableIndex) => ({
        id: table.existingTableIdEnv ? "tblReview" : `tbl-${tableIndex}`,
        name: table.name,
        recordCount: table.minimumRecordCount ?? 0,
        fields: table.fields.map((field, fieldIndex) => ({
          id: `fld-${tableIndex}-${fieldIndex}`,
          name: field.name,
          kind: field.kind,
          options: field.options ?? [],
        })),
        views: table.views.map((name, viewIndex) => ({
          id: `vew-${tableIndex}-${viewIndex}`,
          name,
          type: "grid",
        })),
      })),
    };
    const verification = verifyFeishuSchema(
      feishuSchemaManifest,
      completeSnapshot,
      { FEISHU_REVIEW_TABLE_ID: "tblReview" },
    );
    expect(verification.ok).toBe(true);
    expect(verification.plan.actions).toEqual([]);
  });
});
