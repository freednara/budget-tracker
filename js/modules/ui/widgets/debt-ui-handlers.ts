/**
 * Debt UI Handlers Module
 *
 * Handles debt planner UI rendering and event handlers.
 */
'use strict';

import { createEventBinder } from '../../core/event-binding.js';
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
import { parseAmount, getTodayStr, fmtCur } from '../../core/utils-pure.js';
// Note: Event bus handlers removed - debt list/summary now reactive via signals
import DOM from '../../core/dom-cache.js';
import { html, render, nothing } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import * as signals from '../../core/signals.js';
import type { DebtType } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type RefreshAllCallback = () => void;

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let refreshAllFn: RefreshAllCallback | null = null;

// CR-Apr24-C2c [P2] finding 108: snapshot the debt's data-hash at
// edit-modal-open so Save can detect concurrent modifications. Without
// this, saving a stale form silently overwrites newer values.
let _editDebtSnapshot: string | null = null;

/** Cheaply fingerprint a debt's editable fields for staleness detection. */
function _debtFingerprint(d: { name: string; type: string; balance: number; interestRate: number; minimumPayment: number; dueDay: number }): string {
  return `${d.name}|${d.type}|${d.balance}|${d.interestRate}|${d.minimumPayment}|${d.dueDay}`;
}
const debtHandlerCleanups: Array<() => void> = [];
const bindDebtHandler = createEventBinder(debtHandlerCleanups);

export function cleanupDebtHandlers(): void {
  const cleanups = debtHandlerCleanups.splice(0, debtHandlerCleanups.length);
  cleanups.forEach((cleanup) => cleanup());
}

// Design-Review-Apr21 P2/P3: the debt + debt-payment modal markup has inline
// error regions (`#debt-name-error`, `#debt-balance-error`,
// `#debt-payment-error`) that were shipped but never surfaced — every save
// path fell back to a global toast. These helpers activate those regions so
// AT users hear the alert, sighted users see the field highlight, and
// keyboard users get focus moved to the failing control. Toasts stay in
// place as a secondary announcement for users who may have missed the
// inline feedback.
function setDebtFieldError(inputId: string, errorId: string, message: string): void {
  const errEl = DOM.get(errorId);
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }
  const inputEl = DOM.get<HTMLInputElement>(inputId);
  if (inputEl) {
    inputEl.setAttribute('aria-invalid', 'true');
    inputEl.focus();
  }
}

function clearDebtFieldError(inputId: string, errorId: string): void {
  const errEl = DOM.get(errorId);
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  const inputEl = DOM.get<HTMLInputElement>(inputId);
  if (inputEl) inputEl.setAttribute('aria-invalid', 'false');
}

function clearAllDebtModalErrors(): void {
  clearDebtFieldError('debt-name', 'debt-name-error');
  clearDebtFieldError('debt-balance', 'debt-balance-error');
}

function clearDebtPaymentModalErrors(): void {
  clearDebtFieldError('debt-payment-amount', 'debt-payment-error');
}

