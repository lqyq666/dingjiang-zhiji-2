# System invariants

These rules define correctness across every milestone.

1. PostgreSQL is the only business fact source.
2. Authorization runs before retrieval, and tenant isolation is enforced again by PostgreSQL RLS.
3. LLM output is not a fact. Store it as an inference, assumption, open question, or proposed action until a person or deterministic rule verifies it.
4. Every fact links to evidence; every evidence locator resolves to an immutable SourceVersion and its SourceObject.
5. SourceVersion history is append-only. A changed source creates a new version and preserves the old version.
6. AI work records input references, prompt version, provider configuration, structured output, status, and failure details so it can be audited and replayed.
7. Web calls the API. Domain code is independent from NestJS, Drizzle, model SDKs, and transport details.
8. Cross-package imports use the package root. Architecture tests enforce dependency direction.
9. Vendor-dependent behavior enters through a seam only when a real alternative or test adapter exists.
10. Codex may perform ordinary remote deployment within a frozen Task Contract and must retain deployment and online-verification evidence. Production database or authentication changes require a controlled change, recovery path and audit evidence; new paid purchases, Secret exposure, unrecoverable important remote deletion, contracts and material customer commitments remain hard boundaries.
