/**
 * Centralized Transaction Row Template
 * 
 * Single source of truth for transaction row HTML structure,
 * eliminating duplication across transaction list, virtual scroller, and legacy views.
 * 
 * @module transaction-row-template
 */

import { html, TemplateResult } from '../../core/lit-helpers.js';
import { getCatInfo } from '../../core/categories.js';
import { parseLocalDate, fmtCur as fmtCurDefault } from '../../core/utils-pure.js';
import { formatDateShort, formatViewedMonthLabel } from '../../core/locale-service.js';
import { isSavingsTransferTransaction, getSavingsTransferGoalName } from '../../core/transaction-classification.js';
import { emptyState } from '../core/empty-state.js';
import type { Transaction, CurrencyFormatter } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — transaction-renderer.ts:200 sets
// `showSwipeActions: config.enableSwipeActions` where the config field
// is `boolean | undefined`.
export interface TransactionRowOptions {
  showSwipeActions?: boolean | undefined;
  showSplitBadge?: boolean | undefined;
  currencyFormatter?: CurrencyFormatter | undefined;
  // Phase 6 Slice 1b (L5 #181): widened to `void | Promise<void>` so
  // async row-action callers (dataSdk.delete/update/split — all Promise-
  // returning) can be passed directly without a sync wrapper. The
  // template's `?.(tx)` callsites are fire-and-forget; async rejections
  // should surface via the row-action caller's own trackError, not here.
  onEdit?: ((tx: Transaction) => void | Promise<void>) | undefined;
  onDelete?: ((tx: Transaction) => void | Promise<void>) | undefined;
  onReconcile?: ((tx: Transaction) => void | Promise<void>) | undefined;
  onSplit?: ((tx: Transaction) => void | Promise<void>) | undefined;
  onClick?: ((tx: Transaction) => void | Promise<void>) | undefined;
}

// ==========================================
// TEMPLATE COMPONENTS
// ==========================================

/**
 * Transaction amount display
 */
function renderAmount(tx: Transaction, fmtCur: CurrencyFormatter): TemplateResult {
  const isSavingsTransfer = isSavingsTransferTransaction(tx);
  const amountClass = isSavingsTransfer
    ? 'savings-transfer-amount'
    : (tx.type === 'income' ? 'income-amount' : 'expense-amount');
  const formattedAmount = fmtCur(typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount));
  
  // Directional arrow supplements color for colorblind accessibility.
  // Income ↑ / expense ↓ / savings-transfer → (neutral).
  const dirIcon = isSavingsTransfer ? '→' : tx.type === 'income' ? '↑' : '↓';

  return html`
    <div class="tx-amount ${amountClass}">
      <span class="tx-amount-dir" aria-hidden="true">${dirIcon}</span>${tx.type === 'income' ? '+' : '-'}${formattedAmount}
    </div>
  `;
}

/**
 * Transaction category chip
 */
function renderCategory(tx: Transaction): TemplateResult {
  const catInfo = getCatInfo(tx.type, tx.category);
  
  return html`
    <span class="cat-chip" style="background: ${catInfo.color}22; color: ${catInfo.color};">
      <span class="cat-emoji">${catInfo.emoji}</span>
      <span class="cat-name">${catInfo.name}</span>
    </span>
  `;
}

/**
 * Transaction badges (recurring, split, etc.)
 */
function renderBadges(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  return html`
    ${tx.recurring ? html`
      <span class="badge badge-recurring" title="Recurring transaction">
        🔄
      </span>
    ` : ''}
    ${tx.splits && options.showSplitBadge ? html`
      <span class="badge badge-split" title="Split transaction">
        ✂️
      </span>
    ` : ''}
  `;
}

/**
 * Build a short, human-readable identifier for a transaction — used to
 * disambiguate per-row action buttons for screen-reader and voice-
 * control users. Format:
 *   "{description || category-or-transfer-name} — {amount} on {date}"
 *
 * Design-Review-Apr21 P2 (batch 6 follow-up): the shared transaction-
 * row template previously labeled every edit/delete button — including
 * the swipe actions — with the generic "Edit transaction" / "Delete
 * transaction". In a ledger with dozens of rows, AT users had to
 * reconstruct the target by reading surrounding row text; voice-
 * control users couldn't say "click edit Groceries" because every
 * button advertised the same name. The identifier threads through the
 * label so a single announcement fully specifies the row being acted
 * on. Kept short (no redundant category-chip text) so the label stays
 * scannable in long lists.
 */
