import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { materialSituationForInput } from "./projections";
import { ReadModelService } from "./read-model-service";

const tenantId = "tenant-demo";

/**
 * The read model takes its pool at construction, so a test can hand it a
 * stub directly instead of reaching into the service afterwards.
 */
const readModel = (query: unknown) =>
  new ReadModelService({ query } as unknown as Pool, tenantId);

describe("OWNER read projections", () => {
  it("keeps OWNER high-risk joins inside the tenant and out of acceptance data", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("b.tenant_id = o.tenant_id");
      expect(statement).toContain("p.tenant_id = o.tenant_id");
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo", false]);
      return { rowCount: 0, rows: [] };
    });
    const service = readModel(query) as unknown as {
      highRiskOrders(includeAcceptance?: boolean): Promise<unknown[]>;
    };

    await service.highRiskOrders(false);

    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps NON_PRODUCTION acceptance projects out of the OWNER list", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo", false]);
      return { rowCount: 0, rows: [] };
    });
    const service = readModel(query) as unknown as {
      projects(includeAcceptance?: boolean): Promise<unknown[]>;
    };

    await service.projects(false);

    expect(query).toHaveBeenCalledOnce();
  });

  it("projects only the three traceable operating data sources", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("WHERE o.tenant_id = $1");
      expect(statement).toContain("E2E_ACCEPTANCE");
      expect(values).toEqual([
        "tenant-demo",
        ["SRC-ORDERS", "SRC-BOM", "SRC-PURCHASES"],
      ]);
      return {
        rowCount: 1,
        rows: [
          {
            source_object_id: "SRC-ORDERS",
            source_version_id: "SRC-ORDERS-V1",
            file_name: "orders.csv",
            version_number: 1,
            record_count: 2,
          },
        ],
      };
    });
    const service = readModel(query) as unknown as {
      ownerDataSources(): Promise<unknown[]>;
    };

    await expect(service.ownerDataSources()).resolves.toEqual([
      {
        sourceObjectId: "SRC-ORDERS",
        sourceVersionId: "SRC-ORDERS-V1",
        fileName: "orders.csv",
        category: "ORDER",
        versionNumber: 1,
        recordCount: 2,
        status: "AVAILABLE",
      },
    ]);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("PMC read projections", () => {
  it("keeps NON_PRODUCTION acceptance fixtures out of the employee workspace", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("o.status <> 'E2E_ACCEPTANCE'");
      expect(values).toEqual(["tenant-demo"]);
      return { rowCount: 0, rows: [] };
    });
    const projects = vi.fn(async () => []);
    const highRiskOrders = vi.fn(async () => []);
    const service = readModel(query) as unknown as {
      projects(includeAcceptance?: boolean): Promise<unknown[]>;
      highRiskOrders(includeAcceptance?: boolean): Promise<unknown[]>;
      employee(): Promise<unknown>;
    };
    service.projects = projects;
    service.highRiskOrders = highRiskOrders;

    await service.employee();

    expect(projects).toHaveBeenCalledWith(false);
    expect(highRiskOrders).toHaveBeenCalledWith(false);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("formal experience read model", () => {
  it("reads only the tenant's published formal experience and maps its traceability receipt", async () => {
    const query = async (statement: string, values?: unknown[]) => {
      expect(statement).toContain(
        "WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED'",
      );
      expect(values).toEqual(["FORMAL-EXP-001", "tenant-demo"]);
      return {
        rowCount: 1,
        rows: [
          {
            id: "FORMAL-EXP-001",
            candidate_id: "EXP-CANDIDATE-001",
            source_project_id: "PRJ-OTD-001",
            source_task_id: "SO-202608128",
            status: "PUBLISHED",
            title: "BOM 准备前置治理",
            applicable_situation: "多品种小批量订单进入排产前",
            business_problem: "交付延期",
            practice: "在排产前核对 BOM 齐套情况",
            result_summary: "减少因缺料造成的排产返工",
            limitations: "采购到货风险为主因时不适用",
            published_at: "2026-08-26T01:02:03.000Z",
            retracted_at: null,
            retracted_reason: null,
            source_object_id: "SRC-FORMAL-001",
            source_version_id: "SRC-FORMAL-001-V2",
            candidate_source_object_id: "SRC-CANDIDATE-001",
            candidate_source_version_id: "SRC-CANDIDATE-001-V1",
            evidence_source_object_id: "SRC-RESULT-001",
            evidence_source_version_id: "SRC-RESULT-001-V1",
            structured_card: null,
            coze_index_status: "INDEXED",
            coze_execute_id: "coze-exec-001",
            coze_debug_url: "https://coze.cn/debug/001",
            coze_indexed_at: "2026-08-26T01:04:05.000Z",
          },
        ],
      };
    };
    const service = readModel(query);

    await expect(service.experience("FORMAL-EXP-001")).resolves.toMatchObject({
      id: "FORMAL-EXP-001",
      locator: {
        sourceObjectId: "SRC-FORMAL-001",
        sourceVersionId: "SRC-FORMAL-001-V2",
        reference: "BOM 准备前置治理",
      },
      cozeIndex: {
        status: "INDEXED",
        executeId: "coze-exec-001",
        debugUrl: "https://coze.cn/debug/001",
        indexedAt: "2026-08-26T01:04:05.000Z",
      },
    });
  });

  it("does not expose a formal experience that is absent, retracted, or outside the tenant", async () => {
    const query = async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("tenant_id = $2");
      expect(statement).toContain("status = 'PUBLISHED'");
      expect(values).toEqual(["FORMAL-EXP-404", "tenant-demo"]);
      return { rowCount: 0, rows: [] };
    };
    const service = readModel(query);

    await expect(service.experience("FORMAL-EXP-404")).rejects.toMatchObject({
      message: "正式经验不存在或已撤回",
    });
  });
});

