# ADR-001: Firestore Cloud Sync for Harbor Ledger v3.0

**Status:** Accepted — ready for Phase 1 kickoff
**Date:** 2026-04-10 (revised after Rounds 11–14 reconnaissance)
**Deciders:** Frank Reed (sole maintainer)
**Supersedes:** Supabase sync direction implied in `docs/MARKET_STRATEGY.md`
**Related:** `docs/IMPROVEMENT_ROADMAP.md`, `docs/LAUNCH_CHECKLIST.md`, `harbor-ledger-comprehensive-review.md`, `harbor-ledger-round6-review.md`

## Decision log

| Date | Revision | Change |
|---|---|---|
| 2026-04-10 | r1 | Initial draft (Rounds 1–10) |
| 2026-04-10 | r2 | Rounds 11–14 amendments: encryption posture locked to Option B (full E2EE); credited state-revision / multi-tab-sync-conflicts / transaction-manager / syncState as pre-built; storage debt bumped from 33 to 35+ keys; Phase 1 expanded to include dead-code deletion, stale-docs refresh, and `state-actions.ts` split; Phase 3 rewritten to integrate (not rebuild) conflict layers; Phase 5 expanded to E2EE; added Sections 5.6 (auto-lock) and 5.7 (CI gates); added pre-v3.0 security audit of `pdf-export.ts`; corrected direct-writer allowlist to 11 files; corrected sync scope to include `SK.ACHIEVE` and `SK.STREAK` per existing `syncState.applyKeyUpdate()`. |

---

## 1. Context

### 1.1 What we are deciding

Harbor Ledger is a privacy-first, local-first personal finance PWA shipping at v2.6.2. The v3.0 milestone introduces authenticated cloud sync, a freemium subscription model, and cross-device continuity. This ADR locks in the cloud sync backend, the integration strategy, the bundle/cost budgets, and the phased rollout.

### 1.2 Forces at play

| Force | Detail |
|---|---|
| **Solo maintainer** | One builder owning code, design, UX, and ops. Maintenance burden per component must be minimized. |
| **Local-first invariant** | App must continue to work offline with zero cloud dependency. Sync is additive, not load-bearing. |
| **Strict CSP baseline** | `index.html` enforces `connect-src 'self'` today — any cloud backend requires a deliberate, minimal CSP amendment. |
| **Bundle budget discipline** | `vite.config.ts` already splits `@preact/signals-core` + `lit-html` into a `framework` chunk. A sync backend cannot bloat the free-tier bundle. |
| **Architectural readiness** | The data-layer delta contract (`js/modules/core/data-sync-interface.ts`) and the `DataHandler.onDataPatched` callback (`js/types/index.ts`) were built anticipating a remote backend. The hook points exist. |
| **Financial data sensitivity** | Integer-cents math, PBKDF2 600k PIN hashing, and domain-layer purity already treat this as high-trust data. Cloud transit must match. |
| **Cross-platform parity** | Capacitor ships iOS + Android alongside the web PWA. Apple-only backends are off the table. |
| **Freemium economics** | Target: $4.99/mo, $39.99/yr, $99.99 lifetime. Backend costs per free user must stay near-zero; paid-user margin must survive at small scale. |

### 1.3 What the codebase already provides (the integration is ~75% pre-built)

Fourteen rounds of codebase reconnaissance (capped after Round 6 convergence of the parallel 7-skill audit in `harbor-ledger-comprehensive-review.md`) confirmed the following load-bearing seams are already in place — Firestore integration is **additive, not a refactor**. Original draft credited 60%; the Rounds 11–14 discoveries of Lamport clocks, atomic state groups, the `syncState` action group, and the existing `_persist()` revision minting move the pre-built fraction to ~75%.

**Delta transport contract** — `js/modules/core/data-sync-interface.ts` already exposes the exact wire format a cloud sync engine needs:

```typescript
export const DataSyncEvents = {
  REQUEST_RELOAD: 'data:request:reload',
  REQUEST_APPLY_DELTA: 'data:request:apply_delta',
  REQUEST_SYNC: 'data:request:sync',
  SYNC_COMPLETE: 'data:sync:complete',
  SYNC_ERROR: 'data:sync:error',
  TRANSACTION_UPDATED: 'data:transaction:updated',
  TRANSACTION_DELTA_APPLIED: 'data:transaction:delta_applied',
  BULK_UPDATE: 'data:bulk:update'
} as const;

export function requestDataApplyDelta(
  change: TransactionDataDelta,
  source: string = 'unknown',
  metadata: { revision?: number; tabId?: string; timestamp?: number } = {}
): void { emit(DataSyncEvents.REQUEST_APPLY_DELTA, { change, source, ...metadata }); }
```

The `metadata: { revision, tabId, timestamp }` shape is exactly the Last-Writer-Wins conflict resolution envelope Firestore needs.

**Discriminated change type** — `js/types/index.ts` lines ~680–710:

```typescript
export interface TransactionDataChange {
  type: 'add' | 'update' | 'delete' | 'batch-add' | 'batch-delete' | 'split';
  item?: Transaction;
  previousItem?: Transaction;
  items?: Transaction[];
  id?: string;
  ids?: string[];
}

export interface DataHandler {
  onDataChanged(transactions: Transaction[]): void;
  onDataPatched?(change: TransactionDataChange, transactions: Transaction[]): void;
}
```

All six change types map 1:1 to Firestore document events (`added` / `modified` / `removed`) with trivial fan-out logic.

**Dual-handler integration point** — `js/modules/orchestration/app-init-di.ts` lines 239–246:

```typescript
const initResult = await dataSdk.init({
  onDataChanged: (transactions) => {
    signals.replaceTransactionLedger(transactions);
  },
  onDataPatched: (change) => {
    signals.applyTransactionPatch(change);
  }
});
```

This is the single site where a `SyncEngine` service plugs in. A `_persist()` hook in `js/modules/data/data-manager.ts` fires on every local mutation — that is the outbound edge. `onDataPatched` is the inbound edge.

**DI container** — `js/modules/core/di-container.ts` has 16 registered services with lazy resolution, circular-dependency detection, and `initializationPromise` re-entry protection. Adding `AUTH_SERVICE` and `SYNC_ENGINE` as lazy services is a two-line enum change plus registration.

**Reset contract** — `js/modules/orchestration/app-reset.ts` enumerates every app signal and every localStorage key/prefix in one place. Any Firestore-related local state must be added to `resetSignalsToFirstUseState()` and `APP_LOCAL_STORAGE_KEYS` in the same PR that introduces it.

**Migration blueprint** — `js/modules/data/migration.ts` (664 lines) already embodies the backup-first, batched (100/chunk), version-marked, rollback-flagged storage migration pattern. Phase 1 storage prefix rename reuses this pattern verbatim.

**Revision minting is already wired into `_persist()`** — `js/modules/data/data-manager.ts` lines 380–500 already generates revision numbers on every local mutation and fans them out to the broadcast layer:

```typescript
// data-manager.ts:478–495
if (anyBackendOk) {
  const revision = await stateRevision.recordStateChange(SK.TX, null, getTabId(), {
    skipChecksum: true
  });
  if (change) {
    stateRevision.recordTransactionDelta(revision.revision, change, getTabId());
    invalidateAffectedMonthCaches(currentTransactions, change);
  } else {
    invalidateAllCache();
  }
  broadcastManager.sendStateUpdate(SK.TX, change, {
    revision: revision.revision,
    changeType: change?.type || 'reload',
    changedIds: getChangedIds(change)
  });
}
```

Phase 3's `SyncEngine.pushChange()` does not need to mint revisions — it consumes the envelope that `_persist()` already emits. Called from 6 sites in `data-manager.ts` (lines 352, 574, 618, 651, 674, 755).

