import { describe, expect, it } from 'vitest';
import { buildDemoProfile } from '../js/modules/orchestration/sample-data.js';

describe('buildDemoProfile', () => {
  it('creates a deterministic full demo account shape', () => {
    const referenceDate = new Date(2026, 2, 20);
    const first = buildDemoProfile(referenceDate);
    const second = buildDemoProfile(referenceDate);

    expect(second).toEqual(first);
    expect(first.transactions.length).toBeGreaterThan(80);
    expect(first.savingsGoals).toHaveLength(2);
    expect(first.debts).toHaveLength(2);
    expect(first.txTemplates).toHaveLength(2);
    expect(first.recurringTemplates).toHaveLength(2);
    expect(first.monthlyAllocations['2026-03']).toMatchObject({
      bills: 1820,
      food: 680,
      debt_payment: 350
    });
    expect(first.transactions.some((tx) => tx.__backendId.startsWith('demo_tx_'))).toBe(true);
    expect(first.transactions.some((tx) => tx.tags?.includes('demo_profile'))).toBe(true);
  });

  it('does not create future-dated current-month transactions', () => {
    const profile = buildDemoProfile(new Date(2026, 2, 20));
    const currentMonthTransactions = profile.transactions.filter((tx) => tx.date.startsWith('2026-03-'));

    expect(currentMonthTransactions.length).toBeGreaterThan(0);
    currentMonthTransactions.forEach((tx) => {
      const day = Number(tx.date.slice(-2));
      expect(day).toBeLessThanOrEqual(20);
    });
  });
});
