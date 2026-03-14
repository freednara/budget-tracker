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
  return (signals.debts.value as Debt[]).filter(d => d.isActive);
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
        <div class="empty-state" style="padding: 2rem; text-align: center; color: var(--text-secondary);">
          <p>No debts tracked yet.</p>
          <p style="font-size: 0.875rem; margin-top: 0.5rem;">Add a debt to start planning your payoff strategy.</p>
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
        <div class="debt-item" data-debt-id=${item.debt.id} style="background: var(--surface); border-radius: 0.75rem; padding: 1rem; margin-bottom: 0.75rem;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
            <div>
              <span style="font-size: 1.25rem; margin-right: 0.5rem;">${item.typeInfo.emoji}</span>
              <strong>${item.debt.name}</strong>
              <span style="color: var(--text-secondary); font-size: 0.875rem; margin-left: 0.5rem;">${item.typeInfo.label}</span>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 1.25rem; font-weight: 600; color: var(--danger);">${fmtCur(item.debt.balance)}</div>
              <div style="font-size: 0.75rem; color: var(--text-secondary);">${(item.debt.interestRate * 100).toFixed(2)}% APR</div>
            </div>
          </div>
          <div style="background: var(--background); border-radius: 0.5rem; height: 0.5rem; overflow: hidden; margin-bottom: 0.5rem;">
            <div style=${styleMap({ background: 'var(--accent)', height: '100%', width: `${item.progress.percentComplete}%`, transition: 'width 0.3s' })}></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-secondary);">
            <span>${item.progress.percentComplete.toFixed(1)}% paid off</span>
            <span>Min payment: ${fmtCur(item.debt.minimumPayment)}/mo</span>
          </div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
            <button class="btn-secondary debt-edit-btn" style="flex: 1; padding: 0.5rem; font-size: 0.875rem;">Edit</button>
            <button class="btn-primary debt-payment-btn" style="flex: 1; padding: 0.5rem; font-size: 0.875rem;">Make Payment</button>
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
