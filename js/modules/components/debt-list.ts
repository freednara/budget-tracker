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
import { fmtCur } from '../core/utils-pure.js';
import { formatRate } from '../core/locale-service.js';
import { getDebtProgress, getNextStepRecommendation, calculateTotalInterestPaid, DEBT_TYPE_INFO, deleteDebt, type DebtRecommendation } from '../features/financial/debt-planner.js';
import DOM from '../core/dom-cache.js';
import { emit, Events } from '../core/event-bus.js';
import { selectedDebt } from './transaction-detail-panel.js';
import type { Debt, DebtTypeInfo } from '../../types/index.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Active debts computed from debts signal
 */
const activeDebts = computed((): Debt[] => {
  // Use !== false to include legacy debts that don't have the isActive field (undefined)
  // rev 12 / #39 M2: dead `as Debt[]` cast removed — `signals.debts` is
  // `signal<Debt[]>(...)` at `signals.ts:139`.
  return signals.debts.value.filter(d => d.isActive !== false);
});

/**
 * Debt list item data with progress
 */
interface DebtListItem {
  debt: Debt;
  progress: {
    percentComplete: number;
    paid: number;
    original: number;
    remaining: number;
    interestPaid: number;
    paymentsCount: number;
  };
  typeInfo: DebtTypeInfo;
  recommendation: DebtRecommendation;
}

/**
 * Debt list items with all computed display data
 */
const debtListItems = computed((): DebtListItem[] => {
  const debts = activeDebts.value;
  return debts.map(debt => {
    const progress = getDebtProgress(debt);
    const interestPaid = calculateTotalInterestPaid(debt);
    const typeInfo: DebtTypeInfo = DEBT_TYPE_INFO[debt.type] || { emoji: '💳', label: debt.type };
    const recommendation = getNextStepRecommendation(debt, debts);
    return {
      debt,
      progress: {
        percentComplete: progress.percentComplete,
        paid: progress.paid,
        original: progress.original ?? debt.balance,
        remaining: debt.balance,
        interestPaid,
        paymentsCount: progress.paymentsCount
      },
      typeInfo,
      recommendation
    };
  });
});

// ==========================================
// DELETE HANDLER (two-tap confirm)
// ==========================================

const CONFIRM_TIMEOUT = 3000;
const pendingDeletes = new Map<string, number>();

