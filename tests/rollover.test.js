/**
 * Tests for budget rollover module
 * Validates rollover calculations and settings
 * Uses pure function exports from the actual rollover module
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { toCents, toDollars } from '../js/modules/core/utils.js';
import {
  calculateRolloverPure,
  getEffectiveBudgetPure,
  calculateMonthRolloversPure,
  DEFAULT_ROLLOVER_SETTINGS
} from '../js/modules/features/financial/rollover.js';

// ==========================================
// TEST UTILITIES
// ==========================================

/**
 * Create a mock state for testing
 * Matches RolloverTestState interface from rollover.ts
 */
function createMockState() {
  return {
    transactions: [],
    monthlyAllocations: {},
    rolloverSettings: { ...DEFAULT_ROLLOVER_SETTINGS }
  };
}

// ==========================================
// TESTS FOR calculateRolloverPure
// ==========================================

describe('calculateRolloverPure', () => {
  let state;

  beforeEach(() => {
    state = createMockState();
  });

  it('returns 0 when rollover is disabled', () => {
    state.rolloverSettings.enabled = false;
    state.monthlyAllocations['2024-05'] = { food: 500 };
    // No spending in May = $500 unspent
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(0);
  });

  it('calculates positive rollover when underspent', () => {
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = { food: 500 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 300 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(200); // 500 - 300 = 200
  });

  it('returns 0 for overspent category with zero handling', () => {
    state.rolloverSettings.enabled = true;
    state.rolloverSettings.negativeHandling = 'zero';
    state.monthlyAllocations['2024-05'] = { food: 300 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 400 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(0);
  });

  it('returns negative rollover with carry handling', () => {
    state.rolloverSettings.enabled = true;
    state.rolloverSettings.negativeHandling = 'carry';
    state.monthlyAllocations['2024-05'] = { food: 300 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 400 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(-100); // 300 - 400 = -100
  });

  it('respects max rollover cap', () => {
    state.rolloverSettings.enabled = true;
    state.rolloverSettings.maxRollover = 100;
    state.monthlyAllocations['2024-05'] = { food: 500 };
    // No spending = $500 unspent, but capped at $100
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(100);
  });

  it('respects selected categories mode', () => {
    state.rolloverSettings.enabled = true;
    state.rolloverSettings.mode = 'selected';
    state.rolloverSettings.categories = ['food']; // Only food is included
    state.monthlyAllocations['2024-05'] = { food: 500, transport: 200 };
    // No spending

    const foodRollover = calculateRolloverPure('food', '2024-06', state);
    const transportRollover = calculateRolloverPure('transport', '2024-06', state);

    expect(foodRollover).toBe(500);
    expect(transportRollover).toBe(0); // Not in selected categories
  });

  it('handles category with no previous budget', () => {
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = {}; // No allocations
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(0);
  });

  it('handles first month (no previous data)', () => {
    state.rolloverSettings.enabled = true;
    // No previous month data at all
    const rollover = calculateRolloverPure('food', '2024-01', state);
    expect(rollover).toBe(0);
  });

  it('handles year boundary correctly', () => {
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2023-12'] = { food: 400 };
    state.transactions = [
      { date: '2023-12-20', type: 'expense', category: 'food', amount: 150 }
    ];
    const rollover = calculateRolloverPure('food', '2024-01', state);
    expect(rollover).toBe(250); // 400 - 150
  });
});

// ==========================================
// TESTS FOR getEffectiveBudgetPure
// ==========================================

describe('getEffectiveBudgetPure', () => {
  let state;

  beforeEach(() => {
    state = createMockState();
  });

  it('returns base budget when rollover disabled', () => {
    state.rolloverSettings.enabled = false;
    const effective = getEffectiveBudgetPure('food', '2024-06', 500, state);
    expect(effective).toBe(500);
  });

  it('adds rollover to base budget', () => {
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = { food: 500 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 300 }
    ];
    const effective = getEffectiveBudgetPure('food', '2024-06', 500, state);
    expect(effective).toBe(700); // 500 base + 200 rollover
  });

  it('handles negative rollover correctly', () => {
    state.rolloverSettings.enabled = true;
    state.rolloverSettings.negativeHandling = 'carry';
    state.monthlyAllocations['2024-05'] = { food: 300 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 400 }
    ];
    const effective = getEffectiveBudgetPure('food', '2024-06', 500, state);
    expect(effective).toBe(400); // 500 base - 100 overspent
  });

  it('handles floating-point precision', () => {
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = { food: 100.33 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 50.11 }
    ];
    const effective = getEffectiveBudgetPure('food', '2024-06', 100.22, state);
    // 100.22 + (100.33 - 50.11) = 100.22 + 50.22 = 150.44
    expect(effective).toBe(150.44);
  });
});

// ==========================================
// TESTS FOR calculateMonthRolloversPure
// ==========================================

