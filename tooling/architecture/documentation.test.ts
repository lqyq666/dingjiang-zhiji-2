import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
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

  it("counts the consulting stages the way the code does", async () => {
    // The stages are defined in one place. A document that says "five
    // stages" when the code has seven is a document nobody should trust,
    // and it is exactly the kind of drift a reader cannot notice.
    const stagesSource = await readFile(
      join(repositoryRoot, "apps/api/src/work-stages.ts"),
      "utf8",
    );
    const namesBlock = stagesSource.slice(
      stagesSource.indexOf("export const workStageNames = {"),
    );
    const stageCount = (
      namesBlock.slice(0, namesBlock.indexOf("}")).match(/^[ \t]*[A-Z_]+:/gm) ??
      []
    ).length;
    expect(stageCount).toBeGreaterThan(0);

    const chineseDigits: Record<string, number> = {
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const parseCount = (token: string): number | undefined => {
      if (/^\d+$/.test(token)) return Number(token);
      if (token.length === 1) return chineseDigits[token];
      if (token.startsWith("十"))
        return 10 + (chineseDigits[token.slice(1)] ?? 0);
      if (token.endsWith("十"))
        return (chineseDigits[token.slice(0, -1)] ?? 0) * 10;
      return undefined;
    };

    const mismatched: string[] = [];
    for (const file of [
      "README.md",
      "docs/architecture/system-overview.md",
      "CONTEXT.md",
    ]) {
      const text = await readFile(join(repositoryRoot, file), "utf8");
      for (const match of text.matchAll(
        /(?<![第每前])([零一二三四五六七八九十]+|\d+)\s*个?\s*阶段/g,
      )) {
        const token = match[1];
        if (!token) continue;
        const stated = parseCount(token);
        if (stated === undefined || stated === stageCount) continue;
        mismatched.push(
          `${file}: 写着「${match[0].trim()}」，代码里是 ${stageCount} 个阶段`,
        );
      }
    }

    expect(
      mismatched,
      "文档里的阶段数与代码不一致。请改文档，别改数字了事。\n" +
        mismatched.join("\n"),
    ).toEqual([]);
  });

  it("counts the tables, the migrations and the tools the way the code does", async () => {
    // Numbers in a document rot silently. A table count is cheap to derive
    // from the migrations and a tool count from the tool registry, so there
    // is no reason for a reader to have to trust the prose.
    const migrationDirectory = join(repositoryRoot, "apps/api/migrations");
    const migrationFiles = (await readdir(migrationDirectory)).filter((name) =>
      name.endsWith(".sql"),
    );
    const tables = new Set<string>();
    for (const name of migrationFiles) {
      const text = await readFile(join(migrationDirectory, name), "utf8");
      for (const match of text.matchAll(
        /CREATE TABLE (?:IF NOT EXISTS )?"?([a-z0-9_.]+)"?/gi,
      ))
        if (match[1]) tables.add(match[1].toLowerCase());
    }

    const protocol = await readFile(
      join(repositoryRoot, "services/dingjiang-mcp/src/protocol.ts"),
      "utf8",
    );
    const tools = (protocol.match(/^ {4}name: "[a-z_.]+"/gm) ?? []).length;

    const expectations: Array<{
      label: string;
      actual: number;
      pattern: RegExp;
    }> = [
      {
        label: "张表",
        actual: tables.size,
        pattern: /(\d+)\s*张表/g,
      },
      {
        label: "个迁移",
        actual: migrationFiles.length,
        pattern: /迁移\s*(\d+)\s*个/g,
      },
      {
        label: "个工具",
        actual: tools,
        pattern: /MCP Server，(\d+)\s*个工具/g,
      },
    ];

    const mismatched: string[] = [];
    for (const file of ["README.md", "docs/architecture/system-overview.md"]) {
      const text = await readFile(join(repositoryRoot, file), "utf8");
      for (const expectation of expectations)
        for (const match of text.matchAll(expectation.pattern)) {
          const stated = Number(match[1]);
          if (stated === expectation.actual) continue;
          mismatched.push(
            `${file}: 写着「${match[0].trim()}」，代码里是 ${expectation.actual} ${expectation.label}`,
          );
        }
    }

    expect(
      mismatched,
      "文档里的数量与代码不一致。请改文档，别改数字了事。\n" +
        mismatched.join("\n"),
    ).toEqual([]);
  });

  it("keeps the facade line count in step with the code and the ratchet", async () => {
    // Three places state how big the facade is: the file itself, the
    // architecture note (heading and ratchet history), and the growth ratchet
    // in boundaries.test.ts. All three were written by hand, so all three can
    // drift. Derive the truth from the file and hold them to it.
    const facade = await readFile(
      join(repositoryRoot, "apps/api/src/vs01.service.ts"),
      "utf8",
    );
    const actualLines = facade.split("\n").length - 1;

    const overview = await readFile(
      join(repositoryRoot, "docs/architecture/system-overview.md"),
      "utf8",
    );
    const mismatched: string[] = [];
    const check = (label: string, stated: string | undefined): void => {
      if (stated === undefined) {
        mismatched.push(`${label}: 找不到门面行数的声明`);
      } else if (Number(stated) !== actualLines) {
        mismatched.push(
          `${label}: 写着 ${stated} 行，apps/api/src/vs01.service.ts 实际是 ${actualLines} 行`,
        );
      }
    };

    check(
      "docs/architecture/system-overview.md 8.1 标题",
      overview.match(/vs01\.service\.ts`[：:]\s*(\d+)\s*行/)?.[1],
    );
    check(
      "docs/architecture/system-overview.md 棘轮历史末项",
      overview
        .match(/预算随每次拆分同步下调（([^）]+)）/)?.[1]
        ?.split("→")
        .pop()
        ?.trim(),
    );

    const ratchet = await readFile(
      join(repositoryRoot, "tooling/architecture/boundaries.test.ts"),
      "utf8",
    );
    check(
      "tooling/architecture/boundaries.test.ts 预算",
      ratchet.match(/const budget = (\d+);/)?.[1],
    );

    expect(
      mismatched,
      "门面行数在代码、文档与尺寸棘轮之间对不上了。\n" + mismatched.join("\n"),
    ).toEqual([]);
  });

  it("keeps the dependency graph counts in the README honest", async () => {
    // Run the same analyzer CI runs, but ask for JSON. A README quoting
    // yesterday's graph size is worse than one quoting no size at all.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(
          repositoryRoot,
          "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
        ),
        "apps",
        "packages",
        "services",
        "tooling",
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "json",
      ],
      { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const graph = JSON.parse(stdout) as {
      modules: Array<{ dependencies?: unknown[] }>;
    };
    const modules = graph.modules.length;
    const dependencies = graph.modules.reduce(
      (total, module) => total + (module.dependencies?.length ?? 0),
      0,
    );
    expect(modules, "依赖分析器没有扫到任何模块，守卫会空转").toBeGreaterThan(
      0,
    );

    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const stated = readme.match(/当前扫描 (\d+) 个模块、(\d+) 条依赖/);
    expect(
      stated?.[1],
      `README 里的模块数与实际依赖图不符：实际 ${modules} 个模块`,
    ).toBe(String(modules));
    expect(
      stated?.[2],
      `README 里的依赖数与实际依赖图不符：实际 ${dependencies} 条依赖`,
    ).toBe(String(dependencies));
    // The analyzer walks the whole graph. It takes ~3s locally and longer on
    // a cold CI runner, so it needs more than vitest's 5s default.
  }, 30_000);

  it("keeps the documented switch count in step with the orchestrator", async () => {
    const suite = await readFile(
      join(repositoryRoot, "scripts/testing/run-integration-suite.mjs"),
      "utf8",
    );
    const block = suite.match(/const switches = \{[\s\S]*?\n\};/)?.[0] ?? "";
    const actual = (block.match(/_INTEGRATION:/g) ?? []).length;
    expect(actual, "没解析到任何开关，守卫会空转").toBeGreaterThan(0);

    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const stated = readme.match(/(\d+) 个开关全开/)?.[1];
    expect(
      stated,
      `README 说 ${stated} 个开关，编排脚本里实际有 ${actual} 个`,
    ).toBe(String(actual));
  });
});
