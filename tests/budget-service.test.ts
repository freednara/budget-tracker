/**
 * Budget Domain Service Tests
 * Pure function tests for budget/envelope calculations.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateEnvelopeStatus,
  calculateUnassigned,
  calculateCumulativeUnassigned,
  calculateRolloverAmount,
  calculateAccumulatedRollover,
  calculateAllRollovers,
  getEffectiveBudget,
  summarizeRollovers,
  type RolloverInput,
  type MonthAllocations
} from '../js/modules/domain/budget-service.js';

// ==========================================
// HELPERS
// ==========================================

function rolloverSettings(overrides: Partial<RolloverInput> = {}): RolloverInput {
  return {
    enabled: true,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero',
    ...overrides
  };
}

// ==========================================
// calculateEnvelopeStatus
// ==========================================

describe('calculateEnvelopeStatus', () => {
  it('computes status for each category', () => {
    const allocations: MonthAllocations = { food: 500, transport: 200 };
    const expenses = { food: 350, transport: 180 };

    const result = calculateEnvelopeStatus(allocations, expenses);
    expect(result).toHaveLength(2);

    const food = result.find(s => s.categoryId === 'food')!;
    expect(food.allocated).toBe(500);
    expect(food.spent).toBe(350);
    expect(food?.remaining).toBe(150);
    expect(food.isOverBudget).toBe(false);
    expect(food.percentUsed).toBe(70);

    const transport = result.find(s => s.categoryId === 'transport')!;
    expect(transport.remaining).toBe(20);
    expect(transport.percentUsed).toBe(90);
  });

  it('handles over-budget categories', () => {
    const result = calculateEnvelopeStatus({ food: 200 }, { food: 300 });
    const food = result[0];
    expect(food?.isOverBudget).toBe(true);
    expect(food?.remaining).toBe(-100);
  });

  it('caps percentUsed at 100', () => {
    const result = calculateEnvelopeStatus({ food: 100 }, { food: 200 });
    expect(result[0]?.percentUsed).toBe(100);
  });

  it('handles categories with no spending', () => {
    const result = calculateEnvelopeStatus({ food: 500 }, {});
    expect(result[0]?.spent).toBe(0);
    expect(result[0]?.remaining).toBe(500);
    expect(result[0]?.percentUsed).toBe(0);
  });

  it('includes rollover in effective budget', () => {
    const result = calculateEnvelopeStatus(
      { food: 500 },
      { food: 600 },
      { food: 200 }
    );
    const food = result[0];
    expect(food?.effectiveBudget).toBe(700); // 500 + 200
    expect(food?.remaining).toBe(100); // 700 - 600
    expect(food?.isOverBudget).toBe(false);
    expect(food?.rollover).toBe(200);
  });

  it('handles zero allocation with spending', () => {
    const result = calculateEnvelopeStatus({ food: 0 }, { food: 50 });
    expect(result[0]?.percentUsed).toBe(100);
    expect(result[0]?.isOverBudget).toBe(true);
  });

  it('handles floating-point precision', () => {
    const result = calculateEnvelopeStatus({ food: 33.33 }, { food: 11.11 });
    expect(result[0]?.remaining).toBe(22.22);
  });
});

// ==========================================
// calculateUnassigned
// ==========================================

describe('calculateUnassigned', () => {
  it('returns income minus total allocations', () => {
    const result = calculateUnassigned(5000, { food: 1000, rent: 2000, transport: 500 });
    expect(result).toBe(1500);
  });

  it('returns full income when no allocations', () => {
    expect(calculateUnassigned(3000, {})).toBe(3000);
  });

  it('returns negative when over-allocated', () => {
    expect(calculateUnassigned(1000, { rent: 800, food: 500 })).toBe(-300);
  });

  it('handles zero income', () => {
    expect(calculateUnassigned(0, { food: 100 })).toBe(-100);
  });
});

// ==========================================
// calculateCumulativeUnassigned
// ==========================================

describe('calculateCumulativeUnassigned', () => {
  it('accumulates unassigned across months', () => {
    const data = [
      { income: 5000, allocations: { food: 2000, rent: 2000 } },
      { income: 5000, allocations: { food: 2500, rent: 2000 } },
    ];
    // Month 1: 5000 - 4000 = 1000, Month 2: 5000 - 4500 = 500 → cumulative 1500
    expect(calculateCumulativeUnassigned(data)).toBe(1500);
  });

  it('returns 0 for empty data', () => {
    expect(calculateCumulativeUnassigned([])).toBe(0);
  });

  it('handles months with negative unassigned', () => {
    const data: { income: number; allocations: MonthAllocations }[] = [
      { income: 3000, allocations: { rent: 2000 } },
      { income: 3000, allocations: { rent: 2000, food: 1500 } },
    ];
    // Month 1: 1000, Month 2: -500 → cumulative 500
    expect(calculateCumulativeUnassigned(data)).toBe(500);
  });
});

// ==========================================
// calculateRolloverAmount
// ==========================================

describe('calculateRolloverAmount', () => {
  it('returns surplus when under-spent', () => {
    const result = calculateRolloverAmount(500, 300, rolloverSettings(), 'food');
    expect(result).toBe(200);
  });

  it('returns 0 when rollover is disabled', () => {
    expect(calculateRolloverAmount(500, 300, rolloverSettings({ enabled: false }), 'food')).toBe(0);
  });

  it('returns 0 for non-selected categories in selected mode', () => {
    const settings = rolloverSettings({ mode: 'selected', categories: ['rent'] });
    expect(calculateRolloverAmount(500, 300, settings, 'food')).toBe(0);
  });

  it('includes selected categories in selected mode', () => {
    const settings = rolloverSettings({ mode: 'selected', categories: ['food'] });
    expect(calculateRolloverAmount(500, 300, settings, 'food')).toBe(200);
  });

  it('returns 0 for overspent with zero negativeHandling', () => {
    const settings = rolloverSettings({ negativeHandling: 'zero' });
    expect(calculateRolloverAmount(500, 700, settings, 'food')).toBe(0);
  });

  it('carries negative with carry negativeHandling', () => {
    const settings = rolloverSettings({ negativeHandling: 'carry' });
    expect(calculateRolloverAmount(500, 700, settings, 'food')).toBe(-200);
  });

  it('applies max rollover cap to surplus', () => {
    const settings = rolloverSettings({ maxRollover: 100 });
    expect(calculateRolloverAmount(500, 200, settings, 'food')).toBe(100);
  });

  it('does NOT cap negative rollover (ROLL-01: maxRollover applies to surplus only)', () => {
    const settings = rolloverSettings({ negativeHandling: 'carry', maxRollover: 50 });
    // Overspent by 200 — negative balances carry forward in full
    expect(calculateRolloverAmount(500, 700, settings, 'food')).toBe(-200);
  });

  it('handles zero allocation and zero spending', () => {
    expect(calculateRolloverAmount(0, 0, rolloverSettings(), 'food')).toBe(0);
  });
});

// ==========================================
// calculateAccumulatedRollover
// ==========================================

describe('calculateAccumulatedRollover', () => {
  it('accumulates surplus across months', () => {
    const history = [
      { allocated: 500, spent: 400 }, // +100
      { allocated: 500, spent: 450 }, // +50
    ];
    expect(calculateAccumulatedRollover(history, rolloverSettings(), 'food')).toBe(150);
  });

  it('resets to zero when negativeHandling is zero', () => {
    const history = [
      { allocated: 500, spent: 400 }, // +100
      { allocated: 500, spent: 700 }, // -200 → accumulated -100 → reset to 0
      { allocated: 500, spent: 450 }, // +50
    ];
    const settings = rolloverSettings({ negativeHandling: 'zero' });
    expect(calculateAccumulatedRollover(history, settings, 'food')).toBe(50);
  });

  it('carries deficit when negativeHandling is carry', () => {
    const history = [
      { allocated: 500, spent: 400 }, // +100
      { allocated: 500, spent: 700 }, // -200 → accumulated -100
      { allocated: 500, spent: 450 }, // +50 → accumulated -50
    ];
    const settings = rolloverSettings({ negativeHandling: 'carry' });
    expect(calculateAccumulatedRollover(history, settings, 'food')).toBe(-50);
  });

  it('returns 0 when disabled', () => {
    const history = [{ allocated: 500, spent: 300 }];
    expect(calculateAccumulatedRollover(history, rolloverSettings({ enabled: false }), 'food')).toBe(0);
  });

  it('applies max rollover cap to accumulated amount', () => {
    const history = [
      { allocated: 1000, spent: 200 }, // +800
      { allocated: 1000, spent: 300 }, // +700 → accumulated 1500 → capped 500
    ];
    const settings = rolloverSettings({ maxRollover: 500 });
    expect(calculateAccumulatedRollover(history, settings, 'food')).toBe(500);
  });
});

// ==========================================
// calculateAllRollovers
// ==========================================

describe('calculateAllRollovers', () => {
  it('computes rollovers for all categories', () => {
    const histories = {
      food: [{ allocated: 500, spent: 400 }],
      rent: [{ allocated: 1000, spent: 1000 }],
      transport: [{ allocated: 200, spent: 100 }],
    };
    const result = calculateAllRollovers(histories, rolloverSettings());
    expect(result.food).toBe(100);
    expect(result.transport).toBe(100);
    expect(result.rent).toBeUndefined(); // Zero rollover not included
  });

  it('returns empty when disabled', () => {
    const histories = { food: [{ allocated: 500, spent: 300 }] };
    expect(calculateAllRollovers(histories, rolloverSettings({ enabled: false }))).toEqual({});
  });
});

// ==========================================
// getEffectiveBudget
// ==========================================

describe('getEffectiveBudget', () => {
  it('adds allocation and rollover', () => {
    expect(getEffectiveBudget(500, 100)).toBe(600);
  });

  it('handles negative rollover', () => {
    expect(getEffectiveBudget(500, -200)).toBe(300);
  });

  it('handles floating-point precision', () => {
    expect(getEffectiveBudget(33.33, 11.11)).toBe(44.44);
  });
});

// ==========================================
// summarizeRollovers
// ==========================================

describe('summarizeRollovers', () => {
  it('separates positive and negative rollovers', () => {
    const rollovers = { food: 100, rent: -50, transport: 200, utilities: -30 };
    const result = summarizeRollovers(rollovers);
    expect(result.positive).toBe(300);
    expect(result.negative).toBe(-80);
    expect(result.net).toBe(220);
    expect(result.count).toBe(4);
  });

  it('handles all positive', () => {
    const result = summarizeRollovers({ food: 100, rent: 200 });
    expect(result.positive).toBe(300);
    expect(result.negative).toBe(0);
    expect(result.net).toBe(300);
  });

  it('handles empty rollovers', () => {
    const result = summarizeRollovers({});
    expect(result).toEqual({ positive: 0, negative: 0, net: 0, count: 0 });
  });
});
