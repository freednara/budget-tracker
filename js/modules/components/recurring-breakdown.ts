'use strict';

import { computed, effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render } from '../core/lit-helpers.js';
import { fmtCur, toCents, toDollars } from '../core/utils.js';
import { getMonthBadge } from '../core/utils-dom.js';
import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
import DOM from '../core/dom-cache.js';
import type { Transaction } from '../../types/index.js';

interface RecurringBreakdownData {
  total: number;
  recurring: number;
  variable: number;
  recurringCount: number;
  variableCount: number;
  recurringPercent: number;
  variablePercent: number;
}

const recurringBreakdownData = computed((): RecurringBreakdownData => {
  const _month = signals.currentMonth.value;
  const monthTransactions = signals.currentMonthTx.value.filter((tx: Transaction) => isTrackedExpenseTransaction(tx));

  const recurringCents = monthTransactions
    .filter((tx: Transaction) => tx.recurring)
    .reduce((sum: number, tx: Transaction) => sum + toCents(tx.amount), 0);
  const variableCents = monthTransactions
    .filter((tx: Transaction) => !tx.recurring)
    .reduce((sum: number, tx: Transaction) => sum + toCents(tx.amount), 0);
  const totalCents = recurringCents + variableCents;

  return {
    total: toDollars(totalCents),
    recurring: toDollars(recurringCents),
    variable: toDollars(variableCents),
    recurringCount: monthTransactions.filter((tx: Transaction) => tx.recurring).length,
    variableCount: monthTransactions.filter((tx: Transaction) => !tx.recurring).length,
    recurringPercent: totalCents > 0 ? Math.round((recurringCents / totalCents) * 100) : 0,
    variablePercent: totalCents > 0 ? Math.round((variableCents / totalCents) * 100) : 0
  };
});

export function mountRecurringBreakdown(): () => void {
  const section = DOM.get('recurring-breakdown-section');
  const chartEl = DOM.get('recurring-breakdown-chart');
  const badgeEl = DOM.get('recurring-breakdown-badge');

  if (!section || !chartEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const data = recurringBreakdownData.value;

    if (badgeEl) {
      render(html`<span class="time-badge">${getMonthBadge(signals.currentMonth.value)}</span>`, badgeEl);
    }

    if (data.total <= 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    render(html`
      <div class="budget-stat-grid">
        <div class="budget-stat-card">
          <p class="text-xs font-bold text-secondary mb-2">RECURRING</p>
          <p class="text-2xl font-black text-primary">${fmtCur(data.recurring)}</p>
          <p class="text-xs text-tertiary mt-2">${data.recurringCount} transaction${data.recurringCount === 1 ? '' : 's'} · ${data.recurringPercent}% of spend</p>
        </div>
        <div class="budget-stat-card">
          <p class="text-xs font-bold text-secondary mb-2">VARIABLE</p>
          <p class="text-2xl font-black text-primary">${fmtCur(data.variable)}</p>
          <p class="text-xs text-tertiary mt-2">${data.variableCount} transaction${data.variableCount === 1 ? '' : 's'} · ${data.variablePercent}% of spend</p>
        </div>
      </div>

      <div class="budget-meter">
        <div class="flex items-center justify-between text-xs font-bold">
          <span class="text-secondary">SPENDING MIX</span>
          <span class="text-tertiary">${fmtCur(data.total)} total</span>
        </div>
        <div class="budget-meter__bar" role="img" aria-label="Recurring vs variable spending share">
          <div class="budget-meter__fill" style="width: ${data.recurringPercent}%; background: linear-gradient(90deg, var(--color-warning), var(--color-income));"></div>
        </div>
        <div class="flex items-center justify-between mt-3 text-xs text-tertiary">
          <span>Recurring is your fixed baseline.</span>
          <span>Variable is your flexible spend.</span>
        </div>
      </div>
    `, chartEl);
  });

  return () => {
    cleanup();
  };
}
