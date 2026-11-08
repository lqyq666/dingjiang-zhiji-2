# ADR 0007: Performance work ships with a repeatable comparison

- Status: Accepted
- Date: 2026-11-08

## Context

Three read paths in this system were falling back to sequential scans. The
symptom was not a crash: every query returned the right answer. The cost was
paid per user action - every phase transition asks the subtask count two or
three times - so the price was invisible in the UI and unavoidable in aggregate.

They were found by reading the database's own statistics
(`pg_stat_user_tables`, comparing `seq_scan` against `idx_scan`) and then
checking `pg_indexes` to confirm the predicate had no index at all. A high
scan count alone proves nothing: a three-row table is supposed to be scanned.

The fix was three indexes and a change of about 380 lines, but the measurement
behind it was a one-off. It needed a throwaway database, a synthetic data set
of a known shape and a careful `EXPLAIN ANALYZE` run. Nobody could repeat it,
which means nobody could check whether it was still true.

## Decision

Ship the measurement with the fix.

- `scripts/bench/project-read-path.mjs` builds its own database, applies the
  real migration files, fills it with 300 projects / 100k subtasks / 200k
  events / 200k materials, then measures each of the three reads twice: once
  with the read-path indexes dropped, once with them in place. Each read runs
  three times and the fastest is kept.
- The script reports the plan change, not only the duration, so a reader can
  see that the improvement is `Seq Scan` to `Index Scan` and not a cache
  effect.
- `pnpm bench:read-path` runs it. The README states the numbers and says
  plainly that absolute figures depend on the machine, while the
  before/after comparison on one machine is what is reproducible.
- The index audit test (`read-path-indexes.integration.test.ts`) asserts the
  shape of the indexes rather than a plan. Plan choice is a cost decision,
  and on a small data set a sequential scan is the correct answer.

## Consequences

- Deleting an index now has a visible cost: the benchmark shows it and the
  audit test fails. Before, removing an index changed nothing observable
  except latency, which is why the problem could sit unnoticed.
- Writing the script surfaced a constraint the original one-off had
  overlooked: `vs01_project_nodes.project_id` is unique, so a project has
  exactly one node and subtasks hang off that node.
- The synthetic data set is deliberately not production data. The question is
  "is the index correct without data skew", and a shape that is known and
  reproducible answers it better than a snapshot that changes.
- The script needs a reachable PostgreSQL and nothing else - no model
  credential, no Feishu application.
