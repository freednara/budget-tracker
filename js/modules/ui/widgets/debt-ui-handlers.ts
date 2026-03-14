/**
 * Debt UI Handlers Module
 *
 * Handles debt planner UI rendering and event handlers.
 */
'use strict';

import {
  getDebts,
  getDebt,
  addDebt,
  updateDebt,
  recordPayment,
  compareStrategies
} from '../../features/financial/debt-planner.js';
import { showToast, openModal, closeModal } from '../core/ui.js';
import { parseAmount, getTodayStr } from '../../core/utils.js';
// Note: Event bus handlers removed - debt list/summary now reactive via signals
import DOM from '../../core/dom-cache.js';
import { html, render, nothing, styleMap } from '../../core/lit-helpers.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;
type RefreshAllCallback = () => void;

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v: number): string => '$' + v.toFixed(2);
let refreshAllFn: RefreshAllCallback | null = null;

/**
 * Set the currency formatter function
 */
export function setDebtFmtCur(fn: CurrencyFormatter): void {
  fmtCur = fn;
}

/**
 * Set the refresh all function callback
 */
export function setDebtRefreshAll(fn: RefreshAllCallback): void {
  refreshAllFn = fn;
}

// ==========================================
// RENDERING - Now handled by reactive components
// ==========================================
// renderDebtList() -> mountDebtList() in components/debt-list.ts
// updateDebtSummary() -> mountDebtSummary() in components/debt-summary.ts

// ==========================================
// EVENT HANDLERS
// ==========================================

/**
 * Initialize all debt planner event handlers
 */
