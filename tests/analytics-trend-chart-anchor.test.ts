/**
 * Trend Chart Anchor — Selector-Threaded Month Count
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * the all-time trend chart at the top of the analytics modal must read the
 * trend-period selector and pass that value as `renderTrendChart`'s
 * `monthCount` argument. Pre-fix the call was hardcoded `12`, so when the
 * user switched the dropdown to 3 or 6 the section heading updated to
 * "RECENT 6-MONTH TREND" but the chart underneath stayed 12 months wide —
 * a desync that the section-titles slice (shipped earlier the same day)
 * inadvertently exposed.
 *
 * Coverage:
 *   1. `resolveTrendMonths` pure helper — every branch (year, all-time +
 *      valid 3/6/12, all-time + empty/undefined fallback, all-time +
 *      non-numeric fallback, all-time + non-positive fallback).
 *   2. `populateTrendChart` integration — the all-time branch passes the
 *      selector value to `renderTrendChart`; year-scoped renders bypass
 *      `renderTrendChart` entirely (year branch uses `renderBarChart` over
 *      `getDetailedYearStats`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Hoisted mock surfaces ----------
const {
  transactionsRef,
  transactionsByMonthRef,
  currencyRef,
  renderTrendChartMock,
  renderBarChartMock,
  getDetailedYearStatsMock,
} = vi.hoisted(() => ({
  transactionsRef: { value: [] as unknown[] },
  transactionsByMonthRef: { value: new Map<string, unknown[]>() },
  currencyRef: { value: { symbol: '$', code: 'USD' } },
  renderTrendChartMock: vi.fn().mockResolvedValue(undefined),
  renderBarChartMock: vi.fn(),
  getDetailedYearStatsMock: vi.fn(() => ({})),
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: transactionsRef,
  transactionsByMonth: transactionsByMonthRef,
  currency: currencyRef,
}));

// DOM.get → real document.getElementById so the helper sees the
// `<select id="trend-period-select">` we mount in beforeEach.
vi.mock('../js/modules/core/dom-cache.js', () => ({
  __esModule: true,
  default: {
    get: (id: string) => document.getElementById(id),
    clearAll: () => {},
  },
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

vi.mock('../js/modules/features/financial/calculations.js', () => ({
  getYearStats: vi.fn(),
  getAllTimeStats: vi.fn(),
  compareYearsMonthly: vi.fn(),
  getDetailedYearStats: getDetailedYearStatsMock,
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
  default: { calculate: vi.fn(), invalidateAll: vi.fn(), invalidateMonth: vi.fn() },
  calculateMonthlyTotalsWithCache: vi.fn(),
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

import {
  resolveTrendMonths,
  populateTrendChart,
  setAnalyticsCurrentPeriod,
} from '../js/modules/features/analytics/analytics-ui.js';

// ---------- Pure helper coverage ----------

describe('resolveTrendMonths (7a shared helper)', () => {
  it('year-scoped period: always 12 (selector is disabled in this branch)', () => {
    expect(resolveTrendMonths('2025', '3')).toBe(12);
    expect(resolveTrendMonths('2024', '6')).toBe(12);
    expect(resolveTrendMonths('2023', undefined)).toBe(12);
  });

  it('all-time period: returns the parsed selector value', () => {
    expect(resolveTrendMonths('all-time', '3')).toBe(3);
    expect(resolveTrendMonths('all-time', '6')).toBe(6);
    expect(resolveTrendMonths('all-time', '12')).toBe(12);
  });

  it('all-time period: empty/undefined select value falls back to 12', () => {
    expect(resolveTrendMonths('all-time', '')).toBe(12);
    expect(resolveTrendMonths('all-time', undefined)).toBe(12);
  });

  it('all-time period: non-numeric / non-positive select value falls back to 12', () => {
    expect(resolveTrendMonths('all-time', 'abc')).toBe(12);
    expect(resolveTrendMonths('all-time', '0')).toBe(12);
    expect(resolveTrendMonths('all-time', '-3')).toBe(12);
  });
});

// ---------- Trend-chart integration coverage ----------

function mountTrendDom(selectValue?: string): void {
  document.body.innerHTML = `
    <div id="analytics-trend-chart"></div>
    <select id="trend-period-select">
      <option value="3">3</option>
      <option value="6">6</option>
      <option value="12">12</option>
    </select>
  `;
  if (selectValue !== undefined) {
    const select = document.getElementById('trend-period-select') as HTMLSelectElement;
    select.value = selectValue;
  }
}

describe('populateTrendChart — selector-threaded monthCount (7a)', () => {
  beforeEach(() => {
    renderTrendChartMock.mockClear();
    renderBarChartMock.mockClear();
    getDetailedYearStatsMock.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('all-time + 12 selector: passes 12 as monthCount (preserves pre-fix default)', () => {
    setAnalyticsCurrentPeriod('all-time');
    mountTrendDom('12');

    populateTrendChart();

    expect(renderTrendChartMock).toHaveBeenCalledTimes(1);
    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 12);
    expect(renderBarChartMock).not.toHaveBeenCalled();
  });

  it('all-time + 6 selector: passes 6 as monthCount (was stuck at 12 pre-fix)', () => {
    setAnalyticsCurrentPeriod('all-time');
    mountTrendDom('6');

    populateTrendChart();

    expect(renderTrendChartMock).toHaveBeenCalledTimes(1);
    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 6);
  });

  it('all-time + 3 selector: passes 3 as monthCount (was stuck at 12 pre-fix)', () => {
    setAnalyticsCurrentPeriod('all-time');
    mountTrendDom('3');

    populateTrendChart();

    expect(renderTrendChartMock).toHaveBeenCalledTimes(1);
    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 3);
  });

  it('all-time + missing selector: defaults to 12 (no NaN propagation)', () => {
    setAnalyticsCurrentPeriod('all-time');
    document.body.innerHTML = `<div id="analytics-trend-chart"></div>`;
    // Note: no <select id="trend-period-select"> — DOM.get returns null,
    // resolveTrendMonths sees `undefined` value → falls back to 12.

    populateTrendChart();

    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 12);
  });

  it('all-time + poisoned non-numeric selector: defaults to 12 (no NaN propagation)', () => {
    setAnalyticsCurrentPeriod('all-time');
    document.body.innerHTML = `
      <div id="analytics-trend-chart"></div>
      <select id="trend-period-select"><option value="abc" selected>abc</option></select>
    `;

    populateTrendChart();

    expect(renderTrendChartMock).toHaveBeenCalledWith('analytics-trend-chart', 12);
  });

  it('year-scoped period: bypasses renderTrendChart entirely (uses renderBarChart over year stats)', () => {
    setAnalyticsCurrentPeriod('2025');
    mountTrendDom('6'); // selector value irrelevant in year branch
    getDetailedYearStatsMock.mockReturnValueOnce({
      '2025-01': { income: 100, expenses: 80 },
      '2025-02': { income: 110, expenses: 90 },
    });

    populateTrendChart();

    expect(renderTrendChartMock).not.toHaveBeenCalled();
    expect(renderBarChartMock).toHaveBeenCalledTimes(1);
    expect(getDetailedYearStatsMock).toHaveBeenCalledWith('2025');
  });
});
