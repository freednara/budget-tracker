/**
 * Analytics Scoped Re-renders — YoY + Trend-Period Selectors
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * the YoY year selectors and the trend-period selector must trigger a
 * **scoped** re-render of just the affected sections, not a full
 * `renderAnalyticsModal()` that re-paints all 8 sections of the modal.
 *
 * Pre-fix: every `change` event on `yoy-year1`, `yoy-year2`, or
 * `trend-period-select` fired `renderAnalyticsModal` directly. A single
 * dropdown change triggered re-runs of `populateYearSummary`,
 * `populateTrendChart`, `populateYoYSection`, `populateSeasonalSection`,
 * `populateCategoryTrendsSection`, `populateMovedDashboardSections`,
 * `populateAllTimeStats`, AND re-attached every event listener under the
 * modal. Heavy SVG re-paint, focus risk, and unrelated-side-effect surface
 * for an action that only affected one or three sections.
 *
 * Post-fix:
 *   - YoY change → only `populateYoYSection` runs (only `compareYearsMonthly`
 *     fires from the calculations module, etc.)
 *   - Trend-period change → only `syncPeriodScopedSectionChrome` +
 *     `populateTrendChart` + `populateCategoryTrendsSection` run
 *     (`renderTrendChart` + `calculateCategoryTrends` fire; seasonal,
 *     moved-dashboard, all-time stats DO NOT)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  transactionsRef,
  transactionsByMonthRef,
  monthSummariesRef,
  emptyMonthSummary,
  currencyRef,
  currentMonthRef,
  // Calculations
  compareYearsMonthlyMock,
  getYearStatsMock,
  getAllTimeStatsMock,
  getDetailedYearStatsMock,
  // Charts
  renderTrendChartMock,
  renderBarChartMock,
  // Trend / seasonal modules
  analyzeSeasonalPatternsMock,
  calculateCategoryTrendsMock,
  getTrendingCategoriesMock,
  // Moved-dashboard sections (renderMonthComparison, allocations, etc.)
  renderMonthComparisonMock,
} = vi.hoisted(() => ({
  transactionsRef: { value: [] as Array<{ date: string; amount: number; category: string; type: string }> },
  transactionsByMonthRef: { value: new Map<string, unknown[]>() },
  monthSummariesRef: { value: {} as Record<string, { income: number; expenses: number }> },
  emptyMonthSummary: { income: 0, expenses: 0 },
  currencyRef: { value: { symbol: '$', code: 'USD' } },
  currentMonthRef: { value: '2026-04' },
  compareYearsMonthlyMock: vi.fn(),
  getYearStatsMock: vi.fn(),
  getAllTimeStatsMock: vi.fn(),
  getDetailedYearStatsMock: vi.fn(),
  renderTrendChartMock: vi.fn().mockResolvedValue(undefined),
  renderBarChartMock: vi.fn(),
  analyzeSeasonalPatternsMock: vi.fn(),
  calculateCategoryTrendsMock: vi.fn(),
  getTrendingCategoriesMock: vi.fn(),
  renderMonthComparisonMock: vi.fn(),
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: transactionsRef,
  transactionsByMonth: transactionsByMonthRef,
  monthSummaries: monthSummariesRef,
  EMPTY_MONTH_SUMMARY: emptyMonthSummary,
  currency: currencyRef,
  currentMonth: currentMonthRef,
  monthlyAlloc: { value: {} },
  rolloverSettings: { value: { enabled: false, mode: 'all', maxRollover: null, negativeHandling: 'zero' } },
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  __esModule: true,
  default: {
    get: (id: string) => document.getElementById(id),
    clearAll: () => {},
  },
  STATIC_ELEMENT_IDS: [],
}));

vi.mock('../js/modules/features/financial/calculations.js', () => ({
  compareYearsMonthly: compareYearsMonthlyMock,
  getYearStats: getYearStatsMock,
  getAllTimeStats: getAllTimeStatsMock,
  getDetailedYearStats: getDetailedYearStatsMock,
}));

vi.mock('../js/modules/ui/charts/chart-renderers.js', () => ({
  renderTrendChart: renderTrendChartMock,
  renderBarChart: renderBarChartMock,
  renderLineChart: vi.fn(),
  renderPieChart: vi.fn(),
  renderStackedBarChart: vi.fn(),
  renderSparkline: vi.fn(),
  renderTrendIndicator: vi.fn(),
  renderProgressRing: vi.fn(),
  renderDonut: vi.fn(),
  renderHeatmap: vi.fn(),
}));

vi.mock('../js/modules/features/analytics/seasonal-analysis.js', () => ({
  analyzeSeasonalPatterns: analyzeSeasonalPatternsMock,
}));

vi.mock('../js/modules/features/analytics/trend-analysis.js', () => ({
  calculateCategoryTrends: calculateCategoryTrendsMock,
  getTrendingCategories: getTrendingCategoriesMock,
}));

vi.mock('../js/modules/ui/charts/analytics-ui.js', () => ({
  renderMonthComparison: renderMonthComparisonMock,
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

// Empty allocations map → `populateBudgetVsActualSection` short-circuits on
// `categories.length === 0` and hides the section. This test is about
// scoped re-renders of YoY / trend / category, not budget-vs-actual, so we
// deliberately take the no-op path.
vi.mock('../js/modules/core/month-alloc.js', () => ({
  getMonthAlloc: vi.fn(() => ({})),
}));

vi.mock('../js/modules/core/monthly-totals-cache.js', () => ({
  __esModule: true,
  default: { calculate: vi.fn(() => ({ income: 0, expenses: 0, categoryTotals: {} })), invalidateAll: vi.fn(), invalidateMonth: vi.fn() },
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
  formatMonthShort: () => 'Jan',
}));

import {
  renderAnalyticsModal,
  setAnalyticsCurrentPeriod,
} from '../js/modules/features/analytics/analytics-ui.js';

/**
 * Mount the analytics modal DOM the populate fns reach for. Each
 * populate fn early-returns if its primary container is missing, so
 * mounting all of them keeps the test exercising the full surface
 * without forcing each populate to short-circuit.
 */
