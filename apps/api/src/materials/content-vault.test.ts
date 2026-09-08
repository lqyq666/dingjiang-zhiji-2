import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BadRequestException } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";

import {
  MaterialContentVault,
  maxMaterialBytes,
  validateMaterialFile,
} from "./content-vault";

const file = (originalName: string, body: string | Buffer) => {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { originalName, buffer, size: buffer.length };
};

describe("VS15 material content vault", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts UTF-8 CSV only with a bounded AI preview", () => {
    const material = validateMaterialFile(
      file("负荷.csv", "日期,工时\\n2026-08-20,8"),
    );
    expect(material).toMatchObject({
      mediaType: "text/csv",
      extractionStatus: "EXTRACTED",
      readableByAi: true,
      contentPreview: "日期,工时\\n2026-08-20,8",
    });
    expect(material.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts the .markdown spelling as controlled UTF-8 text", () => {
    expect(
      validateMaterialFile(
        file("notes.markdown", "# 产能核验\\n待补充当日工时"),
      ),
    ).toMatchObject({
      mediaType: "text/markdown",
      extractionStatus: "EXTRACTED",
      readableByAi: true,
    });
  });

  it("rejects disguise, empty, oversized and invalid text before vault staging", () => {
    expect(() => validateMaterialFile(file("伪装.pdf", "not a PDF"))).toThrow(
      BadRequestException,
    );
    expect(() => validateMaterialFile(file("空.csv", ""))).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateMaterialFile(
        file("过大.txt", Buffer.alloc(maxMaterialBytes + 1, "a")),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMaterialFile(file("二进制.txt", Buffer.from([0, 1]))),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMaterialFile(file("损坏编码.txt", Buffer.from([0xc3, 0x28]))),
    ).toThrow(BadRequestException);
    expect(() => validateMaterialFile(file("错误.json", "{not json}"))).toThrow(
      BadRequestException,
    );
  });

  it("stores bytes using opaque generated keys rather than client paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vs15-vault-"));
    roots.push(root);
    const vault = new MaterialContentVault(root);
    const staged = await vault.stage(Buffer.from("机密材料"));
    expect(staged.storageKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(staged.storageKey).not.toContain("机密");
    await vault.finalize(staged.temporaryKey, staged.storageKey);
    const stream = await vault.open(staged.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("机密材料");
    expect(await readFile(path.join(root, staged.storageKey), "utf8")).toBe(
      "机密材料",
    );
  });

  it("fails before returning a stream when the stored blob is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vs15-vault-"));
    roots.push(root);
    const vault = new MaterialContentVault(root);
    await expect(vault.open("missing-material")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
