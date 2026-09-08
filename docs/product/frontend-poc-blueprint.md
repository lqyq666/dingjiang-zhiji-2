# 鼎江智绩 2.0 — Frontend POC Blueprint

Approved visual references:

- [Palette](./assets/poc-palette.png)
- [North-star workspace](./assets/poc-north-star.png)

## Confirmed product decisions

- Primary surface: consultant and project-manager workspace.
- Project launch: consultant creates and submits a draft; an enterprise-responsible user confirms launch.
- Accessibility: WCAG 2.2 AA, keyboard-first fallbacks, color-blind-safe states, and reduced motion.
- Visual direction: deep navy dark workspace with a cobalt action accent.
- Diagnosis hierarchy: configurable major process nodes → node-specific child nodes → node-specific question checklist.

## Primary navigation

| Surface              | Purpose                                                             | Primary action                      |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Home                 | See the priority operational problem and accountable next action    | View diagnosis                      |
| Diagnosis            | Move a problem through evidence-backed configurable process nodes   | Start validation                    |
| Improvement projects | Turn an actionable diagnosis into an approved execution plan        | Submit launch approval              |
| Enterprise data      | See source health and demonstrate adding a source                   | Add data source                     |
| Experience library   | Reuse approved experience without treating it as current fact       | Cite in diagnosis                   |
| Approval center      | Review launch and experience decisions assigned to the current role | Confirm launch / approve experience |

## Diagnosis interaction hierarchy

```text
经营改善流程
├─ 发现问题
├─ 核对事实
├─ 验证原因
│  ├─ 候选原因
│  │  ├─ BOM 准备是否晚于生产排程要求？
│  │  ├─ 关键物料到货延迟是否影响开工？
│  │  ├─ 产能负荷是否超过安全区间？
│  │  └─ 延期订单是否集中在特定产品族？
│  ├─ 验证计划
│  └─ 验证结论
├─ 形成方案
├─ 执行改善
└─ 结果验证
```

Major-node controls: Add node, edit name/description, move earlier, move later, and remove. Child-node controls: Add child node, select, rename, and remove. Checklist controls: Add question, expand, attach demo evidence, supply information, start validation, mark verified, and assign owner/due date.

## End-to-end preview state

```text
OTD anomaly
→ diagnosis question selected
→ evidence inspected
→ validation running
→ actionable diagnosis confirmed
→ project DRAFT
→ PENDING_APPROVAL
→ enterprise-responsible user confirms launch
→ ACTIVE
→ RESULT_VALIDATION
→ COMPLETED
→ candidate experience
→ expert approves formal experience
```

## Role behavior

| Role                          | Preview abilities                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Consultant / project manager  | Edit diagnosis, start validation, create project draft, submit approval, update project |
| Enterprise responsible person | Review evidence summary, confirm launch, return for revision, confirm result            |
| Senior expert                 | Review candidate experience and approve publication                                     |

Role switching is an explicit POC control. It demonstrates permissions but does not represent production authentication or authorization.

## State and feedback rules

- Candidate causes carry a `候选判断` label until human confirmation.
- Evidence opens inline or in a drawer and never mutates the source record.
- Project and experience state transitions announce the actor, result, and next step.
- Empty lists teach the next action instead of displaying only “no data”.
- Local processing uses short, explicit states such as “正在创建项目草稿…” rather than generic loading copy.
- A “重置演示” action restores the initial local mock state.

## Responsive behavior

- Desktop: persistent sidebar, process rail, aligned tables, inline expansion.
- Tablet: collapsible sidebar, horizontally scrollable process rail, reduced table columns.
- Mobile: navigation drawer, vertical records, sticky page action, dialogs sized to the viewport; complex editing remains available through explicit controls.

## Implementation boundary

The POC is semantic React and CSS with local mock data. It must not import a database, Supabase client, storage client, server SDK, or paid AI provider. Future real behavior enters through the API and versioned contracts.
