# ADR 0003: Idempotency comes from requestId plus an advisory lock

- Status: Accepted
- Date: 2026-11-08

## Context

Several writes in this system are not safe to retry blindly: material import
stages a file, imports a task decision, submits a project for approval. The MCP
adapter is an AI client - the same logical request can arrive twice, and a
host may retry on a timeout where the first attempt actually succeeded.

The usual implementation is "look up the request id, and if it is absent,
insert it". That is wrong under concurrency: two requests that arrive together
both find nothing and both perform the effect.

## Decision

Bind every governed write to a caller-supplied `requestId`, and serialise
concurrent attempts on that key inside the database.

- The receipt table has `UNIQUE(tenant_id, command_name, request_id)`. A
  replayed command returns the original receipt instead of writing again.
- Before checking the receipt, the command takes
  `pg_advisory_xact_lock(hashtextextended(tenant:command:requestId))`. Same
  key, same transaction, so the second attempt waits and then finds the
  receipt the first one wrote.
- The payload fingerprint is stored with the receipt. A replay that carries a
  different payload is rejected instead of being silently treated as the same
  request.
- The lock is transaction-scoped, so it is released by `COMMIT`/`ROLLBACK`
  and cannot be left dangling by a crashed process.

## Consequences

- The lock must be taken before the receipt read, not after. The order is the
  whole mechanism: read-then-lock still lets both attempts pass the read.
- `expectedVersion` still guards against a stale write; `requestId` guards
  against a duplicate. They answer different questions and both are needed.
- The advisory lock is database-scoped, which is enough here because there is
  one database and one API process family. A multi-region deployment would
  need a different mechanism, and that would be a new ADR rather than a
  change to this one.
- The receipt lookup is on the hot path of every governed write, so the
  unique index is load-bearing. Its removal would not fail any behaviour test
  that only checks happy paths, which is why the concurrency case is asserted
  with four simultaneous requests that arrive before any receipt exists.
