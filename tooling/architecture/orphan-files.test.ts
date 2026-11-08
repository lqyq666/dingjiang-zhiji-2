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

/**
 * An empty binding list binds nothing. Both `import {} from "./x"` and
 * `export {} from "./x"` are shells left behind when an implementation moves
 * out; counting either as a reference would let a genuinely orphaned file pass
 * the check. Side-effect imports (`import "./x"`), default imports and
 * namespace re-exports (`export * from "./x"`) are the opposite and still count.
 */
const hasEmptyBindings = (
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    // No import clause means a side-effect import; a default binding is real.
    if (!clause || clause.name) return false;
    const bindings = clause.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length === 0
    );
  }

  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length === 0
  );
};

/**
 * Parse with the real file name: TypeScript infers ScriptKind from the
 * extension, so `.tsx` must be parsed as JSX. Both scanners below take the
 * same path, otherwise they would disagree about the same source file.
 */
const parseSource = (text: string, fileName: string): ts.SourceFile =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);

/** Module specifiers a file references, empty binding shells excluded. */
const importedSpecifiers = (text: string, fileName: string): string[] => {
  const source = parseSource(text, fileName);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !hasEmptyBindings(node)
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

/** Empty binding shells, i.e. imports/re-exports left behind by a move. */
const emptyBindingSpecifiers = (text: string, fileName: string): string[] => {
  const source = parseSource(text, fileName);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      hasEmptyBindings(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
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

/**
 * Both guards walk the same source tree. Cache the read once per test process:
 * the tree has ~280 files, and re-reading it for every assertion is pure IO.
 * Keys are absolute paths, which the AST scanners also use to infer ScriptKind.
 */
let cachedSourceTexts: Promise<Map<string, string>> | undefined;

const sourceTexts = (): Promise<Map<string, string>> => {
  cachedSourceTexts ??= (async () => {
    const files = (
      await Promise.all(
        sourceRoots.map((root) => listFiles(join(repositoryRoot, root))),
      )
    )
      .flat()
      .map((file) => resolve(file));
    const texts = new Map<string, string>();
    for (const file of files) texts.set(file, await readFile(file, "utf8"));
    return texts;
  })();
  return cachedSourceTexts;
};

describe("orphan source files", () => {
  it("has no source file that nothing imports", async () => {
    const texts = await sourceTexts();
    const known = new Set(texts.keys());

    const referenced = new Set<string>();
    for (const [file, text] of texts)
      for (const specifier of importedSpecifiers(text, file)) {
        const target = resolveSpecifier(file, specifier, known);
        if (target) referenced.add(target);
      }

    const entries = await scriptEntrypoints();
    const orphans: string[] = [];
    for (const file of texts.keys()) {
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

describe("empty binding shells", () => {
  it("does not mistake an empty import or re-export for a reference", () => {
    expect(
      importedSpecifiers(
        `
        import {} from "./empty-import";
        export {} from "./empty-export";
        import "./side-effect";
        export * from "./namespace";
        import { real } from "./real";
      `,
        "scan.ts",
      ),
    ).toEqual(["./side-effect", "./namespace", "./real"]);
  });

  it("parses .tsx as JSX so its imports are not misread", () => {
    const text = `
      import { Widget } from "./widget";
      export const View = () => <div><Widget /></div>;
      import { after } from "./after";
    `;
    expect(parseSource(text, "view.tsx").languageVariant).toBe(
      ts.LanguageVariant.JSX,
    );
    expect(importedSpecifiers(text, "view.tsx")).toEqual([
      "./widget",
      "./after",
    ]);
  });

  it("reports both kinds of empty binding shells", () => {
    expect(
      emptyBindingSpecifiers(
        'import {} from "./a"; export {} from "./b"; import "./c"; export * from "./d";',
        "scan.ts",
      ),
    ).toEqual(["./a", "./b"]);
  });

  it("keeps empty binding shells out of the source tree", async () => {
    const texts = await sourceTexts();
    const offenders: string[] = [];
    for (const [file, text] of texts) {
      const empties = emptyBindingSpecifiers(text, file);
      if (empties.length > 0)
        offenders.push(
          `${relative(repositoryRoot, file).split(sep).join("/")}: ${empties.join(", ")}`,
        );
    }

    expect(
      offenders,
      "`import {} from ...` 与 `export {} from ...` 都不绑定任何名字，是搬走实现后留下的空壳；" +
        "它们既没有可读性价值，又会让孤儿文件看起来仍被引用。请直接删掉。\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
