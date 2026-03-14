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
import { fmtCur, toCents, toDollars } from '../core/utils.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Total debt summary computed from debts signal
 */
interface DebtSummaryData {
  totalBalance: number;
  monthlyMinimum: number;
  debtCount: number;
}

const debtSummary = computed((): DebtSummaryData => {
  const debts = signals.debts.value;

  if (!debts.length) {
    return {
      totalBalance: 0,
      monthlyMinimum: 0,
      debtCount: 0
    };
  }

  let totalBalanceCents = 0;
  let totalMinimumCents = 0;
  let activeCount = 0;

  for (const d of debts) {
    if (d.isActive) {
      totalBalanceCents += toCents(d.balance);
      totalMinimumCents += toCents(d.minimumPayment);
      activeCount++;
    }
  }

  return {
    totalBalance: toDollars(totalBalanceCents),
    monthlyMinimum: toDollars(totalMinimumCents),
    debtCount: activeCount
  };
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
