/**
 * Split Transactions Module
 * 
 * Handles splitting a transaction into multiple categorized parts using signals and Lit.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { dataSdk } from '../../data/data-manager.js';
import { showToast, closeModal } from '../../ui/core/ui.js';
import { parseAmount, generateId, toCents, toDollars } from '../../core/utils.js';
import { getAllCats } from '../../core/categories.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import type { Transaction } from '../../../types/index.js';

// ==========================================
// CURRENCY FORMATTING
// ==========================================

let splitFmtCurFn: ((v: number) => string) | null = null;

/**
 * Set currency formatter for split transactions
 */
export function setSplitFmtCur(fn: (v: number) => string): void {
  splitFmtCurFn = fn;
}

function formatSplitAmount(amount: number): string {
  return splitFmtCurFn ? splitFmtCurFn(amount) : `$${amount.toFixed(2)}`;
}

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

  if (currentRows.length === 1 && toCents(currentRows[0].amount) === originalCents) {
    const splitEvenlyCents = Math.floor(originalCents / 2);
    const remainderCents = originalCents - splitEvenlyCents;
    nextRows = [{ ...currentRows[0], amount: toDollars(remainderCents) }];
    newAmount = toDollars(splitEvenlyCents);
  }

  const newRow: signals.SplitRow = {
    id: `row_${generateId()}`,
    categoryId: tx.category || 'other',
    amount: newAmount
  };

  signals.splitRows.value = [...nextRows, newRow];
  focusSplitRowAmount(newRow.id);
}

/**
 * Remove a split row
 */
export function removeSplitRow(rowId: string): void {
  signals.splitRows.value = signals.splitRows.value.filter(r => r.id !== rowId);
}

/**
 * Update a split row
 */
