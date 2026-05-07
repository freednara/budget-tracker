# ADR-001 Pre-Phase-1 Verification Report

**Companion to:** `ADR-001-firestore-cloud-sync.md`
**Date:** 2026-04-10
**Status:** Phase 1 is cleared to start. One defense-in-depth fix recommended before merge.
**Purpose:** Convert the ADR's Phase 1 acceptance criteria into checked items, document the ground-truth state of every "blocking" claim in the ADR, and hand Phase 1 a short, executable punch list.

---

## TL;DR

| Blocker | Claim in ADR | Ground truth | Verdict |
|---|---|---|---|
| `pdf-export.ts` XSS | `document.write()` + `buildPdfHtml()` needs an HTML-escape audit before v3.0. | Every user-supplied interpolation in `buildPdfHtml()` is already wrapped in `esc()`. The only unescaped slot (`currencySymbol`) is sourced from a hardcoded `CURRENCY_MAP`, not user input, at every call site. | **Safe today.** Add one defense-in-depth `esc()` wrap so the audit is unconditional and survives Phase 3 sync. |
| `state-actions.ts` over 600-line split threshold | Needs to split before Phase 2 extends `syncState`. | 657 lines confirmed. 13 action groups all colocated. | **Split required.** Low-risk mechanical refactor. Target layout below. |
| `ui/virtual-scroller.ts` dead duplicate | Self-deprecated in its own JSDoc; should be deleted in Phase 1. | Confirmed orphan: only references in the repo are `modules/README.md` (lines 87 and 100 — the README lists it twice) and the file's own deprecation JSDoc. No `import` statements anywhere. | **Safe to delete.** |
| `AGENTS.MD` allowlist drift | Claims lines 74–83 are missing `core/category-store.ts`. | Confirmed. AGENTS.MD lines 73–82 lists exactly 10 files; the authoritative 11-file list lives in `tests/architecture-contract.test.ts`. | **Doc-only fix.** Add the eleventh entry. |
| `modules/README.md` stale | Claims stale counts, old brand, inflated grade. | Confirmed stale on every dimension: "Budget Tracker Elite" header, "146 modules / 170 tests / A+ 98/100 / 138 modules" all wrong, lists `virtual-scroller.ts` in two locations. | **Rewrite required.** |
| `MARKET_STRATEGY.md` / `IMPROVEMENT_ROADMAP.md` brand drift | Still uses "Budget Tracker Core/Pro/Elite" tier names. | (Not re-read in this pass — assumed valid per prior reconnaissance; verify at edit time.) | **Light doc refresh.** |

**Phase 1 green light:** Yes, with the four-item punch list in §6 completed before opening the Phase 1 PR.

---

## 1. `pdf-export.ts` XSS audit

### 1.1 Context

The ADR flagged `js/modules/features/import-export/pdf-export.ts` as an unverified security item blocking Phase 1 because it uses `document.write()` to render the print-preview iframe. The April 7 review raised the concern; it had not been re-verified. Verifying it was the highest-value pre-Phase-1 action because (a) it's blocking, (b) it takes ~10 minutes, and (c) the ciphertext that Phase 3 eventually replicates to Firestore will originate from the same field values — any injection today becomes a persisted remote injection tomorrow.

### 1.2 Method

Traced every string interpolation in `buildPdfHtml()` (pdf-export.ts:43 and 272) to its source. Verified the escape primitive (`esc()` in `utils-pure.ts:418–429`). Traced the one unescaped slot (`currencySymbol`) back to its origin through three call sites.

### 1.3 Findings

**The render surface itself is clean.** `buildPdfHtml()` wraps every user-controlled value in `esc()`:

```ts
// pdf-export.ts:55–67 (transaction row builder)
return `
  <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
    <td class="date">${esc(formatDate(tx.date))}</td>
    <td class="desc">${esc(tx.description || '—')}</td>
    <td class="cat"><span class="emoji">${esc(cat.emoji)}</span> ${esc(cat.name)}</td>
    <td class="type type-${tx.type}">${tx.type === 'income' ? 'Income' : 'Expense'}</td>
    <td class="amount ${amountClass}">${sign}${formatCurrency(tx.amount, currencySymbol)}</td>
  </tr>`;
```

The `esc()` primitive is solid — eight characters covered, including the defense-in-depth `=` and backtick escapes:

