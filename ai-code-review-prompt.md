# Harbor Ledger — Comprehensive AI Code Review Prompt

> Copy and paste this prompt into Claude (or any AI assistant) along with your codebase to get a full review of the Harbor Ledger app.

---

## The Prompt

You are performing a comprehensive code review of **Harbor Ledger**, a production-grade, privacy-first PWA for personal finance management. The app is built with 100% TypeScript, lit-html rendering, Preact Signals state management, and IndexedDB persistence. It runs as a PWA and via Capacitor on iOS/Android.

Review the ENTIRE codebase against every category below. For each finding, provide: the file path, line range, severity (Critical / High / Medium / Low / Info), a description of the issue, and a concrete fix or recommendation. Group findings by category.

---

### 1. SECURITY REVIEW

#### 1a. Input Validation & Injection
- Check all user inputs (transaction amounts, descriptions, category names, form fields) for proper sanitization before rendering or storage.
- Verify lit-html template bindings don't create XSS vectors — look for unsafe `innerHTML`, `unsafeHTML`, or direct DOM manipulation.
- Check emoji picker, search/filter inputs, and import parsers for injection risks.
- Validate all data received from file imports (CSV, JSON) before processing.

#### 1b. Cryptography & PIN Security
- Review `js/modules/features/security/pin-crypto.ts` — verify key derivation (PBKDF2/Argon2 parameters), encryption algorithm choices, and IV/nonce handling.
- Check `js/modules/features/security/rate-limiter.ts` for brute-force protection adequacy.
- Review `js/modules/features/security/auto-lock.ts` for timing attack vulnerabilities and lock bypass possibilities.
- Verify PIN recovery phrase generation and storage security.

#### 1c. Content Security Policy
- Review the CSP meta tag in `index.html` — verify it blocks unsafe-inline, unsafe-eval, and restricts origins appropriately.
- Check that the Vite dev CSP strip plugin (`cspDevStripPlugin`) doesn't leak into production builds.
- Verify service worker (`sw.js`) doesn't weaken CSP protections.

#### 1d. Data Privacy & Storage
- Verify NO data leaves the device — check for any fetch/XMLHttpRequest calls, beacons, or tracking pixels.
- Review IndexedDB adapter (`js/modules/data/indexeddb-adapter.ts`) for data-at-rest security.
- Check localStorage fallback (`js/modules/data/localstorage-adapter.ts`) for sensitive data exposure.
- Review `js/modules/features/import-export/import-export.ts` for data leakage during export.
- Verify `js/modules/features/backup/` modules don't expose sensitive financial data.

#### 1e. Service Worker Security
- Review PWA service worker caching strategies (Workbox config in `vite.config.ts`) for cache poisoning risks.
- Verify no sensitive data is cached in service worker caches.
- Check `registerSW.js` for update prompt security.

---

### 2. ARCHITECTURE & DESIGN PATTERNS

#### 2a. Dependency Injection Container
- Review `js/modules/core/di-container.ts` for circular dependency risks, service lifetime management, and lazy-loading correctness.
- Verify all services are properly registered in `js/modules/orchestration/app-init-di.ts`.
- Check for services that bypass the DI container (direct imports instead of injected dependencies).

#### 2b. State Management
- Review `js/modules/core/signals.ts` and `js/modules/core/state.ts` for state mutation safety.
- Verify ALL state mutations flow through `js/modules/core/state-actions.ts` (the enforced single entry point).
- Check `js/modules/core/state-hydration.ts` for hydration race conditions.
- Review `js/modules/core/state-revision.ts` for version conflict handling.
- Verify `js/modules/core/signal-batcher.ts` doesn't drop updates under load.

#### 2c. Multi-Tab Synchronization
- Review the entire multi-tab sync system: `multi-tab-sync.ts`, `multi-tab-sync-broadcast.ts`, `multi-tab-sync-conflicts.ts`, `multi-tab-sync-activity.ts`.
- Verify `js/modules/core/mutex.ts` correctly prevents concurrent write corruption.
- Check BroadcastChannel message handling for race conditions.
- Verify conflict resolution strategy is correct and doesn't silently lose data.
- Review `js/modules/core/tab-id.ts` for uniqueness guarantees.

#### 2d. Data Layer Architecture
- Review `js/modules/data/storage-manager.ts` for atomic operation guarantees.
- Check `js/modules/data/storage-adapter.ts` abstraction for leaky abstractions.
- Verify `js/modules/data/migration.ts` handles all edge cases (interrupted migrations, corrupt data, version skips).
- Review `js/modules/data/data-manager.ts` for proper separation of concerns.
- Check `js/modules/data/transaction-surface-coordinator.ts` for render coordination correctness.

