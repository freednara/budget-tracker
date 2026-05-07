/**
 * Transaction Detail Panel
 *
 * Generic drill-down modal that shows filtered transactions for a savings goal
 * or debt item. Follows the same signal-driven pattern as category-detail-panel.ts.
 *
 * Usage:
 *   import { selectedSavingsGoal, selectedDebt } from './transaction-detail-panel.js';
 *   selectedSavingsGoal.value = { id, name, emoji };   // opens savings drill-down
 *   selectedDebt.value = { id, name, emoji };           // opens debt drill-down
 *
 * @module components/transaction-detail-panel
 */
'use strict';

import { signal, effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, nothing } from '../core/lit-helpers.js';
import { fmtCur, toCents, toDollars, getTodayStr } from '../core/utils-pure.js';
import { formatDateWithYear } from '../core/locale-service.js';
import { safeAmount } from '../core/safe-amount.js';
import { openModal, closeModal } from '../ui/core/ui.js';
import type { Transaction } from '../../types/index.js';

/**
 * A row shown in the savings-goal drill-down. Either a real `Transaction`
 * or a synthetic "Starting balance" row prepended to reconcile the
 * displayed total with the goal card's `saved` amount (see `savingsPanelData`
 * below for the rationale).
 */
type SyntheticStartingRow = {
  id: string;
  description: string;
  date: string;
  amount: number;
  __synthetic: true;
};
type SavingsRow = Transaction | SyntheticStartingRow;
type RenderableRow = Transaction | SyntheticStartingRow;

// ==========================================
// SIGNALS
// ==========================================

export interface DetailTarget {
  id: string;
  name: string;
  emoji: string;
}

/** Set to open the savings goal transaction drill-down. */
export const selectedSavingsGoal = signal<DetailTarget | null>(null);

/** Set to open the debt transaction drill-down. */
export const selectedDebt = signal<DetailTarget | null>(null);

// ==========================================
// CONSTANTS
// ==========================================

const MODAL_ID = 'tx-detail-modal';

// ==========================================
// COMPUTED TRANSACTIONS
// ==========================================

/**
 * Drill-down panel data for the selected savings goal.
 *
 * Rows include every real `savings_transfer` transaction linked to the goal
 * (via the `[id:{goalId}]` marker or the `Savings Transfer: {name}` description).
 *
 * If `goal.saved` exceeds the sum of those real transactions — for example
 * when a goal was seeded with an initial balance, imported with history we
 * can't reconstruct, or created from sample data — a synthetic "Starting
 * balance" row is prepended so the drill-down total reconciles with the
 * `Saved $X of $Y` headline on the goal card.
 *
 * The synthetic row is marked with `__synthetic: true` so future consumers
 * can distinguish it (e.g. to disable editing); it is NOT persisted to the
 * ledger.
 */
interface SavingsPanelData {
  rows: SavingsRow[];
  realCount: number;
  startingBalance: number;
}

