#!/usr/bin/env node
/**
 * Generate the API surface document from the controllers.
 *
 * The controllers are the truth about which HTTP routes exist. This script
 * reads them with the TypeScript parser - not with a regular expression -
 * and writes what it finds to docs/api-surface.md, so the documented surface
 * cannot drift away from the implemented one without the guard test in
 * tooling/architecture/api-surface.test.ts noticing.
 *
 * Usage:
 *   node scripts/docs/api-surface.mjs          # write docs/api-surface.md
 *   node scripts/docs/api-surface.mjs --json   # print the routes as JSON
 *   node scripts/docs/api-surface.mjs --check  # fail if the document is stale
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const apiSrc = join(root, "apps/api/src");
const documentPath = join(root, "docs/api-surface.md");

const HTTP_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete"]);

const listFiles = async (directory, suffix) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, suffix)));
    else if (entry.name.endsWith(suffix)) files.push(path);
  }
  return files.sort();
};

/** The literal string argument of a decorator, or "" when it has none. */
const decoratorPath = (decorator) => {
  const call = decorator.expression;
  if (!ts.isCallExpression(call)) return "";
  const [first] = call.arguments;
  if (!first || !ts.isStringLiteral(first)) return "";
  return first.text;
};

const decoratorName = (decorator) => {
  const call = decorator.expression;
  const target = ts.isCallExpression(call) ? call.expression : call;
  if (!ts.isIdentifier(target)) return "";
  return target.text;
};

const globalPrefix = async () => {
  const main = await readFile(join(apiSrc, "main.ts"), "utf8");
  const match = main.match(/setGlobalPrefix\(\s*"([^"]*)"/);
  return match ? match[1] : "";
};

const collect = async (prefix) => {
  const files = await listFiles(apiSrc, ".controller.ts");
  const groups = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const routes = [];

    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controller = (ts.getDecorators(statement) ?? []).find(
        (decorator) => decoratorName(decorator) === "Controller",
      );
      if (!controller) continue;
      const controllerPath = decoratorPath(controller);

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        for (const decorator of ts.getDecorators(member) ?? []) {
          const name = decoratorName(decorator);
          if (!HTTP_DECORATORS.has(name)) continue;
          const path = decoratorPath(decorator);
          routes.push({
            method: name.toUpperCase(),
            path: `/${[prefix, controllerPath, path].filter(Boolean).join("/")}`,
            handler: member.name.getText(source),
            file: relative(root, file).split("\\").join("/"),
          });
        }
      }

      if (routes.length)
        groups.push({
          controller: statement.name?.text ?? "",
          routes,
          file: relative(root, file).split("\\").join("/"),
        });
    }
  }

  return groups;
};

const render = (groups) => {
  const total = groups.reduce((sum, group) => sum + group.routes.length, 0);
  const lines = [
    "# API 接口面",
    "",
    "本文件由 `node scripts/docs/api-surface.mjs` 从控制器源码生成，请勿手工编辑。",
    "`tooling/architecture/api-surface.test.ts` 会在每次测试时核对它与代码是否一致。",
    "",
    `共 ${total} 个路由。`,
    "",
  ];
  for (const group of groups) {
    lines.push(
      `## ${group.controller}`,
      "",
      `来源：\`${group.file}\``,
      "",
      "| 方法 | 路径 | 处理函数 |",
      "| --- | --- | --- |",
    );
    for (const route of group.routes)
      lines.push(
        `| ${route.method} | \`${route.path}\` | \`${route.handler}\` |`,
      );
    lines.push("");
  }
  return { markdown: lines.join("\n"), total };
};

const main = async () => {
  const prefix = await globalPrefix();
  const groups = await collect(prefix);
  if (process.argv.includes("--json")) {
    const flat = groups.flatMap((group) => group.routes);
    console.log(JSON.stringify(flat, null, 2));
    return;
  }

  const { markdown, total } = render(groups);
  const formatted = await format(markdown, {
    ...(await resolveConfig(documentPath)),
    filepath: documentPath,
  });
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = await readFile(documentPath, "utf8");
    } catch {
      current = "";
    }
    if (current.replaceAll("\r\n", "\n").trim() !== formatted.trim()) {
      console.error(
        "docs/api-surface.md 与控制器不一致，请运行 `node scripts/docs/api-surface.mjs` 重新生成。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`docs/api-surface.md 与 ${total} 个路由一致`);
    return;
  }

  await writeFile(documentPath, formatted, "utf8");
  console.log(`已写入 ${relative(root, documentPath)}：${total} 个路由`);
};

await main();
