/**
 * Split Transactions Module
 * 
 * Handles splitting a transaction into multiple categorized parts using signals and Lit.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { modal } from '../../core/state-actions.js';
import { dataSdk } from '../../data/data-manager.js';
import { emit, Events } from '../../core/event-bus.js';
import { parseAmount, generateId, toCents, toDollars, fmtCur } from '../../core/utils-pure.js';
import { getAllCats } from '../../core/categories.js';
// CR-Apr22-D slice 6 (finding 64, [P3]): `addSplitRow` previously seeded
// a missing-category split as the hardcoded literal `'other'`. That id
// only exists on the DEFAULT preset — under `household`, `freelance`, or
// `business` the id-space is different (`home_supplies`,
// `contract_income`, etc.), so the fallback itself became a phantom id
// and the split row rendered with a dangling category option value.
// Reuse the shared `pickFallbackCategoryId` helper added in CR-Apr22-B
// slice 1 so the fallback is always a real category id under the user's
// active preset (tier 1 visible `other*`, tier 2 first visible, tier 3
// any candidate — matches the post-delete remap contract).
import { pickFallbackCategoryId, userCategoryConfig } from '../../core/category-store.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';

function focusSplitRowAmount(rowId: string): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-split-row="${rowId}"] input[type="number"]`);
    input?.focus();
    input?.select();
  });
}

// ==========================================
// ACTIONS
// ==========================================

/**
 * Add a new split row
 */
export function addSplitRow(): void {
  const txId = signals.splitTxId.value;
  if (!txId) return;

  const tx = signals.transactions.value.find(t => t.__backendId === txId);
  if (!tx) return;
  const currentRows = signals.splitRows.value;
  const originalCents = toCents(tx.amount);
  const allocatedCents = currentRows.reduce((sum, row) => sum + toCents(row.amount), 0);
  const remainingCents = Math.max(0, originalCents - allocatedCents);

  let nextRows = currentRows;
  let newAmount = toDollars(remainingCents);

  // Phase 6 Slice 1i (rev 12 L6): `currentRows[0]` is `SplitRow | undefined`
  // under `noUncheckedIndexedAccess`; the `length === 1` guard guarantees
  // presence, but a local narrow keeps the spread/access type-safe.
  const firstRow = currentRows[0];
  if (currentRows.length === 1 && firstRow && toCents(firstRow.amount) === originalCents) {
    const splitEvenlyCents = Math.floor(originalCents / 2);
    const remainderCents = originalCents - splitEvenlyCents;
    nextRows = [{ ...firstRow, amount: toDollars(remainderCents) }];
    newAmount = toDollars(splitEvenlyCents);
  }

  // CR-Apr22-D slice 6: if the parent transaction has a valid category,
  // use it. Otherwise resolve a preset-agnostic fallback against the
  // user's current category config — `pickFallbackCategoryId` walks the
  // same tier-1 visible `other*` → tier-2 first visible → tier-3 any
  // hierarchy used by the post-delete remap path, so the fallback id is
  // guaranteed to exist on whichever preset the user is on. If the
  // config has zero categories of the transaction's type (degenerate
  // case — the split modal couldn't render anyway because `getAllCats`
  // above would be empty), fall back to the literal `'other'` as a
  // last-resort placeholder so the row shape is still well-typed; the
  // status signal's `hasEmptyFields` branch will surface the invalid
  // state to the user.
  const config = userCategoryConfig.value;
  const catType: 'expense' | 'income' = tx.type === 'income' ? 'income' : 'expense';
  const fallbackCat = config ? pickFallbackCategoryId(config, catType, '') : null;
  const fallbackCatId = fallbackCat?.id ?? 'other';

  const newRow: signals.SplitRow = {
    id: `row_${generateId()}`,
    categoryId: tx.category || fallbackCatId,
    amount: newAmount
  };

  modal.setSplitRows([...nextRows, newRow]);
  focusSplitRowAmount(newRow.id);
}

/**
 * Remove a split row
 */
export function removeSplitRow(rowId: string): void {
  modal.removeSplitRow(rowId);
}

/**
 * Update a split row
 */
export function updateRow(rowId: string, updates: Partial<signals.SplitRow>): void {
  modal.updateSplitRow(rowId, updates);
}

/**
 * Save the split transaction
 */
export async function saveSplit(): Promise<void> {
  const status = signals.splitStatus.value;
  const txId = signals.splitTxId.value;
  const rows = signals.splitRows.value;

  if (!status.isValid || !txId) return;

  const origTx = signals.transactions.value.find(t => t.__backendId === txId);
  if (!origTx) return;

  const splitData = rows.map(r => ({
    category: r.categoryId,
    amount: r.amount
  }));

  const result = await dataSdk.splitTransaction(origTx, splitData);

  if (result.isOk) {
    emit(Events.CLOSE_MODAL, { id: 'split-modal' });
    modal.clearSplitTxId();
    emit(Events.SHOW_TOAST, { message: 'Transaction split successfully', type: 'success' });
  } else {
    emit(Events.SHOW_TOAST, { message: 'Couldn\u2019t split this transaction \u2014 close other tabs and try again.', type: 'error' });
  }
}

