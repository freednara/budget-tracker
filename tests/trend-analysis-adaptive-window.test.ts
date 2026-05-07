/**
 * Trend Analysis — Adaptive Half-Window
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * year-scoped category trends must use a proper full-year window rather than
 * the legacy `slice(-3)` / `slice(0, 3)` pair which compared Q4 to Q1 on a
 * 12-month view and silently ignored the 10 months in between. The fix uses
 * an adaptive half-window: last half of the monthlyData vs first half. On a
 * 6-month default view this is unchanged (halfWindow = 3 → last 3 vs first
 * 3); on a 12-month year view it collapses to H2 (Jul-Dec) vs H1 (Jan-Jun).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the mock reference at module scope so individual tests can drive
// the per-month totals returned by calculateMonthlyTotalsWithCache.
const { monthlyTotalsMock, getCatInfoMock } = vi.hoisted(() => ({
  monthlyTotalsMock: vi.fn(),
  getCatInfoMock: vi.fn(() => ({
    id: 'food',
    name: 'Food',
    icon: 'utensils',
    color: '#ff0000',
  })),
}));

vi.mock('../js/modules/core/monthly-totals-cache.js', () => ({
  calculateMonthlyTotalsWithCache: monthlyTotalsMock,
  invalidateMonthCache: vi.fn(),
  invalidateAllCache: vi.fn(),
}));

vi.mock('../js/modules/core/categories.js', () => ({
  getCatInfo: getCatInfoMock,
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: { value: [] },
}));

vi.mock('../js/modules/core/transaction-classification.js', () => ({
  isTrackedExpenseTransaction: () => true,
}));

import { calculateCategoryTrends } from '../js/modules/features/analytics/trend-analysis.js';

/**
 * Build a monthly-totals row for a single category ID.
 */
function cat(amount: number): { categoryTotals: Record<string, number> } {
  return { categoryTotals: { food: amount } };
}

describe('calculateCategoryTrends adaptive half-window (7a)', () => {
  beforeEach(() => {
    monthlyTotalsMock.mockReset();
    getCatInfoMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits a 6-month window into last-3 vs first-3 (default behavior preserved)', () => {
    // First 3 months: 100 each → H1 avg = 100. Last 3 months: 200 each →
    // H2 avg = 200. Expected percentage change = (200-100)/100 * 100 = +100%.
    const seq = [100, 100, 100, 200, 200, 200];
    monthlyTotalsMock.mockImplementation(() => cat(seq.shift() ?? 0));

    const result = calculateCategoryTrends(6);

    const food = result.trends.find(t => t.category?.id === 'food');
    if (!food) throw new Error('food trend row missing');
    expect(food.recentAverage).toBe(200);
    expect(food.percentageChange).toBe(100);
    expect(food.baseline.status).toBe('comparable');
  });

  it('splits a 12-month year-scoped window into H2 vs H1 (not Q4 vs Q1)', () => {
    // Pre-fix this call used slice(-3) (Oct/Nov/Dec) vs slice(0, 3)
    // (Jan/Feb/Mar), silently ignoring Apr-Sep. With the adaptive
    // half-window, H2 (Jul-Dec) is compared to H1 (Jan-Jun).
    //
    // Construct a year where Q1 and Q4 happen to be identical (both 100)
    // but the middle months diverge: Apr-Jun = 50, Jul-Sep = 300. A
    // slice(-3)/slice(0,3) implementation would see Q4=100 vs Q1=100 →
    // percentageChange 0 ("flat"). The correct half-split sees
    // H2 = (300+300+300+100+100+100)/6 = 200, H1 = (100+100+100+50+50+50)/6 = 75,
    // so percentageChange = (200-75)/75 * 100 ≈ +166.67%.
    const seq = [
      100, 100, 100,   // Q1: Jan-Mar
      50, 50, 50,      // Q2: Apr-Jun
      300, 300, 300,   // Q3: Jul-Sep
      100, 100, 100,   // Q4: Oct-Dec
    ];
    monthlyTotalsMock.mockImplementation(() => cat(seq.shift() ?? 0));

    const result = calculateCategoryTrends(12, '2025');

    const food = result.trends.find(t => t.category?.id === 'food');
    if (!food) throw new Error('food trend row missing');
    expect(food.recentAverage).toBe(200);
    // H1 avg = 75; percentageChange = (200-75)/75 * 100 = 166.666...
    expect(food.percentageChange).toBeCloseTo(166.666, 2);
    expect(food.baseline.status).toBe('comparable');
  });

  it('does not zero-divide on a 1-month window (halfWindow floor-guarded to 1)', () => {
    // A single-month window degenerates to "this month vs this month"
    // and should report 0% / 'comparable' rather than NaN or Infinity.
    monthlyTotalsMock.mockImplementation(() => cat(100));

    const result = calculateCategoryTrends(1);

    const food = result.trends.find(t => t.category?.id === 'food');
    if (!food) throw new Error('food trend row missing');
    expect(Number.isFinite(food.recentAverage)).toBe(true);
    expect(Number.isFinite(food.percentageChange)).toBe(true);
    // Same value on both sides → 0% change, 'comparable' (not 'new' or 'no-data').
    expect(food.percentageChange).toBe(0);
    expect(food.baseline.status).toBe('comparable');
  });

  it('surfaces baseline.status = "new" when H1 is empty and H2 is populated (year view)', () => {
    // Category spending starts mid-year — H1 is all zero, H2 has data.
    // Pre-baseline-helper this would fabricate a +100% change; the
    // baseline helper correctly classifies it as 'new'.
    const seq = [
      0, 0, 0, 0, 0, 0,      // H1: Jan-Jun, no spend yet
      150, 150, 150, 150, 150, 150, // H2: Jul-Dec, $150/month
    ];
    monthlyTotalsMock.mockImplementation(() => cat(seq.shift() ?? 0));

    const result = calculateCategoryTrends(12, '2025');

    const food = result.trends.find(t => t.category?.id === 'food');
    if (!food) throw new Error('food trend row missing');
    expect(food.baseline.status).toBe('new');
    // percentageChange falls back to 0 per the `baseline.percent ?? 0`
    // contract — callers wanting to distinguish 'new' from 'flat' read
    // baseline.status, not percentageChange.
    expect(food.percentageChange).toBe(0);
  });
});