function handleDeleteDebt(debtId: string, debtName: string, btn: HTMLElement): void {
  if (pendingDeletes.has(debtId)) {
    clearTimeout(pendingDeletes.get(debtId));
    pendingDeletes.delete(debtId);
    deleteDebt(debtId);
    emit(Events.SHOW_TOAST, { message: 'Debt deleted', type: 'success' });
    return;
  }

  btn.classList.add('debt-delete-btn--confirming');
  btn.textContent = 'Delete?';
  // Design-Review-Apr21 P3: thread the debt name through both the
  // confirming and reset aria-labels. The initial render emits
  // `aria-label="Delete ${debt.name}"`, but the confirm-state handler
  // used to overwrite it with the generic "Tap again to confirm
  // delete" — stripping the only cue an AT user had about *which*
  // debt was about to be removed on the next tap. Restoring the name
  // on reset keeps the label stable across the two-tap gesture.
  btn.setAttribute('aria-label', `Tap again to confirm deleting ${debtName}`);

  const timerId = window.setTimeout(() => {
    pendingDeletes.delete(debtId);
    btn.classList.remove('debt-delete-btn--confirming');
    btn.textContent = '🗑️';
    btn.setAttribute('aria-label', `Delete ${debtName}`);
  }, CONFIRM_TIMEOUT);

  pendingDeletes.set(debtId, timerId);
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive debt list component
 * Returns cleanup function to dispose effects
 */
export function mountDebtList(): () => void {
  const container = DOM.get('debts-list');
  const compareBtn = DOM.get('compare-strategies-wrapper');
  const summaryCards = DOM.get('debt-summary-cards');
  const section = DOM.get('debt-planner-section');
  const headerActions = section?.querySelector('.app-panel__actions') as HTMLElement | null;

  if (!container) {
    return () => {};
  }

  const cleanup = effect(() => {
    const items = debtListItems.value;
    // CR-Apr22-G slice 1 (P2): balance / paid / interest-paid / minimum
    // payment labels all flow through fmtCur, which reads module-level
    // formatter state (synced externally by syncCurrencyFormat), not the
    // currency signal. Without an explicit read here the effect doesn't
    // re-run on currency change, so amounts in the debt list stay stale
    // with the prior currency symbol until a debt is added/edited or the
    // debts signal otherwise mutates.
    void signals.currency.value;

    if (items.length === 0) {
      render(html`
        <div class="app-panel-empty">
          <div class="app-panel-empty__icon">💳</div>
          <p class="app-panel-empty__title">No debts tracked yet</p>
          <p class="app-panel-empty__copy">Add a debt to get payoff planning, strategy comparison, and monthly payment pressure in one place.</p>
          <button type="button"
                  class="empty-state-cta mt-3 px-4 py-2 rounded-lg text-sm font-bold"
                  data-action="add-debt">
            + Add Debt
          </button>
        </div>
      `, container);

      // Hide header button, summary cards, and compare button when no debts
      if (headerActions) headerActions.classList.add('hidden');
      if (summaryCards) summaryCards.classList.add('hidden');
      if (compareBtn) compareBtn.classList.add('hidden');
      return;
    }

    // Show header button and summary cards when debts exist
    if (headerActions) headerActions.classList.remove('hidden');
    if (summaryCards) summaryCards.classList.remove('hidden');

    render(html`
      ${repeat(items, item => item.debt.id, item => html`
        <div class="debt-item" data-debt-id=${item.debt.id}>
          <div class="debt-item__header debt-item__header--clickable"
               role="button" tabindex="0"
               aria-label=${`View payment history for ${item.debt.name}`}
               @click=${() => { selectedDebt.value = { id: item.debt.id, name: item.debt.name, emoji: item.typeInfo.emoji }; }}
               @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedDebt.value = { id: item.debt.id, name: item.debt.name, emoji: item.typeInfo.emoji }; } }}>
            <div class="debt-item__identity">
              <span class="debt-item__emoji">${item.typeInfo.emoji}</span>
              <div>
                <strong class="debt-item__name">${item.debt.name}</strong>
                <span class="debt-item__type">${item.typeInfo.label}</span>
              </div>
            </div>
            <div class="debt-item__balance-block">
              <div class="debt-item__balance">${fmtCur(item.debt.balance)}</div>
              <!-- CR-Apr22-G slice 2: APR rate routes through the canonical
                   locale service so the decimal separator follows the user's
                   locale (de-DE → "15,00% APR", en-US → "15.00% APR") rather
                   than always using a dot via toFixed(2). -->
              <div class="debt-item__apr">${formatRate(item.debt.interestRate * 100)}% APR</div>
            </div>
          </div>
          <div class="debt-item__progress-row">
            <div class="progress-track debt-item__progress" role="progressbar" aria-valuenow=${item.progress.percentComplete} aria-valuemin="0" aria-valuemax="100" aria-label="${item.debt.name} payoff progress">
              <div class="progress-fill debt-item__progress-fill" style=${styleMap({ width: `${item.progress.percentComplete}%` })}></div>
            </div>
            <span class="debt-item__progress-pct">${item.progress.percentComplete}%</span>
          </div>
          <details class="debt-item__details">
            <summary class="debt-item__details-toggle"
                     aria-label=${`More details for ${item.debt.name}`}>More details</summary>
            <div class="debt-item__stats debt-item__stats--grid">
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Remaining</span>
                <span class="debt-item__stat-value debt-item__stat-value--remaining">${fmtCur(item.progress.remaining)}</span>
              </span>
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Paid</span>
                <span class="debt-item__stat-value debt-item__stat-value--paid">${fmtCur(item.progress.paid)}</span>
              </span>
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Min / mo</span>
                <span class="debt-item__stat-value">${fmtCur(item.debt.minimumPayment)}</span>
              </span>
            </div>
            <div class="debt-item__stats debt-item__stats--grid debt-item__stats--secondary">
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Original</span>
                <span class="debt-item__stat-value">${fmtCur(item.progress.original)}</span>
              </span>
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Interest paid</span>
                <span class="debt-item__stat-value debt-item__stat-value--interest">${item.progress.interestPaid > 0 ? fmtCur(item.progress.interestPaid) : '—'}</span>
              </span>
              <span class="debt-item__stat">
                <span class="debt-item__stat-label">Payments</span>
                <span class="debt-item__stat-value">${item.progress.paymentsCount}</span>
              </span>
            </div>
            <div class="debt-item-rec debt-item-rec--${item.recommendation.priority}">
              <span class="debt-item-rec__label">Next step</span>
              <span class="debt-item-rec__text">${item.recommendation.text}</span>
            </div>
          </details>
          <div class="debt-item-actions">
            <div class="debt-item-actions__buttons">
              <button
                class="btn btn-ghost debt-delete-btn debt-item-actions__btn--icon"
                @click=${(e: Event) => { e.stopPropagation(); handleDeleteDebt(item.debt.id, item.debt.name, e.currentTarget as HTMLElement); }}
                aria-label=${`Delete ${item.debt.name}`}
                title=${`Delete ${item.debt.name}`}
              >🗑️</button>
              <button
                class="btn btn-secondary debt-edit-btn debt-item-actions__btn"
                aria-label=${`Edit ${item.debt.name}`}
                title=${`Edit ${item.debt.name}`}
              >Edit</button>
              <button
                class="btn btn-primary debt-payment-btn debt-item-actions__btn"
                aria-label=${`Make payment on ${item.debt.name}`}
                title=${`Make payment on ${item.debt.name}`}
              >Make Payment</button>
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
