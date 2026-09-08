# contracts

Purpose: owns versionable transport schemas shared by runtime boundaries.

Owns: Zod request and response schemas plus inferred transport types.

Does not own: business rules, persistence models, authorization, or vendor payloads.

Public interface: `src/public.ts`, published through the package root.

Dependencies: schema libraries only.

Invariant: every runtime payload is validated before becoming trusted application input.

Verify: `pnpm --filter @dingjiang/contracts test && pnpm --filter @dingjiang/contracts build`.
