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
import { fmtCur, getPrevMonthKey, toCents, toDollars } from '../core/utils.js';
import { getEffectiveIncome, calcTotals, getMonthTx } from '../features/financial/calculations.js';
import { calculateMonthlyTotalsWithCacheSync } from '../core/monthly-totals-cache.js';
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
  const cached = calculateMonthlyTotalsWithCacheSync(prevMk);
  return { income: cached.income, expenses: cached.expenses };
});

/**
 * Income trend percentage
 */
const incomeTrend = computed(() => {
  const current = signals.currentMonthTotals.value.income + getRecurringIncome();
  const previous = prevMonthData.value.income;
  if (previous === 0) return null;
  const pctChange = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pctChange === 0) return null;
  return { pctChange, isUp: pctChange > 0, isGood: pctChange > 0 };
});

/**
 * Expense trend percentage
 */
const expenseTrend = computed(() => {
  const current = signals.currentMonthTotals.value.expenses;
  const previous = prevMonthData.value.expenses;
  if (previous === 0) return null;
  const pctChange = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pctChange === 0) return null;
  const isUp = pctChange > 0;
  return { pctChange, isUp, isGood: !isUp }; // For expenses, down is good
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Get recurring income for current month
 */
function getRecurringIncome(): number {
  // This is calculated in getEffectiveIncome but we need it separately
  // For now, use the delta between effective income and transaction income
  const currentMk = signals.currentMonth.value;
  const effectiveIncome = getEffectiveIncome(currentMk);
  const txIncome = signals.currentMonthTotals.value.income;
  return effectiveIncome - txIncome;
}

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

  // Track last values for animation
  let lastIncome = 0;
  let lastExpenses = 0;

  mountEffects('summary-cards', [
    // Effect for income updates
    () => effect(() => {
      const currentMk = signals.currentMonth.value;
      const income = getEffectiveIncome(currentMk);

      if (incomeEl && income !== lastIncome) {
        animateValue(incomeEl, income);
        lastIncome = income;
      }
    }),

    // Effect for expenses updates
    () => effect(() => {
      const expenses = signals.currentMonthTotals.value.expenses;

      if (expensesEl && expenses !== lastExpenses) {
        animateValue(expensesEl, expenses);
        lastExpenses = expenses;
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
