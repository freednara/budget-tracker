import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CR-Apr22-D slice 1 coverage — Dashboard chart effects subscribe to
 * category config (finding 68, `[P2]`).
 *
 * Before this slice the three `mountCharts` effects read currency,
 * currentMonth, current-month summary, and allocations but NEVER read
 * `userCategoryConfig.value`. That signal is the source of truth for
 * category names, colors, and emojis — every downstream chart label and
 * swatch ultimately comes from `getCatInfo(...)`, which pipes through the
 * `indexedUserCategories` computed rooted in `userCategoryConfig`.
 *
 * The failure mode: rename "Food" → "Groceries", or recolor it, and the
 * donut legend + budget-vs-actual bar labels kept showing the OLD values
 * until some unrelated signal (month tick, tx edit, currency switch)
 * happened to wake the effect and pull a fresh category snapshot.
 * Subscription was only incidental — the effect only saw category config
 * if the empty-state short-circuit didn't trip AND the function body
 * happened to call `getCatInfo` during that pass.
 *
 * The fix: each of the donut and budget-vs-actual effects explicitly
 * reads `userCategoryConfig.value` at the top of the effect body, which
 * establishes a permanent dep-track edge. These tests lock that contract
 * by mocking the two `update*` ui-render functions and asserting every
 * category-metadata mutation re-invokes them.
 *
 * The trend chart effect is intentionally NOT category-reactive — it
 * plots aggregate income/expense per month and never touches category
 * metadata. Adding an unnecessary dep would cost a re-render per rename.
 */

// Hoisted mocks so `vi.mock` can see them before the module graph loads.
// Each of these captures a call per re-run of the corresponding effect.
const uiRenderMocks = vi.hoisted(() => ({
  updateTrendChart: vi.fn(),
  updateCategoryBreakdownChart: vi.fn(),
  updateBudgetVsActualChart: vi.fn()
}));

vi.mock('../js/modules/ui/core/ui-render.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/ui/core/ui-render.js')>(
    '../js/modules/ui/core/ui-render.js'
  );
  return {
    ...actual,
    updateTrendChart: uiRenderMocks.updateTrendChart,
    updateCategoryBreakdownChart: uiRenderMocks.updateCategoryBreakdownChart,
    updateBudgetVsActualChart: uiRenderMocks.updateBudgetVsActualChart
  };
});

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { mountCharts } from '../js/modules/components/charts.js';
import {
  addCategory,
  applyPreset,
  updateCategory,
  userCategoryConfig
} from '../js/modules/core/category-store.js';
import type { UserCategoryConfig } from '../js/types/index.js';

function seedConfig(): UserCategoryConfig {
  return {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#ff6b6b', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#4dabf7', type: 'expense', order: 1 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#51cf66', type: 'income', order: 0 }
    ]
  };
}

function seedDom(): void {
  document.body.innerHTML = `
    <div id="trend-chart-container"></div>
    <div id="donut-chart-container"></div>
    <div id="budget-actual-chart"></div>
  `;
  DOM.clearAll();
}