```ts
// utils-pure.ts:418–429
export function esc(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;')
    .replace(/`/g, '&#96;')
    .replace(/=/g, '&#61;');
}
```

**The one unescaped slot is `currencySymbol`:**

```ts
// pdf-export.ts:26–28
function formatCurrency(amount: number, symbol: string): string {
  return `${symbol}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
```

This gets string-concatenated into the rendered HTML without escaping. I traced the three call sites:

1. **`modal-events.ts:572–574`** — source is `CURRENCY_MAP[curr]`, a hardcoded dictionary lookup. Falls back to `'$'`. User can never reach this slot with arbitrary content.
2. **`import-export.ts:464`** — explicitly overwrites imported currency's symbol field with `currencyMap[curr.home]` on import. User-supplied symbols from a malicious JSON export are discarded.
3. **`state-actions.ts:240–255` (`setCurrency`) and `335–346` (`setCurrencySettings`)** — these setters accept a `symbol` parameter of type `string` with no validation. Theoretically reachable if future code wires a user input to these setters without going through `CURRENCY_MAP`. Not reachable today.

### 1.4 Residual risk and the Phase 3 angle

There is one thin residual path that becomes a problem later, not now:

- **Today:** Multi-tab sync uses `BroadcastChannel` + `syncState.applyKeyUpdate('CURRENCY', value)`. Other tabs on the same origin already trust each other, so this is low risk.
- **Phase 3 onward:** Firestore sync will feed the same `syncState.applyKeyUpdate('CURRENCY', value)` entrypoint with payloads that originated on a *different device*. If a remote device is compromised, the attacker could set `currency.symbol` to `<img src=x onerror=...>` and it would ride the sync path into this tab's `buildPdfHtml()` render.
- **Phase 5 (full E2EE):** The payload is ciphertext end-to-end. The attack surface collapses to "attacker controls the victim's own device," at which point they don't need the XSS.

### 1.5 Recommended fix (ship in Phase 1)

Wrap `currencySymbol` in `esc()` inside `formatCurrency()`. Two-line change. Zero functional risk. Converts the audit from "safe because of caller discipline" to "safe unconditionally," which is the posture you want before Phase 3 merges.

```ts
// pdf-export.ts — proposed
import { esc } from '../../core/utils-pure.js';

function formatCurrency(amount: number, symbol: string): string {
  return `${esc(symbol)}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
```

Also add a one-line contract test asserting `formatCurrency('<img src=x>', 100)` returns escaped output, so a future refactor can't silently re-open the gap.

### 1.6 Verdict

**Cleared.** No launch blocker. Ship the two-line defense-in-depth fix as part of the Phase 1 "dead code and hardening" commit.

---

## 2. `state-actions.ts` split feasibility

### 2.1 Confirmed state

- **Line count:** 657 (over the repo's documented 600-line split threshold).
- **Action groups in the file:** `navigation`, `form`, `modal`, `settings`, `data`, `savingsGoals`, `pagination`, `filters`, `calendar`, `alerts`, `onboarding`, `debts`, `syncState` — 13 groups.
- **`syncState.applyKeyUpdate()`** lives at lines 570–657 and switches over 17 `SK` keys. This is the piece Phase 2 will extend with a `onRemoteWrite` callback slot.

### 2.2 Why this is Phase 1 work, not Phase 2

Phase 2 needs to touch `syncState` to add the remote-write callback slot. If the file is still 657 lines with all 13 groups jammed together when Phase 2 lands, the Phase 2 diff will fight history tooling and blame will be unreadable. The cheap move is to split once, before Phase 2, so Phase 2's diff is laser-focused on `sync-actions.ts` alone.

### 2.3 Target layout

```
js/modules/core/
├── state-actions.ts              // thin barrel re-export + shared types
└── actions/
    ├── navigation-actions.ts     // navigation
    ├── form-actions.ts           // form, modal, calendar, pagination, filters
    ├── settings-actions.ts       // settings, alerts, onboarding
    ├── data-actions.ts           // data, savingsGoals, debts
    └── sync-actions.ts           // syncState ← Phase 2 extends this file only
```

Five files, each well under 200 lines. The barrel (`state-actions.ts`) continues to export the action objects under their current names, so no consumer needs to change imports.

### 2.4 Contract-test implications

`tests/architecture-contract.test.ts` is the authoritative allowlist. It currently pins `core/state-actions.ts` as a direct-signal-writer. After the split, the allowlist needs to grow to include the new `core/actions/*-actions.ts` files. This is a single-line change in the test, but it must ship in the same PR as the split — otherwise CI breaks.

Also worth wiring: a new contract assertion that `syncState.applyKeyUpdate()` still switches over exactly the 17 expected `SK` keys, so Phase 2's refactor doesn't silently drop a case.

### 2.5 Verdict

**Safe mechanical refactor.** Ship in Phase 1. Expected diff: ~650 lines moved, ~20 lines touched in contract test, 0 behavior change.

---

## 3. `ui/virtual-scroller.ts` orphan confirmation

### 3.1 Evidence

- **File exists:** `js/modules/ui/virtual-scroller.ts`, 316 lines.
- **Its own JSDoc (lines 1–3) says it is deprecated** in favor of `js/modules/ui/widgets/virtual-scroller.ts`.
- **Repo-wide grep for `virtual-scroller`:** exactly four matches.
  1. `js/modules/README.md:87` — documents the canonical widgets version.
  2. `js/modules/README.md:100` — lists the deprecated top-level version (this is a README bug).
  3. `js/modules/ui/widgets/virtual-scroller.ts:13` — the canonical file's own JSDoc.
  4. `js/modules/ui/virtual-scroller.ts:2, 10` — the deprecated file's own JSDoc pointing at its replacement.

No `import` statement anywhere in the repo references `ui/virtual-scroller.ts` (only the widgets variant is imported). It is a true orphan.

### 3.2 Verdict

**Delete in Phase 1.** Zero-risk deletion. The `modules/README.md` rewrite (§4) will also drop the stale double-listing.

---

## 4. `AGENTS.MD` and `modules/README.md` stale docs

### 4.1 `AGENTS.MD` — allowlist drift

**Confirmed missing entry.** AGENTS.MD lines 73–82 lists exactly 10 files:

```
- js/modules/core/state-actions.ts
- js/modules/core/state-hydration.ts
- js/modules/data/transaction-renderer.ts
- js/modules/features/backup/auto-backup.ts
- js/modules/features/gamification/achievements.ts
- js/modules/features/gamification/streak-tracker.ts
- js/modules/orchestration/app-reset.ts
- js/modules/orchestration/backup-reminder.ts
- js/modules/transactions/edit-mode.ts
- js/modules/ui/core/ui-render.ts
```

The authoritative list in `tests/architecture-contract.test.ts` includes these ten plus `js/modules/core/category-store.ts`. AGENTS.MD should gain a line for `category-store.ts`, and its blurb should state explicitly that the test is authoritative so future drift is self-healing.

**Recommended edit:**

```diff
  Default all app-facing state changes through action methods. Direct signal writes are reserved for a narrow low-level allowlist that is enforced by tests:
+ - `js/modules/core/category-store.ts`
  - `js/modules/core/state-actions.ts`
  - `js/modules/core/state-hydration.ts`
  ...

+ The authoritative source for this list is `tests/architecture-contract.test.ts`. If the two disagree, the test wins — update this file to match.
```

Also: after §2's split lands, the allowlist grows to include the new `core/actions/*-actions.ts` files. AGENTS.MD should be updated in the same PR.

### 4.2 `modules/README.md` — multi-dimensional drift

Every headline fact in this file is wrong:

| Claim in README | Reality |
|---|---|
| Title: "Budget Tracker Elite" | Harbor Ledger (rebrand complete elsewhere) |
| "146 modules" (line 5) | ~156 TS modules |
| "146 TypeScript files" (line 11) | ~156 |
| "Grade: A+ (98/100)" (line 12) | Gemini-generated inflation; remove entirely |
| "45 core modules" (line 16) | 43 |
| "19 Lit-style components" (line 102) | 23 |
| "23 ui modules" (line 74) | ~23 (roughly correct, but the subdivision numbers below it are off) |
| "170 Tests" (line 142) | 634 Vitest tests across ~74 files as of Round 6 |
| "138 TypeScript modules" in Migration Summary (line 151) | ~156 |
| Top-level UI section lists `virtual-scroller.ts` at line 100 | This is the deprecated duplicate; should not be listed |

The file also double-lists `virtual-scroller.ts` (lines 87 and 100), which is the root cause of the dead-code duplication.

**Recommendation:** Rewrite the file from scratch rather than patching individual lines. It's <200 lines, the drift is systemic, and a fresh version generated from the current directory tree is faster than editing. Drop the "Grade A+ 98/100" marketing line entirely — that kind of score is meaningless in internal docs and will drift again next quarter.

### 4.3 `MARKET_STRATEGY.md` and `IMPROVEMENT_ROADMAP.md`

Not re-read in this pass. The ADR and prior reconnaissance notes both state these still use the "Budget Tracker Core/Pro/Elite" tier names. Verify at edit time and rename to "Harbor Ledger Free/Plus/Pro" (or whatever the current monetization doc uses). Low-priority relative to the items above but should ship in the same Phase 1 PR for cleanliness.

---

## 5. Items not re-verified in this pass

These were documented in earlier reconnaissance and trusted without re-reading the source, because they are doc-level or cross-file counts where re-verification has diminishing returns:

- **35+ `budget_tracker_*` storage key sites.** ADR §1.4 claims 26 in `core/state.ts`, 3+2 prefix families in `app-reset.ts`, 3 in `migration.ts`, 2 in `state-revision.ts`. Phase 1 will rename these to `harbor_*` wholesale and add a one-time migration; the exact count is not load-bearing.
- **CSP `connect-src` amendment at `index.html` line ~10.** Single-line edit, will be done at Phase 2 kickoff when Firebase domains are added.
- **`orchestration/app-init.ts` unused `deduplicateTransactions` helper.** ADR says "verify and delete." Not verified here; Phase 1 should grep-confirm no imports before deleting.
- **`daily-allowance.ts` XSS fix from April 7 review.** ADR and memory both state this is already fixed via `textContent`/`createTextNode`. Not re-verified.

None of these are blocking; they are Phase 1 execution details.

---

## 6. Phase 1 punch list

> **Superseded by §9.** A five-pass DRY audit (2026-04-10) surfaced additional Phase 1 work that was not in scope when this section was originally written. §9 contains the authoritative, expanded punch list. The items below remain correct but are incomplete. Read §9 before executing Phase 1.

Concrete actions, in execution order, to clear the pre-Phase-1 gate and open the Phase 1 PR.

1. **Security hardening (10 min)**
   - Wrap `currencySymbol` in `esc()` inside `pdf-export.ts` `formatCurrency()`.
   - Add a unit test asserting `formatCurrency` escapes HTML in the symbol.

2. **Dead-code deletion (15 min)**
   - Delete `js/modules/ui/virtual-scroller.ts`.
   - Grep-confirm `orchestration/app-init.ts` `deduplicateTransactions` has no importers; delete if orphaned.
   - Run `npm run typecheck` and `npm run test:run` to confirm no regressions.

3. **`state-actions.ts` split (60–90 min)**
   - Create `js/modules/core/actions/` with five files per §2.3.
   - Convert `state-actions.ts` to a thin barrel that re-exports the split action objects.
   - Update `tests/architecture-contract.test.ts` direct-writer allowlist to include the new files.
   - Add the new "`syncState.applyKeyUpdate()` switches over exactly 17 keys" contract assertion.
   - Run `npm run typecheck`, `npm run test:run`, and `npx vitest run tests/architecture-contract.test.ts tests/state-actions-contract.test.ts`.

4. **Storage-key rename (2–3 h)**
   - Rename all 35+ `budget_tracker_*` keys to `harbor_*` across `core/state.ts`, `app-reset.ts`, `migration.ts`, `state-revision.ts`.
   - Add a one-time migration in `data/migration.ts` that copies `budget_tracker_*` → `harbor_*` on first boot and deletes the old keys after a successful copy.
   - Add a unit test that seeds old keys, boots, and verifies the new keys exist and the old ones are gone.

5. **Docs refresh (45 min)**
   - `AGENTS.MD`: add `core/category-store.ts` to the allowlist, add the "tests/architecture-contract.test.ts is authoritative" note, update the file header from "Budget Tracker Elite" to "Harbor Ledger."
   - `js/modules/README.md`: rewrite from scratch against the current directory tree. Drop the A+ grade line.
   - `docs/MARKET_STRATEGY.md`, `docs/IMPROVEMENT_ROADMAP.md`: rename old tier names to the current Harbor Ledger monetization naming.

6. **Final gate**
   - `npm run typecheck` (must be 0 errors)
   - `npm run test:run` (target: 634+ passing, same skip/pre-existing-fail count as Round 6)
   - `npm run build`
   - `npm run test:e2e:smoke`
   - Open Phase 1 PR. Link this verification report in the description.

**Expected total Phase 1 effort:** 5–6 working days, consistent with the ADR's revised Phase 1 estimate.

---

## 7. What Phase 1 is still not responsible for

Called out explicitly so the Phase 1 PR doesn't scope-creep:

- **No Firebase imports yet.** Phase 2 adds `firebase/app` and `firebase/auth`.
- **No `onRemoteWrite` callback slot on `syncState` yet.** Phase 2 adds it after the split is merged.
- **No field-crypto module yet.** Phase 5a. Must land before Phase 3 sync engine per ADR §2.1.
- **No Cloud Functions project yet.** Phase 4.
- **No CSP amendment yet.** Phase 2 (done alongside the first `firebase/app` import).
- **No subscription-tier signal yet.** Phase 2.

---

## 8. Green light

Every ADR-flagged blocker has been verified. The one live risk (the `pdf-export.ts` `currencySymbol` path) is closed by a two-line defense-in-depth fix that will ship with the Phase 1 PR. The `state-actions.ts` split is mechanical and low-risk. The dead-code deletions and doc refreshes are cosmetic.

**Recommendation:** Open the Phase 1 branch today. Expected PR in ~5 working days. Phase 2 can start the day Phase 1 merges.

> **Scope amended by §9.** The DRY audit expanded Phase 1 from 5–6 days to ~6–8 days and added six new work items. See §9 for the revised scope, the landmine warning about `migration.ts` storage keys, and the superseding punch list. The green light still stands; the scope is simply larger.

---

## 9. DRY audit addendum (2026-04-10)

### 9.1 Context

After this verification report was originally written, a five-pass DRY audit was conducted across the Harbor Ledger codebase. The audit surfaced findings that are orthogonal to the ADR's verification work but overlap significantly with Phase 1 in scope — several items are mechanical codemods that fit naturally into the same PR as the `harbor_*` storage-key rename. This section captures every finding, classifies it by Phase 1 inclusion, and provides an expanded punch list that supersedes §6.

**Audit methodology:** Five passes of targeted pattern matching and import-boundary probing. Each pass focused on a different surface: storage/formatting/escaping (pass 1), transaction aggregation (pass 2), import-boundary migration (pass 3), tests and CSS and migration code (pass 4), e2e and build config (pass 5). Severity curve flattened by pass 5 — the audit is now exhausted.

**Overall DRY rating:** ~80th–85th percentile for a solo-maintained app of this size and age. The codebase has more centralized helpers than first credited (`sumByType`, `Validator`, `dom-cache`, `locale-service`, DI container, `effect-manager`, architecture contract tests). The real problems are "existing infrastructure is underused" and "one small migration stalled partway" — both fixable in Phase 1.

### 9.2 Full findings register

| # | Severity | Finding | Phase 1? | Estimated cost |
|---|---|---|---|---|
| 1 | **HIGH** | `budget_tracker_*` storage keys scattered across 15+ files; no central `SK` enum coverage of all ~35 keys | ✅ In-scope (already) | ~4 hrs |
| 13 | **LANDMINE** | `migration.ts` has two `budget_tracker_*` keys (`MIGRATION_KEY` at line 74, `budget_tracker_migrated_to_idb` at line 330) that **must NOT be renamed** — doing so would cause existing users to re-run the LocalStorage→IndexedDB migration on their already-migrated data. See §9.4 for required handling. | ✅ Required special-case | 15 min |
| 2 | **MEDIUM-HIGH** | Transaction aggregation pattern (`filter + reduce + toCents`) duplicated across ~15 files; `sumByType` exists in `utils-pure.ts:248` but is only used in 4 files; `pdf-export.ts:47–52` has a latent correctness bug (no `toCents`, no `isTrackedExpenseTransaction`, zero test coverage) | ✅ In-scope (new) | ~2 hrs |
| 10 | **MEDIUM** | `core/utils.ts` is marked `@deprecated` but 50 files still import from it vs only 4 from `utils-pure.ts`. Migration stalled at ~8% complete. | ✅ In-scope (new) | ~1–2 hrs |
| 3 | **MEDIUM** | `formatCurrency` triplicated: canonical in `locale-service.ts`, private copy in `budget-planner-ui.ts` (uses DI cache), private copy in `pdf-export.ts` (hardcoded `en-US` — latent i18n bug) | ✅ In-scope (new) | ~30 min |
| 4 | **LOW** | `new Date().toISOString().split('T')[0]` repeated in 5 files; no `todayISO()` helper; subtle UTC-vs-local timezone bug exists in one usage | ✅ In-scope (new) | ~15 min |
| 11 | **MEDIUM** | No `tests/helpers/` directory, no shared fixture builders. `createTx` defined twice (copy-pasted, not shared). 131 inline transaction literals across 13 test files. Every `Transaction` type change touches all 131 sites. | ❌ Separate small PR, **before** Phase 1 | ~30 min |
| 14 | **LOW** | Three e2e helpers duplicated between `dashboard-layout.spec.ts` and `visual-regression.spec.ts`: `enableStandaloneLikeMode`, `prepareShellBudgetAlert`, `swipeTransactionRow`. Should move into existing `e2e/test-helpers.ts`. | ❌ 15-min standalone cleanup | 15 min |
| 5 | MEDIUM | Date formatting decentralized across 20+ files with hardcoded `'en-US'` locale | ✅ **Completed** (CR-Apr21, 2026-04-21) — pulled forward from post-v3.0. All sites now route through `locale-service` helpers (`formatDateShort`, `formatMonthShort`, `formatMonthShortYear`, `formatCurrency`, `formatNumber`). ESLint `no-restricted-syntax` guard added to prevent regression. | Shipped |
| 12 | LOW | ~80 hardcoded hex color literals in `style.css` despite a healthy 245-variable / 879-usage token system. Worst offenders: `#e2e8f0` (14×), `#1e293b` (11×), `#334155` (9×), `#2563eb` (9×) | ⏸ Deferred to post-v3.0 design system work | — |
| 15 | LOW | Brand colors (`#0a0e27`, `#3b82f6`) hardcoded in both `vite.config.ts` (PWA manifest) and `style.css`; duplicated 4–5× in SVG data URLs inside the manifest | ⏸ Comment cross-reference during Phase 1; centralize later | — |
| 6 | LOW | `document.getElementById` bypasses `dom-cache.ts` in 29 sites across 21 files. Most are one-off setup queries, not hot paths. | ❌ Leave alone | — |
| 7 | — | Validator fan-out across 7 files | ❌ Good DRY — 6 of 7 are call sites into canonical `Validator` class in `core/validator.ts` | — |
| 8 | — | `async-modal.ts` has 27 `querySelector` calls | ❌ Domain density inside one component, not duplication | — |
| — | MICRO | `vite.config.ts:26` has dead-code duplicate `importer.includes('node_modules')` check (already returned at line 21) | Fix in passing during Phase 1 | 1 min |
| — | STRATEGIC | `tsJsResolverPlugin` in `vite.config.ts` is a TS migration shim that could be retired now that the codebase is fully TypeScript; rewrite imports to omit `.js` extensions and delete the plugin (~50 lines of build config simplification) | ⏸ Log as tech debt; not Phase 1 | ~1 hr |

### 9.3 Patterns affirmed as good (do not "fix")

Called out so a future review doesn't mistake them for duplication:

- **`esc()` wrapper layering.** `core/utils-pure.ts` defines the pure version; `core/utils-dom.ts` wraps it with DEV-mode suspicious pattern logging. Two-layer architecture is deliberate — pure core for tests/workers, DOM-aware version for production UI.
- **Storage adapter contract.** IndexedDB primary + LocalStorage fallback with a single contract interface is clean, not duplicated.
- **Architecture contract tests.** `tests/architecture-contract.test.ts` already enforces the 11-file direct-signal-writer allowlist and is designed to grow. Add to it during Phase 1; don't replace it.
- **DI container.** `core/di-container.ts` with `CURRENCY_FORMATTER` service is the right home for cross-cutting concerns.
- **Centralized `signals.ts`.** 21 signal/computed definitions in one file is density, not duplication.
- **Action-object setter boilerplate in `state-actions.ts`.** Looks like duplication at first glance but is deliberate for grep-ability, contract enforcement, and side-effect hook points. **Do NOT "DRY up" these setters** — several prior audits have been tempted to and would have broken the architecture contract.

### 9.4 Landmine: `migration.ts` storage keys (#13) — required handling

The most important finding in the entire audit. If handled incorrectly, this will corrupt existing users' IndexedDB data on their next app load after the `harbor_*` rename ships.

**The two offending lines:**

```ts
// js/modules/data/migration.ts:74
const MIGRATION_KEY = 'budget_tracker_idb_migration';

// js/modules/data/migration.ts:330
localStorage.setItem('budget_tracker_migrated_to_idb', Date.now().toString());
```

**Why these must NOT be included in the `budget_tracker_*` → `harbor_*` sweep:**

These keys answer a single question on every app boot: *"Has this user's LocalStorage-era data already been migrated to IndexedDB?"* For every user who has already migrated (which should be most of your user base at this point), these keys are currently set. If the Phase 1 rename blindly renames them:

1. On next app load, the migration module looks for `harbor_idb_migration`
2. Doesn't find it (it's still under the old name)
3. Concludes migration hasn't happened
4. **Tries to re-run the LocalStorage → IndexedDB migration**
5. Either crashes, or — worse — overwrites the live IndexedDB with stale LocalStorage data

**Required handling in Phase 1:**

1. **Preserve both literals under their current names.** Do not include them in the codemod.
2. **Add an explanatory comment above each one:**
   ```ts
   // PRESERVED ACROSS HARBOR LEDGER RENAME (ADR-001 §9.4): renaming this key
   // would cause existing users to re-run the IDB migration on their
   // already-migrated data. Do NOT include in the budget_tracker_* sweep.
   const MIGRATION_KEY = 'budget_tracker_idb_migration';
   ```
3. **Add a unit test** that asserts the exact string literal is unchanged, so a future rename sweep trips a CI failure before it reaches production:
   ```ts
   // tests/migration-key-preservation.test.ts
   it('migration-complete flag keys must remain under their legacy names', async () => {
     const src = await readFile('js/modules/data/migration.ts', 'utf8');
     expect(src).toContain("'budget_tracker_idb_migration'");
     expect(src).toContain("'budget_tracker_migrated_to_idb'");
   });
   ```
4. **Document in the Phase 1 PR description** that these two keys are intentional exceptions. Reviewers need to see this called out explicitly.

**Alternative (more ambitious, not recommended for Phase 1):** Add a one-time rename-flag migration that reads the old key, writes a new one, and deletes the old atomically. Adds complexity for minimal benefit. The preserved literals are a fine long-term state; they're an honest historical artifact that future-you should see and understand.

### 9.5 Expanded Phase 1 punch list (supersedes §6)

Concrete actions, in execution order, including all new DRY audit items. This list is authoritative.

**Step 0 — Pre-Phase-1 warm-up (separate small PR, ~30 min)**

Ship before Phase 1 so Phase 1's test updates can use the new fixture helpers.

- Create `tests/helpers/fixtures.ts` with `createTx(overrides?)`, `createIncomeTx(overrides?)`, `resetFixtureCounter()`
- Delete the two duplicate `createTx` definitions in `rollover.test.ts:39` and `data-atomic-chaos.test.ts:88`; import from the helpers file instead
- Migrate as many of the 131 inline transaction literals as practical (partial migration is fine — leave literals where the specific values are load-bearing for the assertion, e.g., `calculations-edge-cases.test.ts`)
- Run `npm run test:run` to confirm nothing regresses

**Step 1 — Security hardening (10 min)**

- Wrap `currencySymbol` in `esc()` inside `pdf-export.ts` `formatCurrency()` per §1.5
- Add a unit test asserting `formatCurrency` escapes HTML in the symbol

**Step 2 — Dead-code deletion (15 min)**

- Delete `js/modules/ui/virtual-scroller.ts` (orphan confirmed in §3)
- Grep-confirm `orchestration/app-init.ts` `deduplicateTransactions` has no importers; delete if orphaned
- Fix the dead-code `importer.includes('node_modules')` check at `vite.config.ts:26`
- Run `npm run typecheck` and `npm run test:run`

**Step 3 — `state-actions.ts` split (60–90 min)**

- Create `js/modules/core/actions/` with five files per §2.3
- Convert `state-actions.ts` to a thin barrel re-exporting the split action objects
- Update `tests/architecture-contract.test.ts` allowlist to include the new files
- Add the "`syncState.applyKeyUpdate()` switches over exactly 17 keys" contract assertion
- Run typecheck, test suite, and architecture contract test

**Step 4 — Storage-key rename with migration.ts exception (2–3 hrs)**

- Rename all ~33 `budget_tracker_*` keys to `harbor_*` across `core/state.ts`, `app-reset.ts`, `state-revision.ts`, and the remaining ~12 files (count excludes the 2 preserved keys in `migration.ts`)
- **Preserve `migration.ts:74` and `migration.ts:330` under their legacy names with the explanatory comments from §9.4**
- Add a one-time migration in `data/migration.ts` that copies old `budget_tracker_*` → `harbor_*` on first boot and deletes the old keys after successful copy (applies to the user-data keys, NOT the two preserved flags)
- Expand `SK` enum in `core/state.ts` to cover all ~35 keys
- Add architecture contract test: "no bare storage-key literals outside `core/state.ts` and `data/migration.ts`"
- Add the migration-key-preservation test from §9.4
- Add a unit test that seeds old keys, boots, and verifies the new keys exist and the old ones are gone

**Step 5 — `core/utils.ts` deprecation codemod (1–2 hrs)**

- Write a one-off script (or use `ts-morph`/sed) to rewrite imports in the 50 files that currently import from `core/utils.js`
- Pure symbols (`toCents`, `toDollars`, `sumByType`, `esc`, `getMonthKey`, etc.) → `core/utils-pure.js`
- DOM symbols → `core/utils-dom.js`
- Delete `core/utils.ts` entirely
- Add architecture contract test: "no imports from `core/utils.js` allowed" (prevents regrowth)
- Run typecheck + full test suite

**Step 6 — Transaction aggregation consolidation (~2 hrs)**

- Add `sumTrackedExpenseCents(txs)` as a sibling to the existing `sumByType` in `utils-pure.ts`, with JSDoc on both explaining the transfer-exclusion semantic difference
- Migrate ~15 call sites from inline `filter + reduce + toCents` to the appropriate helper
- **Fix the `pdf-export.ts:47–52` bug** in the same commit: use `toCents` math and `sumTrackedExpenseCents` for expenses
- Add a regression test: dataset with one transfer and one float-precision-sensitive amount (e.g., $10.10 × 3 = $30.30), export to PDF HTML, assert totals match `getYearStatsPure`
- Add architecture contract test: any file outside `core/`, `features/financial/`, and `features/analytics/` that calls `.reduce((s, t) => s + ... .amount` directly fails CI

**Step 7 — `formatCurrency` consolidation (~30 min)**

- Promote `locale-service.ts`'s `formatCurrency` as canonical
- Add `formatCurrencyParts(amount, symbol)` for the `pdf-export.ts` use case (separates symbol from number so `esc()` can wrap the symbol cleanly)
- Delete the private copies in `budget-planner-ui.ts` and `pdf-export.ts`
- This step must land *after* Step 6 so the new helpers are available

**Step 8 — `todayISO` helper (~15 min)**

- Add `todayISO()` (UTC-safe) and `todayLocalISO()` (timezone-aware) to `core/utils-pure.ts`
- Migrate the 5 call sites; fix the subtle UTC-vs-local timezone bug discovered during the audit
- Add a unit test for both variants

**Step 9 — Docs refresh (45 min — already done in this session)**

- ✅ `AGENTS.MD` allowlist + header
- ✅ `js/modules/README.md` full rewrite
- ✅ `docs/PROJECT_SUMMARY.md`, `TECHNICAL_REVIEW.md`, `FEATURE_INVENTORY.md`, `MARKET_STRATEGY.md`, `IMPROVEMENT_ROADMAP.md`, `IMPROVEMENTS_COMPLETED.md`
- ✅ Root `README.md` per-subdir counts

Remaining: update `AGENTS.MD` again after Step 3 (to add the new `core/actions/*-actions.ts` files to the allowlist).

**Step 10 — Deferred / opportunistic during Phase 1**

- Add cross-reference comments linking brand colors in `vite.config.ts` ↔ `style.css` (#15)
- Fix any hardcoded CSS color literals (#12) encountered *while touching a file for another reason* — no dedicated sweep

**Step 11 — Final gate**

- `npm run typecheck` (0 errors)
- `npm run test:run` (target: previous pass count + new tests from Steps 4, 6, 8, and the landmine test)
- `npx vitest run tests/architecture-contract.test.ts` (6+ tests, all new contract assertions included)
- `npm run build`
- `npm run test:e2e:smoke`
- Open Phase 1 PR. Link this verification report in the description. Explicitly call out the `migration.ts` exception from §9.4.

### 9.6 Revised effort estimate

| Phase | Original (§6) | Revised (§9.5) | Delta |
|---|---|---|---|
| Pre-Phase-1 warm-up (Step 0) | — | 30 min | new |
| Step 1 Security hardening | 10 min | 10 min | — |
| Step 2 Dead-code deletion | 15 min | 15 min | — |
| Step 3 `state-actions.ts` split | 60–90 min | 60–90 min | — |
| Step 4 Storage-key rename | 2–3 hrs | 2–3 hrs | — |
| Step 5 `core/utils.ts` deprecation codemod | — | 1–2 hrs | new |
| Step 6 Aggregation consolidation + pdf-export fix | — | ~2 hrs | new |
| Step 7 `formatCurrency` consolidation | — | 30 min | new |
| Step 8 `todayISO` helper | — | 15 min | new |
| Step 9 Docs refresh | 45 min | 0 (already done) | -45 min |
| Step 10 Opportunistic deferred items | — | 0 | — |
| Step 11 Final gate | included | included | — |
| **Total** | **~5–6 working days** | **~6–8 working days** | **+1–2 days** |

### 9.7 Items deferred beyond Phase 1

| # | Item | When to revisit |
|---|---|---|
| 5 | ~~Date formatting centralization (20+ files, hardcoded `'en-US'`)~~ | ✅ **Pulled forward and completed in CR-Apr21 (2026-04-21)** — all date/number/currency formatters route through `locale-service` helpers; ESLint `no-restricted-syntax` guard prevents regression |
| 11 (partial) | Remaining inline transaction literals in test files | Opportunistically during future test refactors; no dedicated sweep |
| 12 | ~80 hardcoded CSS hex color literals | Part of post-v3.0 design system maturation (dark mode, high-contrast, white-labeling) |
| 14 | Three duplicated e2e helpers | Standalone 15-min cleanup PR after Phase 1 |
| 15 | Brand color centralization (vite.config.ts + style.css) | Post-v3.0, logged as tech debt |
| — | `tsJsResolverPlugin` retirement | Post-v3.0, after `.js` → no-extension import codemod |
| — | CSP `connect-src` amendment for Firebase | Phase 2 kickoff (not this PR) |

### 9.8 Bottom line

Phase 1 grew. It's now a genuinely high-value PR that ships:

- Brand completion (rename sweep)
- A correctness fix for `pdf-export.ts` (the aggregation bug)
- Completion of a stalled migration (`core/utils.ts` deprecation)
- Architectural hardening (three new contract tests)
- A critical landmine avoidance (`migration.ts` key preservation)
- Dead-code removal and the `state-actions.ts` split

Four wins in one bundle instead of one. The intellectual risk remains low — architecture contract tests will catch regressions, typecheck will catch import mistakes, and the existing 636-case Vitest suite plus the new regression tests will catch behavior drift.

**Recommendation unchanged:** Open the Phase 1 branch today. Execute Step 0 as a warm-up PR first (~30 min, low risk). Then execute Steps 1–11 as a single focused work session over ~6–8 days. Phase 2 can still start the day Phase 1 merges.
