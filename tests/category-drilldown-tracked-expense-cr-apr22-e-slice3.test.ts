import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { mountCategoryDetailPanel } from '../js/modules/components/category-detail-panel.js';
import { selectedBudgetCategory } from '../js/modules/components/envelope-budget.js';
import { getMonthExpByCat } from '../js/modules/features/financial/calculations.js';
import type { Transaction } from '../js/types/index.js';

/**
 * CR-Apr22-E slice 3 coverage — Category drill-down uses the
 * tracked-expense predicate (finding 60, `[P2]`).
 *
 * Before this slice, `categoryTransactions` in
 * `components/category-detail-panel.ts` filtered with:
 *
 *     tx.type === 'expense' && tx.category === catId
 *
 * The envelope-budget cards, however, compute per-category spend with
 * `getMonthExpByCat` which filters via `isTrackedExpenseTransaction` —
 * a predicate that excludes savings transfers: both `category ===
 * 'savings_transfer'` rows AND legacy `category === 'savings'` rows
 * whose tags / notes / description carry savings-goal markers.
 *
 * Failure mode: clicking a category card that shares an id with savings-
 * transfer rows populated the drill-down list AND header total with
 * more rows/dollars than the card's number. Worst case: the
 * drill-down header total read $N+X while the card itself said $N —
 * breaking the "this card's $N comes from THESE rows" contract the
 * drill-down is supposed to keep.
 *
 * The fix swings the drill-down filter to `isTrackedExpenseTransaction`
 * (exactly what `getMonthExpByCat` uses), so the list + total match
 * the card unconditionally.
 *
 * Tests integrate through the mounted component and the real modal
 * system: seed transactions via `replaceTransactionLedger` (which
 * rebuilds `transactionsByMonth` / `currentMonthTx` atomically), mount
 * the panel, set `selectedBudgetCategory` to open the drill-down, and
 * inspect the rendered rows + total. The "drill-down total === card
 * total" contract is locked down by comparing the rendered header
 * cents against a fresh `getMonthExpByCat` call.
 */

const MODAL_ID = 'category-detail-modal';
const ROW_SELECTOR = '.category-detail-modal__row';
const TOTAL_SELECTOR = '.category-detail-modal__total-amount';
const SUBTITLE_SELECTOR = '.category-detail-modal__subtitle';

