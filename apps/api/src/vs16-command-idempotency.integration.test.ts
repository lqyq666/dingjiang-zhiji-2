import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RootCauseWorkpaperService } from "./workpapers/root-cause-workpaper.service";
import { Vs01Service } from "./vs01.service";

const runIntegration = process.env.VS16_INTEGRATION === "1";
const integrationDescribe = runIntegration ? describe : describe.skip;

integrationDescribe("VS16 workpaper command idempotency", () => {
  const workpapers = new RootCauseWorkpaperService();
  const service = new Vs01Service(undefined, workpapers);
  let projectId = "";
  let materialId = "";

  beforeAll(async () => {
    await service.onModuleInit();
    await service.reset({ actor: "PMC" });
    const material = await service.importTaskMaterial(
      "SO-202608136",
      {
        actor: "PMC",
        situationCode: "CAPACITY_RISK",
        requirementId: "REQ-CAPACITY-LOAD",
        title: "产线负荷记录",
        note: "用于幂等性核验",
        requestId: "06111111-1111-4111-8111-111111111121",
      },
      {
        originalName: "幂等性产能.csv",
        buffer: Buffer.from("日期,负荷率\n2026-08-20,92%"),
        size: 31,
      },
    );
    materialId = material.id;
    await service.decideTask("SO-202608136", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立幂等性核验咨询任务",
    });
    projectId = (
      await service.createProject({
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      })
    ).id;
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await workpapers.onModuleDestroy();
  });

  it("retries an identical command but rejects a changed payload using the same request id", async () => {
    const command = {
      actor: "PMC" as const,
      requestId: "06111111-1111-4111-8111-111111111122",
      expectedRevision: 0,
      materialIds: [materialId],
    };
    const first = await workpapers.candidate(projectId, command);
    const retried = await workpapers.candidate(projectId, command);

    expect(retried.revision).toBe(first.revision);
    await expect(
      workpapers.candidate(projectId, { ...command, expectedRevision: 1 }),
    ).rejects.toMatchObject({
      response: { code: "REQUEST_ID_REUSED" },
    });
    expect((await workpapers.view(projectId)).revision).toBe(first.revision);
  });
});