// Design-Review-Apr21 P2: the strategy-comparison modal keeps the
// EXTRA MONTHLY PAYMENT input live inside the modal, so edits to it
// should recompute the comparison inline. The compute+render logic
// was inlined in the click handler; extracting it here lets both the
// open click and the `input` event on `#extra-payment` drive the same
// render pipeline without re-opening the modal on every keystroke.
function renderStrategyComparison(): void {
  const extraPaymentEl = DOM.get<HTMLInputElement>('extra-payment');
  const extraMonthly = parseAmount(extraPaymentEl?.value ?? 0);
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
    // CR-Apr24-I finding 91: use the user's currency symbol instead of
    // hardcoding '$' in the empty-state placeholders.
    const sym = signals.currency.value.symbol || '$';
    if (snowballMonthsEl) snowballMonthsEl.textContent = '-- months';
    if (snowballInterestEl) snowballInterestEl.textContent = `${sym}-- interest`;
    if (avalancheMonthsEl) avalancheMonthsEl.textContent = '-- months';
    if (avalancheInterestEl) avalancheInterestEl.textContent = `${sym}-- interest`;
    if (recommendationEl) recommendationEl.textContent = '--';
    if (payoffOrderList) render(html``, payoffOrderList);
    render(html`<p class="text-center text-secondary">Add debts to compare payoff strategies.</p>`, strategyResults);
    return;
  }

  const snowball = comparison.snowball;
  const avalanche = comparison.avalanche;
  const savings = avalanche.totalInterest - snowball.totalInterest;

  // CR-Apr24-A3 [P2] findings 32, 33: branch on per-strategy `cannotPayOff`.
  // Pre-fix: both chips always rendered "${months} months" / "${interest}
  // interest" regardless of whether the simulation short-circuited on
  // negative amortization. Users saw numerical payoff projections for
  // plans that can never actually pay the debts off — and because
  // `calculatePayoffDate` returns `months: Infinity` in its guard branch,
  // a future path that forwards that value directly would render the
  // literal string "Infinity months". We preempt both failure modes by
  // switching to an explicit, actionable copy whenever the strategy
  // flagged itself impossible.
  const impossibleCopy = 'Payment below interest — increase minimum';

  // Per-strategy label rendering. When a strategy can't pay off, replace
  // the numerical months/interest text with the explicit failure copy.
  // This keeps the snowball/avalanche tiles visually consistent (same
  // slot, same font weight) while swapping in honest content.
  if (snowballMonthsEl) {
    snowballMonthsEl.textContent = snowball.cannotPayOff
      ? impossibleCopy
      : `${snowball.months} months`;
  }
  if (snowballInterestEl) {
    snowballInterestEl.textContent = snowball.cannotPayOff
      ? '—'
      : `${fmtCur(snowball.totalInterest)} interest`;
  }
  if (avalancheMonthsEl) {
    avalancheMonthsEl.textContent = avalanche.cannotPayOff
      ? impossibleCopy
      : `${avalanche.months} months`;
  }
  if (avalancheInterestEl) {
    avalancheInterestEl.textContent = avalanche.cannotPayOff
      ? '—'
      : `${fmtCur(avalanche.totalInterest)} interest`;
  }

  // Top-level recommendation. Four cases:
  //  (a) both strategies impossible: no recommendation is honest;
  //      explain the structural problem (minimum payments don't cover
  //      monthly interest) and what the user can do about it.
  //  (b) only snowball impossible: recommend avalanche without couching
  //      it as a savings comparison, since snowball has no valid baseline.
  //  (c) only avalanche impossible (rare but possible with extreme rate
  //      distributions): recommend snowball with the same framing.
  //  (d) both viable: fall through to the original recommendation copy.
  let recommendedText: string;
  if (comparison.cannotPayOff) {
    recommendedText = 'Neither plan can pay these debts off at current payments. Increase your monthly payment or renegotiate rates to start making real progress.';
  } else if (snowball.cannotPayOff) {
    recommendedText = 'Avalanche is the only workable plan at current payments. Snowball cannot make progress until your minimum covers monthly interest.';
  } else if (avalanche.cannotPayOff) {
    recommendedText = 'Snowball is the only workable plan at current payments. Avalanche cannot make progress until your minimum covers monthly interest.';
  } else {
    recommendedText = comparison.recommended === 'avalanche'
      ? `Avalanche is the better money-saving plan here, reducing interest by ${fmtCur(Math.max(0, comparison.interestSaved))}.`
      : comparison.interestSaved > 0
        ? `Snowball gives quicker momentum while Avalanche only saves ${fmtCur(comparison.interestSaved)} more in interest.`
        : 'Snowball is the better motivational fit here, with a similar payoff outcome.';
  }

  if (recommendationEl) recommendationEl.textContent = recommendedText;
  if (payoffOrderList) {
    render(html`
      ${avalanche.order.length > 0 ? avalanche.order.map((item, index) => html`
        <div class="payoff-order-row">
          <span>${index + 1}. ${item.name}</span>
          <span class="text-secondary">Month ${item.month}</span>
        </div>
      `) : html`
        <p class="text-secondary">No payoff order available yet.</p>
      `}
    `, payoffOrderList);
  }

  // CR-Apr24-A3 [P2] findings 32, 33: tile-level rendering also honors
  // `cannotPayOff`. Same pattern as the summary labels above. Savings
  // chip only renders when BOTH strategies are viable — comparing
  // interest between a working plan and an impossible plan is
  // meaningless ("saves $X" against a plan that never completes is not
  // a real comparison).
  const snowballPayoffText = snowball.cannotPayOff
    ? 'Cannot pay off at current rate'
    : `${snowball.months} months`;
  const snowballInterestText = snowball.cannotPayOff
    ? '—'
    : fmtCur(snowball.totalInterest);
  const avalanchePayoffText = avalanche.cannotPayOff
    ? 'Cannot pay off at current rate'
    : `${avalanche.months} months`;
  const avalancheInterestText = avalanche.cannotPayOff
    ? '—'
    : fmtCur(avalanche.totalInterest);
  const showSavingsChip = savings !== 0 && !snowball.cannotPayOff && !avalanche.cannotPayOff;

  render(html`
    <div class="strategy-grid">
      <div class="strategy-card strategy-card--snowball">
        <h4>❄️ Snowball Method</h4>
        <p class="strategy-card__desc">Pay smallest balances first for quick wins.</p>
        <div class="strategy-row">
          <span>Payoff time:</span><strong>${snowballPayoffText}</strong>
        </div>
        <div class="strategy-row">
          <span>Total interest:</span><strong>${snowballInterestText}</strong>
        </div>
      </div>
      <div class="strategy-card strategy-card--avalanche">
        <h4>🏔️ Avalanche Method</h4>
        <p class="strategy-card__desc">Pay highest interest first to save money.</p>
        <div class="strategy-row">
          <span>Payoff time:</span><strong>${avalanchePayoffText}</strong>
        </div>
        <div class="strategy-row">
          <span>Total interest:</span><strong>${avalancheInterestText}</strong>
        </div>
      </div>
      ${showSavingsChip ? html`
        <div class="strategy-savings ${savings > 0 ? 'strategy-savings--positive' : 'strategy-savings--negative'}">
          <strong>${savings > 0 ? 'Snowball' : 'Avalanche'} saves ${fmtCur(Math.abs(savings))} in interest!</strong>
        </div>
      ` : nothing}
    </div>
  `, strategyResults);
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

  // CR-Apr24-C2b [P2] findings 103, 107: refresh open debt modals on
  // currency change. Pre-fix: `renderStrategyComparison()` ran only on
  // open + #extra-payment input; the debt-payment modal populated its
  // balance/min labels imperatively at open and never re-ran. A
  // currency change with either modal open kept the stale "$" symbol
  // and locale formatting until close+reopen. These effects watch
  // `signals.currency` and re-fire the relevant open-time render only
  // when that modal is currently active. Cleanup tracked through the
  // existing `bindDebtHandler` cleanup list.
  const strategyCurrencyEffect = effect(() => {
    void signals.currency.value;
    const modal = DOM.get('debt-strategy-modal');
    if (!modal?.classList.contains('active')) return;
    renderStrategyComparison();
  });
  debtHandlerCleanups.push(strategyCurrencyEffect);

  // CR-Apr24-C2b [P2] finding 107 + CR-Apr24-C2c [P2] finding 106:
  // Refresh the open debt-payment modal's context labels on BOTH
  // currency and debt data changes. Pre-fix the labels were populated
  // imperatively at open and never re-rendered.
  //
  // Finding 107 (C2b): currency change left stale "$" formatting.
  // Finding 106 (C2c): edits to the same debt elsewhere left the
  // name/balance/minimum stale while the payment modal was open.
  //
  // Both `signals.currency` and `signals.debts` are read eagerly so
  // Preact subscribes on every execution. The active-guard skips DOM
  // writes when the modal is hidden.
  const paymentDataEffect = effect(() => {
    void signals.currency.value;
    void signals.debts.value;
    const modal = DOM.get('debt-payment-modal');
    if (!modal?.classList.contains('active')) return;
    const paymentIdEl = DOM.get<HTMLInputElement>('debt-payment-id');
    const debtId = paymentIdEl?.value || '';
    if (!debtId) return;
    const debt = getDebt(debtId);
    if (!debt) return;
    // Refresh name (stale on rename — finding 106)
    const paymentNameEl = DOM.get('debt-payment-name');
    if (paymentNameEl) paymentNameEl.textContent = debt.name;
    // Refresh balance + minimum
    const paymentBalanceEl = DOM.get('debt-payment-balance');
    if (paymentBalanceEl) paymentBalanceEl.textContent = fmtCur(debt.balance);
    const paymentMinEl = DOM.get('debt-payment-minimum');
    if (paymentMinEl) paymentMinEl.textContent = fmtCur(debt.minimumPayment);
  });
  debtHandlerCleanups.push(paymentDataEffect);

  // Add Debt Modal
  const addDebtButton = DOM.get('add-debt-btn');
  if (addDebtButton) bindDebtHandler(addDebtButton, 'click', () => {
    _editDebtSnapshot = null; // No snapshot for new debts
    const titleEl = DOM.get('debt-modal-title');
    if (titleEl) titleEl.textContent = 'Add Debt';
    // Reset form fields individually (no form element exists)
    const editIdEl = DOM.get<HTMLInputElement>('edit-debt-id');
    const nameEl = DOM.get<HTMLInputElement>('debt-name');
    const typeEl = DOM.get<HTMLSelectElement>('debt-type');
    const balanceEl = DOM.get<HTMLInputElement>('debt-balance');
    const interestEl = DOM.get<HTMLInputElement>('debt-interest');
    const minimumEl = DOM.get<HTMLInputElement>('debt-minimum');
    const dueDayEl = DOM.get<HTMLInputElement>('debt-due-day');

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

    clearAllDebtModalErrors();
    openModal('debt-modal');
  });

  const deleteDebtButton = DOM.get('delete-debt');
  if (deleteDebtButton) bindDebtHandler(deleteDebtButton, 'click', async () => {
    const editIdEl = DOM.get<HTMLInputElement>('edit-debt-id');
    const debtId = editIdEl?.value || '';
    if (!debtId) return;

    // Design-Review-Apr21 P3 (batch 6 follow-up): the confirmation
    // dialog previously showed "Remove this debt from your tracker?"
    // with no debt name anywhere in the copy. In a session where the
    // user edits several similar debts in sequence, the generic copy
    // gives no cue *which* debt the Delete button will remove —
    // destructive UX best practice is to restate the target verbatim.
    // Fall back to "this debt" defensively if the id can't be resolved
    // (should be impossible because the delete button is hidden unless
    // editing an existing debt, but belt-and-suspenders for refactor
    // safety). Toast after delete also echoes the name so the success
    // announcement stays concrete.
    const targetDebt = getDebts().find(d => d.id === debtId);
    const debtName = targetDebt?.name?.trim() || 'this debt';
    const message = targetDebt
      ? `Delete "${debtName}" from your tracker?`
      : 'Delete this debt from your tracker?';

    const confirmed = await asyncConfirm({
      title: 'Delete Debt',
      message,
      details: 'Only the debt record is removed. All payment transactions stay in your history.',
      type: 'danger',
      confirmText: 'Delete',
      cancelText: 'Cancel'
    });
    if (confirmed) {
      deleteDebt(debtId);
      showToast(targetDebt ? `${debtName} deleted` : 'Debt deleted');
      closeModal('debt-modal');
    }
  });

  const cancelDebtButton = DOM.get('cancel-debt');
  if (cancelDebtButton) bindDebtHandler(cancelDebtButton, 'click', () => closeModal('debt-modal'));

  const saveDebtButton = DOM.get('save-debt');
  if (saveDebtButton) bindDebtHandler(saveDebtButton, 'click', () => {
    const editIdEl = DOM.get<HTMLInputElement>('edit-debt-id');
    const nameEl = DOM.get<HTMLInputElement>('debt-name');
    const typeEl = DOM.get<HTMLSelectElement>('debt-type');
    const balanceEl = DOM.get<HTMLInputElement>('debt-balance');
    const interestEl = DOM.get<HTMLInputElement>('debt-interest');
    const minimumEl = DOM.get<HTMLInputElement>('debt-minimum');
    const dueDayEl = DOM.get<HTMLInputElement>('debt-due-day');

    const editId = editIdEl?.value || '';

    // Phase 5g-4 Slice 1 (Inline-Behavior-Review rev 12, L23): user-visible
    // validation toasts for interest-rate + dueDay BEFORE the setter is
    // invoked. The prior `parseFloat(x || '0') / 100 || 0` pattern masked
    // every unparseable rate to 0% APR (rendering as "interest-free" while
    // interest accrued) and every unparseable due-day to the 1st of the
    // month — both silent. Empty input is treated as "not captured yet"
    // and uses the safe default; non-empty input is parsed strictly and
    // must be within the HTML `min`/`max` bounds the <input type="number">
    // already advertises (0-100 for APR, 1-31 for due-day). The setter
    // (`debt-planner.ts` normalizeInterestRate + normalizeDueDay) remains
    // the defense-in-depth safety net for non-UI callers (event-bus
    // dispatch, sample-data seeder, any future import path).
    const interestRaw = (interestEl?.value ?? '').trim();
    let interestRate = 0;
    if (interestRaw !== '') {
      const interestPercent = parseFloat(interestRaw);
      if (!Number.isFinite(interestPercent)) {
        showToast('Interest rate must be a number (e.g., "19.99").', 'error');
        return;
      }
      if (interestPercent < 0 || interestPercent > 100) {
        showToast('Interest rate must be between 0 and 100.', 'error');
        return;
      }
      interestRate = interestPercent / 100;
    }

    const dueDayRaw = (dueDayEl?.value ?? '').trim();
    let dueDay = 1;
    if (dueDayRaw !== '') {
      const dueDayNum = parseInt(dueDayRaw, 10);
      if (!Number.isFinite(dueDayNum)) {
        showToast('Due day must be a whole number between 1 and 31.', 'error');
        return;
      }
      if (dueDayNum < 1 || dueDayNum > 31) {
        showToast('Due day must be between 1 and 31.', 'error');
        return;
      }
      dueDay = dueDayNum;
    }

    const debtData = {
      name: (nameEl?.value || '').trim(),
      type: (typeEl?.value || 'credit_card') as DebtType,
      balance: parseAmount(balanceEl?.value || 0),
      interestRate,
      minimumPayment: parseAmount(minimumEl?.value || 0),
      dueDay
    };
    if (!debtData.name) {
      setDebtFieldError('debt-name', 'debt-name-error', 'Give your debt a name (e.g., Credit Card or Car Loan).');
      showToast('Give your debt a name (e.g., "Credit Card" or "Car Loan").', 'error');
      return;
    }
    clearDebtFieldError('debt-name', 'debt-name-error');
    if (debtData.balance <= 0) {
      setDebtFieldError('debt-balance', 'debt-balance-error', 'Enter a balance greater than $0.');
      showToast('Balance must be greater than $0.', 'error');
      return;
    }
    clearDebtFieldError('debt-balance', 'debt-balance-error');
    if (editId) {
      // CR-Apr24-C2c [P2] finding 108: detect concurrent modifications.
      // If the debt's editable fields changed after the edit modal was
      // opened, warn the user instead of silently overwriting newer
      // values with stale form state.
      const currentDebt = getDebt(editId);
      if (currentDebt && _editDebtSnapshot && _debtFingerprint(currentDebt) !== _editDebtSnapshot) {
        showToast('This debt was modified elsewhere — your changes will overwrite. Re-open to see latest values.', 'warning');
        // Clear snapshot so the warning doesn't re-fire on second save
        _editDebtSnapshot = null;
      }

      // New-batch P3: `updateDebt` returns `null` when the debt ID is
      // unknown (e.g. the row was deleted in another tab between the
      // modal open and submit). The previous handler reported "Debt
      // updated" unconditionally and closed the modal, hiding the
      // failure from the user. Gate the success messaging on the
      // actual return so stale submissions surface as an error — and
      // keep the modal open so the user can recover.
      const updated = updateDebt(editId, debtData);
      if (!updated) {
        showToast('Couldn\u2019t update that debt \u2014 it may have been deleted elsewhere.', 'error');
        return;
      }
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
    const debtItem = target.closest<HTMLElement>('.debt-item');
    if (!debtItem) return;
    const debtId = debtItem.dataset.debtId;
    if (!debtId) return;
    const debt = getDebt(debtId);
    if (!debt) return;

    if (target.closest('.debt-edit-btn')) {
      const titleEl = DOM.get('debt-modal-title');
      const editIdEl = DOM.get<HTMLInputElement>('edit-debt-id');
      const nameEl = DOM.get<HTMLInputElement>('debt-name');
      const typeEl = DOM.get<HTMLSelectElement>('debt-type');
      const balanceEl = DOM.get<HTMLInputElement>('debt-balance');
      const interestEl = DOM.get<HTMLInputElement>('debt-interest');
      const minimumEl = DOM.get<HTMLInputElement>('debt-minimum');
      const dueDayEl = DOM.get<HTMLInputElement>('debt-due-day');

      // Design-Review-Apr21 P3 (batch 6 follow-up): thread the debt
      // name through both the modal title AND the icon-only delete
      // button's aria-label/title so screen-reader and voice-control
      // users editing several debts in sequence always know which
      // record the destructive action targets. Previously both the
      // heading ("Edit Debt") and the delete button ("Delete debt")
      // were generic, forcing users to reconstruct the target from
      // form values. Matches the identifier-in-label pattern used on
      // the debt list, ledger rows, and savings-goal delete.
      // CR-Apr24-C2c finding 108: snapshot editable fields so Save
      // can detect concurrent modifications.
      _editDebtSnapshot = _debtFingerprint(debt);

      if (titleEl) titleEl.textContent = `Edit Debt: ${debt.name}`;
      if (editIdEl) editIdEl.value = debt.id;
      if (nameEl) nameEl.value = debt.name;
      if (typeEl) typeEl.value = debt.type;
      if (balanceEl) balanceEl.value = String(debt.balance);
      if (interestEl) interestEl.value = (debt.interestRate * 100).toFixed(2);
      if (minimumEl) minimumEl.value = String(debt.minimumPayment);
      if (dueDayEl) dueDayEl.value = String(debt.dueDay);

      // Show delete button when editing
      const delBtn = DOM.get('delete-debt');
      if (delBtn) {
        delBtn.classList.remove('hidden');
        delBtn.setAttribute('aria-label', `Delete ${debt.name}`);
        delBtn.setAttribute('title', `Delete ${debt.name}`);
      }

      clearAllDebtModalErrors();
      openModal('debt-modal');
    } else if (target.closest('.debt-payment-btn')) {
      const paymentIdEl = DOM.get<HTMLInputElement>('debt-payment-id');
      const paymentNameEl = DOM.get('debt-payment-name');
      const paymentBalanceEl = DOM.get('debt-payment-balance');
      const paymentAmountEl = DOM.get<HTMLInputElement>('debt-payment-amount');
      const paymentDateEl = DOM.get<HTMLInputElement>('debt-payment-date');

      if (paymentIdEl) paymentIdEl.value = debt.id;
      if (paymentNameEl) paymentNameEl.textContent = debt.name;
      if (paymentBalanceEl) paymentBalanceEl.textContent = fmtCur(debt.balance);
      const paymentMinEl = DOM.get('debt-payment-minimum');
      if (paymentMinEl) paymentMinEl.textContent = fmtCur(debt.minimumPayment);
      if (paymentAmountEl) paymentAmountEl.value = String(debt.minimumPayment);
      if (paymentDateEl) paymentDateEl.value = getTodayStr();
      clearDebtPaymentModalErrors();
      openModal('debt-payment-modal');
    }
  });

  // Payment Modal
  const cancelDebtPaymentButton = DOM.get('cancel-debt-payment');
  if (cancelDebtPaymentButton) bindDebtHandler(cancelDebtPaymentButton, 'click', () => closeModal('debt-payment-modal'));

  const confirmDebtPaymentButton = DOM.get('confirm-debt-payment');
  if (confirmDebtPaymentButton) bindDebtHandler(confirmDebtPaymentButton, 'click', async () => {
    const btn = DOM.get<HTMLButtonElement>('confirm-debt-payment');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;

    try {
      const paymentIdEl = DOM.get<HTMLInputElement>('debt-payment-id');
      const paymentAmountEl = DOM.get<HTMLInputElement>('debt-payment-amount');
      const paymentDateEl = DOM.get<HTMLInputElement>('debt-payment-date');

      const debtId = paymentIdEl?.value || '';
      const amount = parseAmount(paymentAmountEl?.value || 0);
      const date = paymentDateEl?.value || getTodayStr();
      if (amount <= 0) {
        setDebtFieldError('debt-payment-amount', 'debt-payment-error', 'Enter a payment amount greater than $0.');
        showToast('Enter a payment amount greater than $0.', 'error');
        return;
      }
      clearDebtFieldError('debt-payment-amount', 'debt-payment-error');
      const result = await recordPayment(debtId, amount, date);
      if (!result.isOk) {
        const errMsg = result.error || 'Couldn\u2019t record payment \u2014 check the amount and try again.';
        setDebtFieldError('debt-payment-amount', 'debt-payment-error', errMsg);
        showToast(errMsg, 'error');
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
    renderStrategyComparison();
    openModal('debt-strategy-modal');
  });

  // Design-Review-Apr21 P2: #extra-payment lives inside the open modal,
  // so editing it must recompute the comparison live. Bind an `input`
  // listener (covers typing + arrow-step) so the figures reflect the
  // current value without requiring the modal be closed and re-opened.
  const extraPaymentInput = DOM.get<HTMLInputElement>('extra-payment');
  if (extraPaymentInput) bindDebtHandler(extraPaymentInput, 'input', () => {
    renderStrategyComparison();
  });

  const closeStrategyModalButton = DOM.get('close-strategy-modal');
  if (closeStrategyModalButton) bindDebtHandler(closeStrategyModalButton, 'click', () => closeModal('debt-strategy-modal'));

  // Note: Event bus listeners for debt updates removed
  // Both renderDebtList and updateDebtSummary are now reactive via mountDebtList and mountDebtSummary
  // Signal changes automatically trigger UI updates
}
