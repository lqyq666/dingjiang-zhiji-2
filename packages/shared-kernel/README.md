# shared-kernel

Purpose: owns a very small set of stable concepts shared across business modules.

Owns: stable identifiers and value types with cross-domain meaning.

Does not own: diagnosis helpers, order utilities, persistence, or framework integration.

Public interface: `src/public.ts`, published through the package root.

Dependencies: none.

Invariant: a concept enters this module only after more than one business module needs the same meaning.

Verify: `pnpm --filter @dingjiang/shared-kernel test && pnpm --filter @dingjiang/shared-kernel build`.
