/**
 * Debt List Component
 *
 * Reactive component that renders the debt list with progress bars.
 * Automatically updates when the debts signal changes.
 *
 * @module components/debt-list
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, repeat, styleMap } from '../core/lit-helpers.js';
import { fmtCur, toCents, toDollars } from '../core/utils.js';
import { getDebtProgress, DEBT_TYPE_INFO } from '../features/financial/debt-planner.js';
import DOM from '../core/dom-cache.js';
import type { Debt, DebtType, DebtTypeInfo } from '../../types/index.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Active debts computed from debts signal
 */
const activeDebts = computed((): Debt[] => {
  // Use !== false to include legacy debts that don't have the isActive field (undefined)
  return (signals.debts.value as Debt[]).filter(d => d.isActive !== false);
});

/**
 * Debt list item data with progress
 */
interface DebtListItem {
  debt: Debt;
  progress: {
    percentComplete: number;
    paid: number;
  };
  typeInfo: DebtTypeInfo;
}

/**
 * Debt list items with all computed display data
 */
const debtListItems = computed((): DebtListItem[] => {
  return activeDebts.value.map(debt => {
    const progress = getDebtProgress(debt);
    const typeInfo: DebtTypeInfo = DEBT_TYPE_INFO[debt.type as DebtType] || { emoji: '💳', label: debt.type };
    return {
      debt,
      progress: {
        percentComplete: progress.percentComplete,
        paid: progress.paid
      },
      typeInfo
    };
  });
});

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive debt list component
 * Returns cleanup function to dispose effects
 */
export function mountDebtList(): () => void {
  const container = DOM.get('debts-list');
  const compareBtn = DOM.get('compare-strategies-btn');

  if (!container) {
    return () => {};
  }

  const cleanup = effect(() => {
    const items = debtListItems.value;

    if (items.length === 0) {
      render(html`
        <div class="app-panel-empty app-panel-empty--compact">
          <div class="app-panel-empty__icon">💳</div>
          <p class="app-panel-empty__title">No debts tracked yet</p>
          <p class="app-panel-empty__copy">Add a debt when you want payoff planning and monthly payment pressure in one place.</p>
        </div>
      `, container);

      // Hide compare button when no debts
      if (compareBtn) {
        compareBtn.classList.add('hidden');
      }
      return;
    }

    render(html`
      ${repeat(items, item => item.debt.id, item => html`
        <div class="debt-item" data-debt-id=${item.debt.id}>
          <div class="debt-item__header">
            <div class="debt-item__identity">
              <span class="debt-item__emoji">${item.typeInfo.emoji}</span>
              <div>
                <strong class="debt-item__name">${item.debt.name}</strong>
                <span class="debt-item__type">${item.typeInfo.label}</span>
              </div>
            </div>
            <div class="debt-item__balance-block">
              <div class="debt-item__balance">${fmtCur(item.debt.balance)}</div>
              <div class="debt-item__apr">${(item.debt.interestRate * 100).toFixed(2)}% APR</div>
            </div>
          </div>
          <div class="debt-item__progress">
            <div class="debt-item__progress-fill" style=${styleMap({ width: `${item.progress.percentComplete}%` })}></div>
          </div>
          <div class="debt-item__stats">
            <span class="debt-item__stat">
              <span class="debt-item__stat-label">Paid</span>
              <span class="debt-item__stat-value">${item.progress.percentComplete.toFixed(1)}%</span>
            </span>
            <span class="debt-item__stat">
              <span class="debt-item__stat-label">Min / mo</span>
              <span class="debt-item__stat-value">${fmtCur(item.debt.minimumPayment)}</span>
            </span>
          </div>
          <div class="debt-item-actions">
            <span class="debt-item-actions__label">Next step</span>
            <div class="debt-item-actions__buttons">
              <button class="btn btn-secondary debt-edit-btn" style="font-size: 0.875rem;">Edit</button>
              <button class="btn btn-primary debt-payment-btn" style="font-size: 0.875rem;">Make Payment</button>
            </div>
          </div>
        </div>
      `)}
    `, container);

    // Show strategy comparison button when 2+ active debts exist
    if (compareBtn) {
      compareBtn.classList.toggle('hidden', items.length < 2);
    }
  });

  return cleanup;
}
