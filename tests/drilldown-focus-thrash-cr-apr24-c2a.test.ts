import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { selectedSavingsGoal, selectedDebt } from '../js/modules/components/transaction-detail-panel.js';
import { selectedBudgetCategory } from '../js/modules/components/envelope-budget.js';
import { mountTransactionDetailPanel } from '../js/modules/components/transaction-detail-panel.js';
import { mountCategoryDetailPanel } from '../js/modules/components/category-detail-panel.js';
import {
  userCategoryConfig,
  updateCategory
} from '../js/modules/core/category-store.js';
import type { UserCategoryConfig, Transaction } from '../js/types/index.js';

/**
 * CR-Apr24-C2a [P2×2] — Drill-down modal focus thrash
 * (Code-Review-Report findings 139, 140).
 *
 * Pre-fix: the drill-down effects in `transaction-detail-panel.ts`
 * (savings + debt) and `category-detail-panel.ts` called
 * `openModal(MODAL_ID)` at the end of EVERY effect run. Those effects
 * subscribe to `signals.currency`, live record signals (savingsGoals,
 * debts, userCategoryConfig), and computed transaction lists — so a
 * currency change, a rename made elsewhere, or a new transaction
 * landing in the ledger all re-fired the effect. Each rerun called
 * openModal again, which re-scheduled the modal layer's deferred
 * focus timer (CR-Apr24-C1) and yanked focus back to the modal's
 * first control regardless of where the user had clicked within the
 * open dialog.
 *
 * Fix: gate `openModal` on `!modal.classList.contains('active')` so
 * it fires once per "selection becomes truthy" transition. After the
 * modal is active, subsequent reruns just re-render content via
 * `renderPanel` / `renderModalContent` without re-opening the modal.
 *
 * Tests verify openModal is called at most once across multiple
 * effect re-fires triggered by signal mutations.
 */

const { mockedOpenModal } = vi.hoisted(() => ({
  mockedOpenModal: vi.fn()
}));

vi.mock('../js/modules/ui/core/ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/ui/core/ui.js')>();
  return {
    ...actual,
    openModal: mockedOpenModal
  };
});

function seedConfig(): UserCategoryConfig {
  return {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#ff6b6b', type: 'expense', order: 0 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#51cf66', type: 'income', order: 0 }
    ]
  };
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

