# Harbor Ledger — Module Architecture

This document describes the module layout under `js/modules/`. It is a navigational reference, not a marketing doc — counts and claims here should match the code. If you find drift, fix the code or fix the doc.

## At a glance

- **Language:** TypeScript (strict)
- **State:** `@preact/signals-core` + action objects in `core/state-actions.ts`
- **Rendering:** `lit-html` via `core/lit-helpers.ts`
- **Storage:** IndexedDB primary, LocalStorage fallback, automatic migration
- **DI:** Lazy-loading container in `core/di-container.ts`
- **Total modules under `js/modules/`:** ~155 TypeScript files (excluding `.d.ts` and tests)

## Layer ordering

```
types/ → core/ → data/ → features/ → orchestration/ → ui/ + components/
```

Cross-layer imports outside this ordering are narrow, documented exceptions pinned by `tests/architecture-contract.test.ts`. Add to the exception list only when necessary and only by updating the test.

## Directory map

### `core/` — Foundation layer (~49 modules)
Infrastructure that the rest of the app depends on:
- **State:** `signals.ts`, `state.ts`, `state-actions.ts`, `state-hydration.ts`, `state-revision.ts`, `signal-batcher.ts`, `signal-sync.ts`, `category-store.ts`
- **DI:** `di-container.ts`, `app-container.ts`, `services.ts`
- **Concurrency:** `mutex.ts`, `multi-tab-sync.ts`, `multi-tab-sync-activity.ts`, `multi-tab-sync-broadcast.ts`, `multi-tab-sync-conflicts.ts`
- **Error handling:** `error-boundary.ts`, `error-handler.ts`, `error-tracker.ts`, `error-state.ts`, `global-error-handler.ts`
- **Rendering helpers:** `lit-helpers.ts`, `signal-directive.ts`, `render-scheduler.ts`, `render-batcher.ts`
- **Utilities:** `utils.ts`, `utils-dom.ts`, `utils-pure.ts`, `validator.ts`
- **Performance:** `performance-monitor.ts`, `performance-integration.ts`, `monthly-totals-cache.ts`
- **Services:** `locale-service.ts`, `lazy-loader.ts`, `lifecycle-manager.ts`
- **Interfaces:** `data-sync-interface.ts`, `feature-event-interface.ts`, `ui-event-interface.ts`
- **DOM helpers:** `form-binder.ts`, `managed-listeners.ts`, `accessibility.ts`, `dom-cache.ts`
- **Configuration:** `config.ts`, `categories.ts`, `event-bus.ts`

### `data/` — Persistence layer (~11 modules)
- **Atomic operations:** `data-manager.ts`, `transaction-manager.ts`, `transaction-operations.ts`
- **Storage adapters:** `storage-manager.ts`, `indexeddb-adapter.ts`, `localstorage-adapter.ts`, `base-storage-adapter.ts`, `storage-adapter.ts`
- **Migration:** `migration.ts`
- **Recurring templates:** `recurring-templates.ts`
- **Transaction rendering bridge:** `transaction-renderer.ts` (documented exception — bridges into `ui/`)

### `features/` — Business logic (~29 modules)

- **`financial/`** — `calculations.ts`, `budget-planner-ui.ts`, `savings-goals.ts`, `savings-goals-interface.ts`, `weekly-rollup.ts`, `debt-planner.ts`, `rollover.ts`, `split-transactions.ts`
- **`analytics/`** — `analytics-ui.ts`, `seasonal-analysis.ts`, `trend-analysis.ts`
- **`gamification/`** — `achievements.ts`, `celebration.ts`, `streak-tracker.ts`
- **`personalization/`** — `theme.ts`, `onboarding.ts`, `insights.ts`, `alerts.ts`
- **`security/`** — `pin-crypto.ts` (client-side PBKDF2-SHA256 + AES-GCM)
- **`import-export/`** — `import-export.ts`, `import-export-events.ts`, `duplicate-detection.ts`, `pdf-export.ts`
- **`backup/`** — `auto-backup.ts`, `indexeddb-backup-store.ts`, `backup-manifest.ts`

### `orchestration/` — App coordination (~11 modules)
- **Lifecycle:** `app-init.ts`, `app-init-di.ts`
- **Dashboard:** `dashboard.ts`, `dashboard-animations.ts`, `dashboard-trends.ts`
- **Analytics:** `analytics.ts`
- **Events:** `app-events.ts`
- **Background:** `worker-manager.ts`, `backup-reminder.ts`, `sample-data.ts`, `app-reset.ts`

