## Task Contract

- Issue:
- Contract path:
- Base commit:
- Head commit:

## Outcome and scope

- Required outcome:
- Exact changed paths:
- Out-of-scope paths verified unchanged:

## Evidence

| Gate                        | Result | Evidence |
| --------------------------- | ------ | -------- |
| `pnpm control-plane:check`  |        |          |
| `pnpm lint`                 |        |          |
| `pnpm typecheck`            |        |          |
| `pnpm test`                 |        |          |
| `pnpm build`                |        |          |
| `pnpm format:check:changed` |        |          |
| Runtime/acceptance          |        |          |

## Risk and external actions

- Authorization/tenant/data-integrity impact:
- Migration and rollback:
- External actions executed:
- External actions explicitly not executed:

## Review checklist

- [ ] Task Contract is frozen and this diff stays within its allowed paths.
- [ ] Facts, inference, assumptions and open questions are distinguished where material.
- [ ] No literal secret appears in source, logs, evidence, Issue or PR text.
- [ ] No direct or force push to `main` was used.
- [ ] Production deployment, production data and production authentication actions are explicitly recorded with their recovery evidence.
- [ ] BLOCKER/HIGH findings have completed no more than two automatic repair loops; only genuine strategic or hard-safety decisions are escalated.
- [ ] CI success is reported as validation, not as product or business final acceptance.
