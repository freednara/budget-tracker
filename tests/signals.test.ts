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
  signals.replaceTransactionLedger([]);
  signals.currentMonth.value = '2026-03';
  signals.monthlyAlloc.value = {};
  signals.dismissedAlerts.value = new Set();
  signals.alerts.value = {
    budgetThreshold: null,
    browserNotificationsEnabled: false,
    lastNotifiedAlertKeys: []
  };
});

describe('currentMonthTotals', () => {
  it('recomputes immediately from live current-month transactions', () => {
    signals.currentMonth.value = '2026-03';
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 10, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.currentMonthTotals.value.expenses).toBe(10);

    signals.replaceTransactionLedger([
      ...signals.transactions.value,
      tx({ type: 'expense', amount: 32.5, date: '2026-03-08', category: 'food' }),
      tx({ type: 'income', amount: 100, date: '2026-03-09', category: 'salary' })
    ]);

    expect(signals.currentMonthTotals.value.income).toBe(100);
    expect(signals.currentMonthTotals.value.expenses).toBe(42.5);
    expect(signals.currentMonthTotals.value.balance).toBe(57.5);
  });

  it('excludes savings transfers from tracked expense totals', () => {
    signals.currentMonth.value = '2026-03';
    signals.replaceTransactionLedger([
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
    ]);

    expect(signals.currentMonthTotals.value.income).toBe(1000);
    expect(signals.currentMonthTotals.value.expenses).toBe(120);
    expect(signals.currentMonthTotals.value.balance).toBe(880);
    expect(signals.expensesByCategory.value).toEqual({ food: 120 });
  });
});

describe('month summary signals', () => {
  it('tracks active months from month summaries instead of raw historical scans', () => {
    signals.replaceTransactionLedger([
      tx({ type: 'income', amount: 1000, date: '2026-01-02', category: 'salary' }),
      tx({ type: 'expense', amount: 50, date: '2026-03-03', category: 'food' }),
      tx({
        type: 'expense',
        amount: 200,
        date: '2026-02-03',
        category: SAVINGS_TRANSFER_CATEGORY_ID,
        description: 'Savings Transfer: Vacation',
        tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
        notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: Vacation [id:goal_2]`
      })
    ]);

    expect(signals.activeTransactionMonths.value).toEqual(['2026-01', '2026-03']);
    expect(signals.monthSummaries.value['2026-03']?.expenses).toBe(50);
    expect(signals.monthSummaries.value['2026-02']?.expenses).toBe(0);
  });

  it('updates the current month summary when transactions move between months', () => {
    signals.currentMonth.value = '2026-03';
    const movedTx = tx({ type: 'expense', amount: 80, date: '2026-03-11', category: 'food' });
    signals.replaceTransactionLedger([movedTx]);

    expect(signals.currentMonthSummary.value.expenses).toBe(80);

    signals.replaceTransactionLedger([{ ...movedTx, date: '2026-04-11' }]);

    expect(signals.currentMonthSummary.value.expenses).toBe(0);
    expect(signals.monthSummaries.value['2026-04']?.expenses).toBe(80);
  });
});

describe('activeAlertEntries', () => {
  it('recomputes when an existing category budget amount changes', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-03': {
        food: 100
      }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toHaveLength(1);
    expect(signals.activeAlertEntries.value[0]?.key).toBe('2026-03:food:budget-threshold');

    signals.monthlyAlloc.value = {
      '2026-03': {
        food: 120
      }
    };

    expect(signals.activeAlertEntries.value).toEqual([]);
  });
});