function mountAnalyticsModalDom(): void {
  document.body.innerHTML = `
    <div id="analytics-modal">
      <div id="analytics-period-tabs"></div>

      <h2 id="analytics-trend-title"></h2>
      <h2 id="analytics-seasonal-title"></h2>
      <h2 id="analytics-category-title"></h2>
      <section id="analytics-alltime-section">
        <div id="alltime-stats-content"></div>
      </section>

      <select id="trend-period-select">
        <option value="3">3</option>
        <option value="6">6</option>
        <option value="12" selected>12</option>
      </select>

      <div id="year-summary-content"></div>
      <div id="analytics-trend-chart"></div>

      <div id="yoy-comparison-content"></div>
      <select id="yoy-year1"></select>
      <select id="yoy-year2"></select>
      <div id="yoy-comparison-chart"></div>

      <div id="seasonal-pattern-chart"></div>
      <div id="seasonal-insights"></div>

      <div id="growing-categories"></div>
      <div id="shrinking-categories"></div>
      <div id="category-trends-chart"></div>

      <section id="budget-vs-actual-section"></section>
      <span id="budget-actual-badge"></span>
    </div>
  `;
}

describe('Analytics scoped re-renders (7a)', () => {
  beforeEach(() => {
    mountAnalyticsModalDom();
    transactionsRef.value = [
      { date: '2025-06-15', amount: 100, category: 'food', type: 'expense' },
      { date: '2024-06-15', amount: 80, category: 'food', type: 'expense' },
    ];
    setAnalyticsCurrentPeriod('all-time');

    // Default returns so populates don't crash on first render.
    getAllTimeStatsMock.mockReturnValue({
      totalIncome: 1000,
      totalExpenses: 800,
      avgMonthlySpend: 50,
      monthsTracked: 16,
    });
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
    getDetailedYearStatsMock.mockReturnValue({});
    compareYearsMonthlyMock.mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({
        month: i,
        monthLabel: 'Jan',
        year1: { income: 100, expenses: 80 },
        year2: { income: 90, expenses: 70 },
      }))
    );
    analyzeSeasonalPatternsMock.mockReturnValue({
      patterns: [{ season: 'Spring', totalSpent: 100, transactionCount: 1 }],
      insights: [],
    });
    calculateCategoryTrendsMock.mockReturnValue({
      trends: [],
      summary: { growing: [], shrinking: [], stable: [] },
    });
    getTrendingCategoriesMock.mockReturnValue({ increasing: [], decreasing: [] });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('YoY selector change → only YoY pipeline re-runs (no seasonal / category-trends / all-time / month-comparison)', () => {
    // First: full initial render to attach listeners.
    renderAnalyticsModal();
    // Reset all the spies so the change-event-driven re-render is visible
    // on its own.
    compareYearsMonthlyMock.mockClear();
    analyzeSeasonalPatternsMock.mockClear();
    calculateCategoryTrendsMock.mockClear();
    getAllTimeStatsMock.mockClear();
    renderTrendChartMock.mockClear();
    renderMonthComparisonMock.mockClear();
    getDetailedYearStatsMock.mockClear();

    // Trigger a YoY change.
    const y1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    y1.dispatchEvent(new Event('change'));

    // The YoY pipeline ran (populateYoYSection → compareYearsMonthly).
    expect(compareYearsMonthlyMock).toHaveBeenCalledTimes(1);

    // The other section pipelines DID NOT.
    expect(analyzeSeasonalPatternsMock).not.toHaveBeenCalled();
    expect(calculateCategoryTrendsMock).not.toHaveBeenCalled();
    expect(getAllTimeStatsMock).not.toHaveBeenCalled();
    expect(renderTrendChartMock).not.toHaveBeenCalled();
    expect(renderMonthComparisonMock).not.toHaveBeenCalled();
    expect(getDetailedYearStatsMock).not.toHaveBeenCalled();
  });

  it('Trend-period change → only trend chrome + trend chart + category trends re-run (no YoY / seasonal / all-time / month-comparison)', () => {
    // Initial render attaches listeners.
    renderAnalyticsModal();
    compareYearsMonthlyMock.mockClear();
    analyzeSeasonalPatternsMock.mockClear();
    calculateCategoryTrendsMock.mockClear();
    getAllTimeStatsMock.mockClear();
    renderTrendChartMock.mockClear();
    renderMonthComparisonMock.mockClear();
    getDetailedYearStatsMock.mockClear();

    // Trigger a trend-period change.
    const trendSelect = document.getElementById('trend-period-select') as HTMLSelectElement;
    trendSelect.value = '6';
    trendSelect.dispatchEvent(new Event('change'));

    // Trend chart re-rendered with the new selector value.
    expect(renderTrendChartMock).toHaveBeenCalledTimes(1);
    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 6);
    // Category trends recomputed.
    expect(calculateCategoryTrendsMock).toHaveBeenCalledTimes(1);

    // Other sections NOT re-rendered.
    expect(compareYearsMonthlyMock).not.toHaveBeenCalled();
    expect(analyzeSeasonalPatternsMock).not.toHaveBeenCalled();
    expect(getAllTimeStatsMock).not.toHaveBeenCalled();
    expect(renderMonthComparisonMock).not.toHaveBeenCalled();
    expect(getDetailedYearStatsMock).not.toHaveBeenCalled();
  });

  it('Re-attaching listeners on subsequent renderAnalyticsModal calls is idempotent (no double-fire)', () => {
    // Render twice — pre-fix this still worked because both calls used the
    // same `renderAnalyticsModal` reference for add+remove. Verify the
    // module-scope handler refs (`handleYoYChange` / `handleTrendPeriodChange`)
    // preserve that property.
    renderAnalyticsModal();
    renderAnalyticsModal();
    compareYearsMonthlyMock.mockClear();

    const y1 = document.getElementById('yoy-year1') as HTMLSelectElement;
    y1.dispatchEvent(new Event('change'));

    // Exactly one YoY re-render, not two — the second renderAnalyticsModal
    // didn't double-bind the listener.
    expect(compareYearsMonthlyMock).toHaveBeenCalledTimes(1);
  });
});