describe("material situation projection", () => {
  it("routes unresolved project inputs to the matching material workbench", () => {
    expect(materialSituationForInput("未核验产能风险")).toBe("CAPACITY_RISK");
    expect(materialSituationForInput("缺失 BOM/变更资料")).toBe("BOM_DELAY");
    expect(materialSituationForInput("供应商到货承诺")).toBe("PURCHASE_DELAY");
    expect(materialSituationForInput("原因证据链")).toBeNull();
  });
});

/**
 * `findProject` is the biggest read in this service: eight queries plus the
 * projection behind every project screen. The happy path is covered by the
 * integration suite against a real database; these cases pin the invariants
 * that are easy to lose in a refactor - early exit, tenant scoping, and the
 * keys the child reads join on - without needing a database at all.
 */
describe("project read path", () => {
  const projectRow = {
    node_id: "NODE-1",
    source_task_id: "SO-202608128",
  };

  it("stops after the first read when the project does not exist", async () => {
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      expect(statement).toContain("p.tenant_id = $2");
      expect(values).toEqual(["PRJ-MISSING", tenantId]);
      return { rows: [], rowCount: 0 };
    });
    const service = readModel(query);

    await expect(service.project("PRJ-MISSING")).rejects.toMatchObject({
      message: "项目不存在",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("scopes all seven child reads to the tenant and joins them on the right keys", async () => {
    const calls: Array<{ statement: string; values?: unknown[] }> = [];
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      calls.push({ statement, values });
      if (statement.startsWith("SELECT p.id, p.source_task_id"))
        return { rows: [projectRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const service = readModel(query);

    // With no EXECUTION_CONTROL phase the projection fails before
    // projectSchema.parse, so all seven child reads have already run.
    await expect(service.project("PRJ-1")).rejects.toMatchObject({
      message: "执行节点不存在",
    });

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.statement).toContain("tenant_id");
      expect(call.values).toContain(tenantId);
    }
    // Subtasks join on the node, but materials and experience references
    // belong to the source task, not to the project. Getting either wrong
    // silently drops evidence from the read model.
    expect(calls[2]?.values?.[0]).toBe("NODE-1");
    expect(calls[5]?.values?.[0]).toBe("SO-202608128");
    expect(calls[6]?.values?.[0]).toBe("SO-202608128");
  });
});
