import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("material requirement version semantics", () => {
  it("keeps VS15 requirement links one-to-many while governed create gates the first active material", async () => {
    const [intakeMigration, governedCommand] = await Promise.all([
      readFile(
        path.resolve(
          __dirname,
          "../../migrations/0019_vs15_traceable_materials.sql",
        ),
        "utf8",
      ),
      readFile(
        path.resolve(__dirname, "../materials/material-create-command.ts"),
        "utf8",
      ),
    ]);

    expect(intakeMigration).toContain(
      "ON vs01_task_materials (tenant_id, task_id, request_id)",
    );
    expect(intakeMigration).not.toMatch(
      /UNIQUE[^;]*(requirement_id|situation_code)/i,
    );
    expect(governedCommand).toContain(
      "const currentVersion = existing.rowCount ? 1 : 0",
    );
    expect(governedCommand).toContain("if (currentVersion !== 0)");
  });
});
