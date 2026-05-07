/**
 * Category Detail Modal
 *
 * Shows transactions for a budget category in a modal dialog
 * triggered by clicking a category card in the Budget Allocation panel.
 *
 * @module components/category-detail-panel
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { selectedBudgetCategory } from './envelope-budget.js';
import { html, render } from '../core/lit-helpers.js';
import { fmtCur, toCents, toDollars } from '../core/utils-pure.js';
import { formatViewedMonthPhrase, formatDateShort } from '../core/locale-service.js';
import { getCatInfo } from '../core/categories.js';
// CR-Apr22-E slice 3 (finding 60, [P2]): the envelope-budget cards compute
// per-category spend via `getMonthExpByCat`, which filters through
// `isTrackedExpenseTransaction` — that predicate excludes savings
// transfers (`category === 'savings_transfer'` and legacy `'savings'`
// rows with savings-goal markers). The drill-down previously filtered
// only on `tx.type === 'expense'`, so clicking a card showed MORE rows
// than the card's total summed, breaking the "this card's $N comes from
// these rows" contract. Importing the predicate here and using it in the
// drill-down computed aligns the two views.
import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
// CR-Apr22-E slice 4 (finding 61c [P3]): the mount effect's subscription
// to `userCategoryConfig` used to be incidental — it was established
// transitively through `getCatInfo(...)` inside `renderModalContent`,
// which reads `indexedCategories.value` only for non-savings-transfer
// catIds. That transitive edge was fragile: when catId was a
// savings-transfer id, `getCatInfo` short-circuited on the
// `SAVINGS_TRANSFER_CATEGORY_INFO` constant and the dep-track edge to
// `userCategoryConfig` was never established. A rename of the user's
// categories while the drill-down was open with such an id would leave
// the header stale. Explicitly reading `userCategoryConfig.value` at
// the top of the effect body guarantees a subscription regardless of
// which render path the body takes. Same pattern as CR-Apr22-D slice 1
// used for the dashboard chart effects.
import { userCategoryConfig } from '../core/category-store.js';
import { openModal, closeModal } from '../ui/core/ui.js';
import type { Transaction } from '../../types/index.js';

const MODAL_ID = 'category-detail-modal';

/**
 * Filtered transactions for the selected category
 */
const categoryTransactions = computed(() => {
  const catId = selectedBudgetCategory.value;
  if (!catId) return [];

  const txs = signals.currentMonthTx.value;
  // CR-Apr22-E slice 3: use `isTrackedExpenseTransaction` to match the
  // envelope-budget card's `getMonthExpByCat` filter exactly. The prior
  // `tx.type === 'expense' && tx.category === catId` predicate double-
  // counted savings transfers (legacy `category: 'savings'` + goal tags,
  // or explicit `category: 'savings_transfer'`), so the drill-down list
  // and total drifted above the card's displayed spend on any category
  // with matching id. The header total uses `toCents` sum over the same
  // list below, so aligning the filter keeps the header and the card in
  // lockstep.
  return txs
    .filter(tx => isTrackedExpenseTransaction(tx) && tx.category === catId)
    .sort((a, b) => b.date.localeCompare(a.date));
});

/**
 * Ensure the modal element exists in the DOM
 */
function ensureModal(): HTMLElement {
  let modal = document.getElementById(MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'category-detail-modal-title');
    const container = document.getElementById('modal-container');
    if (container) {
      container.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
  }
  return modal;
}

/**
 * Render the modal content for the selected category
 */
