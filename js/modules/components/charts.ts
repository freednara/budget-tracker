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
import { updateCharts as updateChartsImpl } from '../ui/core/ui-render.js';
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

  // If no chart containers exist, no cleanup needed
  if (!trendContainer && !donutContainer) {
    return () => {};
  }

  const cleanup = effect(() => {
    // Read signals to establish dependency tracking
    const _month = signals.currentMonth.value;
    const _txCount = signals.transactions.value.length;
    const _alloc = signals.monthlyAlloc.value;

    // Re-render charts when any of these signals change
    updateChartsImpl();
  });

  return cleanup;
}
