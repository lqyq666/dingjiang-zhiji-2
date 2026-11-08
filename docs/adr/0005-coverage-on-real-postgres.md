# ADR 0005: Coverage is measured against a real PostgreSQL, not the unit layer

- Status: Accepted
- Date: 2026-11-08

## Context

The API package has roughly a hundred test files. About ninety of them need a
database and sit behind `*_INTEGRATION=1`, so `vitest run` without a database
executes the remaining handful and skips the rest.

That produces a coverage number of about 33%, and the number is not a lie about
the code - it is a lie about what was measured. The governed command kernel,
the material and evidence commands, the workpaper proposals: all of them are
skipped, because they are exactly the parts that need PostgreSQL.

Reporting 33% would be the worst option: it understates what the suite
actually exercises, and it invites the reader to believe the uncovered parts
are unimportant when they are the opposite.

## Decision

Measure coverage where the behaviour lives, and gate on that.

- `pnpm test:coverage` runs tier1 - every API test file with all switches on,
  against a real PostgreSQL - with the v8 coverage provider.
- Thresholds live in `apps/api/vitest.config.mts`: lines 70, statements 70,
  functions 75, branches 60. The measured values sit just above them, with
  room for small movements.
- CI runs it in the `integration` job, right after the full suite, so the
  number is produced on every push rather than on request.
- The unit-only coverage script still exists for fast local feedback, but it
  is not the gate, and the README says which one is which.

## Consequences

- The coverage run needs a database and takes about a minute. That is the same
  database the integration job already provides, so CI pays it once.
- A dropped test in an integration file lowers the number and fails the build,
  which is the intended behaviour: it means the behaviour it covered is no
  longer verified.
- Coverage is a floor, not a goal. Hitting 100% would mean testing defensive
  branches that cannot fail in a meaningful way. The interesting number for a
  reviewer is not the percentage but which paths are uncovered and why.
- The thresholds are deliberately not at the measured values. Setting them
  exactly at the current numbers would fail on any unrelated change that
  shifted a line; setting them just below keeps the promise "do not regress"
  without making the build brittle.
