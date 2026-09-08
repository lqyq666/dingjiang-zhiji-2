# ADR 0001: Repository foundation

- Status: Accepted
- Date: 2026-08-15

## Context

鼎江智绩 2.0 is a new system rather than an in-place rewrite of 1.x. It needs independently deployable runtime processes while preserving low change radius for a Founder-led, AI-assisted development workflow.

## Decision

Use a pnpm and Turborepo monorepo with four runtime entries: Next.js Web, NestJS API, TypeScript Worker, and Python/FastAPI ML service. Start with only two shared packages: contracts and shared-kernel. Add business packages when their first real use case arrives.

Use module-root exports and executable architecture tests. Keep PostgreSQL as the future fact source, but create no Phase 0.2 schema during repository foundation.

## Consequences

- Each runtime can start and build independently.
- Shared transport validation has one explicit interface.
- Package proliferation is deferred until behavior exists.
- Python uses uv beside pnpm; CI must install both toolchains.
- Phase 0.2 must add explicit SQL migrations and tenant isolation tests before business data is introduced.
