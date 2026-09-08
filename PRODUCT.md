# Product

## Register

product

## Users

The Web platform serves enterprise owners and managers reviewing operational events, progress, evidence and business results. Employees perform business actions in WorkBuddy through MCP, with server-bound identity and project authorization.

## Product Purpose

Web is the read-only record and source-tracing surface. It shows what happened, the recorded status, responsible people, evidence versions and measured business results. WorkBuddy is the action surface: provide facts, record progress, confirm results. The assistant assembles known technical fields and asks only for missing factual inputs.

PostgreSQL is the sole business fact source. API mutations commit state, immutable sources and audit receipts together. Web refreshes those facts every 15 seconds and on focus, retaining the last successful view with a stale warning on failure. Proposals remain proposals until the responsible person's explicit decision is recorded under the correct server role.

## Brand Personality

Restrained, trustworthy, professional.

The product should feel like a calm management-consulting workspace combined with an enterprise operating system and a modern production tool. It should communicate expert confidence, evidence discipline, and industrial clarity rather than technological spectacle.

## Confirmed Visual Direction

The desktop product uses a white-first enterprise workspace with a restrained cobalt-blue action and navigation accent. The main workspace and assistant column share the same white and blue-tinted neutral surface hierarchy; crisp dividers, compact Chinese typography, and sparse semantic green / vermilion states add meaning without decorative color, glass effects, or glow.

The product's signature structural motif is the evidence-to-action chain: fact → evidence → validation → action. Process records are grouped into collapsible stages. The current stage opens by default; historical and future stages remain available for inspection.

## Anti-references

This should not resemble a generic AI SaaS dashboard, CRM template, chatbot, KPI-card wall, or neon automation product. Avoid interfaces dominated by blue-purple gradients, magic-wand metaphors, decorative charts, excessive badges, oversized rounding, nested cards, or AI chat as the default interaction model.

If changing the logo would make the interface look like an ordinary finance or CRM product, the design is not specific enough to 鼎江's diagnosis, evidence, validation, and improvement workflow.

## Design Principles

1. **Evidence before confidence.** Every material conclusion exposes its classification and a direct path to the supporting source.
2. **Accountable status.** Each record shows its current state, responsible role and supporting source. WorkBuddy handles the next action.
3. **Progressive operational depth.** Use plain business language first; reveal FACT, INFERENCE, SourceVersion, PromptVersion, and audit detail only when needed.
4. **Human confirmation is visible.** AI proposals remain proposals until an authorized person reviews and confirms the state transition.
5. **Role-appropriate density.** Consultants receive the full working context; owners see decisions, risks, results, and approvals without diagnostic implementation noise.

## Task and approval model

The lifecycle remains a process record. Users browse event facts and materials, project process, measured outcomes and change history in Web. Business forms, inline AI chat, generated task acceptance and approval buttons do not appear on Web. A context-copy control lets users continue in WorkBuddy without inventing an unsupported desktop deep link.

WorkBuddy reads the current operation context before writing. Routine records follow the employee's explicit instruction. Plan finalization requires the authorized owner; formal experience publication requires the authorized expert. Human confirmation text records the user's instruction and is not a separate authenticated human signature.

## Accessibility & Inclusion

Meet WCAG 2.2 AA for the product surfaces. All workflows must support keyboard navigation, visible focus, semantic labels, and screen-reader-readable status changes. Color cannot be the only carrier of severity, progress, confidence, or approval state. Motion must respect `prefers-reduced-motion`. Chinese business text must remain readable at common Windows display scaling and at narrow responsive widths.