#### 2e. Module Boundaries
- Verify architectural contracts: components should not directly import from `features/` or `orchestration/` (check against `tests/architecture-contract.test.ts` allowlists).
- Look for circular dependencies between module directories.
- Verify the domain layer (`js/modules/domain/`) properly encapsulates business logic away from UI.

---

### 3. PERFORMANCE REVIEW

#### 3a. Rendering Performance
- Review `js/modules/core/render-scheduler.ts` for unnecessary re-renders and batching efficiency.
- Check lit-html template usage across all components — look for inefficient template re-creation, missing keyed directives, or large DOM updates.
- Review `js/modules/ui/widgets/virtual-scroller.ts` for scroll performance and memory management.
- Check `js/modules/core/dom-cache.ts` for stale cache entries and memory leaks.
- Verify `js/modules/core/lazy-loader.ts` properly handles loading states and doesn't cause layout shifts.

#### 3b. Data Processing
- Review Web Worker usage in `js/workers/` — verify heavy computations are properly offloaded.
- Check `js/modules/orchestration/worker-manager.ts` for worker lifecycle management and message serialization overhead.
- Review `js/modules/core/monthly-totals-cache.ts` for cache invalidation correctness.
- Check all data operations in `js/modules/data/transaction-operations.ts` for O(n) vs O(1) lookups.

#### 3c. Memory Management
- Look for event listener leaks — verify all addEventListener calls have corresponding removeEventListener in cleanup.
- Check signal subscriptions (`js/modules/core/effect-manager.ts`) for proper disposal.
- Review `js/modules/core/event-bus.ts` for subscriber accumulation.
- Check for detached DOM nodes, especially in modal components (`js/modules/components/form-modals.ts`, `js/modules/components/settings-modal.ts`).
- Verify IndexedDB connections are properly closed.

#### 3d. Bundle & Loading Performance
- Review Vite code splitting config — verify the framework/vendor chunk strategy is optimal.
- Check for oversized modules that should be lazy-loaded.
- Review Google Fonts loading strategy in `index.html` for render-blocking.
- Verify PWA precaching list isn't too large for initial install.

---

### 4. ERROR HANDLING & RESILIENCE

#### 4a. Error Boundaries
- Review `js/modules/core/error-boundary.ts` and `js/modules/core/global-error-handler.ts` for comprehensive error capture.
- Check `js/modules/core/error-handler.ts`, `error-state.ts`, and `error-tracker.ts` for proper error classification and recovery.
- Verify unhandled promise rejections are caught globally.

#### 4b. Data Integrity
- Review `js/modules/data/` for data corruption recovery paths.
- Check `js/modules/features/backup/auto-backup.ts` and `indexeddb-backup-store.ts` for backup reliability.
- Verify `js/modules/features/backup/reset-backup-storage.ts` safely handles the reset flow.
- Check `js/modules/orchestration/app-reset.ts` for complete and safe data wipe.

#### 4c. Graceful Degradation
- Verify IndexedDB-to-localStorage fallback works correctly when IndexedDB is unavailable.
- Check service worker failure handling — does the app work without a service worker?
- Review offline behavior — verify all features degrade gracefully without network.
- Check `js/modules/orchestration/app-init.ts` for initialization failure recovery.

---

### 5. ACCESSIBILITY (a11y)

- Review all components for proper ARIA attributes, roles, and labels.
- Check `js/modules/core/accessibility.ts` for screen reader announcement patterns.
- Verify `#sr-announcer` and `#sr-status` regions in `index.html` are used consistently for dynamic updates.
- Review keyboard navigation: `js/modules/ui/interactions/keyboard-events.ts` — verify all interactive elements are reachable and operable.
- Check `js/modules/ui/interactions/swipe-manager.ts` for keyboard/mouse alternatives to swipe gestures.
- Review `js/modules/components/calendar.ts` for date picker accessibility.
- Check modal focus management in `js/modules/ui/interactions/modal-events.ts` (focus trap, restore on close).
- Verify `js/modules/ui/interactions/emoji-picker.ts` is keyboard navigable.
- Check color contrast in `style.css` for both light and dark themes.
- Review `js/modules/features/personalization/theme.ts` for high-contrast mode support.

---

### 6. TYPE SAFETY & CODE QUALITY

