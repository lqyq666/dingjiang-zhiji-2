# ADR 0002: Tenant isolation lives in PostgreSQL

- Status: Accepted
- Date: 2026-11-08

## Context

鼎江智绩 2.0 is a single-enterprise system that must still separate tenants,
because the production-auth path provisions a dedicated runtime role and
database per deployment, and the acceptance fixtures create one database per
test. Every query therefore carries `tenant_id`, and every write must be scoped
to it.

The application already knows the tenant: `app.tenant_id` is a session variable
set per connection, and `runtimeTenantId()` is the only source of the tenant
identity in the code.

The alternative was to rely on the application layer: every repository method
adds `WHERE tenant_id = $1` and trusts that no query forgets it.

## Decision

Enforce isolation in the database, not only in the application.

- Every table that holds tenant data enables `FORCE ROW LEVEL SECURITY` with a
  policy keyed on `app.tenant_id`. The runtime role has no `BYPASSRLS`, so a
  forgotten predicate cannot return another tenant's rows.
- The application still writes the predicate explicitly. The policy is a second
  line of defence, not a replacement: the explicit predicate keeps query plans
  readable and keeps the database's own statistics useful for the planner.
- The runtime role is denied `INSERT`/`UPDATE`/`DELETE` on intake tables and
  denied schema modification, so a compromised application path cannot rewrite
  history or migrate the schema.

## Consequences

- A query without the tenant predicate returns nothing instead of everything.
  That is the point, but it means new queries must be written with the
  predicate or they will look "empty" rather than "wrong".
- The session variable must be set on every connection, including pools created
  outside the API (tests, the MCP adapter never connects directly).
- Reads in tests need to know the role: the local superuser bypasses RLS, so a
  test that asserts isolation must connect as the runtime role, not as
  `dingjiang`.
- Adding a new tenant-scoped table means adding a policy. The migration
  helpers exist for this; skipping them is visible in review because the table
  would be missing its `FORCE ROW LEVEL SECURITY`.
