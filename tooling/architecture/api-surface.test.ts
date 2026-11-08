import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const script = join(repositoryRoot, "scripts/docs/api-surface.mjs");
const documentPath = join(repositoryRoot, "docs/api-surface.md");

interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
}

const readRoutes = async (): Promise<Route[]> => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [script, "--json"],
    { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Route[];
};

const key = (route: Route) =>
  `${route.method} ${route.path} -> ${route.handler}`;

describe("api surface document", () => {
  it("documents exactly the routes the controllers expose", async () => {
    const routes = await readRoutes();
    expect(
      routes.length,
      "控制器里应当有八十个以上的路由。如果这个数字接近 0，问题出在解析器而不是代码，" +
        "而空的文档也会让下面的比对变成空对空。",
    ).toBeGreaterThanOrEqual(80);

    const document = await readFile(documentPath, "utf8");
    const documented = new Set(
      [
        ...document.matchAll(
          /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/gm,
        ),
      ].map((match) => `${match[1]} ${match[2]} -> ${match[3]}`),
    );
    const implemented = new Set(routes.map(key));

    expect(
      [...implemented].filter((entry) => !documented.has(entry)),
      "这些路由存在于控制器里，但 docs/api-surface.md 没有写。" +
        "请运行 `node scripts/docs/api-surface.mjs` 重新生成。",
    ).toEqual([]);
    expect(
      [...documented].filter((entry) => !implemented.has(entry)),
      "docs/api-surface.md 里写了这些路由，但控制器里已经没有。" +
        "请运行 `node scripts/docs/api-surface.mjs` 重新生成。",
    ).toEqual([]);
  });
});
