# Harbor Ledger — Technical Review

**Scope:** architectural, performance, and quality snapshot of the Harbor Ledger codebase at v2.6.2.
**Purpose:** internal technical reference for contributors and for planning v3.0 work. Not a marketing document.

## 1. Architecture

### Layering
Harbor Ledger uses a strict layered architecture pinned by contract tests in `tests/architecture-contract.test.ts`:

```
types/ → core/ → data/ → features/ → orchestration/ → ui/ + components/
```

Cross-layer imports outside this ordering are narrow, documented exceptions tracked in the architecture contract test. The most notable intentional exception is `data/transaction-renderer.ts`, which bridges the persistence layer into the UI layer to allow low-latency ledger rerenders.

### State management
The app uses `@preact/signals-core` for fine-grained reactivity. All app-facing state mutations default through action objects in `core/state-actions.ts`. Direct signal writes are restricted to an **11-file allowlist** enforced by the architecture contract test. The action-object groups are: `navigation`, `form`, `modal`, `settings`, `data`, `savingsGoals`, `pagination`, `filters`, `calendar`, `alerts`, `onboarding`, `debts`, and `syncState`.

### Storage
Tiered persistence via `data/storage-manager.ts`:
- **Primary:** IndexedDB, accessed through `indexeddb-adapter.ts` with a `BaseStorageAdapter` contract
- **Fallback:** LocalStorage, for environments or failure modes where IndexedDB is unavailable (private browsing, quota exhaustion)
- **Migration:** `data/migration.ts` with idempotent, versioned schema evolution

Atomic write operations are coordinated by `data/data-manager.ts` and `data/transaction-manager.ts`, which use a LIFO rollback stack to unwind partial failures.

### Concurrency
Multi-tab coordination is built on:
- `core/mutex.ts` — custom mutex implementation for atomic storage writes
- Web Locks API (`navigator.locks`) — origin-wide exclusive access for critical sections
- `BroadcastChannel` — inter-tab message bus for state-change notifications
- `core/multi-tab-sync*.ts` — conflict-resolution layers built on top of the above

The conflict-resolution stack combines Lamport clocks, vector clocks, and atomic state groups (`core/state-revision.ts`) to establish causality for concurrent edits, with a user-activity-aware deferral layer that avoids clobbering in-progress edits in inactive tabs.

### Dependency injection
`core/di-container.ts` implements a lazy-loading DI container. Services are registered by interface and resolved on first use, which keeps startup cheap and makes replacing implementations straightforward for testing.

### Rendering
`lit-html` via `core/lit-helpers.ts`, with centralized `esc()` escaping in `core/utils-pure.ts`. Signal-directive integration (`core/signal-directive.ts`) lets templates bind to signals for targeted DOM updates without full re-renders. `core/render-scheduler.ts` and `core/render-batcher.ts` coalesce updates across a microtask to avoid layout thrash.

## 2. Performance posture

### Off-main-thread work
`js/workers/filter-worker-optimized.ts` runs transaction filtering off the main thread, coordinated by `orchestration/worker-manager.ts`. This keeps the UI responsive during large-dataset operations.

### Caching
- `core/monthly-totals-cache.ts` memoizes monthly aggregates
- `core/dom-cache.ts` caches frequently queried DOM nodes
- Date parsing is hoisted and reused across filter passes

### Performance regression guards
Playwright performance suites enforce baselines for:
- Shell-ready latency (time to interactive for the app shell)
- Transactions-surface readiness
- Transaction edit flow
- Calendar selection interactions
- Dashboard chart refresh

These are required gates in CI. Additional 1k / 5k / 10k benchmark runs exist as advisory-only local tooling and are not CI gates.

### Bundle
Vite 7 build with the vite-plugin-pwa service-worker plugin. Precaching is enabled for the built shell. Bundle size is not a hard CI gate at present; size targets should be added before any Phase 3 cloud-sync merge that adds Firebase dependencies.

## 3. Security

### Current state (v2.6.2)
- **PIN protection:** PBKDF2-SHA256 with 600,000 iterations, AES-GCM for data at rest when the PIN is set (`features/security/pin-crypto.ts`)
- **XSS prevention:** `lit-html` for templated DOM, centralized `esc()` in `core/utils-pure.ts` (eight-character escape set including defense-in-depth `=` and backtick), sanitized input via `core/validator.ts`
- **Storage integrity:** mutex-protected writes prevent multi-tab interleaving from corrupting transaction records
- **CSP:** `index.html` declares a Content Security Policy; this needs a `connect-src` amendment before Phase 2 introduces Firebase domains

### Known security items
- `features/import-export/pdf-export.ts` — the `buildPdfHtml()` render surface is safe today (all user-controlled interpolations are wrapped in `esc()`; the one unescaped slot, `currencySymbol`, is sourced from a hardcoded `CURRENCY_MAP` at all call sites). A two-line defense-in-depth `esc()` wrap on the symbol parameter is recommended and is on the Phase 1 punch list — see the pre-Phase-1 verification report.
- **v3.0 cloud sync will require full client-side E2EE.** See [ADR-001](adr/ADR-001-firestore-cloud-sync.md) §2.1 for the encryption posture decision and Phase 5a for the `field-crypto` module scope.

