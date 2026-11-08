import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");

/**
 * The sha256 of the Apache License 2.0 text as published at
 * https://www.apache.org/licenses/LICENSE-2.0.txt.
 *
 * A licence is a legal document, and a licence that was edited by accident
 * is a licence nobody can rely on. Pinning the digest makes any change to
 * the file visible in the diff, and forces whoever makes it to update this
 * constant deliberately - which is the moment to say out loud that the
 * licence is changing.
 */
const APACHE_2_0_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

const REQUIRED_SECTIONS = [
  "Grant of Copyright License",
  "Grant of Patent License",
  "Redistribution",
  "Submission of Contributions",
  "Trademarks",
  "Disclaimer of Warranty",
  "Limitation of Liability",
  "Accepting Warranty or Additional Liability",
  "END OF TERMS AND CONDITIONS",
];

describe("licence", () => {
  it("is the unmodified Apache License 2.0", async () => {
    const licence = await readFile(join(repositoryRoot, "LICENSE"), "utf8");
    expect(createHash("sha256").update(licence).digest("hex")).toBe(
      APACHE_2_0_SHA256,
    );
    for (const section of REQUIRED_SECTIONS)
      expect(licence, `许可证缺少条款：${section}`).toContain(section);
  });

  it("states the copyright holder and the licence in the NOTICE file", async () => {
    const notice = await readFile(join(repositoryRoot, "NOTICE"), "utf8");
    expect(notice).toContain("Copyright 2026 lqyq666");
    expect(notice).toContain("Apache License, Version 2.0");
    expect(notice).toMatch(/不含任何真实企业数据|不含.*真实.*数据/);
  });

  it("declares the same licence in every workspace package", async () => {
    const packages = [
      "package.json",
      "apps/api/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
      "services/dingjiang-mcp/package.json",
      "tooling/architecture/package.json",
      "tooling/feishu-schema/package.json",
    ];
    for (const path of packages) {
      const manifest = JSON.parse(
        await readFile(join(repositoryRoot, path), "utf8"),
      ) as { license?: string };
      expect(manifest.license, `${path} 没有声明许可证`).toBe("Apache-2.0");
    }
  });
});