const savingsPanelData = computed<SavingsPanelData>(() => {
  const goal = selectedSavingsGoal.value;
  if (!goal) return { rows: [], realCount: 0, startingBalance: 0 };

  const allTx = signals.transactions.value;
  const idMarker = `[id:${goal.id}]`;

  // CR-Apr22-G slice 3: rename-safe description fallback. The primary
  // match is the `[id:goalId]` marker in notes, written by
  // `data-actions.addContribution` for every contemporary contribution.
  // The description-match path only catches legacy rows created before
  // the marker existed — those carry `Savings Transfer: <name>` where
  // <name> is the goal name AT THE TIME the row was written. If the
  // goal has since been renamed, matching against `goal.name` alone
  // would lose those legacy rows. Pull the goal's rename history from
  // the signal (populated by `data-actions.savingsGoals.renameGoal`)
  // and match any description that encodes the current OR any prior
  // name. Falls back to the single-name list for goals that have never
  // been renamed — preserving the legacy behavior for the common case.
  const goalRecordForNames = signals.savingsGoals.value[goal.id];
  const candidateNames = [
    goal.name,
    ...(goalRecordForNames?.historicalNames ?? [])
  ];

  // Real contribution transactions, newest first
  const realTxs = allTx
    .filter(tx => {
      if (tx.notes && tx.notes.includes(idMarker)) return true;
      if (!tx.description) return false;
      return candidateNames.some(n => tx.description!.includes(`Savings Transfer: ${n}`));
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // Fixes H7: signal is canonical `Record<string, SavingsGoal>` post-hydration,
  // so the previous dual-shape `saved ?? saved_amount` accessor is unneeded.
  const goalRecord = signals.savingsGoals.value[goal.id];
  const savedAmount = goalRecord?.saved ?? 0;

  // Cent-precision gap calculation avoids floating point noise
  // rev 12 / #39 M1: `tx.amount || 0` replaced with `safeAmount(tx)` so
  // non-finite ledger values in a goal's linked transactions surface as
  // trackError telemetry rather than silently distorting the reconciled gap.
  const txSumCents = realTxs.reduce(
    (sum, tx) => sum + toCents(safeAmount(tx)),
    0
  );
  const gapCents = toCents(savedAmount) - txSumCents;
  const startingBalance = gapCents > 0 ? toDollars(gapCents) : 0;

  let rows: SavingsRow[] = realTxs;
  if (startingBalance > 0) {
    // Anchor the starting balance row at the oldest real contribution date
    // so chronological sorting keeps it at the bottom.
    //
    // CR-Apr22-G slice 3: when there are no real contributions yet, fall
    // back to the goal's `createdAt` (populated for all new goals by
    // `data-actions.savingsGoals.addGoal`) — not today. Previously the
    // row always dated to today, which was misleading for a goal that
    // had been seeded with a starting balance months ago but never had
    // a real contribution logged: the drill-down would claim the seed
    // happened "today." For legacy goals that predate the `createdAt`
    // field, we still fall back to `getTodayStr()` (parseable local
    // wall-clock date, not UTC toISOString — see ADR-001 §9.5 Step 8).
    //
    // Phase 6 Slice 1i (rev 12 L6): `realTxs[i]` is `T | undefined` under
    // `noUncheckedIndexedAccess`; the `realTxs.length` truthy check
    // guarantees presence but a local guard keeps the `.date` read safe.
    const tail = realTxs[realTxs.length - 1];
    const anchorDate = tail
      ? tail.date
      : (goalRecord?.createdAt || getTodayStr());

    const startingRow: SyntheticStartingRow = {
      id: `__synthetic_starting_${goal.id}`,
      description: 'Starting balance',
      date: anchorDate,
      amount: startingBalance,
      __synthetic: true
    };
    rows = [...realTxs, startingRow];
  }

  return { rows, realCount: realTxs.length, startingBalance };
});

/**
 * Filtered transactions for the selected debt.
 * Primary match: `tx.debtId === debt.id` — exact id linkage written by
 * `RecordPaymentCommand.execute` in debt-planner.ts for every contemporary
 * payment.
 * Fallback match: description substring `"<name> payment"` (lower-cased).
 * Retained for legacy rows created before debtId was enforced on payment
 * transactions. The substring check iterates the FULL name history —
 * current name plus every prior name recorded in the debt's
 * `historicalNames` log — so a rename does not orphan legacy rows that
 * encoded the old name verbatim. See `updateDebt` in debt-planner.ts for
 * the history-tracking counterpart.
 */
const debtTransactions = computed(() => {
  const debt = selectedDebt.value;
  if (!debt) return [];

  const allTx = signals.transactions.value;

  // `selectedDebt` is a slim `DetailTarget` projection {id, name, emoji}.
  // Pull the full Debt record from the signal to reach `historicalNames`.
  // Fall back to a single-name candidate list when the record can't be
  // found (no full record exists yet, or the debt has since been removed).
  const debtRecord = signals.debts.value.find(d => d.id === debt.id) ?? null;
  const candidateNames = [debt.name, ...(debtRecord?.historicalNames ?? [])];
  const lowerCandidates = candidateNames.map(n => `${n.toLowerCase()} payment`);

  return allTx
    .filter(tx => {
      if (tx.debtId === debt.id) return true;
      if (!tx.description) return false;
      const descLower = tx.description.toLowerCase();
      return lowerCandidates.some(pattern => descLower.includes(pattern));
    })
    .sort((a, b) => b.date.localeCompare(a.date));
});

// ==========================================
// MODAL DOM
// ==========================================

function ensureModal(): HTMLElement {
  let modal = document.getElementById(MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'tx-detail-modal-title');
    const container = document.getElementById('modal-container');
    if (container) {
      container.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
  }
  return modal;
}

// ==========================================
// RENDER
// ==========================================

interface RenderOptions {
  emoji: string;
  name: string;
  subtitle: string;
  totalLabel: string;
  totalColor: string;
  amountPrefix: string;
  txs: RenderableRow[];
  /**
   * Empty-state copy when `txs.length === 0`. Design-Review-Apr21 P3
   * (batch 6 follow-up wave P): previously the shared empty state
   * read "No transactions found" regardless of the drill-down
   * scope, which was semantically wrong — the savings-goal panel
   * lists *contributions*, the debt panel lists *payments*. Calling
   * every row a "transaction" blurred the domain vocabulary the
   * parent screens used. Required so callers must specify scope-
   * appropriate copy.
   */
  emptyMessage: string;
  onClose: () => void;
}

function renderPanel(opts: RenderOptions): void {
  const modal = ensureModal();
  // rev 12 #16 (cents-math migration): sum in integer cents so the
  // drill-down total doesn't drift by a trailing cent from the
  // savings-goal `saved` / debt-balance displayed on the parent card.
  // `addContribution` already uses `addAmounts` (cents) for `saved`;
  // this reducer is what the user sees in the transaction list header.
  const total = toDollars(opts.txs.reduce((sum, tx) => sum + toCents(tx.amount), 0));

  render(html`
    <!--
      Design-Review-Apr21 P3 (batch 6 follow-up wave J): the drill-down is a
      read-only details view (savings-goal history, debt-payment history) with
      no editable fields. The first focusable descendant was the icon-only
      Close button, so the shared modal opener landed keyboard focus on the
      dismiss affordance the moment the dialog opened — SR users heard the
      title via aria-labelledby but their keyboard cursor was already parked
      on "×". Mark the panel itself as the initial-focus target (tabindex="-1"
      keeps it focusable without adding it to the tab order) so focus lands on
      the dialog content. The dialog title is announced via the existing
      aria-labelledby wiring on the overlay, and Tab still reaches the Close
      button as the next control if the user wants to dismiss.
    -->
    <div class="rounded-2xl w-full card-shadow modal-panel category-detail-modal__panel"
         tabindex="-1"
         data-modal-initial-focus="true">

      <!-- Header -->
      <div class="category-detail-modal__header">
        <div class="category-detail-modal__title-row">
          <span class="category-detail-modal__emoji">${opts.emoji}</span>
          <div>
            <h3 id="tx-detail-modal-title" class="category-detail-modal__title">${opts.name}</h3>
            <p class="category-detail-modal__subtitle">${opts.subtitle}</p>
          </div>
        </div>
        <button class="category-detail-modal__close" @click=${opts.onClose} aria-label="Close">&times;</button>
      </div>

      <!-- Total -->
      <div class="category-detail-modal__total">
        <span class="category-detail-modal__total-label">${opts.totalLabel}</span>
        <span class="category-detail-modal__total-amount" style="color: var(${opts.totalColor});">${fmtCur(total)}</span>
      </div>

      <!-- Transaction list -->
      ${opts.txs.length === 0
        ? html`<div class="category-detail-modal__empty">${opts.emptyMessage}</div>`
        : html`
          <div class="category-detail-modal__list">
            ${opts.txs.map(tx => {
              // CR-Apr22-G slice 2: detail-panel row dates route through the
              // canonical locale service (short month + day + year, no
              // weekday) so the user's chosen locale is honored rather
              // than the browser default. `formatDateWithYear` parses the
              // `YYYY-MM-DD` string via `parseLocalDate` (H16 contract)
              // so negative-TZ users don't see the previous day.
              const dateStr = formatDateWithYear(tx.date, 'short');
              const isSynthetic = '__synthetic' in tx && tx.__synthetic === true;
              // Synthetic rows (e.g. "Starting balance") are muted and carry a
              // small tag so users can tell them apart from real ledger entries.
              const rowClass = isSynthetic
                ? 'category-detail-modal__row category-detail-modal__row--synthetic'
                : 'category-detail-modal__row';
              const rowStyle = isSynthetic ? 'opacity: 0.7; font-style: italic;' : '';
              return html`
                <div class=${rowClass} style=${rowStyle}>
                  <div class="category-detail-modal__row-info">
                    <span class="category-detail-modal__row-desc">
                      ${tx.description || 'Untitled'}
                      ${isSynthetic
                        ? html`<span class="text-xs font-bold px-1.5 py-0.5 rounded ml-2 not-italic" style="background: var(--bg-tertiary); color: var(--text-secondary);">initial</span>`
                        : nothing}
                    </span>
                    <span class="category-detail-modal__row-date">${dateStr}</span>
                  </div>
                  <span class="category-detail-modal__row-amount" style="color: var(${opts.totalColor});">
                    ${opts.amountPrefix}${fmtCur(tx.amount)}
                  </span>
                </div>
              `;
            })}
          </div>
        `
      }
    </div>
  `, modal);
}

// ==========================================
// MOUNT
// ==========================================

export function mountTransactionDetailPanel(): () => void {
  const modal = ensureModal();

  // Savings goal drill-down
  const savingsCleanup = effect(() => {
    const _cur = signals.currency.value;  // re-render on currency change
    const goal = selectedSavingsGoal.value;
    const data = savingsPanelData.value;
    if (!goal) return;

    // CR-Apr22-G slice 5: prefer the live record's name/icon over the
    // DetailTarget snapshot. `selectedSavingsGoal` is `{id, name, emoji}`
    // captured at open-time. If the user renames the goal or changes its
    // icon via the goal-edit form AFTER the modal opened, the snapshot is
    // stale. `savingsPanelData` already reads `signals.savingsGoals.value`
    // transitively, so this effect re-runs on rename; we just need the
    // header to read from the fresh record rather than the captured
    // DetailTarget. Fall back to the snapshot when the live record is
    // missing (edge case: goal deleted while modal is open).
    const liveGoal = signals.savingsGoals.value[goal.id];
    const headerName = liveGoal?.name ?? goal.name;
    const headerEmoji = liveGoal?.icon ?? goal.emoji;

    // Subtitle reflects real contribution count and, when present,
    // notes that a starting balance is included so the total matches
    // the goal card headline.
    //
    // Design-Review-Apr21 P3 (batch 6 follow-up wave P): appended an
    // "All-time history" marker so the subtitle declares the
    // drill-down's scope. The panel aggregates every contribution
    // ever recorded against the goal, independent of the dashboard's
    // `signals.currentMonth` view — without this marker, a user
    // viewing March 2026 on the dashboard and clicking a savings
    // card could reasonably assume the panel showed March-only
    // contributions. Making the scope explicit prevents that.
    const countPart = `${data.realCount} contribution${data.realCount !== 1 ? 's' : ''}`;
    const scopeSuffix = 'All-time history';
    const subtitle = data.startingBalance > 0
      ? `${countPart} • ${fmtCur(data.startingBalance)} starting balance • ${scopeSuffix}`
      : `${countPart} • ${scopeSuffix}`;

    renderPanel({
      emoji: headerEmoji,
      name: headerName,
      subtitle,
      totalLabel: 'Total contributed',
      totalColor: '--color-income-text',
      amountPrefix: '',
      txs: data.rows,
      emptyMessage: 'No contributions yet',
      onClose: () => {
        closeModal(MODAL_ID);
        selectedSavingsGoal.value = null;
      }
    });
    // CR-Apr24-C2a [P2] finding 139: only open the modal when not
    // already active. This effect re-runs on currency change, on
    // `savingsPanelData` recomputes (which fires whenever
    // `signals.savingsGoals` / contributions / transactions change),
    // and on rename via `liveGoal` lookup. Each rerun calling
    // `openModal` re-schedules the modal layer's deferred-focus timer
    // (CR-Apr24-C1) and yanks focus back to the panel — breaking
    // keyboard navigation and SR announcements every time underlying
    // data updates. Gate so openModal fires once per
    // selectedSavingsGoal-becomes-truthy transition.
    if (!modal.classList.contains('active')) {
      openModal(MODAL_ID);
    }
  });

  // Debt drill-down
  const debtCleanup = effect(() => {
    const _cur = signals.currency.value;  // re-render on currency change
    const debt = selectedDebt.value;
    const txs = debtTransactions.value;
    if (!debt) return;

    // CR-Apr22-G slice 5: prefer the live Debt record's name over the
    // DetailTarget snapshot so a rename reflected via `updateDebt` while
    // the modal is open updates the header. `debtTransactions` already
    // reads `signals.debts.value` (for historicalNames lookup), so this
    // effect is already subscribed. The `Debt` interface has no emoji
    // field; the snapshot emoji stays — callers pass a contextual icon
    // from the debt-list card so there's no "live" icon to prefer.
    const liveDebt = signals.debts.value.find(d => d.id === debt.id) ?? null;
    const headerName = liveDebt?.name ?? debt.name;

    renderPanel({
      emoji: debt.emoji,
      name: headerName,
      // Design-Review-Apr21 P3 (batch 6 follow-up wave P): same
      // scope clarifier as the savings drill-down — the list shows
      // every payment ever recorded against the debt, not the
      // currently-viewed month.
      subtitle: `${txs.length} payment${txs.length !== 1 ? 's' : ''} • All-time history`,
      totalLabel: 'Total paid',
      totalColor: '--color-expense-text',
      amountPrefix: '-',
      txs,
      emptyMessage: 'No payments yet',
      onClose: () => {
        closeModal(MODAL_ID);
        selectedDebt.value = null;
      }
    });
    // CR-Apr24-C2a [P2] finding 139: gate openModal on inactive state.
    // Same rationale as the savings effect above — `debtTransactions`
    // re-fires on rename / payment activity / debts signal mutation,
    // and each rerun re-scheduled the modal-layer focus timer.
    if (!modal.classList.contains('active')) {
      openModal(MODAL_ID);
    }
  });

  // Sync close on backdrop click
  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('active')) {
      if (selectedSavingsGoal.value) selectedSavingsGoal.value = null;
      if (selectedDebt.value) selectedDebt.value = null;
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

  return () => {
    savingsCleanup();
    debtCleanup();
    observer.disconnect();
    if (modal.parentElement) {
      modal.parentElement.removeChild(modal);
    }
  };
}
