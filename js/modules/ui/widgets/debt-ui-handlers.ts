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
  deleteDebt,
  recordPayment,
  compareStrategies
} from '../../features/financial/debt-planner.js';
import { showToast, openModal, closeModal } from '../core/ui.js';
import { asyncConfirm } from '../components/async-modal.js';
import { parseAmount, getTodayStr, fmtCur as fmtCurUtil } from '../../core/utils.js';
// Note: Event bus handlers removed - debt list/summary now reactive via signals
import DOM from '../../core/dom-cache.js';
import { html, render, nothing, styleMap } from '../../core/lit-helpers.js';
import type { DebtType } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;
type RefreshAllCallback = () => void;

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = fmtCurUtil;
let refreshAllFn: RefreshAllCallback | null = null;
const debtHandlerCleanups: Array<() => void> = [];

function bindDebtHandler(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject
): void {
  target.addEventListener(type, handler);
  debtHandlerCleanups.push(() => {
    target.removeEventListener(type, handler);
  });
}

export function cleanupDebtHandlers(): void {
  const cleanups = debtHandlerCleanups.splice(0, debtHandlerCleanups.length);
  cleanups.forEach((cleanup) => cleanup());
}

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
  cleanupDebtHandlers();

  // Add Debt Modal
  const addDebtButton = DOM.get('add-debt-btn');
  if (addDebtButton) bindDebtHandler(addDebtButton, 'click', () => {
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
    
    // Hide delete button for new debts
    const delBtn = DOM.get('delete-debt');
    if (delBtn) delBtn.classList.add('hidden');
    
    openModal('debt-modal');
  });

  const deleteDebtButton = DOM.get('delete-debt');
  if (deleteDebtButton) bindDebtHandler(deleteDebtButton, 'click', async () => {
    const editIdEl = DOM.get('edit-debt-id') as HTMLInputElement | null;
    const debtId = editIdEl?.value || '';
    if (!debtId) return;

    const confirmed = await asyncConfirm({
      title: 'Delete Debt',
      message: 'Remove this debt from your tracking?',
      details: 'This removes the debt entry and its progress from the planner. Existing transactions are not deleted.',
      type: 'danger',
      confirmText: 'Delete Debt',
      cancelText: 'Keep Debt'
    });
    if (confirmed) {
      deleteDebt(debtId);
      showToast('Debt deleted');
      closeModal('debt-modal');
    }
  });

  const cancelDebtButton = DOM.get('cancel-debt');
  if (cancelDebtButton) bindDebtHandler(cancelDebtButton, 'click', () => closeModal('debt-modal'));

  const saveDebtButton = DOM.get('save-debt');
  if (saveDebtButton) bindDebtHandler(saveDebtButton, 'click', () => {
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
  const debtsList = DOM.get('debts-list');
  if (debtsList) bindDebtHandler(debtsList, 'click', (e: Event) => {
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

      // Show delete button when editing
      const delBtn = DOM.get('delete-debt');
      if (delBtn) delBtn.classList.remove('hidden');

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
      const paymentMinEl = DOM.get('debt-payment-minimum');
      if (paymentMinEl) paymentMinEl.textContent = fmtCur(debt.minimumPayment);
      if (paymentAmountEl) paymentAmountEl.value = String(debt.minimumPayment);
      if (paymentDateEl) paymentDateEl.value = getTodayStr();
      openModal('debt-payment-modal');
    }
  });

  // Payment Modal
  const cancelDebtPaymentButton = DOM.get('cancel-debt-payment');
  if (cancelDebtPaymentButton) bindDebtHandler(cancelDebtPaymentButton, 'click', () => closeModal('debt-payment-modal'));

  const confirmDebtPaymentButton = DOM.get('confirm-debt-payment');
  if (confirmDebtPaymentButton) bindDebtHandler(confirmDebtPaymentButton, 'click', async () => {
    const btn = DOM.get('confirm-debt-payment') as HTMLButtonElement | null;
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;

    try {
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
      if (refreshAllFn) refreshAllFn();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Strategy Comparison Modal
  const compareStrategiesButton = DOM.get('compare-strategies-btn');
  if (compareStrategiesButton) bindDebtHandler(compareStrategiesButton, 'click', () => {
    const extraPaymentEl = DOM.get('extra-payment') as HTMLInputElement | null;
    const extraMonthly = parseAmount(extraPaymentEl?.value || 0);
    const debts = getDebts().filter(d => d.isActive);
    const comparison = compareStrategies(debts, extraMonthly);
    const strategyResults = DOM.get('strategy-results');
    const snowballMonthsEl = DOM.get('snowball-months');
    const snowballInterestEl = DOM.get('snowball-interest');
    const avalancheMonthsEl = DOM.get('avalanche-months');
    const avalancheInterestEl = DOM.get('avalanche-interest');
    const recommendationEl = DOM.get('strategy-rec-text');
    const payoffOrderList = DOM.get('payoff-order-list');
    if (!strategyResults) return;

    if (!comparison || debts.length === 0) {
      if (snowballMonthsEl) snowballMonthsEl.textContent = '-- months';
      if (snowballInterestEl) snowballInterestEl.textContent = '$-- interest';
      if (avalancheMonthsEl) avalancheMonthsEl.textContent = '-- months';
      if (avalancheInterestEl) avalancheInterestEl.textContent = '$-- interest';
      if (recommendationEl) recommendationEl.textContent = '--';
      if (payoffOrderList) render(html``, payoffOrderList);
      render(html`<p style="text-align: center; color: var(--text-secondary);">Add debts to compare payoff strategies.</p>`, strategyResults);
      openModal('debt-strategy-modal');
      return;
    }

    const snowball = comparison.snowball;
    const avalanche = comparison.avalanche;
    const savings = avalanche.totalInterest - snowball.totalInterest;
    const recommendedText = comparison.recommended === 'avalanche'
      ? `Avalanche is the better money-saving plan here, reducing interest by ${fmtCur(Math.max(0, comparison.interestSaved))}.`
      : comparison.interestSaved > 0
        ? `Snowball gives quicker momentum while Avalanche only saves ${fmtCur(comparison.interestSaved)} more in interest.`
        : 'Snowball is the better motivational fit here, with a similar payoff outcome.';

    if (snowballMonthsEl) snowballMonthsEl.textContent = `${snowball.months} months`;
    if (snowballInterestEl) snowballInterestEl.textContent = `${fmtCur(snowball.totalInterest)} interest`;
    if (avalancheMonthsEl) avalancheMonthsEl.textContent = `${avalanche.months} months`;
    if (avalancheInterestEl) avalancheInterestEl.textContent = `${fmtCur(avalanche.totalInterest)} interest`;
    if (recommendationEl) recommendationEl.textContent = recommendedText;
    if (payoffOrderList) {
      render(html`
        ${avalanche.order.length > 0 ? avalanche.order.map((item, index) => html`
          <div style="display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0;">
            <span>${index + 1}. ${item.name}</span>
            <span style="color: var(--text-secondary);">Month ${item.month}</span>
          </div>
        `) : html`
          <p style="color: var(--text-secondary);">No payoff order available yet.</p>
        `}
      `, payoffOrderList);
    }

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

  const closeStrategyModalButton = DOM.get('close-strategy-modal');
  if (closeStrategyModalButton) bindDebtHandler(closeStrategyModalButton, 'click', () => closeModal('debt-strategy-modal'));

  // Note: Event bus listeners for debt updates removed
  // Both renderDebtList and updateDebtSummary are now reactive via mountDebtList and mountDebtSummary
  // Signal changes automatically trigger UI updates
}
