/**
 * Rollover Calculation Tests
 * Tests budget rollover logic with various modes and edge cases
 */
import { describe, it, expect } from 'vitest';
import {
  calculateRolloverPure,
  getEffectiveBudgetPure
} from '../js/modules/features/financial/rollover.js';
import type { Transaction } from '../js/types/index.js';

interface RolloverTestState {
  rolloverSettings: {
    enabled: boolean;
    mode: 'all' | 'selected';
    categories: string[];
    maxRollover: number | null;
    negativeHandling: 'zero' | 'carry' | 'ignore';
  };
  monthlyAllocations: Record<string, Record<string, number>>;
  transactions: Transaction[];
}

function createState(overrides: Partial<RolloverTestState> = {}): RolloverTestState {
  return {
    rolloverSettings: {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero',
      ...overrides.rolloverSettings
    },
    monthlyAllocations: overrides.monthlyAllocations || {},
    transactions: overrides.transactions || []
  };
}

function createTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 50,
    category: 'food',
    description: 'Test',
    date: '2026-02-15',
    currency: 'USD',
    recurring: false,
    reconciled: false,
    splits: false,
    ...overrides
  };
}

describe('calculateRolloverPure', () => {
  it('should return 0 when rollover is disabled', () => {
    const state = createState({ rolloverSettings: { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' } });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(0);
  });

  it('should return positive rollover when budget is underspent', () => {
    const state = createState({
      monthlyAllocations: { '2026-02': { food: 300 } },
      transactions: [createTx({ amount: 200, category: 'food', date: '2026-02-15' })]
    });
    // Budget 300, spent 200 = 100 unspent rolls over to March
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(100);
  });

  it('should return 0 when budget is exactly spent', () => {
    const state = createState({
      monthlyAllocations: { '2026-02': { food: 200 } },
      transactions: [createTx({ amount: 200, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(0);
  });

  it('should return 0 for overspent category with negativeHandling=zero', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' },
      monthlyAllocations: { '2026-02': { food: 100 } },
      transactions: [createTx({ amount: 150, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(0);
  });

  it('should carry negative with negativeHandling=carry', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'carry' },
      monthlyAllocations: { '2026-02': { food: 100 } },
      transactions: [createTx({ amount: 150, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(-50);
  });

  it('should pass negative through with negativeHandling=ignore', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'ignore' },
      monthlyAllocations: { '2026-02': { food: 100 } },
      transactions: [createTx({ amount: 150, category: 'food', date: '2026-02-15' })]
    });
    // 'ignore' lets the negative pass through
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(-50);
  });

  it('should respect maxRollover cap for positive rollover', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'all', categories: [], maxRollover: 50, negativeHandling: 'zero' },
      monthlyAllocations: { '2026-02': { food: 300 } },
      transactions: [createTx({ amount: 100, category: 'food', date: '2026-02-15' })]
    });
    // Unspent: 200, capped to 50
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(50);
  });

  it('should respect maxRollover cap for negative rollover', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'all', categories: [], maxRollover: 30, negativeHandling: 'carry' },
      monthlyAllocations: { '2026-02': { food: 100 } },
      transactions: [createTx({ amount: 200, category: 'food', date: '2026-02-15' })]
    });
    // Overspent by 100, capped to -30
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(-30);
  });

  it('should return 0 for category not in selected list', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'selected', categories: ['transport'], maxRollover: null, negativeHandling: 'zero' },
      monthlyAllocations: { '2026-02': { food: 300 } },
      transactions: [createTx({ amount: 100, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(0);
  });

  it('should work for category in selected list', () => {
    const state = createState({
      rolloverSettings: { enabled: true, mode: 'selected', categories: ['food'], maxRollover: null, negativeHandling: 'zero' },
      monthlyAllocations: { '2026-02': { food: 300 } },
      transactions: [createTx({ amount: 100, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(200);
  });

  it('should return 0 when no budget allocated', () => {
    const state = createState({
      monthlyAllocations: { '2026-02': {} },
      transactions: [createTx({ amount: 100, category: 'food', date: '2026-02-15' })]
    });
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(0);
  });

  it('should only count expenses for the specific category', () => {
    const state = createState({
      monthlyAllocations: { '2026-02': { food: 300 } },
      transactions: [
        createTx({ amount: 100, category: 'food', date: '2026-02-10' }),
        createTx({ amount: 200, category: 'transport', date: '2026-02-15' }), // different category
        createTx({ amount: 50, category: 'food', type: 'income', date: '2026-02-20' }) // income, not expense
      ]
    });
    // Only the food expense (100) counts: 300 - 100 = 200
    expect(calculateRolloverPure('food', '2026-03', state)).toBe(200);
  });
});

describe('getEffectiveBudgetPure', () => {
  it('should add rollover to base budget', () => {
    const state = createState({
      monthlyAllocations: {
        '2026-02': { food: 300 },
        '2026-03': { food: 300 }
      },
      transactions: [createTx({ amount: 200, category: 'food', date: '2026-02-15' })]
    });
    // Base 300 + rollover 100 = 400
    expect(getEffectiveBudgetPure('food', '2026-03', 300, state)).toBe(400);
  });

  it('should return base budget when rollover is disabled', () => {
    const state = createState({
      rolloverSettings: { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' },
      monthlyAllocations: { '2026-03': { food: 300 } }
    });
    expect(getEffectiveBudgetPure('food', '2026-03', 300, state)).toBe(300);
  });

  it('should return 0 when no allocation exists', () => {
    const state = createState();
    expect(getEffectiveBudgetPure('food', '2026-03', 0, state)).toBe(0);
  });
});
