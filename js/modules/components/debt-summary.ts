/**
 * Debt Summary Component
 *
 * Reactive component that updates the debt summary totals display
 * when the debts signal changes.
 *
 * @module components/debt-summary
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { fmtCur } from '../core/utils.js';
import DOM from '../core/dom-cache.js';
import { getTotalDebtSummary } from '../features/financial/debt-planner.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Total debt summary - delegates to debt-planner.ts (single source of truth)
 */
const debtSummary = computed(() => {
  // Access debts signal to establish reactive dependency
  const _debts = signals.debts.value;
  return getTotalDebtSummary();
});

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive debt summary component
 * Returns cleanup function to dispose effects
 */
export function mountDebtSummary(): () => void {
  const totalDebtEl = DOM.get('total-debt');
  const monthlyPaymentEl = DOM.get('monthly-debt-payments');

  // If neither element exists, no cleanup needed
  if (!totalDebtEl && !monthlyPaymentEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const summary = debtSummary.value;

    if (totalDebtEl) {
      totalDebtEl.textContent = fmtCur(summary.totalBalance);
    }

    if (monthlyPaymentEl) {
      monthlyPaymentEl.textContent = fmtCur(summary.monthlyMinimum);
    }
  });

  return cleanup;
}
