import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Vs01Service } from "../vs01.service";
import type { MaterialCreateCommand } from "../materials/material-create-command";

const tenantId = "tenant-demo";
const classification = "E2E / ACCEPTANCE / NON_PRODUCTION" as const;
const requirementId = "REQ-CAPACITY-LOAD";
const situationCode = "CAPACITY_RISK";

export type MaterialCreateAcceptanceFixture = {
  classification: typeof classification;
  tenantId: typeof tenantId;
  sourceTaskId: string;
  projectId: string;
  workItemId: string;
  requirement: {
    id: typeof requirementId;
    situationCode: typeof situationCode;
    status: "MISSING" | "UNVERIFIED";
    activeMaterialCount: 0;
    expectedVersion: 0;
    versionTarget: "MATERIAL_REQUIREMENT_AVAILABILITY";
  };
  expectedVersionReadPath: string;
  readTool: "list_traceable_materials";
  repeatStrategy: "CREATE_UNIQUE_PROJECT";
  retirementStrategy: string;
};

export class PostgresAcceptanceSourceTaskRepository {
  constructor(private readonly pool: Pool) {}

  async create(sourceTaskId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO vs01_orders (order_id, tenant_id, customer, promised_date, forecast_date, status, source_row) VALUES ($1,$2,$3,'2026-09-01','2026-09-06','E2E_ACCEPTANCE',999999)",
        [sourceTaskId, tenantId, classification],
      );
      await client.query(
        "INSERT INTO vs01_bom (order_id, tenant_id, planned_bom_date, actual_bom_date, completion_status, source_row) VALUES ($1,$2,'2026-08-24','2026-08-28','E2E_ACCEPTANCE',999999)",
        [sourceTaskId, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_purchases (order_id, tenant_id, planned_start_date, actual_start_date, arrival_risk, source_row) VALUES ($1,$2,'2026-08-25','2026-08-28','UNVERIFIED',999999)",
        [sourceTaskId, tenantId],
      );
      await client.query(
        "INSERT INTO vs01_tasks (id, tenant_id, order_id, status) VALUES ($1,$2,$1,'OPEN')",
        [sourceTaskId, tenantId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markProject(projectId: string, sourceTaskId: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE vs01_projects SET name = $1 WHERE id = $2 AND source_task_id = $3 AND tenant_id = $4",
      [
        `${classification} · material.create`,
        projectId,
        sourceTaskId,
        tenantId,
      ],
    );
    if (result.rowCount !== 1)
      throw new Error("acceptance fixture project could not be classified");
  }
}

export class MaterialCreateAcceptanceFixtureBuilder {
  constructor(
    private readonly sourceTasks: PostgresAcceptanceSourceTaskRepository,
    private readonly business: Vs01Service,
  ) {}

  async create(): Promise<MaterialCreateAcceptanceFixture> {
    const sourceTaskId = `SO-E2E-MATERIAL-${randomUUID()}`;
    await this.sourceTasks.create(sourceTaskId);
    await this.business.decideTask(sourceTaskId, {
      actor: "PMC",
      type: "CONFIRMED",
      note: `${classification} fixture bootstrap only`,
    });
    const created = await this.business.createProject({
      actor: "PMC",
      sourceTaskId,
    });
    await this.sourceTasks.markProject(created.id, sourceTaskId);

    const [project, sourceTask] = await Promise.all([
      this.business.project(created.id),
      this.business.task(sourceTaskId),
    ]);
    const workItem = project.phases
      .flatMap((phase) => phase.tasks)
      .find(
        (item) =>
          item.owner === "PMC" &&
          ["READY", "IN_PROGRESS"].includes(item.status) &&
          item.inputs.some(
            (input) =>
              input.requirementId === requirementId &&
              ["MISSING", "UNVERIFIED"].includes(input.status),
          ),
      );
    const gap = workItem?.inputs.find(
      (candidate) =>
        candidate.requirementId === requirementId &&
        ["MISSING", "UNVERIFIED"].includes(candidate.status),
    );
    const activeMaterialCount = sourceTask.materials.filter(
      (material) =>
        material.status === "ACTIVE" &&
        material.requirementId === requirementId &&
        material.situationCode === situationCode,
    ).length;
    if (!workItem || !gap || activeMaterialCount !== 0)
      throw new Error("acceptance fixture is not eligible for material.create");

    return {
      classification,
      tenantId,
      sourceTaskId,
      projectId: project.id,
      workItemId: workItem.id,
      requirement: {
        id: requirementId,
        situationCode,
        status: gap.status as "MISSING" | "UNVERIFIED",
        activeMaterialCount: 0,
        expectedVersion: 0,
        versionTarget: "MATERIAL_REQUIREMENT_AVAILABILITY",
      },
      expectedVersionReadPath: `list_traceable_materials(projectId=${project.id}) -> gaps contains ${requirementId} => expectedVersion 0; items contains ACTIVE ${requirementId} => expectedVersion 1`,
      readTool: "list_traceable_materials",
      repeatStrategy: "CREATE_UNIQUE_PROJECT",
      retirementStrategy:
        "Remove the old projectId from the WorkBuddy token project allowlist; retain the labelled project, SourceVersion and Audit history.",
    };
  }
}

export type MaterialVerificationAcceptanceFixture = Omit<
  MaterialCreateAcceptanceFixture,
  "requirement" | "expectedVersionReadPath"
> & {
  requirement: {
    id: typeof requirementId;
    situationCode: typeof situationCode;
    status: "AVAILABLE";
    activeMaterialCount: 1;
    materialAvailabilityVersion: 1;
  };
  material: {
    id: string;
    status: "ACTIVE";
    verificationStatus: "UNVERIFIED";
    expectedVersion: 0;
    versionTarget: "MATERIAL_VERIFICATION_STREAM";
    sourceObjectId: string;
    sourceVersionId: string;
  };
  verificationExpectedVersionReadPath: string;
  verificationRequestId?: undefined;
};

export class MaterialVerificationAcceptanceFixtureBuilder {
  constructor(
    private readonly base: MaterialCreateAcceptanceFixtureBuilder,
    private readonly materialCreate: MaterialCreateCommand,
  ) {}

  async create(): Promise<MaterialVerificationAcceptanceFixture> {
    const fixture = await this.base.create();
    const created = await this.materialCreate.execute(
      {
        tenantId: fixture.tenantId,
        subjectId: "acceptance-fixture-pmc",
        role: "PMC",
        scopes: ["material:write"],
        projectIds: [fixture.projectId],
      },
      fixture.projectId,
      {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "建立人工材料核验 acceptance fixture",
        correlationId: randomUUID(),
        payload: {
          workItemId: fixture.workItemId,
          situationCode: fixture.requirement.situationCode,
          requirementId: fixture.requirement.id,
          materialType: "CONTROLLED_TEXT",
          displayName: "E2E 人工核验待核验材料",
          sourceMetadata: {
            sourceType: "HUMAN_PROVIDED",
            sourceName: "Acceptance Fixture Builder",
          },
          safeSummary:
            "E2E / ACCEPTANCE / NON_PRODUCTION 输入，仍需真实 PMC 人工核验。",
          controlledTextContent:
            "该材料只建立核验前置状态，不表示内容真实或 Evidence 已成立。",
        },
      },
    );
    return {
      classification: fixture.classification,
      tenantId: fixture.tenantId,
      sourceTaskId: fixture.sourceTaskId,
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      readTool: fixture.readTool,
      repeatStrategy: fixture.repeatStrategy,
      retirementStrategy: fixture.retirementStrategy,
      requirement: {
        id: fixture.requirement.id,
        situationCode: fixture.requirement.situationCode,
        status: "AVAILABLE",
        activeMaterialCount: 1,
        materialAvailabilityVersion: 1,
      },
      material: {
        id: created.data.materialId,
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        expectedVersion: 0,
        versionTarget: "MATERIAL_VERIFICATION_STREAM",
        sourceObjectId: created.data.locator.sourceObjectId,
        sourceVersionId: created.data.locator.sourceVersionId,
      },
      verificationExpectedVersionReadPath: `list_traceable_materials(projectId=${fixture.projectId}) -> items[id=${created.data.materialId}].verification.version`,
    };
  }
}
