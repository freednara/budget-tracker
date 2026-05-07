/**
 * YoY Section — Single-Year Availability Gate
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * when the corpus contains transactions for only ONE year, the Year-over-
 * Year comparison must be **disabled**, not degraded.
 *
 * Pre-fix behavior:
 *   - The single-year branch set `year1Select.value = year2Select.value =
 *     soleYear` and then fell through to `compareYearsMonthly(soleYear,
 *     soleYear)`, producing a degenerate "year vs itself" chart with every
 *     bar pair identical and a fabricated `+0.0%` delta.
 *   - A hint ("Add transactions in a second year…") was prepended on top of
 *     this degenerate render, so the user simultaneously saw BOTH a
 *     misleading comparison AND a message explaining why the comparison
 *     was unavailable. Contradictory and confusing.
 *
 * Post-fix behavior (locked in by this suite):
 *   - Single-year corpus: hint is present, chart is cleared, both selectors
 *     are disabled, and `compareYearsMonthly` / `renderBarChart` are never
 *     invoked (early-return).
 *   - Two-or-more-year corpus: hint is absent, selectors are enabled,
 *     `compareYearsMonthly` runs once, and the chart + chip render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Hoisted mock surfaces ----------
// Same pattern as tests/calculations-tracked-span-denominator.test.ts so the
// mock factories see these references at hoist time.
const {
  transactionsRef,
  transactionsByMonthRef,
  currencyRef,
  compareYearsMonthlyMock,
  getYearStatsMock,
  getAllTimeStatsMock,
  getDetailedYearStatsMock,
  renderBarChartMock,
  renderTrendChartMock,
} = vi.hoisted(() => ({
  transactionsRef: { value: [] as Array<{ date: string; amount: number; category: string; type: string }> },
  transactionsByMonthRef: { value: new Map<string, unknown[]>() },
  currencyRef: { value: { symbol: '$', code: 'USD' } },
  compareYearsMonthlyMock: vi.fn(),
  getYearStatsMock: vi.fn(),
  getAllTimeStatsMock: vi.fn(),
  getDetailedYearStatsMock: vi.fn(),
  renderBarChartMock: vi.fn(),
  renderTrendChartMock: vi.fn(),
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: transactionsRef,
  transactionsByMonth: transactionsByMonthRef,
  currency: currencyRef,
}));

// DOM.get delegates to document.getElementById so real jsdom nodes get
// returned — the behaviors under test (chart clearing, selector disabling)
// need genuine elements, not stub placeholders.
vi.mock('../js/modules/core/dom-cache.js', () => ({
  __esModule: true,
  default: {
    get: (id: string) => document.getElementById(id),
    clearAll: () => {},
  },
}));

// Intercept the calculations module so the test can assert non-invocation
// of `compareYearsMonthly` in the single-year branch. The real module has
// many exports; only the ones analytics-ui reaches for need implementations.
vi.mock('../js/modules/features/financial/calculations.js', () => ({
  compareYearsMonthly: compareYearsMonthlyMock,
  getYearStats: getYearStatsMock,
  getAllTimeStats: getAllTimeStatsMock,
  getDetailedYearStats: getDetailedYearStatsMock,
}));

vi.mock('../js/modules/ui/charts/chart-renderers.js', () => ({
  renderBarChart: renderBarChartMock,
  renderTrendChart: renderTrendChartMock,
  renderLineChart: vi.fn(),
  renderPieChart: vi.fn(),
  renderStackedBarChart: vi.fn(),
  renderSparkline: vi.fn(),
  renderTrendIndicator: vi.fn(),
  renderProgressRing: vi.fn(),
  renderDonut: vi.fn(),
  renderHeatmap: vi.fn(),
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  on: vi.fn(),
  emit: vi.fn(),
  createListenerGroup: vi.fn(() => 'mock-group'),
  destroyListenerGroup: vi.fn(),
}));

vi.mock('../js/modules/core/categories.js', () => ({
  getCatInfo: vi.fn(() => ({ id: 'food', name: 'Food', icon: 'utensils', color: '#ff0000' })),
}));

vi.mock('../js/modules/core/month-alloc.js', () => ({
  getMonthAlloc: vi.fn(() => ({ income: 0, expenses: 0, categoryTotals: {} })),
}));

vi.mock('../js/modules/core/monthly-totals-cache.js', () => ({
  __esModule: true,
  default: {
    calculate: vi.fn(() => ({ income: 0, expenses: 0, categoryTotals: {} })),
    invalidateAll: vi.fn(),
    invalidateMonth: vi.fn(),
  },
  calculateMonthlyTotalsWithCache: vi.fn(() => ({ income: 0, expenses: 0, categoryTotals: {} })),
  invalidateAllCache: vi.fn(),
  invalidateMonthCache: vi.fn(),
}));

vi.mock('../js/modules/core/di-container.js', () => ({
  getDefaultContainer: () => ({
    resolveSync: () => (v: number) => `$${Math.abs(v).toFixed(2)}`,
  }),
  Services: { CURRENCY_FORMATTER: 'CURRENCY_FORMATTER' },
}));

vi.mock('../js/modules/core/locale-service.js', () => ({
  formatMonthShort: (_mk: string) => 'Jan',
}));

vi.mock('./seasonal-analysis.js', () => ({
  analyzeSeasonalPatterns: vi.fn(),
}));

vi.mock('./trend-analysis.js', () => ({
  calculateCategoryTrends: vi.fn(),
  getTrendingCategories: vi.fn(),
}));

vi.mock('../js/modules/ui/charts/analytics-ui.js', () => ({
  renderMonthComparison: vi.fn(),
}));

import { populateYoYSection } from '../js/modules/features/analytics/analytics-ui.js';

// ---------- Shared DOM fixture ----------
// The YoY section chrome the module reaches for — container + two selects
// + chart canvas target. `yoy-comparison-content` is the `container`
// receiving the hint prepend and the lit-html `render()` call in the
// multi-year branch; `yoy-comparison-chart` is the bar chart canvas that
// must be cleared in the single-year branch.
function mountYoYDom(): void {
  document.body.innerHTML = `
    <div id="yoy-comparison-content"></div>
    <select id="yoy-year1"></select>
    <select id="yoy-year2"></select>
    <div id="yoy-comparison-chart"></div>
  `;
}

function seedTransactionsForYears(years: number[]): void {
  transactionsRef.value = years.map(y => ({
    date: `${y}-06-15`,
    amount: 100,
    category: 'food',
    type: 'expense',
  }));
}

describe('populateYoYSection — single-year gate (7a)', () => {
  beforeEach(() => {
    mountYoYDom();
    transactionsRef.value = [];
    transactionsByMonthRef.value = new Map();
    compareYearsMonthlyMock.mockReset();
    getYearStatsMock.mockReset();
    renderBarChartMock.mockReset();
    // Default return shapes so the two-year render path doesn't crash.
    getYearStatsMock.mockReturnValue({
      year: '2025',
      income: 1200,
      expenses: 800,
      savings: 400,
      avgMonthlyIncome: 100,
      avgMonthlyExpenses: 66.67,
      avgMonthlySavings: 33.33,
      topCategory: null,
      monthlyData: {},
      categoryBreakdown: {},
    });
    compareYearsMonthlyMock.mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({
        month: i,
        monthLabel: 'Jan',
        year1: { income: 100, expenses: 80 },
        year2: { income: 90, expenses: 70 },
      }))
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('single-year corpus: renders hint, disables selectors, skips compareYearsMonthly, clears chart', () => {
    seedTransactionsForYears([2025]);

    populateYoYSection();

    const container = document.getElementById('yoy-comparison-content');
    const year1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    const year2 = document.getElementById('yoy-year2') as HTMLSelectElement;
    const chart = document.getElementById('yoy-comparison-chart');

    // Hint is present with the expected copy.
    const hint = container?.querySelector('.yoy-hint');
    expect(hint).toBeTruthy();
    expect(hint?.textContent).toContain('second year');

    // Selectors are disabled — no meaningful action in the single-year case.
    expect(year1.disabled).toBe(true);
    expect(year2.disabled).toBe(true);

    // Both selects still got populated with the sole year as an option
    // (the option enumeration runs before the gate).
    expect(year1.options.length).toBe(1);
    expect(year1.options[0]?.value).toBe('2025');

    // `compareYearsMonthly` must NOT have been invoked — the whole point
    // of the gate is to avoid the degenerate year-vs-itself render.
    expect(compareYearsMonthlyMock).not.toHaveBeenCalled();
    expect(renderBarChartMock).not.toHaveBeenCalled();

    // Chart surface cleared — no stale lit-html nodes, no canvas children.
    expect(chart?.children.length).toBe(0);

    // Container should contain ONLY the hint (stats/chip block removed).
    const nonHintChildren = Array.from(container?.children ?? []).filter(
      el => !el.classList.contains('yoy-hint')
    );
    expect(nonHintChildren.length).toBe(0);
  });

  it('empty corpus: treats zero years as single-year-style (disabled), still no compareYearsMonthly call', () => {
    // Defensive coverage — an empty transactions array has yearOptions=[]
    // which also falls into the `< 2` branch. Must not crash and must not
    // call compareYearsMonthly.
    transactionsRef.value = [];

    populateYoYSection();

    const year1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    const year2 = document.getElementById('yoy-year2') as HTMLSelectElement;
    expect(year1.disabled).toBe(true);
    expect(year2.disabled).toBe(true);
    expect(compareYearsMonthlyMock).not.toHaveBeenCalled();
  });

  it('two-year corpus: enables selectors, removes hint, runs compareYearsMonthly exactly once', () => {
    seedTransactionsForYears([2025, 2024]);

    populateYoYSection();

    const container = document.getElementById('yoy-comparison-content');
    const year1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    const year2 = document.getElementById('yoy-year2') as HTMLSelectElement;

    // Hint is absent in the happy path.
    expect(container?.querySelector('.yoy-hint')).toBeNull();

    // Selectors enabled.
    expect(year1.disabled).toBe(false);
    expect(year2.disabled).toBe(false);

    // Both selectors populated with 2 options each.
    expect(year1.options.length).toBe(2);
    expect(year2.options.length).toBe(2);

    // Full YoY pipeline exercised.
    expect(compareYearsMonthlyMock).toHaveBeenCalledTimes(1);
    expect(renderBarChartMock).toHaveBeenCalledTimes(1);
  });

  it('re-enables selectors and clears a stale hint when the corpus grows from 1 year to 2', () => {
    // First render: single year → hint placed, selectors disabled.
    seedTransactionsForYears([2025]);
    populateYoYSection();

    const container = document.getElementById('yoy-comparison-content');
    expect(container?.querySelector('.yoy-hint')).toBeTruthy();

    // Second render: a second year arrived.
    seedTransactionsForYears([2025, 2024]);
    populateYoYSection();

    const year1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    const year2 = document.getElementById('yoy-year2') as HTMLSelectElement;

    expect(container?.querySelector('.yoy-hint')).toBeNull();
    expect(year1.disabled).toBe(false);
    expect(year2.disabled).toBe(false);
    expect(compareYearsMonthlyMock).toHaveBeenCalledTimes(1);
  });
});