describe('mountCharts — category reactivity (CR-Apr22-D slice 1)', () => {
  const originalConfig = userCategoryConfig.value;
  const originalMonth = signals.currentMonth.value;
  const originalAlloc = signals.monthlyAlloc.value;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    seedDom();
    uiRenderMocks.updateTrendChart.mockReset();
    uiRenderMocks.updateCategoryBreakdownChart.mockReset();
    uiRenderMocks.updateBudgetVsActualChart.mockReset();
    signals.currentMonth.value = '2026-04';
    signals.monthlyAlloc.value = { '2026-04': { food: 400, transport: 150 } };
    userCategoryConfig.value = seedConfig();
  });

  afterEach(() => {
    if (cleanup) {
      try { cleanup(); } catch { /* swallow */ }
      cleanup = null;
    }
    userCategoryConfig.value = originalConfig;
    signals.currentMonth.value = originalMonth;
    signals.monthlyAlloc.value = originalAlloc;
    DOM.clearAll();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('mounts with exactly one initial call per chart effect', () => {
    cleanup = mountCharts();

    // Each effect body runs synchronously on mount — one initial call each.
    expect(uiRenderMocks.updateTrendChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
  });

  it('re-runs the donut + BvA effects when a category is RENAMED', () => {
    cleanup = mountCharts();
    uiRenderMocks.updateTrendChart.mockClear();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();

    updateCategory('food', { name: 'Groceries' });

    // Both category-aware effects must re-run exactly once on a rename —
    // that's the regression lock. Trend chart is intentionally inert.
    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateTrendChart).toHaveBeenCalledTimes(0);
  });

  it('re-runs the donut + BvA effects when a category is RECOLORED', () => {
    cleanup = mountCharts();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();
    uiRenderMocks.updateTrendChart.mockClear();

    updateCategory('food', { color: '#000000' });

    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateTrendChart).toHaveBeenCalledTimes(0);
  });

  it('re-runs the donut + BvA effects when a category EMOJI changes', () => {
    cleanup = mountCharts();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();

    updateCategory('food', { emoji: '🥗' });

    // BvA labels are `emoji + ' ' + name.split(' ')[0]` — the emoji change
    // alters the rendered label and must trigger a re-render.
    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
  });

  it('re-runs the category-aware effects when a new category is ADDED', () => {
    cleanup = mountCharts();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();

    addCategory({ name: 'Entertainment', emoji: '🎮', color: '#ff922b', type: 'expense' });

    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
  });

  it('re-runs the category-aware effects on a PRESET SWITCH', () => {
    cleanup = mountCharts();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();

    applyPreset('business');

    // `applyPreset` replaces the whole config — one re-run per effect
    // (signal-batcher collapses duplicate schedules).
    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalled();
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalled();
  });

  it('still re-renders after rename even when the chart starts in EMPTY state', () => {
    // Reproduces the pre-fix failure mode: when the donut container is
    // empty on initial mount (no allocations, no transactions, no data
    // rows), the prior implementation's incidental subscription through
    // `getCatInfo` was never established — the empty-state branch short-
    // circuits before reaching any category read. Explicitly subscribing
    // to `userCategoryConfig` at the top of the effect ensures the
    // dep-track edge is registered regardless of render-path taken.
    signals.monthlyAlloc.value = {}; // empty — BvA returns early
    userCategoryConfig.value = {
      ...seedConfig(),
      expense: [], // empty — donut has no slices
      income: []
    };

    cleanup = mountCharts();
    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();

    // Rename a (non-existent, but the signal still flips).
    userCategoryConfig.value = {
      ...seedConfig(),
      expense: [
        { id: 'food', name: 'Renamed Food', emoji: '🍔', color: '#ff6b6b', type: 'expense', order: 0 }
      ]
    };

    expect(uiRenderMocks.updateCategoryBreakdownChart).toHaveBeenCalledTimes(1);
    expect(uiRenderMocks.updateBudgetVsActualChart).toHaveBeenCalledTimes(1);
  });

  it('cleanup disposes all three effects so further signal changes are silent', () => {
    cleanup = mountCharts();
    cleanup();
    cleanup = null;

    uiRenderMocks.updateCategoryBreakdownChart.mockClear();
    uiRenderMocks.updateBudgetVsActualChart.mockClear();
    uiRenderMocks.updateTrendChart.mockClear();

    updateCategory('food', { name: 'Disposed' });

    expect(uiRenderMocks.updateCategoryBreakdownChart).not.toHaveBeenCalled();
    expect(uiRenderMocks.updateBudgetVsActualChart).not.toHaveBeenCalled();
    expect(uiRenderMocks.updateTrendChart).not.toHaveBeenCalled();
  });

  it('when no chart containers exist, mountCharts is a no-op (no effects subscribed)', () => {
    // Strip the DOM so the `!trendContainer && !donutContainer && !budgetActualContainer`
    // branch is taken — mountCharts returns a no-op cleanup without registering effects.
    document.body.innerHTML = '';
    DOM.clearAll();

    cleanup = mountCharts();

    updateCategory('food', { name: 'Anything' });

    expect(uiRenderMocks.updateCategoryBreakdownChart).not.toHaveBeenCalled();
    expect(uiRenderMocks.updateBudgetVsActualChart).not.toHaveBeenCalled();
    expect(uiRenderMocks.updateTrendChart).not.toHaveBeenCalled();
  });
});
