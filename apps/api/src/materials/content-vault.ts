import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import { BadRequestException } from "@nestjs/common";

export const maxMaterialBytes = 5 * 1024 * 1024;
export const maxPreviewCharacters = 20_000;

export type UploadedMaterialFile = {
  originalName: string;
  buffer: Buffer;
  size: number;
};

export type ValidatedMaterial = {
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  extractionStatus: "EXTRACTED" | "NEEDS_REVIEW";
  contentPreview: string | null;
  readableByAi: boolean;
  bytes: Buffer;
};

const acceptedExtensions = new Map([
  [".csv", "text/csv"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
] as const);
const textExtensions = new Set([".csv", ".txt", ".md", ".markdown", ".json"]);

const safeOriginalName = (value: string): string => {
  const name = path.posix.basename(value.replace(/\\/g, "/")).trim();
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (name.length > 200 || hasControlCharacter)
    throw new BadRequestException("文件名无效或过长");
  return name;
};

const isValidUtf8 = (bytes: Buffer): string | null => {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
};

export const validateMaterialFile = (
  file: UploadedMaterialFile,
): ValidatedMaterial => {
  const originalName = safeOriginalName(file.originalName);
  const extension = path.extname(originalName).toLowerCase();
  const mediaType = acceptedExtensions.get(
    extension as
      ".csv" | ".txt" | ".md" | ".markdown" | ".json" | ".pdf" | ".xlsx",
  );
  if (!originalName || !mediaType)
    throw new BadRequestException(
      "仅支持 CSV、TXT、Markdown、JSON、PDF 或 XLSX 材料",
    );
  if (!file.buffer?.length || file.size <= 0)
    throw new BadRequestException("材料文件不能为空");
  if (file.size !== file.buffer.length || file.buffer.length > maxMaterialBytes)
    throw new BadRequestException("材料文件不能超过 5MiB");

  let extractionStatus: ValidatedMaterial["extractionStatus"] = "NEEDS_REVIEW";
  let contentPreview: string | null = null;
  let readableByAi = false;
  if (textExtensions.has(extension)) {
    const text = isValidUtf8(file.buffer);
    if (!text) throw new BadRequestException("文本材料必须是非空 UTF-8 内容");
    if (extension === ".json") {
      try {
        JSON.parse(text);
      } catch {
        throw new BadRequestException("JSON 材料格式无效");
      }
    }
    extractionStatus = "EXTRACTED";
    contentPreview = text.slice(0, maxPreviewCharacters);
    readableByAi = true;
  } else if (extension === ".pdf") {
    if (!file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new BadRequestException("PDF 文件内容与扩展名不匹配");
  } else if (
    !file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    throw new BadRequestException("XLSX 文件内容与扩展名不匹配");
  }
  return {
    originalName,
    mediaType,
    byteSize: file.buffer.length,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    extractionStatus,
    contentPreview,
    readableByAi,
    bytes: file.buffer,
  };
};

export interface MaterialContentStore {
  stage(bytes: Buffer): Promise<{ temporaryKey: string; storageKey: string }>;
  finalize(temporaryKey: string, storageKey: string): Promise<void>;
  discard(key: string): Promise<void>;
  open(storageKey: string): Promise<Readable>;
}

export const MATERIAL_CONTENT_STORE = Symbol("MATERIAL_CONTENT_STORE");

export class MaterialContentVault implements MaterialContentStore {
  private readonly root: string;

  constructor(
    root = process.env.VS15_MATERIAL_VAULT_ROOT ??
      path.resolve(process.cwd(), ".data/materials"),
  ) {
    this.root = path.resolve(root);
  }

  async stage(
    bytes: Buffer,
  ): Promise<{ temporaryKey: string; storageKey: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const storageKey = randomUUID();
    const temporaryKey = `.${storageKey}.tmp`;
    const file = await open(this.resolve(temporaryKey), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      await rm(this.resolve(temporaryKey), { force: true }).catch(
        () => undefined,
      );
      throw error;
    } finally {
      await file.close();
    }
    return { temporaryKey, storageKey };
  }

  async finalize(temporaryKey: string, storageKey: string): Promise<void> {
    await rename(this.resolve(temporaryKey), this.resolve(storageKey));
  }

  async discard(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async open(storageKey: string): Promise<Readable> {
    const handle = await open(this.resolve(storageKey), "r");
    return handle.createReadStream({ autoClose: true });
  }

  private resolve(key: string): string {
    if (!/^[.a-zA-Z0-9-]+$/.test(key))
      throw new Error("Invalid material storage key");
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(`${this.root}${path.sep}`))
      throw new Error("Material storage key escapes vault");
    return resolved;
  }
}
