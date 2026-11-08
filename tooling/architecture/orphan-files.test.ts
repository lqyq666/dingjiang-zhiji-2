import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import ts from "typescript";

const repositoryRoot = resolve(process.cwd(), "../..");
const sourceRoots = ["apps", "packages", "services", "tooling"] as const;
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);
const sourceExtensions = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"];

/**
 * Files a framework reaches without an import.
 *
 * Next.js routes are found by their file name, and the CLI tools are found
 * through the scripts in package.json. Both are entry points, not orphans.
 */
const conventionEntrypoints = [
  "page.tsx",
  "page.ts",
  "layout.tsx",
  "layout.ts",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "template.tsx",
  "route.ts",
  "next-env.d.ts",
  "next.config.ts",
  "next.config.mjs",
  "postcss.config.mjs",
  "vitest.config.mts",
  "vitest.config.ts",
];

const isTestFile = (file: string) =>
  /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/.test(file);

const listFiles = async (directory: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      files.push(...(await listFiles(join(directory, entry.name))));
    } else if (sourceExtensions.includes(extname(entry.name)))
      files.push(join(directory, entry.name));
  }
  return files;
};

/** Every relative module specifier a file imports. */
const importedSpecifiers = (text: string): string[] => {
  const source = ts.createSourceFile(
    "scan.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
};

const resolveSpecifier = (
  fromFile: string,
  specifier: string,
  known: Set<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => known.has(candidate));
};

/** Files the package scripts run directly. */
const scriptEntrypoints = async (): Promise<Set<string>> => {
  const entries = new Set<string>();
  const manifests = [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
    "services/dingjiang-mcp/package.json",
    "tooling/architecture/package.json",
    "tooling/feishu-schema/package.json",
  ];
  for (const manifest of manifests) {
    const parsed = JSON.parse(
      await readFile(join(repositoryRoot, manifest), "utf8"),
    ) as { scripts?: Record<string, string> };
    const base = dirname(join(repositoryRoot, manifest));
    for (const command of Object.values(parsed.scripts ?? {})) {
      for (const match of command.matchAll(/[\w./-]+\.(ts|tsx|mts|mjs|js)/g)) {
        const target = resolve(base, match[0]);
        entries.add(target);
        // A script usually runs the build output ("node dist/server.js"), but
        // the file that matters is the source it was built from. Map it back so
        // a compiled entry point is not mistaken for an orphan.
        const fromBuild = target.replace(/[\\/]dist[\\/]/, `${sep}src${sep}`);
        entries.add(fromBuild.replace(/\.js$/, ".ts"));
        entries.add(fromBuild.replace(/\.mjs$/, ".mts"));
      }
    }
  }
  return entries;
};

describe("orphan source files", () => {
  it("has no source file that nothing imports", async () => {
    const files = (
      await Promise.all(
        sourceRoots.map((root) => listFiles(join(repositoryRoot, root))),
      )
    )
      .flat()
      .map((file) => resolve(file));
    const known = new Set(files);
    const texts = new Map<string, string>();
    for (const file of files) texts.set(file, await readFile(file, "utf8"));

    const referenced = new Set<string>();
    for (const [file, text] of texts)
      for (const specifier of importedSpecifiers(text)) {
        const target = resolveSpecifier(file, specifier, known);
        if (target) referenced.add(target);
      }

    const entries = await scriptEntrypoints();
    const orphans: string[] = [];
    for (const file of files) {
      if (isTestFile(file)) continue;
      const name = file.split(sep).pop() ?? "";
      if (conventionEntrypoints.includes(name)) continue;
      if (entries.has(file)) continue;
      if (referenced.has(file)) continue;
      orphans.push(
        `${relative(repositoryRoot, file).split(sep).join("/")} (${(texts.get(file) ?? "").split("\n").length} 行)`,
      );
    }

    expect(
      orphans,
      "这些源码文件没有任何地方 import，看起来是实现了但实际不可达。\n" +
        "如果确实要删，删掉并确认构建与测试仍然通过；如果要留，说明它为什么不可达。\n" +
        orphans.join("\n"),
    ).toEqual([]);
  });
});