#### 6a. TypeScript Strictness
- Look for `any` types, type assertions (`as`), and non-null assertions (`!`) — flag each one with justification assessment.
- Check `js/modules/types/` for completeness — are all interfaces properly defined?
- Verify generic types are used appropriately (not over- or under-constrained).
- Check for implicit `any` in callback parameters.

#### 6b. Code Patterns
- Look for code duplication across components and features.
- Check for functions exceeding ~50 lines that should be decomposed.
- Verify consistent error handling patterns across all modules.
- Look for magic numbers/strings that should be constants (check `js/modules/core/config.ts`).
- Review naming conventions for consistency across all 112+ modules.

#### 6c. Dead Code
- Identify unused exports, unreachable code paths, and commented-out code blocks.
- Check for features that are imported but never used.
- Verify all files in `js/modules/` are actually imported somewhere in the dependency graph.

---

### 7. TESTING GAPS

#### 7a. Unit Test Coverage
- Cross-reference the 42 test files in `tests/` against the 112+ source modules — identify untested modules.
- Pay special attention to untested security modules, data layer code, and business logic in `js/modules/domain/`.
- Check `tests/test-data-factory.ts` for realistic test data generation.

#### 7b. Test Quality
- Review existing tests for meaningful assertions (not just "doesn't throw").
- Check for tests that mock too much and don't test real behavior.
- Verify edge cases: empty states, max values, concurrent operations, corrupt data.
- Check `tests/state-actions-contract.test.ts` and `tests/architecture-contract.test.ts` for completeness of their allowlists.

#### 7c. E2E Test Coverage
- Review the 12 Playwright specs in `e2e/` — identify critical user journeys not covered.
- Check that `e2e/security.spec.ts` tests actual PIN flows end-to-end.
- Verify `e2e/performance-benchmark.spec.ts` has meaningful performance budgets.
- Check visual regression coverage against all component states (loading, error, empty, full).

---

### 8. PWA & MOBILE REVIEW

- Review `capacitor.config.ts` for proper native bridge configuration.
- Check PWA manifest in `vite.config.ts` for completeness (icons, shortcuts, categories).
- Verify service worker update flow (prompt-based) handles edge cases.
- Review Workbox caching strategies for appropriateness (StaleWhileRevalidate vs CacheFirst vs NetworkFirst).
- Check viewport and safe-area handling in `index.html` for notched devices.
- Verify touch targets meet minimum 44x44px size requirements.
- Check `style.css` for responsive design breakpoints and mobile-specific styles.

---

### 9. BUILD & DEPLOYMENT

- Review `vite.config.ts` custom plugins (`tsJsResolverPlugin`, `cspDevStripPlugin`) for correctness and edge cases.
- Check `.github/workflows/ci.yml` for missing CI steps (no linting step currently — flag this).
- Review `.github/workflows/deploy.yml` for deployment safety (rollback capability, smoke tests).
- Verify `package.json` scripts cover all necessary development workflows.
- Check for missing `npm audit` or dependency vulnerability scanning in CI.

---

### 10. BUSINESS LOGIC CORRECTNESS

- Review `js/modules/features/financial/calculations.ts` for arithmetic precision (floating point issues with currency).
- Check `js/modules/features/financial/debt-planner.ts` for correct amortization and payoff calculations.
- Verify `js/modules/features/financial/rollover.ts` handles month boundary edge cases.
- Review `js/modules/features/financial/savings-goals.ts` for goal projection accuracy.
- Check `js/modules/features/financial/split-transactions.ts` for rounding and remainder handling.
- Verify `js/modules/features/financial/weekly-rollup.ts` for correct week boundary calculations.
- Review `js/modules/core/currency-service.ts` for proper locale-aware formatting.
- Check `js/modules/features/gamification/streak-tracker.ts` for timezone-aware streak calculations.
- Verify `js/modules/features/gamification/achievements.ts` for correct unlock conditions.

---

### OUTPUT FORMAT

Organize your findings as follows:

```
## [Category Name]

### [SEVERITY] File: path/to/file.ts (lines X-Y)
**Issue:** Description of the problem
**Impact:** What could go wrong
**Fix:** Specific code change or approach to resolve it

---
```

At the end, provide:

1. **Executive Summary** — Overall health score (A-F) for each of the 10 categories
2. **Critical Issues** — Anything that must be fixed before launch (reference LAUNCH_CHECKLIST.md items)
3. **Quick Wins** — Low-effort, high-impact improvements
4. **Technical Debt** — Items to address in future versions
5. **Missing Infrastructure** — Tools/configs that should be added (ESLint, Prettier, pre-commit hooks, dependency scanning)
