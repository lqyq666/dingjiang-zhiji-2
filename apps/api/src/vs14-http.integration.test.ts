import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { Project, ProjectAssistantResponse } from "@dingjiang/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";

const runHttpIntegration =
  process.env.VS14_HTTP_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:vs14:http" ||
  process.argv.some((argument) =>
    argument.includes("vs14-http.integration.test.ts"),
  );
const httpDescribe = runHttpIntegration ? describe : describe.skip;

type Dashboard = { projects: Project[] };
type AssistantHistory = {
  session: { id: string; scope: { projectId: string; sourceTaskId: string } };
  runs: Array<{
    id: string;
    projectId: string;
    sourceTaskId: string;
    classification: string;
  }>;
};
type WorkpaperCandidate = {
  revision: number;
  current: {
    content: {
      materialFindings: Array<{
        assessment: string;
        verificationStatus: string;
        note: string;
      }>;
    };
  };
  workItem: { acceptanceCriteria: string[] };
};

const delay = (milliseconds: number): Promise<never> =>
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("Timed out while reading the assistant stream")),
      milliseconds,
    ),
  );

type StreamReplay = { raw: string; events: Array<Record<string, unknown>> };

const completeEvents = (raw: string): Array<Record<string, unknown>> =>
  raw
    .split("\n\n")
    .slice(0, -1)
    .flatMap((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      return data ? [JSON.parse(data) as Record<string, unknown>] : [];
    });

/** Read complete replay events and always release the otherwise infinite SSE response. */
const readReplay = async (
  url: string,
  role: string,
  expectedValues: readonly string[],
): Promise<StreamReplay> => {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      headers: { "x-vs01-role": role },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    if (!response.body)
      throw new Error("Assistant stream has no response body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 5_000;
    let raw = "";
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([reader.read(), delay(remaining)]);
      if (next.done)
        throw new Error("Assistant stream ended before replaying an event");
      raw += decoder.decode(next.value, { stream: true });
      const events = completeEvents(raw);
      const serializedEvents = events.map((event) => JSON.stringify(event));
      if (
        events.length > 0 &&
        expectedValues.every((value) =>
          serializedEvents.some((event) => event.includes(value)),
        )
      )
        return { raw, events };
    }
    throw new Error(
      "Assistant stream did not replay the expected complete event",
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    controller.abort();
  }
};