function buildTxIdentifier(tx: Transaction, options: TransactionRowOptions): string {
  const fmtCur = options.currencyFormatter || fmtCurDefault;
  const isTransfer = isSavingsTransferTransaction(tx);
  const transferGoal = getSavingsTransferGoalName(tx);
  // Prefer the user-authored description; fall back to transfer label
  // when it's a savings transfer, then to the category's display name
  // so every row has a meaningful leading identifier even if the user
  // skipped the description field.
  const lead = tx.description?.trim()
    || (isTransfer && transferGoal ? `Transfer to ${transferGoal}` : '')
    || getCatInfo(tx.type, tx.category).name;
  const amount = fmtCur(tx.amount);
  const date = formatDateShort(parseLocalDate(tx.date));
  return `${lead} — ${amount} on ${date}`;
}

/**
 * Transaction actions (edit, delete, reconcile, split)
 */
function renderActions(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  const isReconciled = !!tx.reconciled;
  const reconcileModifier = isReconciled ? 'reconcile-btn--checked' : 'reconcile-btn--unchecked';
  const txId = buildTxIdentifier(tx, options);

  return html`
    <div class="desktop-actions transaction-row-actions flex gap-1">
      <!--
        Design-Review-Apr21 P2 (batch 6 follow-up): thread the shared
        txId through reconcile + split aria-labels and titles, matching
        the edit/delete disambiguation. Previously these controls
        announced generic "Mark as reconciled" / "Split this transaction"
        strings, forcing screen-reader and voice-control users to
        reconstruct the target row from surrounding context in a long
        ledger. The desktop pair gets both aria-label and title; the
        swipe pair below gets aria-label only (no title on touch).
      -->
      <button
        class="reconcile-btn ${reconcileModifier} min-w-11 min-h-11 p-2 rounded-lg hover:opacity-100 flex items-center justify-center text-lg font-bold transition-all"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onReconcile?.(tx);
        }}
        title=${isReconciled ? `Reconciled — click to unmark ${txId}` : `Mark ${txId} as reconciled`}
        aria-label=${isReconciled ? `Mark ${txId} as unreconciled` : `Mark ${txId} as reconciled`}
      >
        ${isReconciled ? '✅' : '⬜'}
      </button>

      <button
        class="split-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onSplit?.(tx);
        }}
        title=${`Split ${txId} into multiple transactions`}
        aria-label=${`Split ${txId}`}
      >
        ✂️
      </button>

      <button
        class="edit-btn action-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onEdit?.(tx);
        }}
        aria-label=${`Edit ${txId}`}
        title=${`Edit ${txId}`}
      >
        ✏️
      </button>

      <button
        class="delete-btn action-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onDelete?.(tx);
        }}
        aria-label=${`Delete ${txId}`}
        title=${`Delete ${txId}`}
      >
        🗑️
      </button>
    </div>
  `;
}

function renderSwipeActions(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  const isReconciled = !!tx.reconciled;
  const txId = buildTxIdentifier(tx, options);

  return html`
    <div class="swipe-actions-right">
      <button
        class="swipe-action-btn reconcile-swipe-btn"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onReconcile?.(tx);
        }}
        aria-label=${isReconciled ? `Mark ${txId} as unreconciled` : `Mark ${txId} as reconciled`}
      >
        <span class="swipe-icon">${isReconciled ? '✅' : '⬜'}</span>
        <span>${isReconciled ? 'Unreconcile' : 'Reconcile'}</span>
      </button>
      <button
        class="swipe-action-btn split-swipe-btn"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onSplit?.(tx);
        }}
        aria-label=${`Split ${txId}`}
      >
        <span class="swipe-icon">✂️</span>
        <span>Split</span>
      </button>
    </div>
    <div class="swipe-actions-left">
      <button
        class="swipe-action-btn edit-swipe-btn"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onEdit?.(tx);
        }}
        aria-label=${`Edit ${txId}`}
      >
        <span class="swipe-icon">✏️</span>
        <span>Edit</span>
      </button>
      <button
        class="swipe-action-btn delete-swipe-btn"
        @click=${(e: Event) => {
          e.stopPropagation();
          void options.onDelete?.(tx);
        }}
        aria-label=${`Delete ${txId}`}
      >
        <span class="swipe-icon">🗑️</span>
        <span>Delete</span>
      </button>
    </div>
  `;
}