## 4. Testing

### Test suites
- **Vitest:** unit and integration — ~65 test files covering ~636 individual cases. Includes architecture contract tests that fail CI if layering, allowlists, or import conventions drift.
- **Playwright:** E2E across Chromium, WebKit, and Mobile Safari. Covers cold-start shell interaction, transactions-surface readiness, modal flows, calendar selection, and the performance regression gates above.
- **`@axe-core/playwright`:** accessibility regression checks embedded in the Playwright suite. Targets WCAG 2.1 AA.

### Architecture contract tests (authoritative invariants)
`tests/architecture-contract.test.ts` pins:
1. The 11-file direct-signal-writer allowlist
2. `components → features / orchestration / ui` bridge exception list
3. `.js` import-extension convention across the repo
4. Transaction-surface ownership routing through `data/transaction-surface-coordinator.ts`
5. `syncState.applyKeyUpdate()` case coverage

Any PR that breaks these invariants must update the tests in the same commit, which forces explicit acknowledgment of architectural drift.

### Coverage
Coverage is generated via `npm run test:coverage` (Vitest + istanbul). It is not currently a CI gate, and exact numbers shift with each test file added. Contributors should run locally when changing core modules to verify coverage remains meaningful.

## 5. Build and deployment

- **Build:** `npm run build` (Vite 7)
- **Dev:** `npm run dev`
- **Typecheck:** `npm run typecheck` (`tsc --noEmit` — must produce 0 errors)
- **Unit tests:** `npm run test:run`
- **E2E smoke:** `npm run test:e2e:smoke`
- **Full E2E:** `npm run test:e2e`

Production hosting is on Vercel. iOS and Android wrappers are built via Capacitor (`ios/` and `android/` directories). Service worker updates are managed by `vite-plugin-pwa`.

## 6. Known technical debt

| Item | Severity | Notes |
|---|---|---|
| ~~`core/state-actions.ts` is 657 lines with 13 action groups colocated~~ | ~~Medium~~ | ~~Split into `core/actions/*-actions.ts` (6 files). Barrel re-export preserves 28 import sites. Largest file: 264 lines.~~ **RESOLVED** |
| ~~`ui/virtual-scroller.ts` is an orphaned duplicate~~ | ~~Low~~ | ~~Deleted in Phase 1.~~ **RESOLVED** |
| ~~`budget_tracker_*` storage key names are stale brand~~ | ~~Medium~~ | ~~Renamed to `harbor_*` with one-time migration in `data/key-migration.ts`. Three legacy keys preserved per ADR-001 §9.4.~~ **RESOLVED** |
| `AGENTS.MD` allowlist and `modules/README.md` had drift (now fixed) | Low | Refreshed alongside this review. |
| CSP `connect-src` is not ready for Firebase domains | Low | One-line amendment when Phase 2 imports `firebase/app`. |

The pre-Phase-1 verification report in [adr/ADR-001-pre-phase-1-verification.md](adr/ADR-001-pre-phase-1-verification.md) has the executable punch list for the items above.

## 7. Major resolved items

The following historical issues are called out for context; all were resolved prior to v2.6.2:

- **Monolithic `app.js`** — refactored into the current modular structure under `js/modules/`
- **Event-listener lifecycle leaks** — standardized via `core/lifecycle-manager.ts` and `core/managed-listeners.ts`
- **Large-dataset UI blocking** — moved to Web Workers + IndexedDB
- **Single-tab data corruption** under concurrent edits — eliminated by the mutex + Web Locks + BroadcastChannel stack
- **XSS regression in `components/daily-allowance.ts`** — fixed during the April 7 review by replacing innerHTML with `textContent` and `createTextNode`

## 8. Browser support

| Browser | Minimum | Support |
|---|---|---|
| Chrome | 90+ | Full |
| Firefox | 88+ | Full |
| Safari | 14+ | Full |
| Edge | 90+ | Full |
| Mobile Safari | 14+ | Full |
| Chrome Android | 90+ | Full |

Playwright WebKit smoke tests run in CI to catch Safari-specific regressions before they ship.

## 9. What this review does not cover

- **Dependency health / `npm audit`** — should be rerun manually; the ADR adds `npm audit` and `dependency-review-action` as CI gates for Phase 2.
- **Lighthouse scores** — currently run manually; not a CI gate.
- **Bundle analyzer output** — not captured in this review; run `vite-bundle-visualizer` locally when changes to dependencies could meaningfully affect bundle size.
- **Backend review** — there is no backend in v2.6.2. v3.0 backend will be reviewed in its own ADR follow-up.

---

*Technical snapshot for v2.6.2. This document should be refreshed whenever a major architectural change lands or whenever CI gates change.*
