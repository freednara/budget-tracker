/**
 * Calculations — Tracked-Span Denominator
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * `getYearStats` and `getAllTimeStats` must derive their monthly-average
 * denominator from the **tracked span** (calendar year / lifetime window),
 * not the **active-months count**. The legacy
 * `Object.keys(monthlyData).length || 1` / `sortedMonths.length || 1`
 * pattern silently dropped zero-activity months from the denominator and
 * inflated the published "avg monthly" readouts whenever the user skipped
 * a month (vacation, moving, no receipts, etc.) or started mid-year.
 *
 * Coverage:
 *   1. Past completed year divides by 12 even when active months = 3.
 *   2. Current year in progress divides by months-elapsed (not /12, not
 *      /active-months).
 *   3. User who started mid-year divides by the in-year tracked span
 *      (spanStart = later of yearStart and firstTrackedOverall).
 *   4. All-time averages divide by the full first-tracked → current-month
 *      span, not active-months.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock surfaces — same pattern used by
// tests/trend-analysis-adaptive-window.test.ts.
const { monthlyTotalsMock, transactionsByMonthRef, transactionsRef } = vi.hoisted(() => ({
  monthlyTotalsMock: vi.fn(),
  transactionsByMonthRef: { value: new Map<string, unknown[]>() },
  transactionsRef: { value: [] as unknown[] },
}));

vi.mock('../js/modules/core/monthly-totals-cache.js', () => ({
  __esModule: true,
  default: {
    init: vi.fn(),
    destroy: vi.fn(),
    getCached: vi.fn(),
    setCached: vi.fn(),
    calculate: monthlyTotalsMock,
    invalidateMonth: vi.fn(),
    invalidateAll: vi.fn(),
    preload: vi.fn(),
    getStats: vi.fn(),
    debug: vi.fn(),
    resetStats: vi.fn(),
  },
  calculateMonthlyTotalsWithCache: monthlyTotalsMock,
  invalidateMonthCache: vi.fn(),
  invalidateAllCache: vi.fn(),
  preloadMonthlyTotalsCache: vi.fn(),
  getCachedMonthlyTotals: vi.fn(),
  setCachedMonthlyTotals: vi.fn(),
  initMonthlyTotalsCache: vi.fn(),
  destroyMonthlyTotalsCache: vi.fn(),
  getCacheStats: vi.fn(),
  debugCache: vi.fn(),
  resetCacheStats: vi.fn(),
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: transactionsRef,
  transactionsByMonth: transactionsByMonthRef,
}));

vi.mock('../js/modules/core/categories.js', () => ({
  getCatInfo: vi.fn(() => ({ id: 'food', name: 'Food', icon: 'utensils', color: '#ff0000' })),
}));

vi.mock('../js/modules/core/transaction-classification.js', () => ({
  isTrackedExpenseTransaction: () => true,
}));

vi.mock('../js/modules/core/month-alloc.js', () => ({
  getMonthAlloc: vi.fn(),
}));

vi.mock('./rollover.js', () => ({
  isRolloverEnabled: () => false,
  calculateMonthRollovers: () => 0,
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  on: vi.fn(),
  emit: vi.fn(),
  createListenerGroup: vi.fn(() => 'mock-group'),
  destroyListenerGroup: vi.fn(),
}));

vi.mock('../js/modules/core/feature-event-interface.js', () => ({
  FeatureEvents: {},
}));

vi.mock('../js/modules/core/locale-service.js', () => ({
  formatMonthShort: (d: Date) =>
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] ?? '',
}));

import {
  getYearStats,
  getAllTimeStats,
  compareYearsMonthly,
} from '../js/modules/features/financial/calculations.js';

/**
 * Drive the mocked `calculateMonthlyTotalsWithCache` with a
 * month-key → totals map. Any month not in the map resolves to an empty
 * totals bucket (all zeros) — the same shape the cache returns for months
 * with no activity.
 */
function seedMonthlyTotals(byMonth: Record<string, { income: number; expenses: number; categoryTotals?: Record<string, number> }>): void {
  monthlyTotalsMock.mockImplementation((mk: string) => {
    const entry = byMonth[mk];
    if (!entry) {
      return { income: 0, expenses: 0, categoryTotals: {} };
    }
    return {
      income: entry.income,
      expenses: entry.expenses,
      categoryTotals: entry.categoryTotals ?? (entry.expenses > 0 ? { food: entry.expenses } : {}),
    };
  });
}