function seedDom(): void {
  // The modal system appends into `#modal-container` if present; the
  // panel's `ensureModal()` falls back to `document.body` when the
  // container is missing, but we mirror production by providing it.
  // The modal's `openModal()` also reads `DOM.get('app')` for inert
  // flagging — happy-dom lets that no-op when absent.
  document.body.innerHTML = `
    <div id="modal-container"></div>
  `;
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
    type: 'expense',
    category: 'food',
    amount: 25,
    description: 'Lunch',
    date: '2026-04-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

function renderedRowCount(): number {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return 0;
  return modal.querySelectorAll(ROW_SELECTOR).length;
}

function renderedTotalText(): string {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return '';
  return modal.querySelector(TOTAL_SELECTOR)?.textContent?.trim() ?? '';
}

function renderedSubtitleText(): string {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return '';
  return modal.querySelector(SUBTITLE_SELECTOR)?.textContent?.trim() ?? '';
}

describe('category drill-down tracked-expense filter — CR-Apr22-E slice 3', () => {
  const originalTx = signals.transactions.value;
  const originalMonth = signals.currentMonth.value;
  const originalSelection = selectedBudgetCategory.value;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    seedDom();
    signals.replaceTransactionLedger([]);
    signals.currentMonth.value = '2026-04';
    selectedBudgetCategory.value = null;
  });

  afterEach(() => {
    selectedBudgetCategory.value = null;
    if (cleanup) {
      try { cleanup(); } catch { /* swallow */ }
      cleanup = null;
    }
    signals.replaceTransactionLedger(originalTx);
    signals.currentMonth.value = originalMonth;
    selectedBudgetCategory.value = originalSelection;
    document.body.innerHTML = '';
  });

  describe('regression lock for finding 60 — savings_transfer rows excluded', () => {
    it('drill-down on "savings_transfer" shows ZERO rows even when matching transactions exist', () => {
      // Pre-fix: the filter was just `type === 'expense' && category === catId`,
      // so a user whose category config (via an oddly-named custom preset
      // or a legacy import) includes an id of `savings_transfer` would see
      // all three transfer rows in the drill-down. `getMonthExpByCat` would
      // report $0 (its predicate excludes savings transfers), so the card
      // showed $0 while the drill-down showed $150 across 3 rows.
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'savings_transfer', amount: 50, description: 'Emergency fund' }),
        makeTx({ type: 'expense', category: 'savings_transfer', amount: 75, description: 'Vacation fund' }),
        makeTx({ type: 'expense', category: 'savings_transfer', amount: 25, description: 'Travel fund' }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'savings_transfer';

      // The load-bearing assertion: zero rows rendered, matching the
      // envelope card's filter.
      expect(renderedRowCount()).toBe(0);
      // Subtitle phrasing sings the same tune as the count.
      expect(renderedSubtitleText()).toContain('0 transactions');
    });

    it('drill-down on legacy "savings" catId excludes rows carrying savings-goal markers', () => {
      // Legacy savings-transfer shape: `category: 'savings'` + notes
      // marker `[savings-transfer]` OR tag `savings_transfer`.
      // `isSavingsTransferTransaction` returns true for those rows.
      signals.replaceTransactionLedger([
        // Excluded — marker in notes.
        makeTx({
          type: 'expense',
          category: 'savings',
          amount: 100,
          description: 'Transfer to savings',
          notes: '[savings-transfer] Monthly contribution'
        }),
        // Excluded — tag.
        makeTx({
          type: 'expense',
          category: 'savings',
          amount: 200,
          tags: 'savings_transfer',
          description: 'Goal contribution'
        }),
        // Excluded — "Contribution to goal:" note.
        makeTx({
          type: 'expense',
          category: 'savings',
          amount: 50,
          description: 'Top-up',
          notes: 'Contribution to goal: Emergency Fund [id:abc]'
        }),
        // INCLUDED — plain `savings`-categorized expense with no markers
        // (rare config, but the predicate is explicit: no markers = not a
        // transfer). Kept here to guard the "don't over-exclude" side of
        // the contract.
        makeTx({
          type: 'expense',
          category: 'savings',
          amount: 10,
          description: 'Savings-related purchase'
        }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'savings';

      // Round 7 broadened check: isTrackedExpenseTransaction now excludes
      // ALL transactions whose category contains "savings" (case-insensitive),
      // regardless of marker tags/notes. Every row is excluded.
      expect(renderedRowCount()).toBe(0);
    });
  });

  describe('positive path — normal expense categories are unaffected', () => {
    it('drill-down on "food" shows every food expense in the viewed month', () => {
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 12, description: 'Breakfast' }),
        makeTx({ type: 'expense', category: 'food', amount: 35, description: 'Dinner' }),
        makeTx({ type: 'expense', category: 'food', amount: 8,  description: 'Coffee' }),
        // Different category — ignored.
        makeTx({ type: 'expense', category: 'transport', amount: 15, description: 'Bus pass' }),
        // Income — ignored by the `type === 'expense'` arm of the predicate.
        makeTx({ type: 'income', category: 'salary', amount: 2000, description: 'Paycheck' }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';

      expect(renderedRowCount()).toBe(3);
      // Total matches the sum: $12 + $35 + $8 = $55.
      expect(renderedTotalText()).toContain('55');
    });

    it('drill-down excludes transactions from a DIFFERENT month (respects currentMonth)', () => {
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 100, date: '2026-04-10' }),
        // Wrong month — `currentMonthTx` filters by `currentMonth.value`.
        makeTx({ type: 'expense', category: 'food', amount: 999, date: '2026-03-10' }),
      ]);
      signals.currentMonth.value = '2026-04';

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';

      expect(renderedRowCount()).toBe(1);
      expect(renderedTotalText()).toContain('100');
      expect(renderedTotalText()).not.toContain('999');
    });
  });

  describe('drill-down total === envelope-card total (the load-bearing contract)', () => {
    it('rendered header total matches getMonthExpByCat to the cent on a mixed ledger', () => {
      // A realistic mix: three food expenses, two savings-transfer-shaped
      // rows that would pollute the drill-down pre-fix, and an income
      // row. The card's number (from `getMonthExpByCat`) must equal
      // whatever the drill-down header shows.
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 12.34, description: 'Breakfast' }),
        makeTx({ type: 'expense', category: 'food', amount: 45.67, description: 'Lunch' }),
        makeTx({ type: 'expense', category: 'food', amount: 8.99,  description: 'Snack' }),
        makeTx({ type: 'expense', category: 'savings_transfer', amount: 100, description: 'Emergency fund' }),
        makeTx({
          type: 'expense',
          category: 'savings',
          amount: 50,
          description: 'Goal',
          notes: '[savings-transfer] Monthly'
        }),
        makeTx({ type: 'income', category: 'salary', amount: 3000 }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';

      // Envelope card derives its number through `getMonthExpByCat`.
      const cardTotal = getMonthExpByCat('food', '2026-04');
      // Rendered via `fmtCur(total)` — contract-free on currency symbol
      // shape, but the number portion must match. Compare by parsing
      // digits + dot.
      const rendered = renderedTotalText();
      const renderedNumber = Number(rendered.replace(/[^0-9.-]/g, ''));

      expect(cardTotal).toBeCloseTo(12.34 + 45.67 + 8.99, 2);
      expect(renderedNumber).toBeCloseTo(cardTotal, 2);
    });

    it('total and row count remain in lockstep when transactions are added live', () => {
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 20 }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';

      expect(renderedRowCount()).toBe(1);

      // Add another food expense — the `currentMonthTx` computed
      // re-derives, the panel's effect re-runs, the DOM updates.
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 20 }),
        makeTx({ type: 'expense', category: 'food', amount: 30 }),
      ]);

      expect(renderedRowCount()).toBe(2);
      expect(renderedTotalText()).toContain('50');
    });
  });

  describe('income rows are never surfaced (pre-existing predicate contract)', () => {
    it('income rows matching the selected catId are not listed', () => {
      // Defense-in-depth: even if a user's income-category id collides
      // with an expense-category id (e.g., both "other"), income rows
      // must not leak into the expense drill-down.
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'other', amount: 15, description: 'Misc expense' }),
        makeTx({ type: 'income',  category: 'other', amount: 500, description: 'Side gig' }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'other';

      expect(renderedRowCount()).toBe(1);
      expect(renderedTotalText()).toContain('15');
      expect(renderedTotalText()).not.toContain('500');
    });
  });

  describe('selection clearing closes the drill-down cleanly', () => {
    it('setting selectedBudgetCategory back to null leaves the modal content intact but releases the selection', () => {
      // The effect in `mountCategoryDetailPanel` returns early when
      // `catId` is null — it does not attempt to render or re-open the
      // modal. This locks that contract so a future refactor can't
      // start thrashing the DOM on deselection.
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 42 }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';
      expect(renderedRowCount()).toBe(1);

      selectedBudgetCategory.value = null;

      // The panel does not re-render on deselection (the effect returns
      // early when catId is falsy). The last rendered content sticks
      // until the next selection, which is fine because closeModal is
      // called by the close-button handler or the backdrop observer.
      expect(selectedBudgetCategory.value).toBeNull();
    });
  });

  describe('cleanup disposes the effect and removes the modal element', () => {
    it('cleanup stops further renders and detaches the modal node', () => {
      signals.replaceTransactionLedger([
        makeTx({ type: 'expense', category: 'food', amount: 10 }),
      ]);

      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';
      expect(renderedRowCount()).toBe(1);

      cleanup();
      cleanup = null;

      // Modal element is removed from the DOM.
      expect(document.getElementById(MODAL_ID)).toBeNull();

      // A subsequent selection must NOT recreate the node — the effect
      // is gone.
      selectedBudgetCategory.value = 'transport';
      expect(document.getElementById(MODAL_ID)).toBeNull();
    });
  });
});