// ==========================================
// RENDERER
// ==========================================

/**
 * Mount the reactive split modal component
 */
export function mountSplitModal(): () => void {
  const container = DOM.get('split-modal');
  if (!container) return () => {};

  const cleanup = effect(() => {
    // CR-Apr24-C2b [P2] finding 100: subscribe to currency so an open
    // split modal re-renders with refreshed `fmtCur()` formatting after
    // a settings change. Pre-fix the effect woke only on splitTxId /
    // splitRows / splitStatus changes — a currency switch with the
    // modal already open kept showing stale "$1,000.00" on a yen
    // ledger until the user touched a split row.
    void signals.currency.value;
    // CR-Apr24-I finding 99: explicit category dependency so the split
    // modal re-renders its category dropdowns after a rename / recolor.
    void signals.categoryVersion.value;
    const txId = signals.splitTxId.value;
    const rows = signals.splitRows.value;
    const status = signals.splitStatus.value;

    if (!txId) {
      render(html``, container);
      return;
    }

    const tx = signals.transactions.value.find(t => t.__backendId === txId);
    const cats = getAllCats(tx?.type || 'expense');

    const hasIncompleteRows = status.hasEmptyFields;
    const incompleteRows = rows.filter((row) => !row.categoryId || toCents(row.amount) === 0);
    // rev 12 #16 (cents-math migration): sum split rows in integer cents so
    // the footer "Allocated $X of $Y" line agrees with `status.remainingAmount`
    // (which is computed in cents via the split-status signal). A pure-float
    // sum here could display $49.99 / $50.00 while the validator says
    // "Balanced", which confuses users and looks like a validator bug.
    const allocatedAmount = toDollars(rows.reduce((sum, row) => sum + toCents(row.amount), 0));
    const bgColor = status.isValid
      ? 'var(--color-income)15'
      : status.remainingAmount < 0
        ? 'var(--color-expense)15'
        : hasIncompleteRows
          ? 'color-mix(in srgb, var(--color-warning) 12%, var(--bg-input))'
          : 'var(--bg-input)';
    const textColor = status.isValid
      ? 'var(--color-income)'
      : status.remainingAmount < 0
        ? 'var(--color-expense)'
        : hasIncompleteRows
          ? 'var(--color-warning)'
          : 'var(--text-secondary)';
    const statusText = status.isValid
      ? '✓ Balanced'
      : status.remainingAmount < 0
        ? `Over by ${fmtCur(Math.abs(status.remainingAmount))}`
        : hasIncompleteRows
          ? 'Complete or remove empty split rows'
          : `${fmtCur(status.remainingAmount)} remaining`;
    const footerDetail = incompleteRows.length > 0
      ? `${incompleteRows.length} row${incompleteRows.length === 1 ? '' : 's'} still need attention`
      : `Allocated ${fmtCur(allocatedAmount)} of ${fmtCur(status.originalAmount)}`;
    // UI/UX Review (CSS drift fix): replaced inline style strings with
    // CSS utility classes. Error variant kept as conditional style since
    // it's dynamically applied per-row.
    const controlErrorStyle = 'border-color: var(--color-warning); box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-warning) 40%, transparent);';

    render(html`
      <div class="modal-content max-w-2xl w-full p-6">
        <div class="flex justify-between items-center mb-6">
          <h3 class="text-xl font-black text-primary">Split Transaction</h3>
          <button @click=${() => { modal.clearSplitTxId(); emit(Events.CLOSE_MODAL, { id: 'split-modal' }); }}
                  class="w-10 h-10 rounded-lg font-bold text-lg transition-all form-input-secondary"
                  aria-label="Close split transaction modal"
                  title="Close">✕</button>
        </div>

        <div class="p-4 rounded-xl mb-6 flex justify-between items-center card-section">
          <div>
            <div class="text-xs text-tertiary uppercase font-bold tracking-tighter">Original</div>
            <div class="text-sm font-bold text-primary">${tx?.description}</div>
          </div>
          <div class="text-right">
            <div class="text-xs text-tertiary uppercase font-bold tracking-tighter">Amount</div>
            <div id="split-original-amount" class="text-lg font-black text-primary">${tx ? fmtCur(tx.amount) : fmtCur(0)}</div>
          </div>
        </div>

        <div id="split-rows" class="space-y-3 mb-6 max-h-[40vh] overflow-y-auto pr-2">
          ${repeat(rows, r => r.id, (r, index) => {
            const hasAmountError = toCents(r.amount) === 0;
            const hasCategoryError = !r.categoryId;
            const rowError = hasCategoryError
              ? 'Choose a category'
              : hasAmountError
                ? 'Enter an amount greater than 0'
                : '';
            const rowControlStyle = rowError ? controlErrorStyle : '';

            return html`
              <div class="space-y-1" data-split-row=${r.id}>
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-secondary">Split ${index + 1}</span>
                  ${index === 0 && rows.length === 1 ? html`
                    <span class="text-[11px] font-bold text-tertiary">Add another row to break this up</span>
                  ` : ''}
                </div>
                <div class="split-row flex gap-2 items-center">
                  <!--
                    Design-Review-Apr21 P2 (batch 6 follow-up): each
                    split row previously exposed two unlabeled form
                    controls (category select + amount input). Visual
                    context ("Split 1", "Split 2"...) was present but
                    wasn't bound to the controls, so screen-reader
                    users walking the modal hit a sequence of bare
                    "combobox" / "spin button" announcements with no
                    way to tell which row owned which field. Added
                    row-scoped aria-labels that combine the row
                    identity with the field purpose — "Split N
                    category" / "Split N amount" — so each control
                    announces full context on focus. Matches the
                    identifier-in-label pattern used for ledger
                    edit/delete/reconcile/split controls and the
                    debt-list edit/delete/payment buttons.

                    Design-Review-Apr21 P3 (batch 6 follow-up): the
                    shared modal opener's focus-resolver picks the
                    first focusable control unless one is tagged with
                    data-modal-initial-focus. The Close button comes
                    first in DOM order, so the dialog used to open
                    focused on dismiss instead of the first editable
                    field. Tag the FIRST row's category select as
                    the explicit initial-focus target so keyboard
                    users land ready to edit. Subsequent rows
                    intentionally omit the tag — the resolver only
                    reads the first match.
                  -->
                  <select class="flex-1 px-2 py-1 rounded text-sm form-input"
                          style=${rowControlStyle}
                          .value=${r.categoryId}
                          aria-label=${`Split ${index + 1} category`}
                          aria-describedby=${rowError ? `split-row-${r.id}-error` : null}
                          aria-invalid=${hasCategoryError ? 'true' : 'false'}
                          ?data-modal-initial-focus=${index === 0}
                          @change=${(e: Event) => {
                            const target = e.target as HTMLSelectElement;
                            updateRow(r.id, { categoryId: target.value });
                          }}>
                    ${cats.map(c => html`
                      <option value="${c.id}">${c.emoji} ${c.name}</option>
                    `)}
                  </select>

                  <input type="number"
                         class="w-24 px-2 py-1 rounded text-sm text-right form-input"
                         style=${rowControlStyle}
                         .value=${String(r.amount || '')}
                         placeholder="0.00"
                         step="0.01"
                         aria-label=${`Split ${index + 1} amount`}
                         aria-describedby=${rowError ? `split-row-${r.id}-error` : null}
                         aria-invalid=${hasAmountError ? 'true' : 'false'}
                         @input=${(e: Event) => {
                           const target = e.target as HTMLInputElement;
                           updateRow(r.id, { amount: parseAmount(target.value) });
                         }}>

                  <!--
                    Design-Review-Apr21 P3 (batch 6 follow-up):
                    previously every remove button announced the same
                    "Remove split row" text, so AT users in a
                    multi-row split could not tell which row the
                    action targeted without walking surrounding
                    content. Interpolate the row index into the
                    accessible name so the button announces
                    "Remove split 2" / "Remove split 3" etc.,
                    mirroring the two-tap delete pattern used on
                    debts and savings goals.
                  -->
                  <button @click=${() => removeSplitRow(r.id)}
                          class="px-3 py-1 rounded text-sm font-bold transition-all btn-tinted-outline text-expense"
                          aria-label=${`Remove split ${index + 1}`}>Remove</button>
                </div>
                ${rowError ? html`
                  <div id="split-row-${r.id}-error" role="alert" class="text-xs font-bold text-warning">
                    ${rowError}
                  </div>
                ` : ''}
              </div>
            `;
          })}
        </div>

        <button id="add-split-row" @click=${addSplitRow}
                class="w-full py-2 rounded-lg text-sm font-bold transition-all mb-6 btn-dashed">
          + Add Another Category
        </button>

        <div class="flex items-center justify-between p-4 rounded-xl mb-6"
             style="background: ${bgColor}">
          <div>
            <div id="split-remaining" class="text-sm font-bold" style="color: ${textColor}">
              ${statusText}
            </div>
            <div class="text-xs font-bold mt-1 text-tertiary">
              ${footerDetail}
            </div>
          </div>
          
          <div class="flex gap-3 min-w-[260px]">
            <button @click=${() => { modal.clearSplitTxId(); emit(Events.CLOSE_MODAL, { id: 'split-modal' }); }}
                    class="flex-1 py-3 rounded-lg font-bold text-sm transition-all form-input-secondary">Cancel</button>
            <button id="save-split" @click=${saveSplit}
                    ?disabled=${!status.isValid}
                    class="flex-1 py-3 rounded-lg font-bold text-sm transition-all ${status.isValid ? 'btn-primary' : 'opacity-70 cursor-not-allowed form-input-secondary'}">
              Save Splits
            </button>
          </div>
        </div>
      </div>
    `, container);
  });

  return cleanup;
}