### `ui/` — Presentation layer (~23 modules)
- **`core/`** — `ui.ts`, `ui-render.ts`, `ui-navigation.ts`, `empty-state.ts`
- **`interactions/`** — `form-events.ts`, `modal-events.ts`, `keyboard-events.ts`, `filter-events.ts`, `storage-events.ts`, `emoji-picker.ts`, `swipe-manager.ts`
- **`widgets/`** — `debt-ui-handlers.ts`, `pin-ui-handlers.ts`, `calendar.ts`, `filters.ts`
- **`charts/`** — `chart-renderers.ts`, `chart-utils.ts`, `analytics-ui.ts`
- **`components/`** — `async-modal.ts`
- **`templates/`** — `transaction-row-template.ts`
- **Top-level:** `modal-accessibility.ts`

### `components/` — Lit-style components (~24 modules)
- **Financial widgets:** `budget-gauge.ts`, `envelope-budget.ts`, `savings-goals.ts`, `daily-allowance.ts`
- **Analytics widgets:** `insights.ts`, `weekly-rollup.ts`, `charts.ts`, `analytics-modal.ts`
- **Debt widgets:** `debt-list.ts`, `debt-summary.ts`
- **Core UI:** `transactions.ts`, `calendar.ts`, `summary-cards.ts`
- **Modals:** `modal-base.ts`, `mount-modals.ts`, `form-modals.ts`, `simple-modals.ts`
- **Settings:** `settings-modal.ts`, `settings-modal-events.ts`

Documented bridge exceptions:
- A small set of dashboard-oriented components imports from `features/` and `orchestration/` for financial calculations and shared animation helpers.
- A small set of components also imports from `ui/` for shared navigation and rendering surfaces.
- These `components → features`, `components → orchestration`, and `components → ui` exceptions are tracked explicitly in `tests/architecture-contract.test.ts` and should be narrowed over time, not expanded.

### `transactions/` — Transaction system (4 modules)
- `index.ts` — main transaction logic
- `edit-mode.ts`
- `transaction-row.ts`
- `template-manager.ts`

### `types/` — TypeScript definitions (1 module)
- `index.ts` — all shared interfaces and type aliases

## Architectural contracts enforced by tests

The following invariants are pinned by `tests/architecture-contract.test.ts`. Changing any of them requires updating both the code and the test in the same PR.

1. **Direct signal-writer allowlist** — only these 11 files may mutate signals directly; everything else routes through action objects in `core/state-actions.ts`:
   - `core/category-store.ts`
   - `core/state-actions.ts`
   - `core/state-hydration.ts`
   - `data/transaction-renderer.ts`
   - `features/backup/auto-backup.ts`
   - `features/gamification/achievements.ts`
   - `features/gamification/streak-tracker.ts`
   - `orchestration/app-reset.ts`
   - `orchestration/backup-reminder.ts`
   - `transactions/edit-mode.ts`
   - `ui/core/ui-render.ts`
2. **Transaction-surface ownership** — UI rerenders of the ledger go through `data/transaction-surface-coordinator.ts`, not ad-hoc renderer imports.
3. **Bridge exceptions** — `components → features / orchestration / ui` imports are allowlisted and narrow.
4. **Import extensions** — all relative imports use the `.js` extension (the Vite resolver maps them to `.ts` at build time).
5. **State-actions scope** — `syncState.applyKeyUpdate()` switches over a known set of storage keys; the test pins the expected set.

## Conventions

- **State mutations** go through action objects (`navigation.setCurrentMonth(...)`, `modal.clearDeleteTargetId(...)`, etc.), not direct `signals.foo.value = ...` assignments. The 11-file allowlist above is the only exception.
- **Imports** use `.js` extensions in source. `moduleResolution: "bundler"` makes extensions technically optional, but the project uses them consistently and the architecture contract test enforces it.
- **Type-only imports** use `import type { ... }` — required by `isolatedModules`.
- **Barrel files** (`index.ts`) are used selectively for public module APIs; only re-export what actually exists.

## Testing

- **Vitest** — unit and integration. Run `npm test` or `npm run test:run`.
- **Playwright** — cross-browser E2E under `tests/e2e/`. Run `npm run test:e2e`.
- **`@axe-core/playwright`** — accessibility regression checks embedded in the Playwright suite.

The architecture contract tests (`tests/architecture-contract.test.ts`) are part of the default `npm run test:run` gate.

## Further reading

- [`/AGENTS.MD`](../../AGENTS.MD) — coding guidelines for agents working on this repo
- [`/README.md`](../../README.md) — project overview
- [`/docs/adr/ADR-001-firestore-cloud-sync.md`](../../docs/adr/ADR-001-firestore-cloud-sync.md) — v3.0 cloud-sync architecture decision
- [`/docs/adr/ADR-001-pre-phase-1-verification.md`](../../docs/adr/ADR-001-pre-phase-1-verification.md) — pre-Phase-1 verification report