**Conflict causality is already far more sophisticated than LWW** — `js/modules/core/state-revision.ts` (851 lines) implements a Lamport clock, vector clock, and atomic state groups:

```typescript
interface StateRevision {
  revision: number;
  timestamp: number;
  logicalClock: number;
  vectorClock?: Record<string, number>;
  tabId: string;
  key: string;
  checksum?: string;
  atomicGroup?: string;
  lastModifier?: string;
}

const ATOMIC_STATE_GROUPS = {
  FINANCIAL_CORE: [SK.TX, SK.SAVINGS, SK.ALLOC],
  DEBT_CORE: [SK.DEBTS, SK.TX],
  CATEGORY_CORE: [SK.CUSTOM_CAT, SK.TX]
};

// Default policy:
conflict_resolution_policy?: 'last_writer_wins' | 'user_decides' | 'merge';

// Already designed for remote peers:
function updateLogicalClock(remoteClock: number): number {
  logicalClock = Math.max(logicalClock, remoteClock) + 1;
  ...
}
```

And `js/modules/core/multi-tab-sync-conflicts.ts` provides typed detection with user-activity awareness (5-second typing/unsaved-changes threshold before declaring a conflict), and `js/modules/data/transaction-manager.ts` provides `withTransaction()` / `Operation` LIFO rollback for atomic multi-step mutations.

Phase 3 does not build LWW from scratch — it integrates these three layers. That is a meaningfully smaller scope than the original draft assumed.

**The `syncState` action group already exists and enumerates exactly what syncs** — `js/modules/core/state-actions.ts` lines 570–657 defines `syncState.applyKeyUpdate(key, value)` as a switch over **17 storage keys**, each routing to the correct action-object writer:

| SK constant | Routes to |
|---|---|
| `TX` | `signals.replaceTransactionLedger` |
| `THEME` | `settings.setTheme` |
| `PIN` | `settings.setPin` |
| `ALLOC` | `data.setMonthlyAllocations` |
| `SAVINGS` | `savingsGoals.setGoals` |
| `CUSTOM_CAT` | `data.setCustomCategories` |
| `DEBTS` | `debts.setDebts` |
| `CURRENCY` | `data.setCurrencySettings` |
| `SAVINGS_CONTRIB` | `savingsGoals.setContributions` |
| `ROLLOVER_SETTINGS` | `settings.setRolloverSettings` |
| `SECTIONS` | `settings.setSections` |
| `ALERTS` | `settings.setAlerts` |
| `INSIGHT_PERS` | `settings.setInsightPersonality` |
| `ACHIEVE` | `settings.setAchievements` |
| `STREAK` | `settings.setStreak` |
| `FILTER_PRESETS` | `data.setFilterPresets` |
| `TX_TEMPLATES` | `data.setTxTemplates` |

This is the authoritative sync scope. The architecture has already committed to syncing achievements and streak state. Phase 2 extends `syncState` with a Firestore write fan-out; it does **not** add new direct signal writers. This keeps the 11-file direct-writer allowlist (enforced by `tests/architecture-contract.test.ts`) untouched.

### 1.4 What the codebase does not yet provide

| Gap | Location to address |
|---|---|
| Storage key prefix rebrand (**35+** `budget_tracker_*` keys) | `core/state.ts` (26 in `SK`), `orchestration/app-reset.ts` (3 hardcoded + 2 prefix families), `data/migration.ts` (3 more), `core/state-revision.ts` (`REVISION_KEY` + `TRANSACTION_DELTA_LOG_KEY`) |
| CSP `connect-src` amendment | `index.html` line ~10 and `vite.config.ts` (no csp plugin today) |
| Auth state signal + subscription tier signal | New signals in `core/signals.ts`; reset entries in `app-reset.ts` |
| Firestore SDK bundle isolation | `vite.config.ts` `manualChunks` extension |
| Stripe / Apple IAP / Google Billing receipt verification | New Cloud Functions project, not in the web repo |
| **Full E2EE** for all synced fields (see §2.1) | New `core/field-crypto.ts` wrapping existing Web Crypto utilities |
| Dead code deletion blocking rename | `js/modules/ui/virtual-scroller.ts` (self-documented deprecated duplicate), verify `js/modules/orchestration/app-init.ts` unused helpers |
| Stale agent docs feeding wrong allowlist into future agents | `AGENTS.MD` lines 74–83 missing `core/category-store.ts`; `js/modules/README.md` stale counts and stale brand; `docs/MARKET_STRATEGY.md` + `docs/IMPROVEMENT_ROADMAP.md` still use "Budget Tracker Core/Pro/Elite" tier names |
| `state-actions.ts` at 657 lines is over the 600-line split threshold before Phase 2 extends it further | Split into per-domain action files (`navigation-actions.ts`, `modal-actions.ts`, `sync-actions.ts`, etc.) |
| Unverified `document.write()` XSS surface in print-to-PDF | `js/modules/features/import-export/pdf-export.ts` lines 43, 272, 288 (`buildPdfHtml` + `document.write`) — HTML-escape audit required before v3.0 ships |

---

## 2. Decision

**Adopt Firebase Firestore as the Harbor Ledger v3.0 cloud sync backend**, integrated as a lazy-loaded `SyncEngine` service that plugs into the existing `_persist()` hook outbound and the `DataHandler.onDataPatched` callback inbound, with the Firestore SDK configured for `persistentLocalCache` + `persistentMultipleTabManager` so that Firestore's IndexedDB cache and Harbor Ledger's existing IndexedDB adapter run side-by-side without mutual interference.

### Why Firestore specifically

1. **Mature offline-first semantics** out of the box — exactly the posture Harbor Ledger already takes, reducing impedance mismatch.
2. **`persistentMultipleTabManager`** matches Harbor Ledger's existing BroadcastChannel + Web Locks API multi-tab architecture (`data/indexeddb-adapter.ts:480–527`) without fighting it.
3. **Auth, payments adjacency, push, analytics** all live in one console with a single billing relationship — meaningful for a solo maintainer who should not be gluing five vendors together.
4. **Tree-shakable modular SDK (v9+)** — we import only `initializeFirestore`, `doc`, `collection`, `onSnapshot`, `setDoc`, `deleteDoc`, `writeBatch`. Estimated bundle impact: ~40KB gzipped for the sync path, loaded only after authenticated premium sign-in.
5. **Security rules** enforce per-user data isolation server-side, so a client bug cannot leak another user's data — defense-in-depth on top of field-level encryption.
6. **Known free-tier ceiling**: 50K document reads, 20K writes, 1 GiB storage per day — comfortably covers the free tier for the first ~2,000 MAU before cost becomes a design variable.

### 2.1 Encryption posture — full client-side E2EE

**Decision: Harbor Ledger v3.0 ships with full end-to-end encryption.** Every synced field — amount, date, category, description, note, debt balance, savings contribution — is encrypted client-side with a user-derived key before any Firestore write. The Firebase server sees ciphertext only. No client bug, server bug, rules misconfiguration, or legal process can leak plaintext financial data.

#### Why full E2EE and not the partial-encryption posture in the v1 draft

The original draft scoped encryption to `note` and `description` only, on the theory that amounts, dates, and categories staying plaintext would enable future server-side aggregation features. Four arguments reversed that call:

