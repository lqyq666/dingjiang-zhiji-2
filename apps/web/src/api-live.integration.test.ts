import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `import type` is erased at compile time, so naming the module this way does
// not evaluate it before NEXT_PUBLIC_API_BASE_URL is pointed at the test server.
import type * as WebDataLayer from "./app/lib/vs01-api";

/**
 * Live web → API → PostgreSQL run.
 *
 * The browser pages are client-rendered, so an HTTP fetch of the HTML proves
 * almost nothing. What actually breaks the UI is contract drift between the
 * data layer in `src/app/lib` and the API it calls — and that layer is ordinary
 * TypeScript, so it can be driven directly against a real server.
 *
 * This test therefore imports the shipped data-layer functions (no rewrite, no
 * mock), points `NEXT_PUBLIC_API_BASE_URL` at a real API process, and lets the
 * functions' own Zod parsing decide whether the API still honours its contract.
 *
 * Enable with WEB_E2E=1. Requires a migrated and seeded database in
 * DATABASE_URL; `scripts/testing/run-integration-suite.mjs` prepares one.
 */
const run = process.env.WEB_E2E === "1";

const apiEntry = resolve(process.cwd(), "../api/dist/main.js");
const port = 32_000 + Math.floor(Math.random() * 2_000);
const baseUrl = `http://127.0.0.1:${port}/api`;

type WebApi = typeof WebDataLayer;

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`API did not become ready: ${lastError}`);
};

describe.skipIf(!run)("web data layer against a live API", () => {
  let api: ChildProcess;
  let web: WebApi;
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("WEB_E2E requires DATABASE_URL");
    expect(existsSync(apiEntry)).toBe(true);

    api = spawn(process.execPath, [apiEntry], {
      env: {
        ...process.env,
        PORT: String(port),
        API_HOST: "127.0.0.1",
        VS15_MATERIAL_VAULT_ROOT: resolve(process.cwd(), ".data/web-e2e-vault"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors: string[] = [];
    api.stderr?.on("data", (chunk: Buffer) =>
      errors.push(chunk.toString("utf8")),
    );
    api.once("exit", (code) => {
      if (code !== 0) errors.push(`API exited with ${code}`);
    });
    await waitForHealth(`${baseUrl}/health`);

    // Set before importing: the module reads the base URL at module scope, the
    // same way Next.js inlines NEXT_PUBLIC_* at build time.
    process.env.NEXT_PUBLIC_API_BASE_URL = baseUrl;
    web = await import("./app/lib/vs01-api");

    // Build the demo project the way a user does, not by inserting rows: reset,
    // confirm the source work item, then open the project off it.
    const resetResponse = await fetch(`${baseUrl}/vs01/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vs01-role": "PMC" },
      body: JSON.stringify({ actor: "PMC" }),
    });
    if (!resetResponse.ok)
      throw new Error(
        `reset failed: HTTP ${resetResponse.status} ${await resetResponse.text()} ${errors.join("")}`,
      );

    await web.decideTask("SO-202608128", {
      actor: "PMC",
      type: "CONFIRMED",
      note: "建立 Web 端到端测试项目",
    });
    const project = await web.createProject("SO-202608128");
    expect(project.id).toBe("PRJ-OTD-001");
  }, 180_000);

  afterAll(async () => {
    if (api && api.exitCode === null) {
      const exited = new Promise<void>((resolvePromise) =>
        api.once("exit", () => resolvePromise()),
      );
      api.kill();
      await exited;
    }
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  }, 60_000);

  it("loads the owner dashboard through the shipped data layer", async () => {
    const dashboard = await web.getBossDashboard();
    // Parsed by bossDashboardSchema inside the data layer: any contract drift
    // between web and API fails here rather than in the browser.
    expect(dashboard.role).toBe("OWNER");
    expect(dashboard.projects.length).toBeGreaterThan(0);
    expect(dashboard.projects.map((project) => project.id)).toContain(
      "PRJ-OTD-001",
    );
    expect(dashboard.project?.id).toBe("PRJ-OTD-001");
  });

  it("loads the employee dashboard and a project with phases", async () => {
    const employee = await web.getEmployeeDashboard();
    expect(employee.role).toBe("PMC");

    const project = await web.getProject("PRJ-OTD-001");
    expect(project.id).toBe("PRJ-OTD-001");
    expect(project.phases.length).toBeGreaterThan(0);
    expect(project.phases.some((phase) => phase.tasks.length > 0)).toBe(true);
  });

  it("writes a subtask status through the UI path and reads it back", async () => {
    const before = await web.getProject("PRJ-OTD-001");
    const subtask = before.phases
      .flatMap((phase) => phase.tasks)
      .find((task) => task.owner === "PMC" && task.status !== "DONE");
    expect(subtask).toBeDefined();

    const updated = await web.updateProjectSubtask(subtask!.id, {
      actor: "PMC",
      status: "IN_PROGRESS",
      note: "Web 端到端测试记录的进展",
      outputReference: "",
    });
    const after = updated.phases
      .flatMap((phase) => phase.tasks)
      .find((task) => task.id === subtask!.id);
    expect(after?.status).toBe("IN_PROGRESS");

    // Read back through a fresh request rather than trusting the write receipt.
    const reread = await web.getProject("PRJ-OTD-001");
    expect(
      reread.phases
        .flatMap((phase) => phase.tasks)
        .find((task) => task.id === subtask!.id)?.status,
    ).toBe("IN_PROGRESS");
  });

  it("surfaces a missing project as an error instead of an empty page", async () => {
    await expect(web.getProject("PRJ-DOES-NOT-EXIST")).rejects.toThrow();
  });
});