httpDescribe("VS14 HTTP multi-engagement isolation", () => {
  let app: INestApplication;
  let api = "";
  let legacyId = "";
  let secondId = "";
  let legacyBeforeProgression: Pick<
    Project,
    "status" | "outcome" | "auditTrail" | "experienceCandidate"
  >;

  const request = async <T>(
    path: string,
    role: string | undefined,
    body?: unknown,
  ): Promise<{ response: Response; data: T }> => {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(role ? { "x-vs01-role": role } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: (await response.json()) as T };
  };

  const getProject = async (projectId: string): Promise<Project> => {
    const result = await request<Project>(`/vs01/projects/${projectId}`, "PMC");
    expect(result.response.status).toBe(200);
    return result.data;
  };

  const completePhase = async (
    initial: Project,
    phaseCode: Project["phases"][number]["code"],
  ): Promise<Project> => {
    let project = initial;
    const phase = project.phases.find((item) => item.code === phaseCode);
    if (!phase) throw new Error(`Missing ${phaseCode} phase`);
    for (const task of phase.tasks.filter(
      (item) =>
        item.owner === "PMC" && ["READY", "IN_PROGRESS"].includes(item.status),
    )) {
      const updated = await request<Project>(
        `/vs01/project-subtasks/${task.id}/status`,
        "PMC",
        {
          actor: "PMC",
          status: "DONE",
          note: `VS14 HTTP 验收完成：${task.title}`,
          outputReference: `VS14 第二咨询任务输出：${task.title}`,
          confirmedAcceptanceCriteria: task.acceptance,
        },
      );
      expect(updated.response.status).toBe(201);
      project = updated.data;
    }
    return project;
  };

  const confirmRootCause = async (projectId: string) => {
    const form = new FormData();
    form.set("actor", "PMC");
    form.set("situationCode", "CAPACITY_RISK");
    form.set("requirementId", "REQ-CAPACITY-LOAD");
    form.set("title", "VS14 HTTP 根因核验材料");
    form.set("note", "真实 VS16 流程");
    form.set("requestId", "14211111-1111-4111-8111-111111111111");
    form.set(
      "file",
      new Blob(["日期,负荷率\n2026-08-26,93%"], { type: "text/csv" }),
      "vs14-http-capacity.csv",
    );
    const importResponse = await fetch(
      `${api}/vs01/tasks/SO-202608136/materials/import`,
      { method: "POST", headers: { "x-vs01-role": "PMC" }, body: form },
    );
    expect(importResponse.status).toBe(201);
    const imported = (await importResponse.json()) as {
      materials: Array<{ id: string; title: string }>;
    };
    const material = imported.materials.find(
      (item) => item.title === "VS14 HTTP 根因核验材料",
    );
    if (!material)
      throw new Error("Expected imported VS14 HTTP workpaper material");
    const candidate = await request<WorkpaperCandidate>(
      `/vs16/projects/${projectId}/root-cause-workpaper/candidate-runs`,
      "PMC",
      {
        actor: "PMC",
        requestId: "14211111-1111-4111-8111-111111111112",
        expectedRevision: 0,
        materialIds: [material.id],
      },
    );
    expect(candidate.response.status).toBe(201);
    const current = candidate.data.current;
    const complete = await request<unknown>(
      `/vs16/projects/${projectId}/root-cause-workpaper/complete`,
      "PMC",
      {
        actor: "PMC",
        requestId: "14211111-1111-4111-8111-111111111113",
        expectedRevision: candidate.data.revision,
        content: {
          ...current.content,
          materialFindings: current.content.materialFindings.map((finding) => ({
            ...finding,
            assessment: "SUPPORTS",
            verificationStatus: "EMPLOYEE_CHECKED",
            note: "PMC 已核对 HTTP 材料。",
          })),
          conclusion: {
            result: "SUPPORTS",
            statement: "VS14 HTTP 第二任务已确认根因。",
            limitations: "仅本地测试。",
            nextChecks: ["在方案中明确责任。"],
          },
        },
        completionNote: "VS14 HTTP 使用真实 VS16 确认底稿。",
        confirmedAcceptanceCriteria: candidate.data.workItem.acceptanceCriteria,
      },
    );
    expect(complete.response.status).toBe(201);
  };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number } | null;
    if (!address)
      throw new Error("HTTP test application did not bind a local port");
    api = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("runs a complete second engagement through public HTTP seams without changing the legacy engagement", async () => {
    const reset = await request<Dashboard>("/vs01/reset", "PMC", {
      actor: "PMC",
    });
    expect(reset.response.status).toBe(201);

    const unauthenticated = await request<{ statusCode: number }>(
      "/vs01/employee",
      undefined,
    );
    expect(unauthenticated.response.status).toBe(403);
    const wrongRole = await request<{ statusCode: number }>(
      "/vs01/projects",
      "OWNER",
      {
        actor: "PMC",
        sourceTaskId: "SO-202608128",
      },
    );
    expect(wrongRole.response.status).toBe(403);

    for (const sourceTaskId of ["SO-202608128", "SO-202608136"]) {
      const decision = await request(
        `/vs01/tasks/${sourceTaskId}/decision`,
        "PMC",
        {
          actor: "PMC",
          type: "CONFIRMED",
          note: `VS14 HTTP 验收：确认 ${sourceTaskId} 的候选原因`,
        },
      );
      expect(decision.response.status).toBe(201);
    }

    const malformedCreate = await request<{ statusCode: number }>(
      "/vs01/projects",
      "PMC",
      {
        actor: "PMC",
        sourceTaskId: "SO-202608128",
        projectId: "PRJ-CLIENT-CONTROLLED",
      },
    );
    expect(malformedCreate.response.status).toBe(400);

    const legacyCreate = await request<Project>("/vs01/projects", "PMC", {
      actor: "PMC",
      sourceTaskId: "SO-202608128",
    });
    const secondCreate = await request<Project>("/vs01/projects", "PMC", {
      actor: "PMC",
      sourceTaskId: "SO-202608136",
    });
    expect(legacyCreate.response.status).toBe(201);
    expect(secondCreate.response.status).toBe(201);
    legacyId = legacyCreate.data.id;
    secondId = secondCreate.data.id;
    await confirmRootCause(secondId);
    expect(legacyId).toBe("PRJ-OTD-001");
    expect(secondId).not.toBe(legacyId);
    expect(secondCreate.data.node.id).not.toBe(legacyCreate.data.node.id);
    expect(secondCreate.data.phases.map((phase) => phase.id)).not.toEqual(
      legacyCreate.data.phases.map((phase) => phase.id),
    );

    const duplicate = await request<{ statusCode: number }>(
      "/vs01/projects",
      "PMC",
      {
        actor: "PMC",
        sourceTaskId: "SO-202608136",
      },
    );
    expect(duplicate.response.status).toBe(400);

    const [employee, boss] = await Promise.all([
      request<Dashboard>("/vs01/employee", "PMC"),
      request<Dashboard>("/vs01/boss", "OWNER"),
    ]);
    expect(employee.response.status).toBe(200);
    expect(boss.response.status).toBe(200);
    for (const dashboard of [employee.data, boss.data]) {
      expect(dashboard.projects.map((project) => project.id)).toEqual(
        expect.arrayContaining([legacyId, secondId]),
      );
    }

    const projectAssistant = await request<ProjectAssistantResponse>(
      `/vs01/projects/${secondId}/assistant`,
      "PMC",
      {
        actor: "PMC",
        intent: "ASK",
        question: "请基于第二咨询任务的事实、证据和材料说明下一步",
        workflowAction: "INSPECT",
      },
    );
    expect(projectAssistant.response.status).toBe(201);
    expect(projectAssistant.data).toMatchObject({
      provider: "DEMO_RULES",
      classification: "PROPOSAL",
      context: {
        projectId: secondId,
        sourceTaskId: "SO-202608136",
      },
    });
    expect(
      projectAssistant.data.context.workItems.every((item) =>
        item.id.includes(secondId),
      ),
    ).toBe(true);
    const assistantContext = JSON.stringify(projectAssistant.data);
    expect(assistantContext).toContain("E-ORDER-202608136");
    expect(assistantContext).toContain("E-BOM-202608136");
    expect(assistantContext).toContain("E-PURCHASE-202608136");
    expect(assistantContext).not.toContain("SO-202608128");
    expect(assistantContext).not.toContain("E-BOM-128");

    legacyBeforeProgression = (await getProject(legacyId)) as Project;
    legacyBeforeProgression = {
      status: legacyBeforeProgression.status,
      outcome: legacyBeforeProgression.outcome,
      auditTrail: legacyBeforeProgression.auditTrail,
      experienceCandidate: legacyBeforeProgression.experienceCandidate,
    };

    const [legacyRun, secondRun] = await Promise.all([
      request<{ id: string }>(
        "/vs12/projects/PRJ-OTD-001/assistant/runs",
        "PMC",
        {
          intent: "NEXT_ACTION",
          question: "旧项目下一步是什么？",
        },
      ),
      request<{ id: string }>(
        `/vs12/projects/${secondId}/assistant/runs`,
        "PMC",
        {
          intent: "NEXT_ACTION",
          question: "第二项目下一步是什么？",
        },
      ),
    ]);
    expect(legacyRun.response.status).toBe(201);
    expect(secondRun.response.status).toBe(201);
    const [legacyHistory, secondHistory] = await Promise.all([
      request<AssistantHistory>(
        `/vs12/projects/${legacyId}/assistant/history`,
        "PMC",
      ),
      request<AssistantHistory>(
        `/vs12/projects/${secondId}/assistant/history`,
        "PMC",
      ),
    ]);
    expect(legacyHistory.response.status).toBe(200);
    expect(secondHistory.response.status).toBe(200);
    expect(legacyHistory.data.session.scope).toMatchObject({
      projectId: legacyId,
      sourceTaskId: "SO-202608128",
    });
    expect(secondHistory.data.session.scope).toMatchObject({
      projectId: secondId,
      sourceTaskId: "SO-202608136",
    });
    expect(
      legacyHistory.data.runs.every(
        (run) =>
          run.projectId === legacyId && run.sourceTaskId === "SO-202608128",
      ),
    ).toBe(true);
    expect(
      secondHistory.data.runs.every(
        (run) =>
          run.projectId === secondId && run.sourceTaskId === "SO-202608136",
      ),
    ).toBe(true);

    const replay = await readReplay(
      `${api}/vs12/projects/${secondId}/assistant/stream?after=0`,
      "PMC",
      [secondHistory.data.session.id, secondRun.data.id],
    );
    expect(replay.raw).toContain("event:");
    expect(
      replay.events.every(
        (event) => event.sessionId === secondHistory.data.session.id,
      ),
    ).toBe(true);
    expect(
      replay.events.some((event) => event.runId === secondRun.data.id),
    ).toBe(true);
    expect(replay.raw).not.toContain(legacyHistory.data.session.id);
    for (const run of legacyHistory.data.runs)
      expect(replay.raw).not.toContain(run.id);

    const solutionComplete = await completePhase(
      await getProject(secondId),
      "SOLUTION_APPROVAL",
    );
    expect(solutionComplete.id).toBe(secondId);
    const submitted = await request<Project>(
      `/vs01/projects/${secondId}/submit`,
      "PMC",
      {
        actor: "PMC",
      },
    );
    expect(submitted.response.status).toBe(201);
    const approved = await request<Project>(
      `/vs01/projects/${secondId}/approve`,
      "OWNER",
      {
        actor: "OWNER",
      },
    );
    expect(approved.response.status).toBe(201);
    const executionComplete = await completePhase(
      approved.data,
      "EXECUTION_CONTROL",
    );
    expect(executionComplete.status).toBe("RESULT_VALIDATION");
    const resultComplete = await completePhase(
      executionComplete,
      "RESULT_ACCEPTANCE",
    );
    expect(resultComplete.id).toBe(secondId);
    const outcome = await request<Project>(
      `/vs01/projects/${secondId}/outcome`,
      "PMC",
      {
        actor: "PMC",
        currentOtd: 83,
        evidenceReference: "VS14 HTTP 第二咨询任务 OTD 重算表",
        conclusion: "第二咨询任务已按同口径确认 OTD 从 71% 提升至 83%",
        note: "仅用于本地 HTTP 集成验收",
      },
    );
    expect(outcome.response.status).toBe(201);
    const knowledgeComplete = await completePhase(
      outcome.data,
      "KNOWLEDGE_CAPTURE",
    );
    expect(knowledgeComplete.id).toBe(secondId);
    const outcomeLocator = knowledgeComplete.outcome.locator;
    if (!outcomeLocator) throw new Error("Expected accepted outcome locator");
    const candidate = await request<Project>(
      `/vs01/projects/${secondId}/experience-candidate`,
      "PMC",
      {
        actor: "PMC",
        title: "第二咨询任务的 BOM 准备前置治理",
        applicableSituation: "工程变更已冻结的多品种小批量订单",
        businessProblem: "BOM 准备滞后导致采购和排产启动延迟",
        practice: "分类缺料与版本冲突，明确责任并日清补料",
        resultSummary: "OTD 从 71% 提升至 83%，已由责任员工确认",
        limitations: "仅适用于工程变更已冻结的订单",
        structuredCard: {
          trigger: "BOM 准备滞后",
          conditions: ["工程变更已冻结"],
          actions: [{ order: 1, action: "明确责任并日清补料" }],
          rationale: "由当前项目已确认结果证据支持。",
          exceptions: ["工程变更未冻结时不适用。"],
          scope: {
            products: ["多品种小批量订单"],
            departments: ["工程", "采购"],
            scenarios: ["BOM 准备滞后"],
          },
          claims: [
            {
              statement: "BOM 延误影响采购启动。",
              evidenceIds: ["E-BOM-202608136"],
            },
          ],
          evidenceRefs: [outcomeLocator],
          missingInformation: [],
        },
      },
    );
    expect(candidate.response.status).toBe(201);
    expect(candidate.data.experienceCandidate).toMatchObject({
      id: `EXP-${secondId}`,
      status: "PENDING_REVIEW",
      revision: 1,
    });

    const legacyAfter = await getProject(legacyId);
    expect({
      status: legacyAfter.status,
      outcome: legacyAfter.outcome,
      auditTrail: legacyAfter.auditTrail,
      experienceCandidate: legacyAfter.experienceCandidate,
    }).toEqual(legacyBeforeProgression);
  });
});