1. **Marketing and strategic alignment.** `docs/MARKET_STRATEGY.md` sells Harbor Ledger as "Your finances, your device, your control." `docs/IMPROVEMENT_ROADMAP.md` commits to a "no-knowledge architecture where server never sees raw data." Partial encryption makes both statements technically untrue. Shipping a "privacy-first" app that stores plaintext financial amounts in a third-party database is a marketing vulnerability the competition will exploit.
2. **Worst-of-both-worlds for compliance.** Partial encryption does not remove Harbor Ledger from the regulatory perimeter — holding any plaintext financial data on behalf of users triggers the same GDPR / CCPA / state-specific disclosure obligations as holding all of it. The compliance burden is fixed; the privacy story is weakened for no benefit.
3. **Server-side aggregation is not on the roadmap.** The IMPROVEMENT_ROADMAP.md v4.0 feature direction is local LLM inference via WebGPU/Wasm, voice commands, OCR receipts, and investment tracking. None of these require plaintext server-side access. Preserving "optionality" for server-side analytics features that are not planned is premature optimization against a capability we are not going to use.
4. **The existing codebase already treats this data as high-trust.** PBKDF2 600k PIN hashing, integer-cents math, Web Crypto API, the `data/export-import/*` encrypted-backup path — the architecture already operates as if the data is sensitive. Partial encryption is inconsistent with the rest of the codebase's posture.

#### Implementation sketch