function renderModalContent(catId: string, txs: Transaction[]): void {
  const modal = ensureModal();
  const cat = getCatInfo('expense', catId);
  // rev 12 #16 (cents-math migration): accumulate in integer cents so the
  // category-total header doesn't drift from the sum the budget panel
  // displays — previously `reduce((s, tx) => s + tx.amount, 0)` summed
  // dollars as floats and could disagree with `sumTrackedExpenses` by a
  // trailing cent on datasets that straddled a .10 boundary.
  const total = toDollars(txs.reduce((sum, tx) => sum + toCents(tx.amount), 0));

  // Design-Review-Apr21 P3 (batch 6 follow-up wave L): subtitle + empty
  // state used to hardcode "this month", but the drill-down is
  // populated from `signals.currentMonth.value` (via `currentMonthTx`)
  // — so opening the modal while reviewing April 2026 would still show
  // "X transactions this month" regardless of which month was selected.
  // `formatViewedMonthPhrase` returns "this month" at current-view
  // default and "in April 2026"-style labels when navigated elsewhere.
  const monthPhrase = formatViewedMonthPhrase(signals.currentMonth.value);

  render(html`
    <!--
      Design-Review-Apr21 P3 (batch 6 follow-up wave K): the category drill-down
      is a read-only details view with no editable fields. The first focusable
      descendant was the icon-only Close button, so the shared modal opener
      landed keyboard focus on the dismiss affordance the moment the dialog
      opened — SR users heard the title via aria-labelledby but their keyboard
      cursor was parked on "×". Mark the panel itself as the initial-focus
      target (tabindex="-1" keeps it focusable without adding it to the tab
      order) so focus lands on the dialog content. The dialog title is
      announced via the existing aria-labelledby wiring on the overlay; Tab
      still reaches the Close button as the next control if the user wants to
      dismiss. Matches the tx-detail-modal fix from wave J — same shape,
      same pattern.
    -->
    <div class="rounded-2xl w-full card-shadow modal-panel category-detail-modal__panel"
         tabindex="-1"
         data-modal-initial-focus="true">

      <!-- Header -->
      <div class="category-detail-modal__header">
        <div class="category-detail-modal__title-row">
          <span class="category-detail-modal__emoji">${cat.emoji}</span>
          <div>
            <h3 id="category-detail-modal-title" class="category-detail-modal__title">${cat.name}</h3>
            <p class="category-detail-modal__subtitle">
              ${txs.length} transaction${txs.length !== 1 ? 's' : ''} ${monthPhrase}
            </p>
          </div>
        </div>
        <button class="category-detail-modal__close" @click=${() => {
          closeModal(MODAL_ID);
          selectedBudgetCategory.value = null;
        }} aria-label="Close">&times;</button>
      </div>

      <!-- Total -->
      <div class="category-detail-modal__total">
        <span class="category-detail-modal__total-label">Total spent</span>
        <span class="category-detail-modal__total-amount">${fmtCur(total)}</span>
      </div>

      <!-- Transaction list -->
      ${txs.length === 0
        ? html`<div class="category-detail-modal__empty">No transactions ${monthPhrase}</div>`
        : html`
          <div class="category-detail-modal__list">
            ${txs.map(tx => {
              // CR-Apr22-G slice 2: category drill-down row dates route
              // through the canonical locale service's short-date helper
              // (month + day, no year) so the user's chosen locale is
              // honored. `formatDateShort` parses the `YYYY-MM-DD` string
              // via `parseLocalDate` (H16 contract) to avoid negative-TZ
              // off-by-one.
              const dateStr = formatDateShort(tx.date);
              return html`
                <div class="category-detail-modal__row">
                  <div class="category-detail-modal__row-info">
                    <span class="category-detail-modal__row-desc">${tx.description || 'Untitled'}</span>
                    <span class="category-detail-modal__row-date">${dateStr}</span>
                  </div>
                  <span class="category-detail-modal__row-amount">-${fmtCur(tx.amount)}</span>
                </div>
              `;
            })}
          </div>
        `
      }
    </div>
  `, modal);
}

/**
 * Mount the category detail modal system.
 * Listens to selectedBudgetCategory signal and opens/closes the modal.
 */
export function mountCategoryDetailPanel(): () => void {
  const modal = ensureModal();

  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // re-render on currency change
    // CR-Apr22-E slice 4: explicit subscription to the category config
    // so a rename / recolor / icon swap of the selected drill-down
    // category always re-runs this effect, rerendering the header
    // (emoji + name) to the live record. Without this edge the effect
    // only wakes when currency / selection / transactions change, and
    // a rename made from Settings while the modal was open would leave
    // the header showing the old name.
    userCategoryConfig.value;
    const catId = selectedBudgetCategory.value;
    const txs = categoryTransactions.value;

    if (!catId) {
      return;
    }

    renderModalContent(catId, txs);

    // CR-Apr24-C2a [P2] finding 140: only call openModal when the modal
    // isn't already active. Pre-fix this effect re-runs on currency /
    // category-config / transactions changes — ANY of those mutations
    // while the modal was already open re-triggered openModal which
    // re-scheduled the modal layer's deferred initial-focus logic
    // (CR-Apr24-C1's setTimeout). The re-scheduled focus call yanks
    // focus back to the modal's first control even if the user has
    // clicked elsewhere within the open dialog, breaking keyboard
    // navigation and screen-reader announcements every time
    // underlying data updated. Gate on the active class to make
    // openModal a one-shot per "selectedBudgetCategory becomes truthy".
    if (!modal.classList.contains('active')) {
      openModal(MODAL_ID);
    }
  });

  // When modal is closed via backdrop click, clear the selection
  const handleModalClose = () => {
    // The modal system adds/removes 'active' class
    // We observe this via MutationObserver to sync signal state
    const observer = new MutationObserver(() => {
      if (!modal.classList.contains('active') && selectedBudgetCategory.value) {
        selectedBudgetCategory.value = null;
      }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    return observer;
  };

  const observer = handleModalClose();

  return () => {
    cleanup();
    observer.disconnect();
    if (modal.parentElement) {
      modal.parentElement.removeChild(modal);
    }
  };
}