/**
 * Seed the `transactionsByMonth` signal with a fixed set of month keys
 * so `getAllTimeStats` + `getYearStats` can read the sorted-keys list
 * to discover the first-tracked-month boundary.
 */
function seedTrackedMonths(monthKeys: string[]): void {
  transactionsByMonthRef.value = new Map(monthKeys.map(mk => [mk, [] as unknown[]]));
}

describe('getYearStats tracked-span denominator (7a)', () => {
  beforeEach(() => {
    monthlyTotalsMock.mockReset();
    transactionsByMonthRef.value = new Map();
    transactionsRef.value = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('divides past completed year by 12 even when active months = 3 (vacation months included in denominator)', () => {
    // User tracked Jan-Nov 2024 diligently but had zero activity in Dec
    // (vacation). Another zero month in Feb-Apr and Jun-Oct. Only Jan +
    // May + Nov have non-zero totals. Pre-fix denominator = 3 →
    // avg = $300; correct denominator = 12 → avg = $75.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21)); // April 21, 2026 — well past 2024.
    seedTrackedMonths(['2024-01', '2024-05', '2024-11']);
    seedMonthlyTotals({
      '2024-01': { income: 0, expenses: 300 },
      '2024-05': { income: 0, expenses: 300 },
      '2024-11': { income: 0, expenses: 300 },
    });

    const stats = getYearStats('2024');

    expect(stats.expenses).toBe(900);
    // 900 / 12, not 900 / 3 — the nine zero-activity months count.
    expect(stats.avgMonthlyExpenses).toBeCloseTo(75, 5);
  });

  it('divides in-progress current year by months-elapsed (not 12, not active-months)', () => {
    // "Today" = April 21, 2026 → 4 elapsed months. User has activity in
    // Jan only: $400. Pre-fix avg = 400/1 = $400 (WRONG — reads as
    // "spending $400/mo" when really they spent $400 spread over 4
    // months). Naive calendar-year fix = 400/12 = $33 (also WRONG, hides
    // that only 4 months have happened). Correct = 400/4 = $100.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21)); // April (month index 3) 2026.
    seedTrackedMonths(['2026-01']);
    seedMonthlyTotals({
      '2026-01': { income: 0, expenses: 400 },
    });

    const stats = getYearStats('2026');

    expect(stats.expenses).toBe(400);
    expect(stats.avgMonthlyExpenses).toBeCloseTo(100, 5);
  });

  it('divides mid-year-onboarded year by in-year tracked span (spanStart = later of yearStart and firstTrackedOverall)', () => {
    // User started tracking in July 2024. For 2024 the correct denominator
    // is 6 (Jul-Dec = 6 months), NOT 12 (they weren't tracking Jan-Jun)
    // and NOT the active-months count of 1. Input: $600 in Jul only.
    // Correct avg = 600/6 = $100.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21)); // April 21, 2026 — 2024 is complete.
    seedTrackedMonths(['2024-07']);
    seedMonthlyTotals({
      '2024-07': { income: 0, expenses: 600 },
    });

    const stats = getYearStats('2024');

    expect(stats.expenses).toBe(600);
    expect(stats.avgMonthlyExpenses).toBeCloseTo(100, 5);
  });

  it('falls back to /12 for a year entirely before first-tracked (so avg resolves to 0, not NaN)', () => {
    // User started tracking in 2024, asks for 2020 stats. No data →
    // totals all zero. Denominator must not divide 0 by 0.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2024-01', '2024-02']);
    seedMonthlyTotals({
      '2024-01': { income: 100, expenses: 50 },
      '2024-02': { income: 100, expenses: 50 },
    });

    const stats = getYearStats('2020');

    expect(stats.expenses).toBe(0);
    expect(Number.isFinite(stats.avgMonthlyExpenses)).toBe(true);
    expect(stats.avgMonthlyExpenses).toBe(0);
  });
});

describe('getAllTimeStats tracked-span denominator (7a)', () => {
  beforeEach(() => {
    monthlyTotalsMock.mockReset();
    transactionsByMonthRef.value = new Map();
    transactionsRef.value = [{ __backendId: 'anchor', date: '2023-01-15', amount: 0, category: 'food', type: 'expense' }];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('divides across full first-tracked → current-month span (zero-activity months included)', () => {
    // First tracked: Jan 2023. Current month: Apr 2026. Full span =
    // Jan 2023 → Apr 2026 = 40 months. User has activity in only 3 of
    // those months (sparse history, e.g. import after long break),
    // totaling $800. Pre-fix avg = 800/3 ≈ $266.67 (WRONG — makes a
    // sparse user look like a heavy spender). Correct = 800/40 = $20.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21)); // April 21, 2026.
    seedTrackedMonths(['2023-01', '2024-06', '2025-10']);
    seedMonthlyTotals({
      '2023-01': { income: 0, expenses: 300 },
      '2024-06': { income: 0, expenses: 300 },
      '2025-10': { income: 0, expenses: 200 },
    });

    const stats = getAllTimeStats();

    if (!stats) throw new Error('getAllTimeStats returned null');
    expect(stats.totalExpenses).toBe(800);
    // 40-month span: (2026-2023)*12 + (4-1) + 1 = 36 + 3 + 1 = 40.
    expect(stats.avgMonthlySpend).toBeCloseTo(20, 5);
  });
});

/**
 * 7a (Inline-Behavior-Review, Period/scope coherence): Months-Tracked
 * alignment.
 *
 * The analytics modal's All-Time Stats block displays "Months Tracked"
 * alongside "Avg/Month" readouts that divide by `avgMonthlySpend`'s
 * denominator. Pre-fix the two numbers were derived from independent
 * code paths:
 *   - `avgMonthlySpend` (in `getAllTimeStats`) divided total expenses
 *     by the full first-tracked → max(last-data, current) span.
 *   - "Months Tracked" (inline in `populateAllTimeStats`) computed
 *     firstDate → lastDate only, with no current-month extension.
 *
 * A user who logged $1200 across Jan 2024 → Feb 2024 and then went
 * silent through Apr 2026 would see:
 *   - "Months Tracked: 2" (the inline narrow window),
 *   - "Avg/Month: $46.15" (the wide 26-month denominator underneath),
 * which obviously can't both be right — $1200 / 2 = $600, $1200 / 26 ≈
 * $46. Post-fix `getAllTimeStats` exposes the canonical denominator as
 * `monthsTracked` and the UI reads it straight, so the two values
 * cannot drift.
 */
describe('getAllTimeStats months-tracked alignment (7a)', () => {
  beforeEach(() => {
    monthlyTotalsMock.mockReset();
    transactionsByMonthRef.value = new Map();
    transactionsRef.value = [{ __backendId: 'anchor', date: '2023-01-15', amount: 0, category: 'food', type: 'expense' }];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes monthsTracked equal to the denominator behind avgMonthlySpend', () => {
    // Sparse history — the active-month count (3) is wildly smaller
    // than the tracked span (40). Pre-fix these two numbers disagreed;
    // post-fix `monthsTracked` reports the same 40-month span that
    // `avgMonthlySpend`'s divisor uses.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2023-01', '2024-06', '2025-10']);
    seedMonthlyTotals({
      '2023-01': { income: 0, expenses: 300 },
      '2024-06': { income: 0, expenses: 300 },
      '2025-10': { income: 0, expenses: 200 },
    });

    const stats = getAllTimeStats();

    if (!stats) throw new Error('getAllTimeStats returned null');
    expect(stats.monthsTracked).toBe(40);
    // And it really is the same number used for avgMonthlySpend.
    // monthsTracked * avgMonthlySpend ≈ totalExpenses (to cents).
    expect(stats.monthsTracked * stats.avgMonthlySpend).toBeCloseTo(stats.totalExpenses, 5);
  });

  it('extends the span to the current month even when last-tracked-month is stale', () => {
    // User has NOT logged since Feb 2024 but it's now Apr 2026. The
    // inline legacy calc (firstDate → lastDate only) would return 2.
    // The tracked-span calc should extend to current-month and return
    // 27 (Feb 2024 → Apr 2026 inclusive).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2024-02']);
    seedMonthlyTotals({
      '2024-02': { income: 0, expenses: 100 },
    });

    const stats = getAllTimeStats();

    if (!stats) throw new Error('getAllTimeStats returned null');
    // Feb 2024 → Apr 2026 = (2026-2024)*12 + (4-2) + 1 = 24+2+1 = 27.
    expect(stats.monthsTracked).toBe(27);
  });

  it('does not clamp below 1 even when first and last are the same month', () => {
    // Single-month history. firstDate === lastDate. The denominator
    // must be at least 1 — and in this case "current month" === "only
    // tracked month", so the span is exactly 1.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2026-04']);
    seedMonthlyTotals({
      '2026-04': { income: 0, expenses: 500 },
    });

    const stats = getAllTimeStats();

    if (!stats) throw new Error('getAllTimeStats returned null');
    expect(stats.monthsTracked).toBe(1);
    expect(stats.avgMonthlySpend).toBe(500);
  });

  it('uses last-data-month when a future-dated import extends past today', () => {
    // Edge case: the user imported a future-dated transaction (bill
    // paid in advance, scheduled transfer, etc.) so last-data-month >
    // current-month. The span endpoint is max(last, current) = last.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21)); // Apr 2026.
    seedTrackedMonths(['2026-01', '2026-08']);
    seedMonthlyTotals({
      '2026-01': { income: 0, expenses: 100 },
      '2026-08': { income: 0, expenses: 100 },
    });

    const stats = getAllTimeStats();

    if (!stats) throw new Error('getAllTimeStats returned null');
    // Jan 2026 → Aug 2026 = 8 months (spanEnd = last-data, not current).
    expect(stats.monthsTracked).toBe(8);
  });
});

/**
 * 7a — compareYearsMonthly no-fabrication shape contract.
 *
 * `MonthlyComparison` used to carry `expenseChange` / `incomeChange` /
 * `netChange` fields populated via the fabrication
 * `prev === 0 ? (cur > 0 ? 100 : 0) : pct`. Zero consumers read those
 * fields, and the fabrication pattern is exactly what
 * `core/baseline.ts::computeBaselineDelta` was introduced to replace.
 * The fields + helper were retired in this slice; these tests lock in
 * the new contract so a future re-add can't silently reintroduce the
 * "+100% for a zero-prior baseline" UX regression.
 */
describe('compareYearsMonthly fabrication-free shape (7a)', () => {
  beforeEach(() => {
    monthlyTotalsMock.mockReset();
    transactionsByMonthRef.value = new Map();
    transactionsRef.value = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 12 rows with the documented shape and no fabricated change fields', () => {
    // Seed identical corpora for two years — concrete totals don't matter
    // for the shape assertion. The point is "what keys does a row carry?"
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2024-01', '2025-01']);
    seedMonthlyTotals({
      '2024-01': { income: 0, expenses: 100 },
      '2025-01': { income: 0, expenses: 200 },
    });

    const rows = compareYearsMonthly('2025', '2024');
    expect(rows).toHaveLength(12);

    // Every row must carry exactly these keys — no legacy fabrication
    // fields. Sort both sides for stability against insertion-order drift.
    const allowedKeys = ['month', 'monthLabel', 'year1', 'year2'].sort();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(allowedKeys);
    }
  });

  it('does not surface a degenerate +100% for a zero-prior-year baseline', () => {
    // Classic fabrication-surface: prior year had no expenses in month X,
    // current year does. Pre-retirement the legacy `expenseChange` would
    // have been exactly `100` regardless of the magnitude of the current-
    // year spend — indistinguishable from a true year-over-year doubling.
    // With the field gone, any UI that wants a YoY percentage must route
    // through `computeBaselineDelta`, which classifies this case as 'new'.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 21));
    seedTrackedMonths(['2024-01', '2025-03']);
    seedMonthlyTotals({
      '2024-01': { income: 0, expenses: 50 },   // Jan 2024 only
      '2025-03': { income: 0, expenses: 800 },  // Mar 2025 with no 2024 baseline
    });

    const rows = compareYearsMonthly('2025', '2024');
    const march = rows.find(r => r.month === 3);
    if (!march) throw new Error('March row missing from comparison');

    // Spot-check the raw per-year totals survive — the chart consumes
    // these, not a derived percentage.
    expect(march.year1.expenses).toBe(800);
    expect(march.year2.expenses).toBe(0);
    // And confirm the fabrication-surface field is genuinely absent. A
    // fresh `in` check is the tightest invariant we can pin: if a future
    // refactor re-adds the field, this test breaks immediately.
    expect('expenseChange' in march).toBe(false);
    expect('incomeChange' in march).toBe(false);
    expect('netChange' in march).toBe(false);
  });
});
