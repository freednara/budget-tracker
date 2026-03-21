import { afterEach, describe, expect, it } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { SAVINGS_TRANSFER_CATEGORY_ID, SAVINGS_TRANSFER_NOTE_MARKER, SAVINGS_TRANSFER_TAG } from '../js/modules/core/transaction-classification.js';
import type { Transaction } from '../js/types/index.js';

function tx(
  overrides: Partial<Transaction> & {
    type: 'expense' | 'income';
    amount: number;
    date: string;
    category: string;
  }
): Transaction {
  return {
    __backendId: `test_${Math.random().toString(36).slice(2)}`,
    description: 'Test',
    currency: 'USD',
    recurring: false,
    ...overrides
  };
}

afterEach(() => {
  signals.transactions.value = [];
  signals.currentMonth.value = '2026-03';
});

describe('currentMonthTotals', () => {
  it('recomputes immediately from live current-month transactions', () => {
    signals.currentMonth.value = '2026-03';
    signals.transactions.value = [
      tx({ type: 'expense', amount: 10, date: '2026-03-05', category: 'food' })
    ];

    expect(signals.currentMonthTotals.value.expenses).toBe(10);

    signals.transactions.value = [
      ...signals.transactions.value,
      tx({ type: 'expense', amount: 32.5, date: '2026-03-08', category: 'food' }),
      tx({ type: 'income', amount: 100, date: '2026-03-09', category: 'salary' })
    ];

    expect(signals.currentMonthTotals.value.income).toBe(100);
    expect(signals.currentMonthTotals.value.expenses).toBe(42.5);
    expect(signals.currentMonthTotals.value.balance).toBe(57.5);
  });

  it('excludes savings transfers from tracked expense totals', () => {
    signals.currentMonth.value = '2026-03';
    signals.transactions.value = [
      tx({ type: 'income', amount: 1000, date: '2026-03-01', category: 'salary' }),
      tx({ type: 'expense', amount: 120, date: '2026-03-04', category: 'food' }),
      tx({
        type: 'expense',
        amount: 250,
        date: '2026-03-05',
        category: SAVINGS_TRANSFER_CATEGORY_ID,
        description: 'Savings Transfer: Emergency Fund',
        tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
        notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: Emergency Fund [id:goal_1]`
      })
    ];

    expect(signals.currentMonthTotals.value.income).toBe(1000);
    expect(signals.currentMonthTotals.value.expenses).toBe(120);
    expect(signals.currentMonthTotals.value.balance).toBe(880);
    expect(signals.expensesByCategory.value).toEqual({ food: 120 });
  });
});
