# ADR 0004: The integration suite is layered, and the outer layers run real processes

- Status: Accepted
- Date: 2026-11-08

## Context

About ninety tests in this repository need a real PostgreSQL: the governed
command kernel, material intake, evidence confirmation, workpaper proposals,
the production-auth roles and the end-to-end path. They sit behind
`*_INTEGRATION=1` switches, so a plain `pnpm test` skips them. That is
convenient locally and dangerous on CI, because the default run says nothing
about whether the system actually works.

Running them was also awkward. Three of them refuse to run against a shared
database because they reset it, and they cannot run in parallel against one
database. Knowing which switch belongs to which file, which database each one
demands, and what order they must run in was tribal knowledge.

The outer layers face a second question: what does "end to end" mean when the
system has three entry points - a Next.js web app, a NestJS API and an MCP
adapter? A test that calls a handler in-process proves the handler works. It
does not prove the entry point works.

## Decision

One script owns the knowledge, and the suite is layered by how much of the
system it actually starts.

- `scripts/testing/run-integration-suite.mjs` runs five tiers and fails the
  whole run if any tier fails.
- tier1 runs every API test file with all switches on, serially, against one
  shared database - serially because these tests reset it.
- tier2 and tier3 give VS17 and VS18 their own databases, because they are
  allowed to reset those.
- tier4 spawns the built MCP server and the built API as separate processes
  and talks to them over real HTTP with a bearer token. Nothing is mocked: it
  checks `initialize` and `tools/list` metadata, that an unauthorised write is
  rejected, that a governed write succeeds, that a replayed `requestId`
  returns the original receipt, that a stale `expectedVersion` is rejected,
  and then it reads the database back to confirm exactly one fact and one
  receipt were written.
- tier5 drives `apps/web/src/app/lib/vs01-api.ts` - the shipped data layer,
  not a rewrite of it - against a real API process, letting the function's own
  Zod parsing decide whether the contract still holds.
- `pnpm verify` runs everything, and both CI jobs are required checks on
  `main`.

## Consequences

- A developer needs a running PostgreSQL to run the full suite. That is a real
  cost, paid back by not having to remember which flag goes with which file.
- CI is slower than a unit-only run, which is the intended trade: the
  database-backed paths are where the governance rules live.
- The layers are not interchangeable. A behaviour test that does not need a
  database should not get one, because it would be slow and would reset state
  other tests depend on.
- tier4 and tier5 need build artefacts. The script fails early with a clear
  message when `dist/` is missing, rather than failing inside a spawn.
- The web data layer is driven directly instead of through a browser. The page
  is client-rendered, so scraping HTML would prove almost nothing; what
  actually breaks is the contract between the data layer and the API, and the
  data layer is ordinary TypeScript that can be called.
