# Harbor Ledger — Project Summary

## What it is

Harbor Ledger is a privacy-first, local-first personal finance Progressive Web App. All user data lives on-device (IndexedDB primary, LocalStorage fallback). There is no account, no tracking, no subscription required for self-host use, and no telemetry. The codebase is 100% TypeScript with strict type checking and a layered, DI-driven architecture.

- **Version:** 2.6.2
- **Status:** Production — live at [harborledger.app](https://harborledger.app)
- **Codebase:** ~155 TypeScript modules under `js/modules/`
- **Tests:** ~65 Vitest files (~636 individual cases) + Playwright E2E across Chromium, WebKit, and Mobile Safari
- **License:** MIT

## Documentation map

### Project foundation
- **[../README.md](../README.md)** — user-facing project overview, install, tech stack, quick start
- **[PROJECT_SUMMARY.md](PROJECT_SUMMARY.md)** — this document (developer-facing overview)
- **[../AGENTS.MD](../AGENTS.MD)** — coding conventions and architecture rules for contributors and AI agents

### Architecture & technical reference
- **[../js/modules/README.md](../js/modules/README.md)** — module directory map and enforced architectural contracts
- **[TECHNICAL_REVIEW.md](TECHNICAL_REVIEW.md)** — technical review snapshot (architecture, performance, testing posture)
- **[DI_MIGRATION_GUIDE.md](DI_MIGRATION_GUIDE.md)** — dependency-injection patterns and migration notes
- **[FEATURE_INVENTORY.md](FEATURE_INVENTORY.md)** — complete feature catalog

### Architecture decision records
- **[adr/ADR-001-firestore-cloud-sync.md](adr/ADR-001-firestore-cloud-sync.md)** — v3.0 cloud-sync architecture (Firestore backend, full client-side E2EE, three-layer conflict resolution)
- **[adr/ADR-001-pre-phase-1-verification.md](adr/ADR-001-pre-phase-1-verification.md)** — pre-Phase-1 verification report with the Phase 1 punch list

### Strategy & planning
- **[IMPROVEMENT_ROADMAP.md](IMPROVEMENT_ROADMAP.md)** — feature roadmap and release phases
- **[MARKET_STRATEGY.md](MARKET_STRATEGY.md)** — market positioning, monetization tiers, go-to-market plan
- **[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md)** — pre-deployment verification steps

### Contribution
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — contributor guidelines

### Archive
- **[archive/](archive/)** — historical review snapshots and superseded planning docs, preserved for context. Content in `archive/` may reference the earlier "Budget Tracker Elite" brand and obsolete module counts; it is intentionally frozen.

## Architectural highlights

- **Layered imports enforced by contract tests:** `types → core → data → features → orchestration → ui/components`. Exceptions are narrow and allowlisted in `tests/architecture-contract.test.ts`.
- **State management:** reactive signals via `@preact/signals-core`. All app-facing mutations default through action objects in `core/state-actions.ts`; direct signal writes are restricted to an 11-file allowlist that the architecture contract test enforces.
- **Storage:** IndexedDB-first with LocalStorage fallback, managed by `storage-manager.ts`. Schema evolution is handled by `data/migration.ts`.
- **Concurrency:** per-origin mutex, Web Locks API, and `BroadcastChannel` coordinate multi-tab writes. Three-layer conflict resolution (Lamport + vector causality, atomic state groups, user-activity-aware deferral) is pre-built and will be reused by cloud sync in v3.0.
- **Security posture:** PIN protection via PBKDF2-SHA256 (600k iterations) + AES-GCM. v3.0 will extend this to full client-side E2EE for cloud sync — see ADR-001.
- **Performance:** Web Workers for transaction filtering, `render-batcher.ts` for DOM coalescing, `signal-batcher.ts` for state updates, and `monthly-totals-cache.ts` for memoized aggregates.
- **Testing:** Vitest for unit and integration, Playwright for E2E (Chromium, WebKit, Mobile Safari), `@axe-core/playwright` for accessibility regression, five architecture contract tests that fail CI if layering or allowlists drift.

## Technical achievements (factual snapshot)

- 100% TypeScript with strict mode across the entire codebase
- Modular refactor of the original monolithic `app.js` into ~155 semantic modules
- Lazy-loading DI container (`core/di-container.ts`) for service wiring
- Signal-based reactivity with fine-grained UI updates (no full re-renders)
- Tiered persistence (IndexedDB → LocalStorage) with automatic migration
- Multi-tab synchronization via `BroadcastChannel`, `Mutex`, and Web Locks API
- Web Workers for off-main-thread transaction filtering
- Standardized error boundaries and circuit breakers in `core/error-*`
- Vite 7 build tooling with Vitest and Playwright integration
- Capacitor iOS/Android wrappers under `ios/` and `android/`

## Feature scope

The app currently supports envelope budgeting with monthly rollovers, transaction tracking (CRUD, splits, templates, duplicate detection, tags, notes), debt planning (snowball/avalanche), savings goals with progress tracking, recurring transactions and bill reminders, advanced analytics (MoM/YoY comparison, seasonal analysis, trend analysis), gamification (achievements and streaks), CSV/JSON import/export, PDF report export, multi-currency support, dark/light themes, and full PWA offline mode with a service worker. See [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) for the complete catalog.

## What's next

The active planning focus is **v3.0 cloud sync** — an optional, opt-in Firestore backend with full client-side end-to-end encryption. The decision is documented in [ADR-001](adr/ADR-001-firestore-cloud-sync.md) and the pre-Phase-1 blockers have been verified in the [verification report](adr/ADR-001-pre-phase-1-verification.md). Phase 1 is complete: security hardening, dead-code deletion, storage-key rename (`budget_tracker_*` → `harbor_*` with one-time migration), UTC bug fixes, barrel codemod, `state-actions.ts` split into `core/actions/`, and 9 architecture contract tests are all shipped. Phase 2 (Firebase auth scaffolding) can begin. Phases 2–5 layer in Firebase auth, the sync engine, Cloud Functions for billing, and the field-crypto module.

## Out of scope

Harbor Ledger is not trying to replace YNAB or Mint as an enterprise product. It is a tool that respects user data. The following are explicit non-goals:

- Server-side access to plaintext financial data
- Telemetry or usage tracking of any kind
- Ad-supported monetization
- Server-side aggregation that requires decrypting user data
- Searchable encryption (the v3.0 threat model prefers plaintext metadata simplicity over query features)