// ==========================================
// MAIN TEMPLATE
// ==========================================

/**
 * Main transaction row template
 */
export function transactionRowTemplate(
  tx: Transaction,
  options: TransactionRowOptions = {}
): TemplateResult {
  const fmtCur = options.currencyFormatter || fmtCurDefault;
  const isSavingsTransfer = isSavingsTransferTransaction(tx);
  const goalName = getSavingsTransferGoalName(tx);
  const rowDescription = isSavingsTransfer && goalName
    ? `Transfer to ${goalName}`
    : tx.description;
  
  // Design-Review-Apr21 P2: only advertise the row as interactive (pointer
  // cursor + row-level click binding) when a caller actually wires `onClick`.
  // The main transactions list consumer (`data/transaction-renderer.ts`) does
  // not provide a row-action, so previously every row styled itself as
  // tappable while only the small action buttons responded — a misleading
  // affordance on both desktop and touch. Gating both the class and the
  // `@click` handler on `options.onClick` keeps the interactive styling
  // available for call sites that do opt in (drill-down panels etc.) while
  // the default ledger row returns to a passive display.
  const isInteractive = typeof options.onClick === 'function';
  const rowContent = html`
    <div
      class="swipe-content transaction-row ${isInteractive ? 'transaction-row--interactive' : ''} flex items-center gap-3 rounded-lg ${tx.type}-row ${isSavingsTransfer ? 'savings-transfer-row' : ''} ${options.showSwipeActions ? 'transaction-row--swipe-ready' : ''}"
      data-id="${tx.__backendId}"
      @click=${isInteractive ? (() => void options.onClick?.(tx)) : null}
    >
      <div class="tx-main flex-1 min-w-0">
        <div class="tx-top flex items-center justify-between gap-4">
          <div class="tx-info min-w-0 flex-1 flex items-center gap-3">
            <div class="tx-description flex items-center flex-wrap gap-2">
              <span class="tx-description-text font-bold text-sm">${rowDescription}</span>
              <span class="tx-badges inline-flex items-center gap-1">${renderBadges(tx, options)}</span>
            </div>
            <div class="tx-meta flex items-center gap-2">
              <span class="tx-date text-xs text-secondary">${formatDateShort(parseLocalDate(tx.date))}</span>
              ${isSavingsTransfer && goalName
                ? html`<span class="tx-goal-meta" title="Savings goal">${goalName}</span>`
                : renderCategory(tx)}
            </div>
          </div>
          <div class="tx-aside flex items-center gap-3 shrink-0">
            ${renderAmount(tx, fmtCur)}
            ${renderActions(tx, options)}
          </div>
        </div>
      </div>
    </div>
  `;

  if (!options.showSwipeActions) {
    return rowContent;
  }

  return html`
    <div class="swipe-container" data-tx-id="${tx.__backendId}">
      ${renderSwipeActions(tx, options)}
      ${rowContent}
    </div>
  `;
}

// ==========================================
// DELETED — `transactionRowSimple` (Phase 5g-3 Slice 6)
// ==========================================
//
// Phase 5g-3 Slice 6 (Inline-Behavior-Review rev 12, incidental cleanup
// surfaced during Slice 5 `virtual-scroller.ts` verification): the
// `transactionRowSimple(tx, fmtCur, options)` HTML-string template — a
// non-Lit simplified renderer designed for the virtual-scroller's row-pool
// hot path — was deleted alongside its two consumers `createRowRenderer()`
// and `batchRenderTransactions()` (see DELETED block further below).
//
// Why it was dead: Slice 5 deleted the entire `virtual-scroller.ts` module
// (701 LOC) after grep confirmed zero callers. `transactionRowSimple` was
// the only row-renderer this template file exposed in string form — it
// existed solely to feed `createRowRenderer()`, which fed `virtualScroller`.
// With the consumer chain gone, the simplified template was an orphan.
// Grep across `js/` + `tests/` + `e2e/` confirmed zero external callers of
// `transactionRowSimple`, `createRowRenderer`, or `batchRenderTransactions`
// at the start of Slice 6 — direct verification, not transitive inference.
//
// The `escapeHtml` import from `utils-dom.js` was consumed ONLY by this
// template's 9 inline-escape sites (tx description, goal name, category
// chip color/name, row/swipe-container data-id, notes title). With the
// template gone, the import was dropped too — Lit-html's `html` tagged-
// template auto-escaping handles XSS defense for every surviving export
// in this file (`transactionRowTemplate`, `emptyTransactionListTemplate`,
// `loadingTransactionListTemplate`).
//
// Surviving exports retained — all live:
//   - `transactionRowTemplate`       → consumed by `data/transaction-renderer.ts:207`
//   - `emptyTransactionListTemplate` → consumed by `data/transaction-renderer.ts:187`
//   - `loadingTransactionListTemplate` → consumed by `data/transaction-renderer.ts:140`
//
// Note: there is also a separate `transactionRowTemplate` in
// `js/modules/transactions/transaction-row.ts` used by the edit-mode row
// path. That's a different export in a different module and is unaffected.

