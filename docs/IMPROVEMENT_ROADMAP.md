# Harbor Ledger — Improvement Roadmap

## Executive summary
This roadmap outlines the evolution of Harbor Ledger from its v2.x production state to a scalable, cloud-sync-capable privacy-first finance platform. **Phases 1 and 2 of the original modernization (TypeScript migration and modular refactor) are complete.** The next major milestone is **v3.0 cloud sync**, which is fully architected and ready for implementation — see [ADR-001](adr/ADR-001-firestore-cloud-sync.md).

---

## ✅ Original Phase 1 & 2: Architectural Modernization (COMPLETED)
*Foundation for scale and maintainability*

### 100% TypeScript migration
- [x] Full codebase converted to TypeScript
- [x] Strict type checking and interface definitions
- [x] Standardized data models across the application
- [x] `moduleResolution: "bundler"` with consistent `.js` import extensions

### Modular refactoring
- [x] Decoupled monolithic `app.js` into ~155 semantic modules
- [x] Implemented lazy-loading Dependency Injection (DI) container
- [x] Established layered architecture contract (`types → core → data → features → orchestration → ui/components`)
- [x] Pinned layering, direct-writer allowlist, and bridge exceptions with contract tests

### Performance at scale
- [x] Migrated to IndexedDB as the primary storage layer with LocalStorage fallback
- [x] Implemented Web Workers for off-main-thread transaction filtering
- [x] Added Signal-based reactivity (Preact Signals) for precise UI updates
- [x] Implemented multi-tab synchronization with `BroadcastChannel`, `Mutex`, and Web Locks API
- [x] Built three-layer conflict resolution (Lamport + vector clocks, atomic state groups, user-activity-aware deferral)

### Reliability & safety
- [x] Standardized error boundaries and circuit breakers
- [x] Implemented `MigrationManager` for robust data schema updates
- [x] Integrated `PerformanceMonitor` for real-time app vitals
- [x] Playwright regression gates for shell-ready, transactions-surface, edit, calendar, and dashboard refresh

---

## 🚀 v3.0: Optional Cloud Sync (ACTIVE)
*Cross-device sync without compromising the privacy-first posture*

**Decision:** see [ADR-001](adr/ADR-001-firestore-cloud-sync.md). Backend is Firebase Firestore; encryption is full client-side E2EE; conflict resolution reuses the pre-built three-layer stack.

**Readiness:** pre-Phase-1 blockers are verified — see [ADR-001-pre-phase-1-verification.md](adr/ADR-001-pre-phase-1-verification.md). Phase 1 is cleared for kickoff.

### Phase 1: Hardening and cleanup (5–6 days)
- [x] Security: `pdf-export.ts` `formatCurrencyHtml` XSS-safe formatter + 5 XSS regression tests
- [x] Dead-code deletion: removed `ui/virtual-scroller.ts`, `orchestration/app-init.ts`, `core/utils.ts` barrel (codemod to direct imports)
- [x] Refactor: split `core/state-actions.ts` into `core/actions/*-actions.ts` (6 files, barrel re-export preserves all 28 import sites)
- [x] Storage key rename: all `budget_tracker_*` → `harbor_*` with one-time migration in `data/key-migration.ts`; 3 legacy keys preserved per ADR-001 §9.4
- [x] Bug fixes: cents-safe `sumTrackedExpenses()` (transfer-aware), `getTodayStr()`/`formatDateForInput()` UTC-vs-local fix (7 sites), `formatCurrency` DI consolidation
- [x] Architecture contract tests: 9 assertions guarding module boundaries, sync allowlist, import conventions, and brand rename
- [x] Documentation refresh: AGENTS.MD allowlist, `js/modules/README.md` rewrite, brand cleanup across `docs/`

### Phase 2: Firebase integration scaffolding (~3 days)
- [ ] Add `firebase/app` and `firebase/auth` as dependencies (modular imports only)
- [ ] Add `AUTH_SERVICE` DI registration and sign-in/sign-out UI
- [ ] Scaffold `onRemoteWrite` callback slot on the split `syncState`
- [ ] Amend CSP `connect-src` for Firestore and Firebase Auth domains
- [ ] Subscription-tier signal (free / pro / lifetime)

### Phase 3: Sync engine (5–7 days)
- [ ] Integrate the three existing conflict-resolution layers with Firestore listeners
- [ ] Delta-contract wiring via the pre-built `_persist()` revision minting path
- [ ] Firestore security rules + rules tests
- [ ] Multi-device integration tests (two-tab + two-device scenarios)

### Phase 4: Cloud Functions + billing (~3 days)
- [ ] Cloud Functions project scaffold
- [ ] Stripe webhook → Firestore subscription claim
- [ ] Quota enforcement (document count, write rate per tier)