describe('CR-Apr24-C2a — Drill-down focus thrash', () => {
  describe('finding 140 — category-detail-panel openModal called once per selection transition', () => {
    let cleanup: (() => void) | null = null;
    const originalConfig = userCategoryConfig.value;
    const originalSelection = selectedBudgetCategory.value;
    const originalCurrency = signals.currency.value;

    beforeEach(() => {
      mockedOpenModal.mockReset();
      document.body.innerHTML = '';
      userCategoryConfig.value = seedConfig();
      signals.replaceTransactionLedger([makeTx({ category: 'food', amount: 12 })]);
      signals.currentMonth.value = '2026-04';
      selectedBudgetCategory.value = null;
      signals.currency.value = { home: 'USD', symbol: '$' };
    });

    afterEach(() => {
      if (cleanup) {
        try { cleanup(); } catch { /* swallow */ }
        cleanup = null;
      }
      selectedBudgetCategory.value = originalSelection;
      userCategoryConfig.value = originalConfig;
      signals.currency.value = originalCurrency;
      document.body.innerHTML = '';
    });

    it('opens modal once when selection becomes truthy', () => {
      cleanup = mountCategoryDetailPanel();

      // Mark the modal active (the test mock for openModal doesn't,
      // so we manually flip the class on the modal element to mirror
      // production-flow state).
      selectedBudgetCategory.value = 'food';
      // The effect's first render path will have called openModal once.
      // Production openModal sets `.active`; here our mock doesn't,
      // so manually set it so the next effect rerun's gate sees an
      // active modal.
      const modal = document.getElementById('category-detail-modal');
      modal?.classList.add('active');

      const callsAfterOpen = mockedOpenModal.mock.calls.length;
      expect(callsAfterOpen).toBeGreaterThanOrEqual(1);

      // Rerun trigger: rename the selected category. Effect re-fires.
      updateCategory('food', { name: 'Groceries' });

      // openModal must NOT have been called again.
      expect(mockedOpenModal.mock.calls.length).toBe(callsAfterOpen);
    });

    it('does not call openModal on currency change while modal is open', () => {
      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';
      const modal = document.getElementById('category-detail-modal');
      modal?.classList.add('active');

      const callsBefore = mockedOpenModal.mock.calls.length;

      // Currency flip — effect re-runs to refresh fmtCur output.
      signals.currency.value = { home: 'EUR', symbol: '€' };

      expect(mockedOpenModal.mock.calls.length).toBe(callsBefore);
    });

    it('does not call openModal on category-config change while modal is open', () => {
      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';
      const modal = document.getElementById('category-detail-modal');
      modal?.classList.add('active');

      const callsBefore = mockedOpenModal.mock.calls.length;

      // Trigger category-config rerun.
      updateCategory('food', { emoji: '🥗' });

      expect(mockedOpenModal.mock.calls.length).toBe(callsBefore);
    });

    it('reopens modal when selection cleared and re-set (clean re-entry)', () => {
      cleanup = mountCategoryDetailPanel();
      selectedBudgetCategory.value = 'food';
      const modal = document.getElementById('category-detail-modal');
      modal?.classList.add('active');

      const firstOpenCount = mockedOpenModal.mock.calls.length;

      // Clear selection (simulates user closing modal — selectedBudget.value -> null).
      selectedBudgetCategory.value = null;
      // Now mock the closed state (production: closeModal removes 'active').
      modal?.classList.remove('active');

      // Re-select the category.
      selectedBudgetCategory.value = 'food';

      // openModal should have been called again (we crossed the
      // active-class boundary).
      expect(mockedOpenModal.mock.calls.length).toBeGreaterThan(firstOpenCount);
    });
  });

  describe('finding 139 — transaction-detail-panel openModal gated for savings + debt', () => {
    let cleanup: (() => void) | null = null;
    const originalSelection = selectedSavingsGoal.value;
    const originalDebt = selectedDebt.value;
    const originalSavings = signals.savingsGoals.value;

    beforeEach(() => {
      mockedOpenModal.mockReset();
      document.body.innerHTML = '';
      signals.savingsGoals.value = {
        'g1': { id: 'g1', name: 'Emergency', target: 1000, saved: 200, icon: '🆘' }
      } as typeof signals.savingsGoals.value;
      signals.replaceTransactionLedger([]);
      signals.currency.value = { home: 'USD', symbol: '$' };
      selectedSavingsGoal.value = null;
      selectedDebt.value = null;
    });

    afterEach(() => {
      if (cleanup) {
        try { cleanup(); } catch { /* swallow */ }
        cleanup = null;
      }
      selectedSavingsGoal.value = originalSelection;
      selectedDebt.value = originalDebt;
      signals.savingsGoals.value = originalSavings;
      document.body.innerHTML = '';
    });

    it('savings drill-down opens modal once across rerender triggers', () => {
      cleanup = mountTransactionDetailPanel();
      selectedSavingsGoal.value = { id: 'g1', name: 'Emergency', emoji: '🆘' };
      const modal = document.getElementById('tx-detail-modal');
      modal?.classList.add('active');

      const callsAfterOpen = mockedOpenModal.mock.calls.length;
      expect(callsAfterOpen).toBeGreaterThanOrEqual(1);

      // Trigger rerender via savingsGoals signal mutation (rename).
      signals.savingsGoals.value = {
        ...signals.savingsGoals.value,
        'g1': { ...signals.savingsGoals.value['g1']!, name: 'Rainy Day' }
      };

      expect(mockedOpenModal.mock.calls.length).toBe(callsAfterOpen);
    });

    it('savings drill-down does not call openModal on currency change', () => {
      cleanup = mountTransactionDetailPanel();
      selectedSavingsGoal.value = { id: 'g1', name: 'Emergency', emoji: '🆘' };
      const modal = document.getElementById('tx-detail-modal');
      modal?.classList.add('active');

      const callsBefore = mockedOpenModal.mock.calls.length;

      signals.currency.value = { home: 'EUR', symbol: '€' };

      expect(mockedOpenModal.mock.calls.length).toBe(callsBefore);
    });
  });
});
