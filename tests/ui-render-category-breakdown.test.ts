import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chartRenderersMocks = vi.hoisted(() => ({
  renderDonutChart: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  calculateCategoryTrends: vi.fn()
}));

vi.mock('../js/modules/ui/charts/chart-renderers.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/ui/charts/chart-renderers.js')>(
    '../js/modules/ui/charts/chart-renderers.js'
  );
  return {
    ...actual,
    renderDonutChart: chartRenderersMocks.renderDonutChart
  };
});

vi.mock('../js/modules/features/analytics/trend-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/features/analytics/trend-analysis.js')>(
    '../js/modules/features/analytics/trend-analysis.js'
  );
  return {
    ...actual,
    calculateCategoryTrends: analyticsMocks.calculateCategoryTrends
  };
});

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { replaceTransactionLedger } from '../js/modules/core/signals.js';
import { updateCategoryBreakdownChart } from '../js/modules/ui/core/ui-render.js';
import { createExpenseTransaction } from './test-data-factory.js';

describe('ui-render category breakdown trends', () => {
  const originalTransactions = signals.transactions.value;
  const originalCurrentMonth = signals.currentMonth.value;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="donut-chart-container"></div>
      <span id="category-breakdown-badge"></span>
    `;

    DOM.clearAll();
    chartRenderersMocks.renderDonutChart.mockReset();
    analyticsMocks.calculateCategoryTrends.mockReset();

    signals.currentMonth.value = '2026-03';
    replaceTransactionLedger([
      createExpenseTransaction({ __backendId: 'tx-food', category: 'food', amount: 107.2354984551469, date: '2026-03-03' }),
      createExpenseTransaction({ __backendId: 'tx-transport', category: 'transport', amount: 82.49, date: '2026-03-04' }),
      createExpenseTransaction({ __backendId: 'tx-shopping', category: 'shopping', amount: 99.99, date: '2026-03-05' }),
      createExpenseTransaction({ __backendId: 'tx-bills', category: 'bills', amount: 10, date: '2026-03-06' })
    ]);
  });

  afterEach(() => {
    replaceTransactionLedger(originalTransactions);
    signals.currentMonth.value = originalCurrentMonth;
    DOM.clearAll();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('rounds dashboard category trend percentages before rendering the donut legend', () => {
    analyticsMocks.calculateCategoryTrends.mockReturnValue({
      trends: [
        {
          category: { id: 'food' },
          monthlyData: [
            { month: '2026-02', amount: 100 },
            { month: '2026-03', amount: 107.2354984551469 }
          ]
        },
        {
          category: { id: 'transport' },
          monthlyData: [
            { month: '2026-02', amount: 100 },
            { month: '2026-03', amount: 82.49 }
          ]
        },
        {
          category: { id: 'shopping' },
          monthlyData: [
            { month: '2026-02', amount: 100 },
            { month: '2026-03', amount: 99.99 }
          ]
        },
        {
          category: { id: 'bills' },
          monthlyData: [
            { month: '2026-02', amount: 0 },
            { month: '2026-03', amount: 10 }
          ]
        },
        {
          category: { id: 'entertainment' },
          monthlyData: [
            { month: '2026-02', amount: 0 },
            { month: '2026-03', amount: 0 }
          ]
        }
      ]
    });

    updateCategoryBreakdownChart();

    expect(chartRenderersMocks.renderDonutChart).toHaveBeenCalledOnce();
    const [, , donutTrends] = chartRenderersMocks.renderDonutChart.mock.calls[0] as [
      string,
      Array<{ catId: string; label: string; value: number; color: string }>,
      Record<string, { change: number; direction: 'up' | 'down' | 'flat' | 'new' }>
    ];

    expect(donutTrends.food).toEqual({ change: 7, direction: 'up' });
    expect(donutTrends.transport).toEqual({ change: 18, direction: 'down' });
    expect(donutTrends.shopping).toEqual({ change: 0, direction: 'down' });
    expect(donutTrends.bills).toEqual({ change: 100, direction: 'new' });
    expect(donutTrends.entertainment).toEqual({ change: 0, direction: 'flat' });
  });
});