/**
 * Empty state template
 */
export function emptyTransactionListTemplate(options: {
  hasTransactions?: boolean;
  hasActiveFilters?: boolean;
  isAllMonths?: boolean;
  // Design-Review-Apr21 P3 (batch 6 follow-up wave L): `monthKey` added so
  // the ledger empty state can match the month the user is actually
  // viewing instead of hardcoding "this month" — previously a user who
  // navigated to an empty past/future month saw "No transactions for
  // this month" regardless of which period was on screen. Pure template
  // stays signal-free; caller passes `signals.currentMonth.value`.
  monthKey?: string;
} = {}): TemplateResult {
  const { hasTransactions = false, hasActiveFilters = false, isAllMonths = false, monthKey } = options;
  // `formatViewedMonthLabel` returns "this month" at current-view default
  // and bare "April 2026"-style labels when navigated elsewhere — we want
  // the bare label here because the surrounding copy ("No transactions
  // for X" / "tracking X") already carries the preposition, so a phrase
  // form ("in April 2026") would produce the double-preposition bug
  // ("for in April 2026"). When `monthKey` is omitted (legacy callers)
  // we fall back to "this month" to preserve existing behavior.
  const viewedMonth = monthKey ? formatViewedMonthLabel(monthKey) : 'this month';
  const title = hasTransactions
    ? (hasActiveFilters ? 'No transactions match these filters' : `No transactions for ${isAllMonths ? 'this view' : viewedMonth}`)
    : 'No transactions yet';
  const body = hasTransactions
    ? (hasActiveFilters
        ? 'Adjust or clear filters to see more results.'
        : (isAllMonths ? 'Try a different filter or add a new transaction.' : 'Try another month or add a new transaction.'))
    : `Add your first transaction to start tracking ${viewedMonth}.`;

  // Only show a CTA for "clear filters" — the Add Transaction form is already
  // visible on the same page, so a redundant button would be inconsistent
  // with the other panel empty states (debts, savings, envelopes) which have none.
  const action = hasTransactions && hasActiveFilters
    ? { id: 'clear-filters', label: 'Clear Filters' }
    : null;

  return emptyState(
    hasActiveFilters ? '🔍' : '📝',
    title,
    body,
    action
  );
}

/**
 * Loading state template
 */
export function loadingTransactionListTemplate(): TemplateResult {
  return html`
    <div class="loading-state text-center py-12">
      <div class="spinner animate-spin rounded-full h-12 w-12 mx-auto mb-4"></div>
      <p class="text-secondary">Loading transactions…</p>
    </div>
  `;
}

// ==========================================
// DELETED — `createRowRenderer` + `batchRenderTransactions` (Phase 5g-3 Slice 6)
// ==========================================
//
// `createRowRenderer(options)` returned a `(tx, index) => string` row-render
// closure that wrapped `transactionRowSimple` with a pre-bound formatter —
// a factory meant to feed the (now-deleted) virtual-scroller row pool.
// `batchRenderTransactions(transactions, options)` wrapped a `.map()` over
// `transactionRowTemplate` behind a Lit-html tagged template, but callers
// of `transaction-renderer.ts:207` already inline the `.map()` directly.
//
// Both were grep-confirmed zero-caller at the start of Slice 6. They're
// deleted alongside `transactionRowSimple` (see DELETED block above) as
// the same orphaned surface that Slice 5's virtual-scroller deletion
// left behind. A future caller needing a row-renderer factory should
// construct one at the call site against `transactionRowTemplate` and
// Lit-html — the extra abstraction layer these two exports provided
// wasn't earning its keep.
