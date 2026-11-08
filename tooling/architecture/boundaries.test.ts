import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const sourceRoots = ["apps", "packages", "services", "tooling"] as const;
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredSourceDirectories = new Set([
  ".next",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
]);
const webDatabasePackages = [
  "@dingjiang/db",
  "@prisma/client",
  "@supabase/ssr",
  "@supabase/supabase-js",
  "drizzle-orm",
  "kysely",
  "pg",
  "postgres",
  "typeorm",
] as const;

async function sourceFiles(relativeRoot: string): Promise<string[]> {
  const root = resolve(repositoryRoot, relativeRoot);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (ignoredSourceDirectories.has(entry.name)) return;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) return visit(absolute);
        if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
          files.push(absolute);
      }),
    );
  }

  await visit(root);
  return files;
}

function scriptKind(fileName: string): ts.ScriptKind {
  const extension = extname(fileName);

  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleSpecifiers(
  sourceText: string,
  fileName = "source.ts",
): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const specifiers: string[] = [];

  function addStringLiteral(node: ts.Node | undefined): void {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";

      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

async function violations(
  isViolation: (specifier: string, file: string) => boolean,
  roots: readonly string[] = sourceRoots,
): Promise<string[]> {
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  const matches: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (
      moduleSpecifiers(content, file).some((specifier) =>
        isViolation(specifier, file),
      )
    ) {
      matches.push(file.replace(repositoryRoot, ""));
    }
  }

  return matches;
}

function isCrossPackageImport(specifier: string, file: string): boolean {
  if (/^@dingjiang\/[^/]+\/.+/.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;

  const workspacePath = relative(repositoryRoot, file).split(sep);
  const workspaceRoot = resolve(repositoryRoot, ...workspacePath.slice(0, 2));
  const importedPath = resolve(dirname(file), specifier);

  return (
    importedPath !== workspaceRoot &&
    !importedPath.startsWith(`${workspaceRoot}${sep}`)
  );
}

function isWebDatabaseImport(specifier: string): boolean {
  return webDatabasePackages.some(
    (packageName) =>
      specifier === packageName || specifier.startsWith(`${packageName}/`),
  );
}

describe("architecture import extraction", () => {
  it("covers static, re-exported, dynamic, CommonJS, and import-equals forms", () => {
    expect(
      moduleSpecifiers(`
        import value from "@dingjiang/static";
        export { value } from "@dingjiang/re-export";
        const dynamic = import("@dingjiang/dynamic");
        const commonJs = require("@dingjiang/commonjs");
        import legacy = require("@dingjiang/import-equals");
      `),
    ).toEqual([
      "@dingjiang/static",
      "@dingjiang/re-export",
      "@dingjiang/dynamic",
      "@dingjiang/commonjs",
      "@dingjiang/import-equals",
    ]);
  });
});

describe("architecture boundaries", () => {
  it("keeps database and persistence SDKs out of the web app", async () => {
    const matches = await violations(isWebDatabaseImport, ["apps/web"]);
    expect(matches).toEqual([]);
  });

  it("forbids package subpaths and relative imports across workspaces", async () => {
    const matches = await violations(isCrossPackageImport);
    expect(matches).toEqual([]);
  });

  it("keeps package code independent from frameworks and persistence", async () => {
    const matches = await violations(
      (specifier) =>
        specifier.startsWith("@nestjs/") ||
        specifier === "drizzle-orm" ||
        specifier.startsWith("drizzle-orm/"),
      ["packages"],
    );
    expect(matches).toEqual([]);
  });
});

/**
 * Size ratchet for the one file that is already a known problem.
 *
 * `apps/api/src/vs01.service.ts` carries six bounded contexts in 94 methods.
 * Splitting it is a real refactor that needs its own change window; until that
 * happens, the file must not quietly keep growing. A ratchet says "do not make
 * it worse", which is a weaker promise than "make it good" but a keepable one.
 *
 * If a change genuinely belongs in this file, raising the number is allowed —
 * in its own commit, with the reason. That is the friction this test exists to
 * create.
 */
describe("growth ratchet", () => {
  const budget = 5261;

  it("keeps vs01.service.ts from absorbing more responsibilities", async () => {
    const file = resolve(repositoryRoot, "apps/api/src/vs01.service.ts");
    const lines = (await readFile(file, "utf8")).split("\n").length - 1;
    expect(
      lines,
      `apps/api/src/vs01.service.ts 已从 ${budget} 行增长到 ${lines} 行。` +
        `它同时承担任务接入、材料、项目状态机、AI 助手、经验资产与读模型六个上下文，` +
        `继续变大只会让改动风险线性上升。新逻辑请放进 apps/api/src/<context>/ 下的独立模块；` +
        `确实必须写在这里时，请在本测试里同步调整预算，并在提交信息里说明理由。`,
    ).toBeLessThanOrEqual(budget);
  });
});
