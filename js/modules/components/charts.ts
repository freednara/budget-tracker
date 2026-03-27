/**
 * Charts Component
 *
 * Reactive wrapper for dashboard charts (trend, donut, budget vs actual).
 * Automatically re-renders when transactions, month, or allocations change.
 *
 * @module components/charts
 */
'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import {
  updateTrendChart,
  updateCategoryBreakdownChart,
  updateBudgetVsActualChart
} from '../ui/core/ui-render.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive charts component
 * Watches transactions, currentMonth, and monthlyAlloc signals to auto-update charts
 * Returns cleanup function to dispose effects
 */
export function mountCharts(): () => void {
  const trendContainer = DOM.get('trend-chart-container');
  const donutContainer = DOM.get('donut-chart-container');
  const budgetActualContainer = DOM.get('budget-actual-chart');

  // If no chart containers exist, no cleanup needed
  if (!trendContainer && !donutContainer && !budgetActualContainer) {
    return () => {};
  }

  const cleanups: Array<() => void> = [];

  if (trendContainer) {
    cleanups.push(effect(() => {
      const _month = signals.currentMonth.value;
      const _summaries = signals.monthSummaries.value;
      updateTrendChart();
    }));
  }

  if (donutContainer) {
    cleanups.push(effect(() => {
      const _month = signals.currentMonth.value;
      const _summary = signals.currentMonthSummary.value;
      updateCategoryBreakdownChart();
    }));
  }

  if (budgetActualContainer) {
    cleanups.push(effect(() => {
      const monthKey = signals.currentMonth.value;
      const _summary = signals.currentMonthSummary.value;
      const _alloc = signals.monthlyAlloc.value[monthKey] || {};
      updateBudgetVsActualChart();
    }));
  }

  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}
