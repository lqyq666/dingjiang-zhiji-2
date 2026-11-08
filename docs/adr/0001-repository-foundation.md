# ADR 0001: Repository foundation

- Status: Accepted
- Date: 2026-08-15

## Context

鼎江智绩 2.0 is a new system rather than an in-place rewrite of 1.x. It needs independently deployable runtime processes while preserving low change radius for a Founder-led, AI-assisted development workflow.

## Decision

Use a pnpm and Turborepo monorepo with three runtime entries: Next.js Web, NestJS API, and the WorkBuddy MCP adapter. Start with one shared package (contracts); add business packages when their first real use case arrives. The Worker and ML service were part of the original four-entry plan, but their first use case never arrived, so their empty shells were removed in favour of honest boundaries rather than scaffolding that pretends to run.

Use module-root exports and executable architecture tests. Keep PostgreSQL as the future fact source, but create no Phase 0.2 schema during repository foundation.

## Consequences

- Each runtime can start and build independently.
- Shared transport validation has one explicit interface.
- Package proliferation is deferred until behavior exists.
- Phase 0.2 must add explicit SQL migrations and tenant isolation tests before business data is introduced.