- **Key derivation.** Email/password users derive a data encryption key (DEK) via PBKDF2-SHA256 at 600k iterations (matching the existing PIN hasher's parameters in `features/security/pin-crypto.ts`) from a separate encryption passphrase set on first sync activation. OAuth users (Google, Apple) are prompted to set an encryption passphrase on the same sign-in-first-sync screen; the passphrase never leaves the client and never touches Firebase Auth.
- **Envelope encryption.** Each document gets a random 256-bit per-record key wrapped with the DEK via AES-KW. This means passphrase rotation re-wraps keys instead of re-encrypting every document, and a single-record key leak does not compromise the whole dataset.
- **AES-GCM for field ciphertext.** 96-bit random IV per field, 128-bit auth tag. Additional authenticated data (AAD) includes the user's Firebase UID and the document path, so a ciphertext lifted out of its document cannot be replayed into another user's collection.
- **Searchable fields.** Harbor Ledger does no server-side search today. Client-side search over the decrypted local ledger is already how every list/filter works in v2.6.2. E2EE does not regress any user-visible functionality.
- **Key recovery.** Lost passphrase = lost cloud data (by design). The ADR pairs this with a mandatory **export-to-local-backup** nudge at passphrase-creation time and at every passphrase change. Free users (no cloud sync) are unaffected.
- **Device-to-device bootstrap.** On a new device, the user enters the encryption passphrase once; the device derives the DEK and unwraps per-record keys on demand. No secret material is transported through Firestore.

#### What stays plaintext on the server

- Firebase UID (opaque token, not financial data).
- Document existence / count (Firestore metadata — unavoidable).
- `lastModified` timestamp and `revision` number from `state-revision.ts` (required for conflict resolution; these are not financial data).
- `atomicGroup` label and `vectorClock` shape (causality metadata; not financial data).
- Subscription tier status on the user doc (required for Firestore rules to gate access).

Everything that is genuinely user-owned financial data becomes ciphertext.

#### Acceptance criterion for Phase 5

Firestore Emulator test suite must demonstrate that:
1. Every document under `users/{uid}/transactions` has all financial fields as base64 ciphertext strings.
2. Deleting the encryption passphrase cache and re-entering it successfully round-trips plaintext → ciphertext → plaintext on the client.
3. A Firestore security-rules test confirms that even a rule misconfiguration cannot reveal plaintext — because no plaintext exists server-side.

---

## 3. Options Considered

### Option A: Firebase Firestore (CHOSEN)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — SDK is large but tree-shakable; rules language has a learning curve |
| Setup time | Low — project creation to working auth in hours, not days |
| Cost (free tier) | Very low — well within free quota at expected MAU |
| Cost (scale) | Predictable — per-read pricing rewards the delta model we already plan to use |
| Scalability | High — Google infra, automatic horizontal scaling |
| Bundle impact | ~40KB gzipped (lazy-loaded, premium path only) |
| Offline semantics | Native — matches Harbor Ledger posture |
| Multi-tab | Native via `persistentMultipleTabManager` |
| Solo-maintainer burden | Low — one console, one vendor, one SLA |
| Vendor lock-in | Medium — sync engine is abstracted behind `SyncEngine` interface, but query semantics and rules language are Firebase-specific |
| Data export | Full via `getDocs` + local IDB; user-initiated export already ships |

**Pros:**
- Fastest path to a working v3.0 without rebuilding half the data layer
- Auth, payments, push notifications in one place
- Offline-first posture aligns with app values
- Free tier absorbs the free-user base indefinitely at projected scale
- Excellent Capacitor story (no native bridges required)

**Cons:**
- Vendor lock-in on query semantics and security rules DSL
- Bundle hit on premium path (~40KB) needs disciplined lazy loading
- Firestore's own IndexedDB cache sits alongside Harbor Ledger's IDB — small risk of storage-quota pressure on aggressive users; must be load-tested
- Security rules must be hand-written and reviewed; mistakes here are catastrophic

### Option B: Supabase (Postgres + Realtime)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — more relational thinking required |
| Setup time | Medium — schema-first; RLS policies to write |
| Cost (free tier) | Generous (500MB DB, 2GB bandwidth) but harder to stay inside with per-row realtime |
| Scalability | Good — Postgres scales well vertically, less obvious horizontal path |
| Bundle impact | ~45–55KB gzipped for `@supabase/supabase-js` |
| Offline semantics | Weak — no first-party offline cache; community shims |
| Multi-tab | Not native; we'd reuse our BroadcastChannel layer |
| Solo-maintainer burden | Medium-high — more moving parts (RLS, migrations, realtime channels) |
| Vendor lock-in | Lower — it's Postgres; portable |

**Rejected because:** Supabase's offline story is weak and the realtime channel model does not map as cleanly to our existing `onDataPatched` contract. The lower lock-in is attractive but does not outweigh the 2–3x extra integration effort for a solo maintainer. `MARKET_STRATEGY.md` mentioned Supabase aspirationally; this ADR supersedes that direction.

### Option C: Custom backend (Node/Deno + Postgres on Fly.io)

| Dimension | Assessment |
|---|---|
| Complexity | High — auth, rate limiting, realtime, payments, receipts all DIY |
| Setup time | Weeks — not days |
| Cost | Low at rest, unpredictable under load |
| Scalability | Entirely our problem |
| Offline semantics | Entirely our problem |
| Solo-maintainer burden | Unsustainable |
| Vendor lock-in | None |

**Rejected because:** Total cost of ownership is hostile to a solo maintainer. Every hour spent on backend infra is an hour not spent on the product. This is the correct answer only if we grow a backend-owning engineer on the team.

### Option D: CloudKit (iCloud) only

| Dimension | Assessment |
|---|---|
| Complexity | Low on iOS, impossible on Android/Web |
| Setup time | Low |
| Cost | Free to Apple users |
| Offline semantics | Native |
| Cross-platform | **No Android, no web sync** |

**Rejected because:** Android parity is a first-class goal. A sync backend that cannot serve Android users fragments the product.

### Option E: Cloudflare D1 + Durable Objects

| Dimension | Assessment |
|---|---|
| Complexity | High — realtime fan-out via DO requires custom code |
| Bundle impact | Minimal (just `fetch`) |
| Cost | Very low |
| Offline semantics | DIY |

**Rejected because:** Custom realtime implementation is a multi-week undertaking for a solo maintainer. Attractive in two years; premature now.

---

## 4. Trade-off Analysis

The dominant axis is **solo-maintainer sustainability vs. vendor lock-in**. Firestore pays lock-in as its price. Every alternative either (a) transfers that cost to custom infrastructure work the solo maintainer cannot afford, or (b) fails the offline-first / cross-platform / integrated-payments bar.

The `SyncEngine` interface is the lock-in firewall: as long as all Firestore calls sit behind a single DI-resolved service, a future port to another backend costs weeks, not months. The wire format (`TransactionDataChange`) is already backend-agnostic — it was designed for this.

The second axis is **bundle discipline**. Target budgets:

| Tier | Budget (gzipped) | Rationale |
|---|---|---|
| Free, anon | ~20KB additional over v2.6.2 baseline | Free users should pay minimal bundle tax; only Firebase Auth loads lazily |
| Free, authenticated (no sync) | ~25KB additional | Auth only; Firestore does not load until premium activation |
| Premium, authenticated | ~55–65KB additional | Firestore lazy-loaded once subscription tier confirmed |

Achieved by: `manualChunks` in `vite.config.ts` splits Firebase Auth and Firestore into separate chunks; dynamic `import('./sync/firestore-engine.js')` behind a subscription-tier guard; tree-shaking verified in CI via a bundle-size check.

The third axis is **integration risk vs. refactor scope**. Because the delta contract (`data-sync-interface.ts`), the `_persist()` revision-minting path (`data-manager.ts:380–500`), the `syncState.applyKeyUpdate()` 17-key fan-out (`state-actions.ts:570–657`), the Lamport/vector-clock causality layer (`state-revision.ts`), the user-activity-aware conflict detector (`multi-tab-sync-conflicts.ts`), and the dual-handler hook (`app-init-di.ts:239–246`) already exist, this is a plug-in, not a rewrite. The refactor scope is bounded to: (1) storage prefix rename (35+ keys) + dead-code deletion + stale-docs refresh + `state-actions.ts` split (Phase 1), (2) CSP amendment (Phase 2), (3) three new DI services — `AUTH_SERVICE`, `SYNC_ENGINE`, `FIELD_CRYPTO` (Phases 2/3/5), (4) two new signals — `authSignal`, `subscriptionTierSignal` (Phase 2), (5) one new orchestration module — the Firestore sync engine (Phase 3), (6) new Cloud Functions project for receipt verification (Phase 4), (7) field-crypto module + passphrase UI (Phase 5). Total: roughly a two-week core implementation stretched to 4–6 weeks for disciplined phasing, testing, and the stale-debt payoff landing in Phase 1.

---

## 5. Consequences

### 5.1 What becomes easier

- Cross-device continuity ships without custom conflict resolution — the three existing layers (Lamport/vector-clock causality, atomic state groups, user-activity-aware detection in `multi-tab-sync-conflicts.ts`) are extended from multi-tab to multi-device by feeding remote `{ revision, logicalClock, vectorClock, tabId }` metadata through the same paths that already handle cross-tab reconciliation.
- Payments, auth, and sync live in one vendor relationship — one invoice, one dashboard, one incident surface.
- Freemium gating has a clean enforcement layer: `SyncEngine.isEnabled()` checks `authSignal.value?.subscription?.active === true`; no other code needs to know.
- Push notifications (budget threshold alerts, recurring-transaction reminders) become trivial via FCM — a v3.1 lever.

### 5.2 What becomes harder

- CSP audit surface grows. Every Firebase endpoint added to `connect-src` is a permanent policy concession that must be reviewed in security audits.
- Bundle size becomes a CI gate. Free-tier bundle regressions must fail the build.
- Firestore security rules become a piece of code we ship and test. Rules cannot be unit-tested the way TypeScript can; we need the Firestore Emulator in CI.
- Data residency questions appear (GDPR Article 3). We declare US-only data residency initially and document it in the privacy policy; EU residency is a v3.1 decision.
- Offline → online reconciliation edge cases multiply. The existing multi-tab tests (`tests/multi-tab-sync.test.ts`) need companions for multi-device scenarios.

### 5.3 What we will need to revisit

- **Bundle budgets** — re-check after each phase ships; tighten if we drift over budget.
- **Free-tier quota** — re-check at 1,000 and 5,000 MAU; switch to bundled Cloud Functions billing if reads exceed free tier.
- **Vendor lock-in** — re-evaluate annually; if Firestore pricing becomes hostile or a credible open-source alternative matures (e.g., ElectricSQL reaches 1.0), reassess.
- **Field encryption scope** — v3.0 ships full E2EE per §2.1 (every financial field ciphertext, metadata plaintext). Revisit only if regulatory changes require us to reveal more plaintext server-side for compliance attestation — which is a policy pivot, not a tuning knob.

### 5.4 What the four readiness-state DOM contracts require

Phase 3 (Sync Engine) must preserve the existing four-state boot contract in `app-init-di.ts`:

- `data-app-shell-ready` — UI shell rendered (must fire before any sync work begins)
- `data-app-interactive-ready` — local data loaded and interactive (must fire regardless of sync status)
- `data-app-background-ready` — background initialization complete (this is where sync engine initialization reports success)
- `data-app-background-failed` — background init failed (sync engine failure reports here; UI remains fully interactive locally)

Acceptance criterion for Phase 3: the app must reach `data-app-interactive-ready` in the same P95 time with sync enabled as without. Sync is a background concern, not a boot dependency.

### 5.5 Storage prefix rename — load-bearing for v3.0 branding

The storage key audit uncovered 33+ `budget_tracker_*` keys across three files (`core/state.ts`, `orchestration/app-reset.ts`, `data/migration.ts`) plus two prefix families (`monthly_totals_cache`, `budget_tracker_sync_`). The rebrand to Harbor Ledger is incomplete as long as these persist — and v3.0 is the last reasonable window to rename them before cloud sync permanently codifies the old prefix in Firestore document IDs and schema.

**Decision: fold the storage prefix rename into Phase 1, before any Firestore code ships.** The `MigrationManager` blueprint in `data/migration.ts` is directly reusable: backup-first snapshot, batch 100/chunk, version marker, rollback failure flag. Estimated cost: one focused day inside Phase 1.

### 5.6 Sync behavior during auto-lock

Harbor Ledger's `features/security/auto-lock.ts` triggers a lock on `visibilitychange` → `hidden` as an aggressive privacy measure, and on an inactivity timer. The sync engine must not leak behavior through the lock boundary.

**Rules for Phase 3:**

- **Outbound writes continue while locked.** A locked session still has the encryption passphrase in memory (until the passphrase cache timer expires). Pending local writes flush to Firestore as ciphertext normally. Blocking outbound writes on lock would strand the user's recent entries in IndexedDB and require another unlock-roundtrip to sync — a worse UX without a security benefit, since the ciphertext is what lives on the server either way.
- **Inbound reads are buffered, not applied.** `onSnapshot` listeners stay subscribed while locked so the `persistentLocalCache` stays warm, but the inbound `requestDataApplyDelta` path is gated behind the lock state — buffered deltas apply on unlock. This prevents a background data change from silently updating the visible (locked) summary numbers behind the lock screen.
- **Passphrase cache TTL is independent of auto-lock TTL.** Auto-lock is a privacy affordance (hide the screen); passphrase cache is a cryptographic affordance (allow decryption without re-prompting). The two can and should have different timeouts. Recommended defaults: auto-lock 2 minutes, passphrase cache 15 minutes, with independent user override.
- **Passphrase expiration during sync.** If the passphrase cache expires mid-sync-operation, the engine pauses writes, surfaces a "re-enter passphrase" prompt on unlock, and resumes from the pending queue after re-derivation.

### 5.7 CI gates (hard gates before any Phase 3+ merge)

Every PR from Phase 3 onward must pass:

| Gate | Command / Check |
|---|---|
| TypeScript typecheck | `npm run typecheck` — 0 errors |
| Unit + architecture contracts | `npm run test:run` — includes `architecture-contract.test.ts` and `state-actions-contract.test.ts` |
| Playwright smoke | `npm run test:e2e:smoke` across chromium, webkit, mobile-safari |
| Visual regression | baselines at `e2e/visual-regression.spec.ts-snapshots/` — no unapproved diffs |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` — zero high/critical |
| Supply-chain dependency review | `actions/dependency-review-action@v4` on the PR — blocks new high/critical deps |
| Bundle size | free tier delta ≤ 5KB gzipped; premium tier delta ≤ 65KB gzipped |
| Modular Firebase imports | grep check asserts no `import * from 'firebase/firestore'` or `from 'firebase/app'` barrel imports — tree-shaking requires per-symbol imports |
| Firestore rules test | `npm run test:rules` against Firestore Emulator — blocks rules regressions |
| Accessibility | `@axe-core/playwright` suite — zero violations |

These gates live in `.github/workflows/ci.yml`. Failures block merge. The `npm audit` + `dependency-review-action` combo is the existing supply-chain posture from the April 7 review — Phase 3 does not weaken it.

---

## 6. Phased Action Plan

**Total estimate: 4–6 weeks of focused solo-dev time.** Each phase is independently shippable behind a feature flag.

### Phase 1 — Storage cleanup, prefix rename, dead-code, stale-docs refresh, and `state-actions.ts` split (5–6 days)

**Goal:** Pay down every piece of debt that would compound once cloud sync locks in. Phase 2 cannot start until Phase 1 lands because (a) the storage prefix will be codified into Firestore document IDs, (b) future agents will read stale `AGENTS.MD` / `modules/README.md` and repeat my Round 13 allowlist error, and (c) Phase 2 extends `state-actions.ts` which is already over the 600-line split threshold.

**Storage cleanup (original scope)**

- [ ] Delete 10 unused IndexedDB stores identified in Round 5 of the codebase audit
- [ ] Slim `js/modules/data/local-storage-adapter.ts` from 709 lines to ~200 (remove dead paths)
- [ ] Fix localStorage fallback to use `_transactionsCache` key name

**Storage prefix rename — now 35+ keys, not 33** ✅ COMPLETED

- [x] One-time migration in `data/key-migration.ts` renames all `budget_tracker_*` → `harbor_*` on first boot (simpler than MigrationManager — collect-first-then-rename pattern, collision guard for pre-existing new keys, idempotent via `harbor_key_migration_done` marker)
- [x] Updated all **35+** hardcoded keys across `core/state.ts` (26 in `SK`), `app-reset.ts`, `state-revision.ts`, and ~30 other production files
- [x] 3 legacy keys preserved under old names per §9.4: `budget_tracker_idb_migration`, `budget_tracker_migrated_to_idb`, `budget_tracker_storage_rollback_failed`
- [x] Migration test suite: 6 tests covering rename, preservation, idempotency, empty LS, non-interference, and old+new collision guard
- [x] Architecture contract test bans `budget_tracker_` string literals in production code (4 allowed files)
- [ ] Verify Capacitor storage plugins on iOS + Android do not bypass the rename (per Open Question §9)

**Dead code deletion** ✅ COMPLETED

- [x] Deleted `js/modules/ui/virtual-scroller.ts` (296 lines, orphaned duplicate)
- [x] Deleted `js/modules/orchestration/app-init.ts` (51 lines, zero importers — `deduplicateTransactions` was dead code)
- [x] Deleted `js/modules/core/utils.ts` barrel (93 lines, fully codemodded to direct `utils-pure.js`/`utils-dom.js` imports across 60+ files)

**Stale-docs refresh (or every future agent session repeats Round 13's allowlist error)**

- [ ] Update `AGENTS.MD` header from "Budget Tracker Elite" to "Harbor Ledger"
- [ ] Update `AGENTS.MD` lines 74–83 direct-signal-writer allowlist to include `core/category-store.ts` — current allowlist is missing it. Authoritative source is `tests/architecture-contract.test.ts`; the test enforces 11 files; AGENTS.MD lists 10.
- [ ] Update `AGENTS.MD` action-group list to reflect that `syncState` already exists with a 17-key `applyKeyUpdate()` switch
- [ ] Rewrite `js/modules/README.md`: correct module count to ~156, test count to 74 (63 unit + 11 E2E), component count to 23, backup module count to 3; remove self-congratulatory "Grade A+ (98/100)" line; update brand to "Harbor Ledger"
- [ ] Update `docs/MARKET_STRATEGY.md` and `docs/IMPROVEMENT_ROADMAP.md` pricing tier names from "Budget Tracker Core/Pro/Elite" to "Harbor Ledger Free / Pro / Lifetime" (or the chosen final naming)
- [ ] Retire or annotate `docs/PROJECT_SUMMARY.md`, `docs/TECHNICAL_REVIEW.md`, `docs/IMPROVEMENTS_COMPLETED.md` as superseded by `harbor-ledger-comprehensive-review.md` + `harbor-ledger-round6-review.md`

**`state-actions.ts` split** ✅ COMPLETED

- [x] Split `js/modules/core/state-actions.ts` (659 lines) into per-domain action files:
  - `core/actions/action-utils.ts` (batching infrastructure: `batchUpdates`, `queueEvent`, `flushPendingEvents`)
  - `core/actions/navigation-actions.ts`
  - `core/actions/form-actions.ts` (form + modal)
  - `core/actions/data-actions.ts` (settings + data + savingsGoals + debts)
  - `core/actions/filters-actions.ts` (pagination + filters + calendar + alerts + onboarding)
  - `core/actions/sync-state-actions.ts` (hosts `syncState.applyKeyUpdate` — Phase 2's Firestore write fan-out attaches here)
  - `core/state-actions.ts` retained as thin barrel re-export (44 lines, zero call-site changes needed)
- [x] `tests/architecture-contract.test.ts` updated: direct-writer allowlist now lists the 4 action files that write signals directly; 17-key sync lockstep test reads from `sync-state-actions.ts`
- [x] No file in `core/actions/` exceeds 264 lines (well under the 400-line ADR threshold)

**Ancillary cleanup**

- [ ] Fix `index.html:73` `.form-input` misuse on `#copy-recovery-btn`

**Security audit that blocks Phase 1 merge**

- [ ] Read `js/modules/features/import-export/pdf-export.ts` `buildPdfHtml()` (lines 43, 272) and the `document.write()` call at line 288. Confirm every interpolated value routes through an HTML escape helper. If any user-controlled field (transaction description, category label, custom category name) lands un-escaped, fix it in this phase before touching sync code. This item was flagged in the April 7 comprehensive review and is the one outstanding P1 security finding still unverified.

**Acceptance:**

- All existing Vitest + Playwright tests pass
- `tests/architecture-contract.test.ts` and `tests/state-actions-contract.test.ts` pass after the action-file split
- Users upgrading from v2.x see zero data loss (seeded fixture test)
- New installs write only `harbor_ledger_*` keys
- `AGENTS.MD` allowlist matches `tests/architecture-contract.test.ts` (automated check: a new test reads both and asserts equality)
- `pdf-export.ts` XSS audit documented either as "no issues found, all values escaped via X" or as a fix commit
- `state-actions.ts` is split; no file in `core/actions/` exceeds 400 lines

### Phase 2 — Firebase Auth + subscription tier + `syncState` extension scaffolding (4–5 days)

**Goal:** Authenticated users have a subscription tier signal, and the `syncState` action group is extended (not replaced) with a pluggable Firestore write fan-out that stays dormant until Phase 3 activates it.

**Auth**

- [ ] Create Firebase project; enable Email/Password and Google providers (Apple added in Phase 4 alongside IAP)
- [ ] Add `js/modules/auth/auth-service.ts` — wraps Firebase Auth, exposes `signInGuest()`, `signIn()`, `signUp()`, `signOut()`, `currentUser$`
- [ ] Register `AUTH_SERVICE` in `di-container.ts` Services enum, lazy-loaded
- [ ] Add `authSignal`, `subscriptionTierSignal` to `core/signals.ts`; add entries to `resetSignalsToFirstUseState()` in `app-reset.ts`
- [ ] Amend CSP `connect-src` in `index.html` to add: `https://*.firebaseio.com https://*.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com`
- [ ] Amend `vite.config.ts` `manualChunks` to isolate `firebase/auth` into its own chunk; verify modular imports tree-shake correctly
- [ ] Add auth UI: sign-in modal, account page, sign-out affordance — use existing lit-html component patterns
- [ ] Feature flag `HARBOR_AUTH_ENABLED` gates the entire auth UI during rollout
- [ ] Playwright specs for sign-up, sign-in, sign-out, and the "guest continues to work offline" path
- [ ] Guest mode remains fully client-local per §9 Open Question 2 — no anonymous Firebase identity consumed

**`syncState` extension (scaffold only — no Firestore writes until Phase 3)**

- [ ] Extend `core/actions/sync-state-actions.ts` (the post-Phase-1 successor to the `syncState` block in `state-actions.ts`) with a registrable `onRemoteWrite(key, value, metadata)` callback slot. Phase 3 wires the Firestore engine into this slot; Phase 2 lands the slot itself and tests it with a noop.
- [ ] **Do not** add new files to the direct-signal-writer allowlist in `tests/architecture-contract.test.ts`. The 11-file allowlist stays untouched.
- [ ] Add a unit test that registers a fake remote-write callback, calls `syncState.applyKeyUpdate()` for each of the 17 SK keys, and asserts the callback fires with the correct envelope shape

**Acceptance:** `data-app-interactive-ready` P95 unchanged vs v2.6.2. Guest mode shows zero regression in local-only workflows. Bundle delta for the free (unauthenticated) path ≤ 5KB gzipped. `tests/architecture-contract.test.ts` direct-writer allowlist is unchanged.

### Phase 3 — Sync engine (5–7 days — revised down from 7–10 after crediting pre-built infra)

**Goal:** Premium authenticated users sync transactions across devices with offline-first semantics. Phase 3 *integrates* the three existing conflict layers; it does not build LWW from scratch.

**Estimate basis for the revision from 7–10 to 5–7 days:**
- `_persist()` already mints revisions via `stateRevision.recordStateChange` — no revision engine to build.
- `state-revision.ts` already has Lamport + vector clocks + atomic state groups — no causality layer to build.
- `multi-tab-sync-conflicts.ts` already has user-activity-aware conflict detection — no UX layer to build.
- `syncState.applyKeyUpdate()` already exists and knows how to route 17 SK keys — the Phase 2 scaffold adds the fan-out slot, so Phase 3 only fills it.
- What remains is Firestore-specific: SDK configuration, `onSnapshot` wiring, security rules, and the E2EE read/write path from Phase 5.

**Sync engine**

- [ ] Add `js/modules/sync/firestore-sync-engine.ts` implementing a new `SyncEngine` interface
- [ ] Register `SYNC_ENGINE` in `di-container.ts` with dependencies `[AUTH_SERVICE, DATA_SDK, FIELD_CRYPTO]` (FIELD_CRYPTO lands in Phase 5; Phase 3 can launch behind a flag without it and add encryption in a follow-up PR, but the preferred sequence is to land §5 first — see §6.5 for ordering discussion)
- [ ] Dynamic-import Firestore SDK only after subscription tier confirmed active: `await import('firebase/firestore')`
- [ ] Configure Firestore with `persistentLocalCache({ tabManager: persistentMultipleTabManager() })`
- [ ] **Hook outbound:** wire `firestoreSyncEngine.pushChange` into the `onRemoteWrite` callback slot added in Phase 2. The existing `_persist()` envelope (`{ revision, tabId, timestamp, changeType, changedIds }`) is already emitted — Phase 3 consumes it, does not re-mint it.
- [ ] **Hook inbound:** Firestore `onSnapshot` → `requestDataApplyDelta(change, 'firestore', metadata)` via existing `data-sync-interface.ts` event contract; the inbound path reuses `dataSdk.init({ onDataPatched })` at `app-init-di.ts:239–246`.

**Conflict resolution — integrate, do not rebuild**

Three existing layers, routed to the same decisions:

1. **Causality (layer 1):** `state-revision.ts` `updateLogicalClock(remoteClock)` + vector clock comparison decides happens-before. If `vectorClock(local) < vectorClock(remote)`, remote wins without user input. If `vectorClock(local) > vectorClock(remote)`, local wins and the stale remote write is overwritten on next push. Concurrent writes (neither dominates) fall through to layer 2.
2. **Atomic groups (layer 1.5):** `ATOMIC_STATE_GROUPS` guarantee that conflicts inside `FINANCIAL_CORE = [TX, SAVINGS, ALLOC]` resolve as a set — a partial rollback of TX without rolling back ALLOC would leave the budget math inconsistent. Phase 3 extends atomic-group enforcement to remote writes by buffering inbound snapshots for a group until all keys in the group arrive.
3. **User-activity awareness (layer 2):** `multi-tab-sync-conflicts.ts` `hasActiveUserInteraction()` defers conflict resolution on any record the user is currently editing (unsaved changes or typing within 5 seconds). Phase 3 displays a "Changes from another device are waiting" nudge instead of overwriting. Once the user saves or navigates away, the buffered remote write is applied through layer 1.
4. **Policy fallback (layer 3):** `state-revision.ts` `conflict_resolution_policy` default is `'user_decides'` — Phase 3 adds a settings toggle letting the user switch to `'last_writer_wins'` for automation. Default stays `'user_decides'` for financial safety.

**Firestore-specific work**

- [ ] Firestore security rules — per-user isolation: `allow read, write: if request.auth.uid == resource.data.userId && request.auth.token.email_verified == true`
- [ ] Firestore Emulator in CI for rules tests — invoked from `npm run test:rules` (new script)
- [ ] Handle sync failures via `data-app-background-failed` contract — UI stays fully interactive even if sync is down
- [ ] Add `tests/sync-engine.test.ts` with mocked Firestore and `tests/multi-device-sync.e2e.ts` with Emulator
- [ ] Bundle-size CI gate: free tier delta ≤ 5KB, premium tier delta ≤ 65KB gzipped
- [ ] Visual regression suite must remain green (baselines live at `e2e/visual-regression.spec.ts-snapshots/`)
- [ ] WebKit smoke pass (`npm run test:e2e:smoke` against the Playwright webkit project) — Harbor Ledger supports iOS Safari and historically the sync-related IndexedDB paths are WebKit-sensitive

**Acceptance:**
- A transaction added on device A appears on device B within 3 seconds when both are online
- Offline changes on either side reconcile correctly on reconnect
- Concurrent edits on a record the user is actively editing defer via `hasActiveUserInteraction` instead of overwriting
- Security rules deny cross-user reads in Emulator tests
- `data-app-interactive-ready` P95 with sync enabled ≤ baseline + 50ms
- Visual regression + WebKit smoke green
- `architecture-contract.test.ts` unchanged (11-file allowlist preserved)
- Firestore SDK confirmed tree-shaken via modular imports (bundle analyzer output checked into PR)

### Phase 4 — Payments (3–4 days)

**Goal:** Users can purchase monthly, annual, or lifetime premium subscriptions.

- [ ] Stripe Checkout for web, verified via Cloud Function webhook
- [ ] Apple IAP for iOS Capacitor build, verified via Cloud Function
- [ ] Google Play Billing for Android Capacitor build, verified via Cloud Function
- [ ] Cloud Function `verifyReceipt` updates Firestore user doc with `subscription.active`, `subscription.tier`, `subscription.expiresAt`
- [ ] `subscriptionTierSignal` subscribes to the user doc; `SyncEngine` gates on its value
- [ ] Receipt verification failure flows: graceful downgrade to free tier with 7-day grace period
- [ ] Playwright specs for Stripe sandbox checkout flow

**Acceptance:** A successful Stripe test-mode purchase flips `subscription.active` to true within 5 seconds. Sync engine activates automatically. Cancellation downgrades at grace-period end, not immediately.

### Phase 5 — Full E2EE + GDPR + hardening (5–6 days — revised up to absorb the full-encryption scope)

**Goal:** Every synced field is ciphertext at rest in Firestore. Key material never leaves the client. User-initiated account deletion works end-to-end. Per §2.1, this is now full E2EE rather than `note`/`description`-only.

**Scheduling note:** Phase 5 *should* land before Phase 3 ships to users, because activating the sync engine without E2EE would mean plaintext financial data hitting Firestore during the beta period. The recommended sequence is: Phase 1 → Phase 2 → **Phase 5 field-crypto module** → Phase 3 sync engine (which depends on `field-crypto.ts`) → Phase 4 payments → Phase 5 GDPR deletion + privacy policy. The Phase numbering is kept stable for continuity with the original draft; the *build order* is the one to follow.

**Field-crypto module**

- [ ] `js/modules/core/field-crypto.ts` — wraps Web Crypto API:
  - `deriveDEK(passphrase, salt)` → PBKDF2-SHA256 600k → 256-bit DEK (parameters match `features/security/pin-crypto.ts`)
  - `wrapRecordKey(dek, recordKey)` → AES-KW envelope
  - `encryptField(recordKey, plaintext, aad)` → `{ iv, ciphertext, tag }` with AAD = `uid || documentPath`
  - `decryptField(recordKey, ciphertext, aad)` → plaintext or throw on auth tag failure
- [ ] Register `FIELD_CRYPTO` in `di-container.ts` Services enum, lazy-loaded (crypto keys initialized only on first sync activation)
- [ ] Encryption passphrase UI: first-time setup modal; settings page "Change encryption passphrase" affordance with re-wrap flow (re-wrap per-record keys with new DEK, no re-encryption of field ciphertexts)
- [ ] Mandatory local-backup nudge at passphrase creation and at every passphrase change — lost passphrase = lost cloud data, and the user must acknowledge this

**Sync engine integration**

- [ ] All `SyncEngine.pushChange` paths encrypt every sensitive field before the Firestore write
- [ ] All `onSnapshot` paths decrypt every sensitive field before handing to `requestDataApplyDelta`
- [ ] Fields that stay plaintext on the server (metadata only): `revision`, `timestamp`, `vectorClock`, `atomicGroup`, `uid`, `subscriptionTier`
- [ ] Fields that become ciphertext: `amount`, `date`, `category`, `description`, `note`, `debtBalance`, `savingsContributionAmount`, every custom-category label, every filter-preset label, every transaction-template body — exhaustively enumerated in a Phase 5 test fixture

**GDPR / deletion / export**

- [ ] "Delete my account" button → Cloud Function wipes user's Firestore collection → Firebase Auth user deletion → local `app-reset.ts` flow
- [ ] GDPR export: existing user-initiated export already handles local data; add a server-side export Cloud Function for anything in Firestore that isn't local (should be nothing beyond metadata after E2EE, but the endpoint still returns metadata for compliance)
- [ ] Privacy policy update reflecting:
  - Full E2EE of financial fields
  - What metadata stays plaintext and why
  - Data residency (US-only initially)
  - Retention policy
  - Passphrase-loss consequence

**Tests**

- [ ] Firestore Emulator test confirms every document field in the encrypted-field fixture is base64 ciphertext, not plaintext
- [ ] Round-trip test: plaintext → encrypt → write to emulator → read from emulator → decrypt → assert equality
- [ ] Replay-resistance test: ciphertext lifted from one user's document fails AAD check when replayed into another user's path
- [ ] E2E sync test: create → sync → modify on other device → sync back → delete account → verify zero Firestore residue
- [ ] Passphrase-loss test: clear local crypto cache, re-enter passphrase, confirm decryption succeeds; enter wrong passphrase, confirm decryption fails gracefully with a user-visible error (not a silent corruption)

**Acceptance:** Firestore Emulator test confirms ciphertext-only storage for ALL sensitive fields. Account deletion leaves zero documents under the user's path. All existing accessibility, performance, visual regression, and Playwright suites pass. A rules-misconfiguration test (intentionally broken rules) cannot leak plaintext because no plaintext exists server-side.

---

## 7. Non-goals (explicitly out of scope for v3.0)

- **EU data residency** — US-only initially, documented in privacy policy. Revisit when EU MAU > 20% of total.
- **Real-time collaboration on shared budgets** — v3.0 is single-user sync only. Multi-user shared budgets are a v4.0 conversation.
- **Push notifications** — FCM integration is cheap to add later but out of scope for v3.0 to protect the shipping date.
- **Self-hosted sync option** — interesting for privacy-maximalist users but doubles the solo-dev maintenance burden. Revisit only with headcount.
- **Server-side aggregation / analytics features** — full E2EE (§2.1) precludes server-side access to plaintext financial data. Any future feature that would require the server to see plaintext is a policy reversal, not a feature addition. Use client-side aggregation only.
- **Searchable encryption** — v3.0 uses client-side search over the decrypted local ledger (the same way v2.6.2 already works). OPE or other searchable-encryption schemes are not considered; their cryptographic weaknesses are worse than the feature is worth.

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Firestore bundle blows the budget | Medium | Medium | CI gate on bundle size; lazy-load gated by subscription tier; dynamic import not static; modular Firebase imports (no barrel) |
| Security rules bug leaks cross-user data | Low | Catastrophic | Firestore Emulator rules tests in CI; full E2EE per §2.1 means even a rules breach exposes ciphertext only |
| Storage prefix migration data-losses an existing user | Low | Catastrophic | Backup-first snapshot (pattern from `migration.ts`); idempotent migration; rollback failure flag; test with seeded v2.x fixture; Capacitor iOS + Android verification before Phase 1 merge |
| Firestore's IndexedDB cache contends with Harbor Ledger's IDB | Low | Medium | Load test with large transaction ledgers; monitor quota; document a "clear Firestore cache" escape hatch |
| Concurrent edit corruption | Medium | Medium | Three-layer conflict handling (Lamport/vector-clock causality, atomic state groups, user-activity-aware detection) — integrated from existing `state-revision.ts` + `multi-tab-sync-conflicts.ts`; default policy stays `'user_decides'` for financial safety; conflict log persisted for audit |
| User loses encryption passphrase | Medium | Catastrophic (for cloud data) | Mandatory local-backup nudge at passphrase creation and at every change; clear in-app warning that passphrase loss = cloud data loss; free tier unaffected |
| Free tier Firestore quota exceeded early | Low | Low | Per-user read budget monitoring; graceful degradation to poll-every-N-seconds if quota pressure appears |
| Vendor lock-in pain in year 2+ | Medium | Medium | `SyncEngine` interface isolates Firestore; wire format already backend-agnostic; port cost is weeks not months |
| Apple or Google rejects IAP integration on first review | Medium | Low | Submit early in Phase 4; have Stripe-only fallback ready for initial launch if mobile review slips |
| Future agent reads stale `AGENTS.MD` and proposes wrong allowlist | Medium | Low | Phase 1 refreshes `AGENTS.MD` + `modules/README.md`; new test asserts `AGENTS.MD` allowlist matches `architecture-contract.test.ts` |
| `pdf-export.ts` `document.write` XSS exploitable | Unknown (unverified) | High | Pre-Phase-1 audit of `buildPdfHtml` escape paths; fix or document as safe in Phase 1 PR |

---

## 9. Open questions

1. **Do we support email/password auth, or OAuth-only?** Email/password adds password-reset UI cost but reduces Google dependency. **Recommendation:** ship both; OAuth is a one-click add in Firebase.
2. **Do guest users get a Firebase anonymous auth identity, or stay fully client-local?** Anonymous identity enables future "upgrade guest → account without losing data" but costs a Firebase MAU slot per visitor. **Recommendation:** stay fully client-local for guests; anonymous auth only on explicit sign-up intent.
3. **Encryption passphrase for OAuth users** — no password means no PBKDF2 seed. **Recommendation:** prompt OAuth users to set an encryption passphrase on first sync activation; cache it in-memory only.
4. **Storage prefix migration for Capacitor builds** — native storage plugins may not use localStorage. **Action:** verify on both iOS and Android before Phase 1 ships.

---

## 10. Action items (ordered by sequence)

1. [ ] Approve this ADR (Frank) — status currently reads "Accepted — ready for Phase 1 kickoff"; convert to "Accepted" and add a kickoff date on approval
2. [ ] Verify `pdf-export.ts` `buildPdfHtml` HTML-escape audit (§5.7 blocks Phase 1 merge on this; can run concurrent with Phase 1 PR as a separate fix if a vulnerability is found)
3. [ ] Verify Capacitor storage plugins on iOS and Android re: Phase 1 prefix migration (per §9 Open Question 4)
4. [ ] Create Firebase project; document project IDs in `docs/INFRA.md` (new file)
5. [ ] **Phase 1 PR** — storage cleanup (10 unused IDB stores, slim LocalStorageAdapter) + 35+ key prefix rename + dead-code deletion (`virtual-scroller.ts`) + stale-docs refresh (`AGENTS.MD` allowlist, `modules/README.md`, strategy docs rebrand) + `state-actions.ts` split into `core/actions/` + `index.html:73` cleanup
6. [ ] **Phase 2 PR** — Firebase Auth + CSP amendment + `syncState` scaffold slot (noop-wired) behind `HARBOR_AUTH_ENABLED`
7. [ ] **Phase 5a PR** (field-crypto module only) — `field-crypto.ts` + passphrase UI + key-derivation tests; no Firestore integration yet
8. [ ] **Phase 3 PR** — Sync engine wired through the Phase 2 scaffold + the Phase 5a field-crypto module + three-layer conflict integration + Firestore Emulator in CI, behind `HARBOR_SYNC_ENABLED`
9. [ ] **Phase 4 PR** — Stripe first, then Apple IAP + Google Billing + Cloud Function receipt verification
10. [ ] **Phase 5b PR** — GDPR deletion + privacy policy update + final encrypted-field fixture sweep
11. [ ] **v3.0 launch checklist:** CSP audit, bundle budget check, security rules review, Emulator tests green, Capacitor smoke tests, visual regression green, WebKit smoke green, App Store + Play Store review submission
12. [ ] Retire `docs/IMPROVEMENTS_COMPLETED.md` and annotate `docs/Code-Review-Report.md` as resolved — folded into the Phase 1 PR

---

## Appendix A — Grounding references

Every claim in this ADR maps to a specific file. If any of the following has drifted from the current state, the ADR must be updated before the next phase ships.

| Claim | File | Lines |
|---|---|---|
| Delta event contract exists | `js/modules/core/data-sync-interface.ts` | 17–26, 60–66 |
| Metadata envelope for LWW | `js/modules/core/data-sync-interface.ts` | 60–66 |
| Change discriminated union (`TransactionDataChange`) | `js/types/index.ts` | ~691–710 |
| Dual-handler integration point | `js/modules/orchestration/app-init-di.ts` | 239–246 |
| DI container ready for new services | `js/modules/core/di-container.ts` | Services enum, 898 lines |
| Readiness DOM contract | `js/modules/orchestration/app-init-di.ts` | `setStartupProgress`, `window.__APP_*_READY__` flags |
| Reset contract enumerates all state | `js/modules/orchestration/app-reset.ts` | 34–44 (keys), `resetSignalsToFirstUseState` (signals) |
| Migration blueprint to reuse | `js/modules/data/migration.ts` | 664 lines, pattern: backup → batch 100 → version marker |
| Storage prefix debt footprint (35+ keys) | `js/modules/core/state.ts` (26 keys in `SK`), `app-reset.ts` (3 hardcoded + 2 prefix families), `migration.ts` (3), `state-revision.ts` (`REVISION_KEY`, `TRANSACTION_DELTA_LOG_KEY`) | see each |
| CSP baseline to amend | `index.html` | ~line 10 (meta tag) |
| Bundle splitting seam | `vite.config.ts` | `manualChunks` 88–97 |
| Multi-tab architecture (Web Locks) | `js/modules/data/indexeddb-adapter.ts` | 480–527 |
| **11 direct-signal-writer allowlist (authoritative — AGENTS.MD is stale and missing `category-store.ts`)** | `tests/architecture-contract.test.ts` | allowlist assertion block |
| `syncState.applyKeyUpdate()` — 17-key authoritative sync scope | `js/modules/core/state-actions.ts` | 570–657 |
| `_persist()` already mints revisions via `stateRevision.recordStateChange` | `js/modules/data/data-manager.ts` | 380–500 (revision call at 480) |
| `_persist()` callers (6 sites) | `js/modules/data/data-manager.ts` | 352, 574, 618, 651, 674, 755 |
| Lamport + vector clocks + `ATOMIC_STATE_GROUPS` | `js/modules/core/state-revision.ts` | 851 lines total; key section in first ~240 |
| `updateLogicalClock(remoteClock)` designed for remote peers | `js/modules/core/state-revision.ts` | function declaration |
| User-activity-aware conflict detection | `js/modules/core/multi-tab-sync-conflicts.ts` | `hasActiveUserInteraction` (~line 50), `ConflictResolution` interface |
| `withTransaction()` / `Operation` LIFO rollback | `js/modules/data/transaction-manager.ts` | `withTransaction` implementation |
| Auto-lock fires on `visibilitychange` hidden | `js/modules/features/security/auto-lock.ts` | `onVisibilityChange` (~line 80 of 136) |
| Dead code to delete in Phase 1 | `js/modules/ui/virtual-scroller.ts` | JSDoc lines 1–3 self-document deprecation |
| Pending security audit (document.write / buildPdfHtml) | `js/modules/features/import-export/pdf-export.ts` | 43, 272, 288 |
| Transaction-surface architectural guardian | `js/modules/data/transaction-surface-coordinator.ts` | sole authorized importer of `transaction-renderer.js` |
| Architecture contract tests (five-test enforcement) | `tests/architecture-contract.test.ts` | 129 lines — five enforcement tests |
| April 2026 convergence audit (0 critical, 0 new) | `harbor-ledger-round6-review.md` | convergence summary |
| April 2026 comprehensive audit (7-skill consolidated) | `harbor-ledger-comprehensive-review.md` | 251 lines |

---

**End of ADR-001.**
