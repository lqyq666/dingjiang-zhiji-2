import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  evidenceProposalReviewListSchema,
  integrationEvidenceBundleSchema,
  integrationMaterialPreviewSchema,
  integrationSuccessEnvelopeSchema,
  integrationWorkspaceResumeSchema,
} from "@dingjiang/contracts";
import type { Pool } from "pg";
import { createTestPool } from "./testing/test-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { GovernedCommandKernel } from "./command-kernel/governed-command-kernel";
import { PostgresGovernedCommandStore } from "./command-kernel/postgres-governed-command-store";
import { MaterialCreateCommand } from "./materials/material-create-command";
import { MaterialVerificationCommand } from "./materials/material-verification-command";
import { databaseUrl, migrate, resetAndSeed } from "./vs01-db";
import { Vs01Service } from "./vs01.service";

const integrationDescribe =
  process.env.EVIDENCE_INTAKE_HTTP_INTEGRATION === "1"
    ? describe
    : describe.skip;

integrationDescribe(
  "governed Evidence intake HTTP and formal read-after-write",
  () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalBindings = process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
    const databaseName = `dingjiang_evidence_http_${process.pid}_${Date.now()}`;
    const token = "local-evidence-intake-http-token";
    let admin: Pool;
    let pool: Pool;
    let business: Vs01Service;
    let app: INestApplication;
    let api: string;
    let projectId: string;
    let workItemId: string;
    let materialId: string;
    let sourceObjectId: string;
    let sourceVersionId: string;

    beforeAll(async () => {
      const adminUrl = new URL(databaseUrl());
      adminUrl.pathname = "/postgres";
      admin = createTestPool(adminUrl.toString());
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const testUrl = new URL(databaseUrl());
      testUrl.pathname = `/${databaseName}`;
      process.env.DATABASE_URL = testUrl.toString();
      pool = createTestPool(testUrl.toString());
      await migrate(pool);
      await resetAndSeed(pool);
      business = new Vs01Service();
      await business.decideTask("SO-202608136", {
        actor: "PMC",
        type: "CONFIRMED",
        note: "建立 Evidence HTTP isolation fixture",
      });
      projectId = (
        await business.createProject({
          actor: "PMC",
          sourceTaskId: "SO-202608136",
        })
      ).id;
      workItemId = String(
        (
          await pool.query(
            "SELECT s.id FROM vs01_project_subtasks s JOIN vs01_project_nodes n ON n.id = s.node_id WHERE n.project_id = $1 AND s.id LIKE '%SUB-SOLUTION-001' LIMIT 1",
            [projectId],
          )
        ).rows[0]?.id,
      );
      const kernel = new GovernedCommandKernel(
        new PostgresGovernedCommandStore(pool),
      );
      const created = await new MaterialCreateCommand(kernel).execute(
        {
          tenantId: "tenant-demo",
          subjectId: "fixture-pmc",
          role: "PMC",
          scopes: ["material:write"],
          projectIds: [projectId],
        },
        projectId,
        {
          requestId: randomUUID(),
          expectedVersion: 0,
          reason: "建立已核验 Evidence HTTP 来源材料",
          correlationId: randomUUID(),
          payload: {
            workItemId,
            situationCode: "CAPACITY_RISK",
            requirementId: "REQ-CAPACITY-LOAD",
            materialType: "CONTROLLED_TEXT",
            displayName: "HTTP Evidence fixture",
            sourceMetadata: {
              sourceType: "HUMAN_PROVIDED",
              sourceName: "HTTP Fixture",
            },
            safeSummary: "NON_PRODUCTION Evidence HTTP fixture。",
            controlledTextContent:
              "测试产线负荷率为 82%。统计周期为 fixture week 1。",
          },
        },
      );
      materialId = created.data.materialId;
      sourceObjectId = created.data.locator.sourceObjectId;
      sourceVersionId = created.data.locator.sourceVersionId;
      await new MaterialVerificationCommand(kernel).execute(
        {
          tenantId: "tenant-demo",
          subjectId: "human-pmc-http-fixture",
          role: "PMC",
          scopes: ["material:verify"],
          projectIds: [projectId],
        },
        projectId,
        {
          requestId: randomUUID(),
          expectedVersion: 0,
          reason: "合法 human gate 核验 HTTP fixture",
          correlationId: randomUUID(),
          payload: {
            materialId,
            decision: "VERIFIED",
            verificationNote:
              "已核对 fixture 文本，可进入 Evidence Proposal HTTP 验收。",
          },
        },
      );
      process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = JSON.stringify([
        {
          token,
          tenantId: "tenant-demo",
          subjectId: "workbuddy-pmc-evidence-http",
          role: "PMC",
          scopes: [
            "project:read",
            "workitem:read",
            "workpaper:read",
            "material:read",
            "evidence:read",
            "evidence:write",
          ],
          projectIds: [projectId],
        },
      ]);
      app = await NestFactory.create(AppModule, { logger: false });
      app.setGlobalPrefix("api");
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as { port: number };
      api = `http://127.0.0.1:${address.port}/api`;
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      await business?.onModuleDestroy();
      await pool?.end();
      if (admin) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
          [databaseName],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
        await admin.end();
      }
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalBindings === undefined)
        delete process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON;
      else process.env.DINGJIANG_MCP_TOKEN_BINDINGS_JSON = originalBindings;
    }, 30_000);

    it("keeps proposal non-formal until the PMC human gate, then exposes formal Evidence", async () => {
      const request = {
        requestId: randomUUID(),
        expectedVersion: 0,
        reason: "通过 Integration API 登记 Evidence Proposal",
        correlationId: randomUUID(),
        payload: {
          workItemId,
          materialId,
          claim: "测试产线在 fixture 周期内负荷率为 82%。",
          evidenceType: "METRIC",
          sourceObjectId,
          sourceVersionId,
          exactSpan: {
            kind: "TEXT_SPAN",
            start: 0,
            end: 13,
            exactText: "测试产线负荷率为 82%。",
          },
          reasoning: "原文直接给出该指标。",
          limitations: "仅适用于 NON_PRODUCTION fixture。",
        },
      };
      const materialsBefore = await fetch(
        `${api}/integration/projects/${projectId}/materials`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(await materialsBefore.json()).toMatchObject({
        data: {
          items: [
            expect.objectContaining({
              id: materialId,
              verificationStatus: "VERIFIED",
              evidenceProposalVersion: 0,
            }),
          ],
        },
      });
      const proposedResponse = await fetch(
        `${api}/integration/projects/${projectId}/evidence/proposals`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );
      expect(proposedResponse.status).toBe(201);
      const proposed = (await proposedResponse.json()) as {
        data: { data: { proposalId: string } };
      };
      const proposalId = proposed.data.data.proposalId;
      const materialsAfter = await fetch(
        `${api}/integration/projects/${projectId}/materials`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(await materialsAfter.json()).toMatchObject({
        data: {
          items: [
            expect.objectContaining({
              id: materialId,
              evidenceProposalVersion: 1,
            }),
          ],
        },
      });

      const reviewProjectionResponse = await fetch(
        `${api}/vs01/projects/${projectId}/evidence/proposals`,
        { headers: { "x-vs01-role": "PMC" } },
      );
      expect(reviewProjectionResponse.status).toBe(200);
      expect(await reviewProjectionResponse.json()).toEqual([
        expect.objectContaining({
          proposalId,
          claim: request.payload.claim,
          locator: expect.objectContaining({ sourceObjectId, sourceVersionId }),
          exactSpan: request.payload.exactSpan,
          limitations: request.payload.limitations,
          review: null,
        }),
      ]);

      const readHeaders = { authorization: `Bearer ${token}` };
      const integrationProposals = await fetch(
        `${api}/integration/projects/${projectId}/evidence/proposals`,
        { headers: readHeaders },
      );
      expect(integrationProposals.status).toBe(200);
      const { data: proposals } = integrationSuccessEnvelopeSchema(
        evidenceProposalReviewListSchema,
      ).parse(await integrationProposals.json());
      expect(proposals).toEqual([
        expect.objectContaining({ proposalId, projectId, review: null }),
      ]);
      const resume = await fetch(`${api}/integration/workspace/resume`, {
        headers: readHeaders,
      });
      expect(resume.status).toBe(200);
      const { data: workspace } = integrationSuccessEnvelopeSchema(
        integrationWorkspaceResumeSchema,
      ).parse(await resume.json());
      expect(workspace.proposals).toEqual(proposals);
      expect(
        workspace.materials.items.find((item) => item.id === materialId),
      ).toMatchObject({ evidenceProposalVersion: 1 });

      const bundle = await fetch(
        `${api}/integration/projects/${projectId}/evidence-bundle`,
        { headers: readHeaders },
      );
      expect(bundle.status).toBe(200);
      const { data: evidenceBundle } = integrationSuccessEnvelopeSchema(
        integrationEvidenceBundleSchema,
      ).parse(await bundle.json());
      expect(evidenceBundle.proposals).toEqual(proposals);
      expect(evidenceBundle.materials).toEqual(workspace.materials);

      const preview = await fetch(
        `${api}/integration/projects/${projectId}/materials/${materialId}/preview`,
        { headers: readHeaders },
      );
      expect(preview.status).toBe(200);
      expect(
        integrationSuccessEnvelopeSchema(
          integrationMaterialPreviewSchema,
        ).parse(await preview.json()).data,
      ).toMatchObject({
        bodyAvailable: true,
        materialType: "CONTROLLED_TEXT",
        contentPreview: "测试产线负荷率为 82%。统计周期为 fixture week 1。",
        material: {
          id: materialId,
          file: null,
          evidenceProposalVersion: 1,
          locator: { sourceVersionId },
        },
      });

      const before = await fetch(
        `${api}/integration/projects/${projectId}/evidence`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(
        ((await before.json()) as { data: { items: unknown[] } }).data.items,
      ).toHaveLength(3);

      const confirmedResponse = await fetch(
        `${api}/vs01/projects/${projectId}/evidence/proposals/${proposalId}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-vs01-role": "PMC" },
          body: JSON.stringify({
            requestId: randomUUID(),
            expectedVersion: 0,
            reason: "PMC 核对来源与 claim 后确认",
            correlationId: randomUUID(),
            payload: {
              proposalId,
              decision: "CONFIRMED",
              reviewNote:
                "已看到 claim、来源版本、exact span 与限制并完成确认。",
            },
          }),
        },
      );
      expect(confirmedResponse.status).toBe(201);
      const confirmed = (await confirmedResponse.json()) as {
        data: { evidenceId: string; reviewedBy: string };
      };
      expect(confirmed.data.reviewedBy).toBe("human-pmc-web");

      const reviewedProjectionResponse = await fetch(
        `${api}/vs01/projects/${projectId}/evidence/proposals`,
        { headers: { "x-vs01-role": "PMC" } },
      );
      expect(await reviewedProjectionResponse.json()).toEqual([
        expect.objectContaining({
          proposalId,
          review: expect.objectContaining({
            decision: "CONFIRMED",
            version: 1,
            reviewedBy: "human-pmc-web",
            evidenceId: confirmed.data.evidenceId,
          }),
        }),
      ]);

      const [listResponse, detailResponse, sourceResponse] = await Promise.all([
        fetch(`${api}/integration/projects/${projectId}/evidence`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        fetch(
          `${api}/integration/projects/${projectId}/evidence/${confirmed.data.evidenceId}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
        fetch(
          `${api}/integration/projects/${projectId}/source-versions/${sourceVersionId}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
      ]);
      expect([
        listResponse.status,
        detailResponse.status,
        sourceResponse.status,
      ]).toEqual([200, 200, 200]);
      const list = (await listResponse.json()) as {
        data: { items: Array<Record<string, unknown>> };
      };
      expect(list.data.items).toHaveLength(4);
      expect(list.data.items).toContainEqual(
        expect.objectContaining({
          id: confirmed.data.evidenceId,
          classification: "FACT",
          origin: "HUMAN_CONFIRMED_MATERIAL",
          confirmedBy: "human-pmc-web",
        }),
      );
      expect((await sourceResponse.json()) as object).toMatchObject({
        data: { foundIn: "EVIDENCE", locator: { sourceVersionId } },
      });
    });
  },
);
