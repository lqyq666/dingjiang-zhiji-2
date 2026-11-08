import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");

const documentationRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  ".github",
  "packages",
  "apps",
  "services",
  "tooling",
];

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

/**
 * pnpm commands that exist without being a package script.
 * Listing them keeps the check from reporting `pnpm install` as missing.
 */
const builtinCommands = new Set([
  "add",
  "audit",
  "config",
  "dedupe",
  "dlx",
  "exec",
  "fetch",
  "import",
  "info",
  "install",
  "licenses",
  "list",
  "login",
  "logout",
  "outdated",
  "pack",
  "publish",
  "why",
]);

const collectFiles = async (target: string): Promise<string[]> => {
  const absolute = join(repositoryRoot, target);
  if (!existsSync(absolute)) return [];
  // A documentation root can be a single file (README.md) as well as a
  // directory. Reading a file as a directory would silently yield nothing,
  // and the check would pass without ever looking at it.
  if (!statSync(absolute).isDirectory()) return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      files.push(...(await collectFiles(relative(repositoryRoot, path))));
    } else if ([".md", ".yml", ".yaml"].includes(extname(entry.name)))
      files.push(path);
  }
  return files;
};

const readPackageScripts = async (manifestPath: string) => {
  try {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, manifestPath), "utf8"),
    ) as { name?: string; scripts?: Record<string, string> };
    return manifest;
  } catch {
    return undefined;
  }
};

describe("documented commands exist", () => {
  it("only mentions pnpm scripts that are actually defined", async () => {
    const root = await readPackageScripts("package.json");
    const rootScripts = new Set(Object.keys(root?.scripts ?? {}));

    const packageScripts = new Map<string, Set<string>>();
    for (const manifestPath of [
      "apps/api/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
      "services/dingjiang-mcp/package.json",
      "tooling/architecture/package.json",
      "tooling/feishu-schema/package.json",
    ]) {
      const manifest = await readPackageScripts(manifestPath);
      if (manifest?.name)
        packageScripts.set(
          manifest.name,
          new Set(Object.keys(manifest.scripts ?? {})),
        );
    }

    const files: string[] = [];
    for (const target of documentationRoots)
      files.push(...(await collectFiles(target)));

    const missing: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const where = relative(repositoryRoot, file).split(sep).join("/");
      // Only look inside fenced blocks and inline code spans. Prose such as
      // "a pnpm and Turborepo monorepo" is not a command, and treating it as
      // one would make this check cry wolf.
      const blocks = [...text.matchAll(/```[\s\S]*?```/g)].map(
        (match) => match[0],
      );
      const spans = [
        ...text.replace(/```[\s\S]*?```/g, "").matchAll(/`[^`\n]+`/g),
      ].map((match) => match[0]);
      const code = [...blocks, ...spans].join("\n");

      for (const match of code.matchAll(
        /pnpm\s+(?:--filter\s+([@\w/.-]+)\s+)?([a-z][a-z0-9:-]*)/g,
      )) {
        const [, filter, command] = match;
        if (!command) continue;
        if (builtinCommands.has(command)) continue;
        if (filter) {
          const scripts = packageScripts.get(filter);
          if (!scripts) {
            missing.push(`${where}: pnpm --filter ${filter} 指向不存在的包`);
            continue;
          }
          if (!scripts.has(command))
            missing.push(
              `${where}: pnpm --filter ${filter} ${command} —— ${filter} 没有这个 script`,
            );
          continue;
        }
        if (!rootScripts.has(command))
          missing.push(
            `${where}: pnpm ${command} —— 根 package.json 没有这个 script`,
          );
      }
    }

    expect(
      missing,
      "文档里引用了不存在的命令。请改文档，或把命令加进 package.json。\n" +
        missing.join("\n"),
    ).toEqual([]);
  });

  it("only links to files that exist", async () => {
    const files: string[] = [];
    for (const target of documentationRoots)
      files.push(...(await collectFiles(target)));

    const broken: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const where = relative(repositoryRoot, file).split(sep).join("/");
      for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (!target) continue;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        if (target.startsWith("/")) continue;
        const resolved = resolve(dirname(file), target.split("#")[0] ?? target);
        if (!existsSync(resolved))
          broken.push(`${where}: 链接指向不存在的 ${target}`);
      }
    }

    expect(
      broken,
      "文档里的相对链接指向了不存在的文件。请改链接，或补回文件。\n" +
        broken.join("\n"),
    ).toEqual([]);
  });
});