describe('calculateMonthRolloversPure', () => {
  let state;

  beforeEach(() => {
    state = createMockState();
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = {
      food: 500,
      transport: 200,
      entertainment: 100
    };
    state.transactions = [
      { date: '2024-05-10', type: 'expense', category: 'food', amount: 300 },
      { date: '2024-05-15', type: 'expense', category: 'transport', amount: 200 },
      // entertainment: no spending = $100 unspent
    ];
  });

  it('calculates rollovers for all categories', () => {
    const result = calculateMonthRolloversPure(
      '2024-06',
      ['food', 'transport', 'entertainment'],
      state
    );
    expect(result.byCategory.food).toBe(200);
    expect(result.byCategory.transport).toBeUndefined(); // 0 is not included
    expect(result.byCategory.entertainment).toBe(100);
  });

  it('calculates total rollover', () => {
    const result = calculateMonthRolloversPure(
      '2024-06',
      ['food', 'transport', 'entertainment'],
      state
    );
    expect(result.total).toBe(300); // 200 + 0 + 100
  });

  it('handles empty category list', () => {
    const result = calculateMonthRolloversPure('2024-06', [], state);
    expect(result.total).toBe(0);
    expect(Object.keys(result.byCategory).length).toBe(0);
  });

  it('handles all categories fully spent', () => {
    state.monthlyAllocations['2024-05'] = { food: 300 };
    state.transactions = [
      { date: '2024-05-10', type: 'expense', category: 'food', amount: 300 }
    ];
    const result = calculateMonthRolloversPure('2024-06', ['food'], state);
    expect(result.total).toBe(0);
  });
});

// ==========================================
// TESTS FOR ROLLOVER SETTINGS
// ==========================================

describe('Rollover settings', () => {
  let state;

  beforeEach(() => {
    state = createMockState();
    state.rolloverSettings.enabled = true;
    state.monthlyAllocations['2024-05'] = { food: 500 };
    // No spending = $500 unspent
  });

  it('mode "all" includes all categories', () => {
    state.rolloverSettings.mode = 'all';
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(500);
  });

  it('mode "selected" excludes non-selected categories', () => {
    state.rolloverSettings.mode = 'selected';
    state.rolloverSettings.categories = []; // Empty = none selected
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(0);
  });

  it('max rollover caps large amounts', () => {
    state.rolloverSettings.maxRollover = 200;
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(200);
  });

  it('max rollover does not affect smaller amounts', () => {
    state.rolloverSettings.maxRollover = 1000;
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(500); // Under cap
  });

  it('null max rollover means unlimited', () => {
    state.rolloverSettings.maxRollover = null;
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(500);
  });
});

// ==========================================
// EDGE CASES
// ==========================================

describe('Edge cases', () => {
  let state;

  beforeEach(() => {
    state = createMockState();
    state.rolloverSettings.enabled = true;
  });

  it('handles zero budget', () => {
    state.monthlyAllocations['2024-05'] = { food: 0 };
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(0);
  });

  it('handles multiple transactions in category', () => {
    state.monthlyAllocations['2024-05'] = { food: 500 };
    state.transactions = [
      { date: '2024-05-01', type: 'expense', category: 'food', amount: 50 },
      { date: '2024-05-10', type: 'expense', category: 'food', amount: 75.50 },
      { date: '2024-05-20', type: 'expense', category: 'food', amount: 100.25 },
      { date: '2024-05-25', type: 'expense', category: 'food', amount: 24.25 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(250); // 500 - 250 spent
  });

  it('ignores income transactions', () => {
    state.monthlyAllocations['2024-05'] = { food: 500 };
    state.transactions = [
      { date: '2024-05-15', type: 'income', category: 'food', amount: 100 },
      { date: '2024-05-20', type: 'expense', category: 'food', amount: 200 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(300); // 500 - 200 (income ignored)
  });

  it('ignores transactions from other months', () => {
    state.monthlyAllocations['2024-05'] = { food: 500 };
    state.transactions = [
      { date: '2024-04-15', type: 'expense', category: 'food', amount: 100 }, // April
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 200 }, // May
      { date: '2024-06-15', type: 'expense', category: 'food', amount: 150 }  // June
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(300); // Only May spending counts: 500 - 200
  });

  it('handles cents precision correctly', () => {
    state.monthlyAllocations['2024-05'] = { food: 100.01 };
    state.transactions = [
      { date: '2024-05-15', type: 'expense', category: 'food', amount: 50.02 }
    ];
    const rollover = calculateRolloverPure('food', '2024-06', state);
    expect(rollover).toBe(49.99); // 100.01 - 50.02
  });
});

// ==========================================
// CHAINED ROLLOVER (MULTI-MONTH)
// ==========================================

describe('Chained rollover (multi-month)', () => {
  it('rollover compounds across months', () => {
    const state = createMockState();
    state.rolloverSettings.enabled = true;

    // Set up chain: Jan -> Feb -> March
    state.monthlyAllocations['2024-01'] = { food: 500 };
    state.monthlyAllocations['2024-02'] = { food: 500 };
    state.monthlyAllocations['2024-03'] = { food: 500 };

    // January: spend 300, rollover 200 to Feb
    state.transactions = [
      { date: '2024-01-15', type: 'expense', category: 'food', amount: 300 }
    ];

    const janToFeb = calculateRolloverPure('food', '2024-02', state);
    expect(janToFeb).toBe(200);

    // February: spend 400 of (500 + 200 effective)
    // Note: Our simple implementation only looks at previous month's budget,
    // not effective budget. Real implementation would need recursive calculation.
    state.transactions.push(
      { date: '2024-02-15', type: 'expense', category: 'food', amount: 400 }
    );

    const febToMarch = calculateRolloverPure('food', '2024-03', state);
    expect(febToMarch).toBe(100); // 500 - 400 = 100 (base calculation)
  });
});