export function initDebtHandlers(): void {
  // Add Debt Modal
  DOM.get('add-debt-btn')?.addEventListener('click', () => {
    const titleEl = DOM.get('debt-modal-title');
    if (titleEl) titleEl.textContent = 'Add Debt';
    // Reset form fields individually (no form element exists)
    const editIdEl = DOM.get('edit-debt-id') as HTMLInputElement | null;
    const nameEl = DOM.get('debt-name') as HTMLInputElement | null;
    const typeEl = DOM.get('debt-type') as HTMLSelectElement | null;
    const balanceEl = DOM.get('debt-balance') as HTMLInputElement | null;
    const interestEl = DOM.get('debt-interest') as HTMLInputElement | null;
    const minimumEl = DOM.get('debt-minimum') as HTMLInputElement | null;
    const dueDayEl = DOM.get('debt-due-day') as HTMLInputElement | null;

    if (editIdEl) editIdEl.value = '';
    if (nameEl) nameEl.value = '';
    if (typeEl) typeEl.value = 'credit_card';
    if (balanceEl) balanceEl.value = '';
    if (interestEl) interestEl.value = '';
    if (minimumEl) minimumEl.value = '';
    if (dueDayEl) dueDayEl.value = '1';
    openModal('debt-modal');
  });

  DOM.get('cancel-debt')?.addEventListener('click', () => closeModal('debt-modal'));

  DOM.get('save-debt')?.addEventListener('click', () => {
    const editIdEl = DOM.get('edit-debt-id') as HTMLInputElement | null;
    const nameEl = DOM.get('debt-name') as HTMLInputElement | null;
    const typeEl = DOM.get('debt-type') as HTMLSelectElement | null;
    const balanceEl = DOM.get('debt-balance') as HTMLInputElement | null;
    const interestEl = DOM.get('debt-interest') as HTMLInputElement | null;
    const minimumEl = DOM.get('debt-minimum') as HTMLInputElement | null;
    const dueDayEl = DOM.get('debt-due-day') as HTMLInputElement | null;

    const editId = editIdEl?.value || '';
    const debtData = {
      name: (nameEl?.value || '').trim(),
      type: (typeEl?.value || 'credit_card') as DebtType,
      balance: parseAmount(balanceEl?.value || 0),
      interestRate: parseFloat(interestEl?.value || '0') / 100 || 0,
      minimumPayment: parseAmount(minimumEl?.value || 0),
      dueDay: parseInt(dueDayEl?.value || '1') || 1
    };
    if (!debtData.name) {
      showToast('Please enter a debt name', 'error');
      return;
    }
    if (debtData.balance <= 0) {
      showToast('Please enter a valid balance', 'error');
      return;
    }
    if (editId) {
      updateDebt(editId, debtData);
      showToast('Debt updated');
    } else {
      const debtDataWithOriginal = {
        ...debtData,
        originalBalance: debtData.balance
      };
      addDebt(debtDataWithOriginal);
      showToast('Debt added');
    }
    closeModal('debt-modal');
    // renderDebtList and updateDebtSummary now reactive via mountDebtList/mountDebtSummary
  });

  // Debt list click handlers (edit/payment)
  DOM.get('debts-list')?.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    const debtItem = target.closest('.debt-item') as HTMLElement | null;
    if (!debtItem) return;
    const debtId = debtItem.dataset.debtId;
    if (!debtId) return;
    const debt = getDebt(debtId);
    if (!debt) return;

    if (target.closest('.debt-edit-btn')) {
      const titleEl = DOM.get('debt-modal-title');
      const editIdEl = DOM.get('edit-debt-id') as HTMLInputElement | null;
      const nameEl = DOM.get('debt-name') as HTMLInputElement | null;
      const typeEl = DOM.get('debt-type') as HTMLSelectElement | null;
      const balanceEl = DOM.get('debt-balance') as HTMLInputElement | null;
      const interestEl = DOM.get('debt-interest') as HTMLInputElement | null;
      const minimumEl = DOM.get('debt-minimum') as HTMLInputElement | null;
      const dueDayEl = DOM.get('debt-due-day') as HTMLInputElement | null;

      if (titleEl) titleEl.textContent = 'Edit Debt';
      if (editIdEl) editIdEl.value = debt.id;
      if (nameEl) nameEl.value = debt.name;
      if (typeEl) typeEl.value = debt.type;
      if (balanceEl) balanceEl.value = String(debt.balance);
      if (interestEl) interestEl.value = (debt.interestRate * 100).toFixed(2);
      if (minimumEl) minimumEl.value = String(debt.minimumPayment);
      if (dueDayEl) dueDayEl.value = String(debt.dueDay);
      openModal('debt-modal');
    } else if (target.closest('.debt-payment-btn')) {
      const paymentIdEl = DOM.get('debt-payment-id') as HTMLInputElement | null;
      const paymentNameEl = DOM.get('debt-payment-name');
      const paymentBalanceEl = DOM.get('debt-payment-balance');
      const paymentAmountEl = DOM.get('debt-payment-amount') as HTMLInputElement | null;
      const paymentDateEl = DOM.get('debt-payment-date') as HTMLInputElement | null;

      if (paymentIdEl) paymentIdEl.value = debt.id;
      if (paymentNameEl) paymentNameEl.textContent = debt.name;
      if (paymentBalanceEl) paymentBalanceEl.textContent = fmtCur(debt.balance);
      if (paymentAmountEl) paymentAmountEl.value = String(debt.minimumPayment);
      if (paymentDateEl) paymentDateEl.value = getTodayStr();
      openModal('debt-payment-modal');
    }
  });

  // Payment Modal
  DOM.get('cancel-debt-payment')?.addEventListener('click', () => closeModal('debt-payment-modal'));

  DOM.get('confirm-debt-payment')?.addEventListener('click', async () => {
    const paymentIdEl = DOM.get('debt-payment-id') as HTMLInputElement | null;
    const paymentAmountEl = DOM.get('debt-payment-amount') as HTMLInputElement | null;
    const paymentDateEl = DOM.get('debt-payment-date') as HTMLInputElement | null;

    const debtId = paymentIdEl?.value || '';
    const amount = parseAmount(paymentAmountEl?.value || 0);
    const date = paymentDateEl?.value || getTodayStr();
    if (amount <= 0) {
      showToast('Please enter a valid payment amount', 'error');
      return;
    }
    const result = await recordPayment(debtId, amount, date);
    if (!result.isOk) {
      showToast(result.error || 'Payment failed', 'error');
      return;
    }
    closeModal('debt-payment-modal');
    showToast('Payment recorded');
    // renderDebtList and updateDebtSummary now reactive via mountDebtList/mountDebtSummary
    if (refreshAllFn) refreshAllFn();
  });

  // Strategy Comparison Modal
  DOM.get('compare-strategies-btn')?.addEventListener('click', () => {
    const extraPaymentEl = DOM.get('extra-payment') as HTMLInputElement | null;
    const extraMonthly = parseAmount(extraPaymentEl?.value || 0);
    const debts = getDebts().filter(d => d.isActive);
    const comparison = compareStrategies(debts, extraMonthly);
    const strategyResults = DOM.get('strategy-results');
    if (!strategyResults) return;

    if (!comparison || debts.length === 0) {
      render(html`<p style="text-align: center; color: var(--text-secondary);">Add debts to compare payoff strategies.</p>`, strategyResults);
      openModal('debt-strategy-modal');
      return;
    }

    const snowball = comparison.snowball;
    const avalanche = comparison.avalanche;
    const savings = avalanche.totalInterest - snowball.totalInterest;

    render(html`
      <div style="display: grid; gap: 1rem;">
        <div style="background: var(--surface); padding: 1rem; border-radius: 0.75rem; border-left: 4px solid var(--accent);">
          <h4 style="margin: 0 0 0.5rem 0;">❄️ Snowball Method</h4>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.75rem;">Pay smallest balances first for quick wins.</p>
          <div style="display: flex; justify-content: space-between;">
            <span>Payoff time:</span><strong>${snowball.months} months</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Total interest:</span><strong>${fmtCur(snowball.totalInterest)}</strong>
          </div>
        </div>
        <div style="background: var(--surface); padding: 1rem; border-radius: 0.75rem; border-left: 4px solid var(--success);">
          <h4 style="margin: 0 0 0.5rem 0;">🏔️ Avalanche Method</h4>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.75rem;">Pay highest interest first to save money.</p>
          <div style="display: flex; justify-content: space-between;">
            <span>Payoff time:</span><strong>${avalanche.months} months</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Total interest:</span><strong>${fmtCur(avalanche.totalInterest)}</strong>
          </div>
        </div>
        ${savings !== 0 ? html`
          <div style=${styleMap({
            textAlign: 'center',
            padding: '0.75rem',
            background: savings > 0 ? 'var(--success-bg)' : 'var(--warning-bg)',
            borderRadius: '0.5rem'
          })}>
            <strong>${savings > 0 ? 'Snowball' : 'Avalanche'} saves ${fmtCur(Math.abs(savings))} in interest!</strong>
          </div>
        ` : nothing}
      </div>
    `, strategyResults);
    openModal('debt-strategy-modal');
  });

  DOM.get('close-strategy-modal')?.addEventListener('click', () => closeModal('debt-strategy-modal'));

  // Note: Event bus listeners for debt updates removed
  // Both renderDebtList and updateDebtSummary are now reactive via mountDebtList and mountDebtSummary
  // Signal changes automatically trigger UI updates
}
