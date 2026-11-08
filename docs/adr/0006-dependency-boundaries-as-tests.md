# ADR 0006: Architectural boundaries are enforced by a tool, not by prose

- Status: Accepted
- Date: 2026-11-08

## Context

The repository states its boundaries in the README and in
`docs/architecture/system-overview.md`:

- Web calls the API over HTTP; it does not import server code.
- The MCP adapter talks to the API over HTTP and never touches the database.
- `packages/contracts` carries the public contract and nothing else.
- The API never depends back on an entry point.

Those are the boundaries that keep two entry points from drifting into two
implementations. They were also, until now, only sentences. Nothing failed if
someone imported `Vs01Service` into the web app, and nothing said so.

The same problem has a second face: parts of the repository that look like
features but are not. A worker package that printed a ready status, a shared
kernel with one unused type, an ML service with a health endpoint, a `supabase`
directory with no migrations behind it. They were easy to mistake for working
subsystems, and in a public repository they are exactly what a reviewer opens
first.

## Decision

Encode the boundaries as rules a tool enforces, and delete what only looks
like functionality.

- `.dependency-cruiser.cjs` defines seven forbidden dependency rules, one per
  stated boundary, all at `severity: "error"`.
- `pnpm depcruise` runs them and is part of `pnpm verify` and the CI verify
  job.
- The rules were verified to actually fail: injecting a Web file that imports
  the API and a contracts file that imports an implementation produced exit
  code 2 with the offending paths named, and the run returned to green once
  the files were removed. Default severity would have printed warnings and
  exited 0, which would have made the gate decorative.
- The four empty shells were deleted rather than documented: an empty package
  is not a feature, and a repository that claims a microservice it does not
  have is harder to defend than one that claims less.
- The planning intent was not discarded. ADR 0001 now records that the worker
  and ML service were part of the original four-entry plan and were removed
  because their first real use case never arrived.

## Consequences

- The boundary set is explicit and reviewable. Changing it means editing a
  config file with a comment, which shows up in the diff.
- Cross-package imports of shared packages are still allowed - `contracts` is
  imported by the API, the web app and the MCP adapter. Only directions that
  would duplicate or invert a boundary are forbidden.
- The dependency graph is checked on every push, so a new dependency that
  crosses a line is caught by CI rather than by whoever notices later.
- Deleting the shells changed the CI matrix: no Python toolchain is installed
  any more, because there is no Python service to build.
