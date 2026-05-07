/**
 * Summary Cards Component
 *
 * Reactive component that updates income/expenses/balance summary cards
 * when underlying signals change. Uses Preact Signals effects for
 * automatic DOM updates.
 *
 * @module components/summary-cards
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, styleMap } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';
import { fmtCur, getPrevMonthKey } from '../core/utils-pure.js';
import { getEffectiveIncome } from '../features/financial/calculations.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from '../core/monthly-totals-cache.js';
// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// route the income/expense month-over-month computeds through
// `computeBaselineDelta` to unify the baseline-classification story
// across summary-cards, donut legend, and category trends. The previous
// inline `previous === 0 return null` shortcut was functionally
// equivalent for the UX layer (both 'new' and 'no-data' collapse to
// "hide the chip") but diverged architecturally from the rest of the
// 7a arc. Slice 12 routes both computeds through the helper so any
// future UX decision to surface "new this month" as a first-class chip
// can flip at a single site rather than re-deriving `previous === 0`
// in two places.
import { computeBaselineDelta } from '../core/baseline.js';
import DOM from '../core/dom-cache.js';
import { animateValue as animateValueById } from '../orchestration/dashboard-animations.js';

// ==========================================
// COMPUTED SIGNALS FOR TRENDS
// ==========================================

/**
 * Previous month totals for trend comparison
 */
const prevMonthData = computed(() => {
  const currentMk = signals.currentMonth.value;
  const prevMk = getPrevMonthKey(currentMk);
  // Use cached totals (O(1) cache hit) instead of scanning all transactions O(N)
  const cached = calculateMonthlyTotalsWithCache(prevMk);
  return { income: cached.income, expenses: cached.expenses };
});

/**
 * Income trend percentage
 *
 * 7a (Inline-Behavior-Review, summary-cards baseline-helper parity):
 * routed through `computeBaselineDelta`. 'new' and 'no-data' baseline
 * statuses both collapse to null (same as the prior `previous === 0`
 * short-circuit) — current UX hides the chip entirely on degenerate
 * baselines rather than surfacing "new this month". If that UX
 * decision ever changes, flip at this single site rather than
 * re-deriving the baseline check inline.
 */
const incomeTrend = computed(() => {
  // CR-Apr22-E slice 5 [P3]: `getRecurringIncome()` was a no-op. It
  // returned `getEffectiveIncome(mk) - currentMonthTotals.income`, but
  // `getEffectiveIncome(mk)` IS `sumByType(getMonthTx(mk), 'income')` —
  // i.e. the same sum that feeds `currentMonthTotals.income`. The delta
  // was therefore always 0 (modulo floating-point noise). Removing the
  // helper eliminates the dead code and tightens the subscription edge
  // (the computed no longer incidentally depends on whatever internals
  // `getEffectiveIncome` reads). The displayed "income" value in the
  // header card still uses `getEffectiveIncome` inside the mount
  // effect, preserving pre-existing rendering semantics — this fix
  // only corrects the trend-baseline computation.
  const current = signals.currentMonthTotals.value.income;
  const previous = prevMonthData.value.income;
  const baseline = computeBaselineDelta(current, previous);
  if (baseline.status !== 'comparable' || baseline.percent === null) return null;
  const pctChange = Math.round(baseline.percent);
  if (pctChange === 0) return null;
  return { pctChange, isUp: pctChange > 0, isGood: pctChange > 0 };
});

/**
 * Expense trend percentage
 *
 * 7a (Inline-Behavior-Review, summary-cards baseline-helper parity):
 * same baseline-helper routing as `incomeTrend`. `isGood = !isUp`
 * preserves the expense-specific inversion (lower expenses = positive
 * for the user).
 */
const expenseTrend = computed(() => {
  const current = signals.currentMonthTotals.value.expenses;
  const previous = prevMonthData.value.expenses;
  const baseline = computeBaselineDelta(current, previous);
  if (baseline.status !== 'comparable' || baseline.percent === null) return null;
  const pctChange = Math.round(baseline.percent);
  if (pctChange === 0) return null;
  const isUp = pctChange > 0;
  return { pctChange, isUp, isGood: !isUp }; // For expenses, down is good
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// CR-Apr22-E slice 5 [P3]: removed `getRecurringIncome()` — see the
// `incomeTrend` computed for the rationale. The helper was a dead
// no-op: `getEffectiveIncome(mk) - currentMonthTotals.income` is
// structurally 0 because both sides sum the same income transactions
// from the unified ledger. No call sites remain.

/**
 * Animate a numeric value on an element (delegates to shared animation utility)
 */
function animateValue(el: HTMLElement, target: number): void {
  if (!el.id) {
    el.textContent = fmtCur(target);
    return;
  }
  animateValueById(el.id, target);
}

/**
 * Update trend indicator element
 */
function updateTrendEl(el: HTMLElement, trend: { pctChange: number; isUp: boolean; isGood: boolean } | null): void {
  if (!trend) {
    el.classList.add('hidden');
    return;
  }
  const arrow = trend.isUp ? '↑' : '↓';
  const color = trend.isGood ? 'var(--color-income)' : 'var(--color-expense)';
  render(html`<span style=${styleMap({ color })}>${arrow} ${Math.abs(trend.pctChange)}%</span> vs last month`, el);
  el.classList.remove('hidden');
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive summary cards component
 * Returns cleanup function to dispose effects
 */
export function mountSummaryCards(): () => void {
  const incomeEl = DOM.get('total-income');
  const expensesEl = DOM.get('total-expenses');
  const incomeTrendEl = DOM.get('income-trend');
  const expenseTrendEl = DOM.get('expense-trend');

  mountEffects('summary-cards', [
    // Effect for income updates (re-runs on currency change for formatting)
    () => effect(() => {
      const _cur = signals.currency.value;  // subscribe to currency changes
      const currentMk = signals.currentMonth.value;
      const income = getEffectiveIncome(currentMk);

      if (incomeEl) {
        animateValue(incomeEl, income);
      }
    }),

    // Effect for expenses updates (re-runs on currency change for formatting)
    () => effect(() => {
      const _cur = signals.currency.value;  // subscribe to currency changes
      const expenses = signals.currentMonthTotals.value.expenses;

      if (expensesEl) {
        animateValue(expensesEl, expenses);
      }
    }),

    // Effect for income trend
    () => effect(() => {
      if (incomeTrendEl) {
        updateTrendEl(incomeTrendEl, incomeTrend.value);
      }
    }),

    // Effect for expense trend
    () => effect(() => {
      if (expenseTrendEl) {
        updateTrendEl(expenseTrendEl, expenseTrend.value);
      }
    }),
  ]);

  return () => unmountEffects('summary-cards');
}
