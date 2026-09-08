# 鼎江智绩 2.0 — POC Design System

## Direction

The approved north-star is a compact, white-first enterprise workspace. It is designed for consultants working at a desktop and for enterprise owners reviewing decisions and approvals. The main work area and assistant column use one shared light surface hierarchy so the UI feels like a coherent operational control surface, not a generic BI dashboard or AI chat product.

## Color

Use OKLCH tokens in implementation.

- Canvas: neutral white with only a subtle cobalt tint for structural separation.
- Surface 1: pure white primary work surface.
- Surface 2: white or blue-tinted near-white for sidebars, toolbars, selected rows, and focused detail.
- Primary: high-contrast cobalt blue, reserved for current selection, primary action, links, and focus.
- Success: emerald green with an icon and label.
- Critical and warning: vermilion red with an icon and label.
- Text: deep blue-black primary and blue-tinted secondary; all body text meets WCAG 2.2 AA.

Do not use color as the only state signal. Do not use purple, gradient text, glassmorphism, translucent card stacks, or decorative glow.

## Typography

- One Chinese sans-serif stack: `"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif`.
- Fixed product scale in rem: 0.75, 0.875, 1, 1.125, 1.5, and 2.
- Body text is at least 1rem with slightly increased line-height on dark surfaces.
- Use tabular numerals for metrics, dates, counts, and progress.
- Use semibold only for navigation, section headings, and primary labels; avoid display fonts.

## Layout and Density

- Desktop shell: persistent side navigation, compact top command bar, and one primary work area.
- Four-point spacing base with 8, 12, 16, 24, and 32 px as the dominant values.
- Cards use 8–12 px radii and crisp 1 px dividers. Never nest cards.
- Diagnosis prioritizes the major process rail. The selected node controls one child-node strip and one question list below it.
- Detail expands inline or in a drawer only when requested.
- The project middle column permanently shows only the project summary, seven-stage rail and up to three current atomic tasks. Task evidence and completion fields expand inline on demand.
- The project AI dock uses two tabs only: conversation and task proposals. Task proposals expose a restrained approve/edit pair; guided-analysis diagnostics stay out of the default surface.
- At narrow widths, the side navigation becomes a drawer, the process rail scrolls horizontally, and data rows become stacked records without hiding core actions.

## Component Vocabulary

- Primary button: solid cobalt, verb + object label.
- Secondary button: opaque navy surface with a visible border.
- Text action: cobalt text, used for navigation or low-risk actions.
- Status: icon + text label, never color alone.
- Lists and tables: aligned rows and dividers; no repeated icon-card grid.
- Dialogs: only for creation or consequential confirmation. Inline editing and undo are preferred for routine changes.
- Feedback: an aria-live toast confirms local POC state changes.

## Motion

- 100–150 ms press and hover feedback.
- 180–240 ms tabs, row expansion, drawers, and dialogs using ease-out-quart or ease-out-quint.
- No page-load choreography or decorative motion.
- Respect `prefers-reduced-motion` with instant or crossfade alternatives.

## Accessibility

- WCAG 2.2 AA contrast, visible 2 px focus rings, semantic landmarks, labels, and keyboard-operable actions.
- Touch targets are at least 44 × 44 px on coarse pointers.
- Node reordering has explicit move buttons in addition to any drag affordance.
- Dynamic state updates are announced to assistive technology.