### Phase 5a: Field-crypto module (3–4 days) — **must land before Phase 3 sync engine**
- [ ] `core/field-crypto.ts`: PBKDF2-SHA256 600k → AES-KW key wrapping → AES-GCM field encryption
- [ ] DEK derived from passphrase, per-record keys wrapped with AES-KW
- [ ] AAD = `uid + documentPath` to bind ciphertext to Firestore location
- [ ] Contract tests for key derivation, encryption, decryption, and tamper detection

### Phase 5b: Passphrase UX (2 days)
- [ ] Passphrase setup and recovery flow
- [ ] Auto-lock timing and in-memory key clearing
- [ ] Sync-during-lock behavior (outbound as ciphertext, inbound buffered until unlock)

**Total Phase 1–5 estimate:** ~21–25 working days.

---

## 💎 Post-v3.0 Feature Expansion
*Net worth, bills, and AI features that depend on v3.0 sync being in place*

### Net worth tracking
- [ ] Asset tracking (bank accounts, investments, property) with manual update UI
- [ ] Aggregate assets and liabilities for real-time net worth
- [ ] Historical net worth trend charts
- [ ] Optional Plaid bridge for users who opt in to institutional sync (encrypted server-side)

### Bills & subscription calendar
- [x] Calendar bill indicators (`getUpcomingBillsForMonth` exists)
- [ ] Dedicated calendar view for recurring transactions
- [ ] Bill due date reminders and notifications
- [ ] Visual color-coding: Paid, Upcoming, Overdue
- [ ] Integrated subscription management dashboard

### Advanced reporting & insights
- [x] Month-over-month and Year-over-year comparison views
- [x] Export to CSV and JSON formats
- [x] PDF export (shipped in v2.6.x)
- [ ] Custom category spending trend analysis
- [ ] Savings goal progress projections and "what-if" scenarios

### UX & accessibility enhancements
- [ ] Final WCAG 2.1 AA color contrast audit and refinements
- [x] Advanced keyboard shortcuts for power-user navigation
- [ ] Haptic feedback for mobile-installed PWA users
- [x] Improved dark mode theme customizability
- [x] Modal accessibility improvements

---

## 🔮 v4.0 Exploration (Q4 2026+)
*Not yet decided — items that might become their own ADRs*

### AI financial insights (local-first)
- Integrate a local-first LLM/SLM (via WebGPU/Wasm) for spending analysis
- Anomaly detection for unusual spending patterns
- Natural language querying ("Show me how much I spent on coffee last month")
- Automated spending category suggestions

### Native mobile
- Sharpen the Capacitor iOS and Android wrappers
- Native biometric authentication (FaceID / TouchID / Android BiometricPrompt)
- Native push notifications for bill reminders
- Home screen widgets

### Collaborative budgeting
- Shared-vault support for families (E2EE, pairwise key exchange)
- Read-only view sharing

### Voice and OCR
- Voice commands via Web Speech API
- Receipt scanning with on-device OCR (Tesseract.js or equivalent)

---

## Success metrics

### Technical targets (v3.0 gate)
| Metric | v2.6.2 current | v3.0 target | Status |
|---|---|---|---|
| Typecheck | 0 errors | 0 errors | ✅ |
| Vitest pass rate | ~636 passing | ~636 + new sync tests | Active |
| Playwright perf gates | All passing | All passing + multi-device | Active |
| CSP includes Firestore domains | No | Yes | Phase 2 |
| `harbor_*` storage keys | No | Yes, with migration | Phase 1 |
| Full client-side E2EE | No | Yes | Phase 5a |
| Architecture contract tests | 5 invariants | 6 invariants (add syncState scope) | Phase 1 |

### Feature velocity
| Area | Phase | Status |
|---|---|---|
| TypeScript migration | Original Phase 1 | ✅ Completed |
| Modular refactor + DI | Original Phase 2 | ✅ Completed |
| Cloud sync ADR | v3.0 design | ✅ Accepted |
| Phase 1 hardening + cleanup | v3.0 Phase 1 | 🟢 Ready to start |
| Sync engine | v3.0 Phase 3 | ⏳ Blocked on Phase 5a |
| Full E2EE (`field-crypto`) | v3.0 Phase 5a | ⏳ Blocked on Phase 2 |
| Net worth tracking | Post-v3.0 | 📋 Backlog |
| AI insights | v4.0 exploration | 🔮 Not yet designed |

---

*Roadmap Version: 3.0*
*Last Updated: April 10, 2026*
*Review Status: Active — v3.0 Phase 1 cleared for kickoff*
