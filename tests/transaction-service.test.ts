/**
 * Transaction Domain Service Tests
 * Pure function tests for transaction calculations.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateMonthTotals,
  calculateTotals,
  calculateDailyAllowance,
  calculateSpendingPace,
  calculateVelocity,
  validateSplitAmounts,
  getTopCategory,
  getTopCategories,
  calculateYearStats,
  calculateAllTimeStats,
  // 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
  // `calculatePercentChange` was retired from the domain layer alongside
  // the live-layer `calcPercentChange` — both used the pre-baseline-helper
  // fabrication pattern (`prev === 0 ? (cur > 0 ? 100 : 0) : pct`). The
  // tests that used to live in this file actively locked in the
  // fabrication (e.g., `expect(calculatePercentChange(100, 0)).toBe(100)`),
  // which is why they couldn't simply be re-pointed at the domain helper —
  // removing the function and its tests together is the correct shape.
  // See `core/baseline.ts::computeBaselineDelta` + `tests/baseline.test.ts`
  // for the replacement contract.
  type TransactionInput
} from '../js/modules/domain/transaction-service.js';

// ==========================================
// HELPERS
// ==========================================

function tx(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    type: 'expense' as const,
    amount: 50,
    date: '2026-04-01',
    category: 'food',
    ...overrides,
  } as TransactionInput;
}

// ==========================================
// calculateMonthTotals
// ==========================================

describe('calculateMonthTotals', () => {
  it('aggregates income and expenses for a given month', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'income', amount: 3000, date: '2026-04-01', category: 'salary' }),
      tx({ type: 'expense', amount: 100, date: '2026-04-05', category: 'food' }),
      tx({ type: 'expense', amount: 50, date: '2026-04-10', category: 'transport' }),
    ];
    const result = calculateMonthTotals(txs, '2026-04');
    expect(result.income).toBe(3000);
    expect(result.expenses).toBe(150);
    expect(result.balance).toBe(2850);
  });

  it('ignores transactions from other months', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 100, date: '2026-03-15', category: 'food' }),
      tx({ type: 'expense', amount: 200, date: '2026-04-15', category: 'food' }),
      tx({ type: 'expense', amount: 300, date: '2026-05-15', category: 'food' }),
    ];
    const result = calculateMonthTotals(txs, '2026-04');
    expect(result.expenses).toBe(200);
  });

  it('computes category totals correctly', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 100, date: '2026-04-01', category: 'food' }),
      tx({ type: 'expense', amount: 50, date: '2026-04-02', category: 'food' }),
      tx({ type: 'expense', amount: 75, date: '2026-04-03', category: 'transport' }),
    ];
    const result = calculateMonthTotals(txs, '2026-04');
    expect(result.categoryTotals).toEqual({ food: 150, transport: 75 });
  });

  it('returns zeros for empty transaction list', () => {
    const result = calculateMonthTotals([], '2026-04');
    expect(result).toEqual({ income: 0, expenses: 0, balance: 0, categoryTotals: {} });
  });

  it('handles floating-point precision via cents math', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 0.1, date: '2026-04-01', category: 'food' }),
      tx({ type: 'expense', amount: 0.2, date: '2026-04-01', category: 'food' }),
    ];
    const result = calculateMonthTotals(txs, '2026-04');
    expect(result.expenses).toBe(0.3); // Should NOT be 0.30000000000000004
  });
});

// ==========================================
// calculateTotals
// ==========================================

describe('calculateTotals', () => {
  it('sums income and expenses across all months', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'income', amount: 1000, date: '2026-01-01', category: 'salary' }),
      tx({ type: 'income', amount: 2000, date: '2026-03-01', category: 'salary' }),
      tx({ type: 'expense', amount: 500, date: '2026-02-15', category: 'rent' }),
    ];
    const result = calculateTotals(txs);
    expect(result.income).toBe(3000);
    expect(result.expenses).toBe(500);
    expect(result.balance).toBe(2500);
  });

  it('returns zeros for empty list', () => {
    expect(calculateTotals([])).toEqual({ income: 0, expenses: 0, balance: 0 });
  });
});

// ==========================================
// calculateDailyAllowance
// ==========================================

describe('calculateDailyAllowance', () => {
  it('calculates remaining daily budget', () => {
    // $3000 income, $1500 spent, $2500 allocated, 15 days remaining
    const result = calculateDailyAllowance(3000, 1500, 2500, 15);
    expect(result).toBeCloseTo(66.66, 1); // (2500 - 1500) / 15 = 66.66
  });

  it('returns 0 when over budget', () => {
    const result = calculateDailyAllowance(3000, 3500, 3000, 10);
    expect(result).toBe(0);
  });

  it('returns 0 when no days remaining', () => {
    expect(calculateDailyAllowance(3000, 1000, 2000, 0)).toBe(0);
  });

  it('returns 0 for negative days remaining', () => {
    expect(calculateDailyAllowance(3000, 1000, 2000, -5)).toBe(0);
  });

  it('includes rollover in calculation', () => {
    // $2500 allocated + $500 rollover - $1500 spent = $1500 over 15 days = $100/day
    const result = calculateDailyAllowance(3000, 1500, 2500, 15, 500);
    expect(result).toBe(100);
  });
});

// ==========================================
// calculateSpendingPace
// ==========================================

describe('calculateSpendingPace', () => {
  it('returns under pace when spending is slow', () => {
    // Day 15 of 30 (50%), $200 spent of $1000 budget (20%)
    const result = calculateSpendingPace(200, 1000, 15, 30);
    expect(result.status).toBe('under');
    expect(result.percentUsed).toBe(20);
    expect(result.pace).toBeCloseTo(0.4, 1); // 20% / 50% = 0.4
  });

  it('returns on-track when spending matches pace', () => {
    // Day 15 of 30 (50%), $500 spent of $1000 budget (50%)
    const result = calculateSpendingPace(500, 1000, 15, 30);
    expect(result.status).toBe('on-track');
    expect(result.pace).toBeCloseTo(1.0, 1);
  });

  it('returns over when spending exceeds pace', () => {
    // Day 10 of 30 (33%), $600 spent of $1000 budget (60%)
    const result = calculateSpendingPace(600, 1000, 10, 30);
    expect(result.status).toBe('over');
    expect(result.pace).toBeGreaterThan(1.1);
  });

  it('handles zero budget', () => {
    const result = calculateSpendingPace(100, 0, 15, 30);
    expect(result.status).toBe('over');
    expect(result.percentUsed).toBe(100);
  });

  it('handles negative budget', () => {
    const result = calculateSpendingPace(0, -500, 15, 30);
    expect(result.status).toBe('over');
  });
});

// ==========================================
// calculateVelocity
// ==========================================

describe('calculateVelocity', () => {
  it('calculates daily rate and projection for current month', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 100, date: '2026-04-01', category: 'food' }),
      tx({ type: 'expense', amount: 200, date: '2026-04-05', category: 'transport' }),
    ];
    // Reference date: April 10 (10 days elapsed in a 30-day month)
    const result = calculateVelocity(txs, '2026-04', new Date(2026, 3, 10));
    expect(result.actual).toBe(300);
    expect(result.dailyRate).toBe(30); // 300 / 10
    expect(result.projected).toBe(900); // 30 * 30
  });

  it('ignores income transactions', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'income', amount: 5000, date: '2026-04-01', category: 'salary' }),
      tx({ type: 'expense', amount: 100, date: '2026-04-01', category: 'food' }),
    ];
    const result = calculateVelocity(txs, '2026-04', new Date(2026, 3, 10));
    expect(result.actual).toBe(100);
  });

  it('uses full month for past months', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 300, date: '2026-03-15', category: 'food' }),
    ];
    // Reference date is in April but querying March (31 days)
    const result = calculateVelocity(txs, '2026-03', new Date(2026, 3, 10));
    expect(result.actual).toBe(300);
    expect(result.dailyRate).toBeCloseTo(300 / 31, 1);
  });

  it('returns zero for no matching transactions', () => {
    const result = calculateVelocity([], '2026-04', new Date(2026, 3, 10));
    expect(result.actual).toBe(0);
    expect(result.dailyRate).toBe(0);
    expect(result.projected).toBe(0);
  });
});

// ==========================================
// validateSplitAmounts
// ==========================================

describe('validateSplitAmounts', () => {
  it('returns valid when splits sum to original', () => {
    const result = validateSplitAmounts(100, [40, 35, 25]);
    expect(result.valid).toBe(true);
    expect(result.remainingCents).toBe(0);
  });

  it('returns invalid when splits are under', () => {
    const result = validateSplitAmounts(100, [40, 30]);
    expect(result.valid).toBe(false);
    expect(result.remainingCents).toBe(3000); // 30.00 remaining in cents
  });

  it('returns invalid when splits exceed original', () => {
    const result = validateSplitAmounts(100, [60, 50]);
    expect(result.valid).toBe(false);
    expect(result.remainingCents).toBe(-1000);
  });

  it('handles floating-point amounts correctly', () => {
    const result = validateSplitAmounts(10.03, [3.34, 3.34, 3.35]);
    expect(result.valid).toBe(true);
  });
});

// ==========================================
// getTopCategory / getTopCategories
// ==========================================

describe('getTopCategory', () => {
  it('returns the highest-spending category', () => {
    const totals = { food: 300, transport: 150, entertainment: 500 };
    const result = getTopCategory(totals);
    expect(result).toEqual({ category: 'entertainment', amount: 500 });
  });

  it('returns null for empty map', () => {
    expect(getTopCategory({})).toBeNull();
  });
});

describe('getTopCategories', () => {
  it('returns top N categories sorted by amount', () => {
    const totals = { food: 300, transport: 150, entertainment: 500, rent: 1000, utilities: 200 };
    const result = getTopCategories(totals, 3);
    expect(result).toEqual([
      { id: 'rent', amount: 1000 },
      { id: 'entertainment', amount: 500 },
      { id: 'food', amount: 300 },
    ]);
  });

  it('returns all categories when limit exceeds count', () => {
    const totals = { food: 100, transport: 200 };
    const result = getTopCategories(totals, 10);
    expect(result).toHaveLength(2);
  });

  it('defaults to top 5', () => {
    const totals: Record<string, number> = {};
    for (let i = 0; i < 10; i++) totals[`cat${i}`] = (i + 1) * 10;
    const result = getTopCategories(totals);
    expect(result).toHaveLength(5);
    expect(result[0]?.amount).toBe(100); // cat9
  });
});

// ==========================================
// calculateYearStats
// ==========================================

describe('calculateYearStats', () => {
  it('aggregates stats for a specific year', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'income', amount: 5000, date: '2026-01-15', category: 'salary' }),
      tx({ type: 'income', amount: 5000, date: '2026-06-15', category: 'salary' }),
      tx({ type: 'expense', amount: 2000, date: '2026-03-10', category: 'rent' }),
      tx({ type: 'expense', amount: 500, date: '2026-07-20', category: 'food' }),
      tx({ type: 'expense', amount: 100, date: '2025-12-01', category: 'food' }), // different year
    ];

    const result = calculateYearStats(txs, '2026');
    expect(result.income).toBe(10000);
    expect(result.expenses).toBe(2500);
    expect(result.net).toBe(7500);
    expect(result.savingsRate).toBe(75);
    expect(result.transactionCount).toBe(4); // excludes 2025 tx
    expect(result.topCategories[0]).toEqual({ id: 'rent', amount: 2000 });
  });

  it('returns zeros for year with no transactions', () => {
    const result = calculateYearStats([], '2026');
    expect(result.income).toBe(0);
    expect(result.expenses).toBe(0);
    expect(result.transactionCount).toBe(0);
  });

  it('handles zero income savings rate', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 100, date: '2026-01-01', category: 'food' }),
    ];
    const result = calculateYearStats(txs, '2026');
    expect(result.savingsRate).toBe(0);
  });
});

// ==========================================
// calculateAllTimeStats
// ==========================================

describe('calculateAllTimeStats', () => {
  it('computes all-time stats across all transactions', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'income', amount: 3000, date: '2025-01-15', category: 'salary' }),
      tx({ type: 'income', amount: 3000, date: '2026-06-15', category: 'salary' }),
      tx({ type: 'expense', amount: 1000, date: '2025-06-01', category: 'rent' }),
      tx({ type: 'expense', amount: 500, date: '2026-03-10', category: 'food' }),
    ];

    const result = calculateAllTimeStats(txs);
    expect(result).not.toBeNull();
    expect(result!.firstDate).toBe('2025-01-15');
    expect(result!.lastDate).toBe('2026-06-15');
    expect(result!.totalIncome).toBe(6000);
    expect(result!.totalExpenses).toBe(1500);
    expect(result!.netSavings).toBe(4500);
    expect(result!.savingsRate).toBe(75);
    expect(result!.transactionCount).toBe(4);
  });

  it('returns null for empty list', () => {
    expect(calculateAllTimeStats([])).toBeNull();
  });

  it('returns null when all transactions lack dates', () => {
    const txs: TransactionInput[] = [
      tx({ type: 'expense', amount: 100, date: '', category: 'food' }),
    ];
    expect(calculateAllTimeStats(txs)).toBeNull();
  });
});

// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// the `calculatePercentChange` test block used to live here. It asserted
// the retired fabrication semantics directly (zero-baseline → 100,
// both-zero → 0), which is why realigning the suite toward the
// `computeBaselineDelta` contract would have required rewriting every
// case. `core/baseline.ts` owns the replacement semantics and is
// independently covered by `tests/baseline.test.ts`.