export function updateRow(rowId: string, updates: Partial<signals.SplitRow>): void {
  signals.splitRows.value = signals.splitRows.value.map(r => 
    r.id === rowId ? { ...r, ...updates } : r
  );
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
    closeModal('split-modal');
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
    showToast('Transaction split successfully');
  } else {
    showToast(`Split failed: ${result.error}`, 'error');
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
    const txId = signals.splitTxId.value;
    const rows = signals.splitRows.value;
    const status = signals.splitStatus.value;
    
    if (!txId) {
      render(html``, container);
      return;
    }

    const tx = signals.transactions.value.find(t => t.__backendId === txId);
    const cats = getAllCats(tx?.type || 'expense', true);

    const hasIncompleteRows = status.hasEmptyFields;
    const incompleteRows = rows.filter((row) => !row.categoryId || toCents(row.amount) === 0);
    const allocatedAmount = rows.reduce((sum, row) => sum + row.amount, 0);
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
        ? `Over by $${Math.abs(status.remainingAmount).toFixed(2)}`
        : hasIncompleteRows
          ? 'Complete or remove empty split rows'
          : `$${status.remainingAmount.toFixed(2)} remaining`;
    const footerDetail = incompleteRows.length > 0
      ? `${incompleteRows.length} row${incompleteRows.length === 1 ? '' : 's'} still need attention`
      : `Allocated ${formatSplitAmount(allocatedAmount)} of ${formatSplitAmount(status.originalAmount)}`;
    const controlStyle = 'background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);';
    const subtleButtonStyle = 'background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);';
    const removeButtonStyle = 'background: color-mix(in srgb, var(--color-expense) 12%, transparent); color: var(--color-expense); border: 1px solid color-mix(in srgb, var(--color-expense) 28%, transparent);';
    const addRowButtonStyle = 'background: var(--bg-input); color: var(--text-secondary); border: 1px dashed var(--border-input);';
    const saveButtonStyle = status.isValid
      ? 'background: linear-gradient(135deg, var(--color-accent), #2563eb); color: white; border: none;'
      : 'background: color-mix(in srgb, var(--color-accent) 20%, var(--bg-input)); color: var(--text-tertiary); border: 1px solid var(--border-input);';

    render(html`
      <div class="modal-content max-w-2xl w-full p-6">
        <div class="flex justify-between items-center mb-6">
          <h3 class="text-xl font-black text-primary">Split Transaction</h3>
          <button @click=${() => { signals.splitTxId.value = null; closeModal('split-modal'); }} 
                  class="w-10 h-10 rounded-lg font-bold text-lg transition-all"
                  style=${subtleButtonStyle}>✕</button>
        </div>

        <div class="p-4 rounded-xl mb-6 flex justify-between items-center" style="background: var(--bg-card-section);">
          <div>
            <div class="text-xs text-tertiary uppercase font-bold tracking-tighter">Original</div>
            <div class="text-sm font-bold text-primary">${tx?.description}</div>
          </div>
          <div class="text-right">
            <div class="text-xs text-tertiary uppercase font-bold tracking-tighter">Amount</div>
            <div id="split-original-amount" class="text-lg font-black text-primary">$${tx?.amount.toFixed(2)}</div>
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
            const rowControlStyle = rowError
              ? `${controlStyle} border-color: var(--color-warning); box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-warning) 40%, transparent);`
              : controlStyle;

            return html`
              <div class="space-y-1" data-split-row=${r.id}>
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold" style="color: var(--text-secondary);">Split ${index + 1}</span>
                  ${index === 0 && rows.length === 1 ? html`
                    <span class="text-[11px] font-bold" style="color: var(--text-tertiary);">Add another row to break this up</span>
                  ` : ''}
                </div>
                <div class="split-row flex gap-2 items-center">
                  <select class="flex-1 px-2 py-1 rounded text-sm"
                          style=${rowControlStyle}
                          .value=${r.categoryId}
                          @change=${(e: Event) => {
                            const target = e.target as HTMLSelectElement;
                            updateRow(r.id, { categoryId: target.value });
                          }}>
                    ${cats.map(c => html`
                      <option value="${c.id}">${c.parent ? '↳ ' : ''}${c.emoji} ${c.name}</option>
                    `)}
                  </select>
                  
                  <input type="number" 
                         class="w-24 px-2 py-1 rounded text-sm text-right"
                         style=${rowControlStyle}
                         .value=${String(r.amount || '')}
                         placeholder="0.00"
                         step="0.01"
                         @input=${(e: Event) => {
                           const target = e.target as HTMLInputElement;
                           updateRow(r.id, { amount: parseAmount(target.value) });
                         }}>
                  
                  <button @click=${() => removeSplitRow(r.id)} 
                          class="px-3 py-1 rounded text-sm font-bold transition-all"
                          style=${removeButtonStyle}
                          aria-label="Remove split row">Remove</button>
                </div>
                ${rowError ? html`
                  <div class="text-xs font-bold" style="color: var(--color-warning);">
                    ${rowError}
                  </div>
                ` : ''}
              </div>
            `;
          })}
        </div>

        <button id="add-split-row" @click=${addSplitRow} 
                class="w-full py-2 rounded-lg text-sm font-bold transition-all mb-6"
                style=${addRowButtonStyle}>
          + Add Another Category
        </button>

        <div class="flex items-center justify-between p-4 rounded-xl mb-6"
             style="background: ${bgColor}">
          <div>
            <div id="split-remaining" class="text-sm font-bold" style="color: ${textColor}">
              ${statusText}
            </div>
            <div class="text-xs font-bold mt-1" style="color: var(--text-tertiary);">
              ${footerDetail}
            </div>
          </div>
          
          <div class="flex gap-3 min-w-[260px]">
            <button @click=${() => { signals.splitTxId.value = null; closeModal('split-modal'); }} 
                    class="flex-1 py-3 rounded-lg font-bold text-sm transition-all"
                    style=${subtleButtonStyle}>Cancel</button>
            <button id="save-split" @click=${saveSplit}
                    ?disabled=${!status.isValid}
                    class="flex-1 py-3 rounded-lg font-bold text-sm transition-all ${!status.isValid ? 'opacity-70 cursor-not-allowed' : ''}"
                    style=${saveButtonStyle}>
              Save Splits
            </button>
          </div>
        </div>
      </div>
    `, container);
  });

  return cleanup;
}
