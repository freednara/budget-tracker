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
import { getMonthAlloc } from '../core/month-alloc.js';
// CR-Apr22-D slice 1 (finding 68 [P2]): donut and budget-vs-actual
// chart effects read category metadata (name, color, emoji) through
// `getCatInfo` — which in turn reads from the `userCategoryConfig`
// signal via the `indexedUserCategories` computed. Before this slice
// the mount effects did not touch `userCategoryConfig`, so a rename
// or recolor (or a preset switch) left the dashboard charts showing
// stale labels/colors until some unrelated signal (month tick, tx
// add, currency change) happened to wake the effect. Importing the
// signal here and reading it inside the relevant effects establishes
// the dep-track link that drives a re-render on every category
// metadata change.
import { userCategoryConfig } from '../core/category-store.js';
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
      const _cur = signals.currency.value;   // re-render on currency change
      const _month = signals.currentMonth.value;
      const _summaries = signals.monthSummaries.value;
      updateTrendChart();
    }));
  }

  if (donutContainer) {
    cleanups.push(effect(() => {
      const _cur = signals.currency.value;   // re-render on currency change
      const _month = signals.currentMonth.value;
      const _summary = signals.currentMonthSummary.value;
      // CR-Apr22-D slice 1: subscribe to category metadata so
      // renames / recolors / preset switches redraw the donut
      // immediately — `updateCategoryBreakdownChart` looks up
      // `getCatInfo('expense', catId)` per slice for label + color.
      const _cats = userCategoryConfig.value;
      updateCategoryBreakdownChart();
    }));
  }

  if (budgetActualContainer) {
    cleanups.push(effect(() => {
      const _cur = signals.currency.value;   // re-render on currency change
      const monthKey = signals.currentMonth.value;
      const _summary = signals.currentMonthSummary.value;
      // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces
      // `signals.monthlyAlloc.value[mk] || {}` — getMonthAlloc still reads
      // `monthlyAlloc.value` internally, so this effect stays subscribed to
      // allocation changes exactly as before. The underscore prefix marks
      // the dependency-read intent; return value is intentionally unused.
      const _alloc = getMonthAlloc(monthKey, signals.monthlyAlloc.value);
      // CR-Apr22-D slice 1: subscribe to category metadata so bar
      // labels (emoji + name prefix via `getCatInfo`) stay current
      // after a rename / recolor / preset switch.
      const _cats = userCategoryConfig.value;
      updateBudgetVsActualChart();
    }));
  }

  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}
