/**
 * Architecture boundary rules, enforced on every push.
 *
 * These encode the boundaries the README and docs/architecture/system-overview.md
 * state in prose: Web talks to the API over HTTP, the MCP adapter talks to the
 * API over HTTP and never touches the database, contracts carry no
 * implementation, and the API never depends back on an entry point.
 *
 * Every rule below already holds today. The point is that it keeps holding:
 * a boundary that only exists in a document is one refactor away from being
 * gone.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-web-to-api",
      severity: "error",
      comment:
        "Web 只通过 HTTP 调用 API，不得 import 服务端实现。两个入口各写一套，治理规则迟早分叉。",
      from: { path: "^apps/web" },
      to: { path: "^apps/api" },
    },
    {
      name: "no-web-to-database",
      severity: "error",
      comment:
        "Web 不得直接依赖数据库驱动。PostgreSQL 是唯一业务事实源，但只有 API 能碰它。",
      from: { path: "^apps/web" },
      to: { path: "^pg$" },
    },
    {
      name: "no-mcp-to-api",
      severity: "error",
      comment:
        "MCP 适配层不得 import API 实现，它通过真实 HTTP 调用受治理写入口。",
      from: { path: "^services/dingjiang-mcp" },
      to: { path: "^apps/api" },
    },
    {
      name: "no-mcp-to-database",
      severity: "error",
      comment: "MCP 不直连数据库，也不持有维护凭据。只读工具与写工具都走 API。",
      from: { path: "^services/dingjiang-mcp" },
      to: { path: "^pg$" },
    },
    {
      name: "no-contracts-to-implementation",
      severity: "error",
      comment:
        "跨服务公开合同不得依赖任何实现。合同里出现实现细节，调用方就被绑死了。",
      from: { path: "^packages/contracts" },
      to: { path: "^(apps|services)/" },
    },
    {
      name: "no-api-to-entries",
      severity: "error",
      comment: "API 不得反向依赖入口层，依赖方向只能是入口 → API → 事实源。",
      from: { path: "^apps/api" },
      to: { path: "^(apps/web|services/dingjiang-mcp)" },
    },
    {
      name: "no-runtime-to-tooling",
      severity: "error",
      comment:
        "运行时代码不得依赖 tooling 下的架构守卫与脚手架，那是给仓库自身用的。",
      from: { path: "^(apps|services|packages)/" },
      to: { path: "^tooling/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|\\.next|coverage)/" },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "tsconfig.base.json" },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+(/.*)?",
      },
    },
  },
};
