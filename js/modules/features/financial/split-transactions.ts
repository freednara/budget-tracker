/**
 * Split Transactions Module
 *
 * Handles splitting a transaction into multiple categorized parts.
 *
 * @module split-transactions
 */
'use strict';

import * as signals from '../../core/signals.js';
import { modal } from '../../core/state-actions.js';
import { dataSdk } from '../../data/data-manager.js';
import { showToast, closeModal } from '../../ui/core/ui.js';
import { parseAmount, toCents, esc } from '../../core/utils.js';
import { getAllCats } from '../../core/categories.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, FlattenedCategory } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;

interface SplitRowData {
  cat: string;
  amt: number;
}

interface SplitData {
  category: string;
  amount: number;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v) => '$' + v.toFixed(2);
let splitResetMs = 2000;

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Set the currency formatter function
 */
export function setSplitFmtCur(fn: CurrencyFormatter): void {
  fmtCur = fn;
}

/**
 * Set the split reset timing
 */
export function setSplitResetMs(ms: number): void {
  splitResetMs = ms;
}

// ==========================================
// SPLIT REMAINING DISPLAY
// ==========================================

/**
 * Update the split remaining display with real-time validation
 */
export function updateSplitRemaining(): void {
  const el = DOM.get('split-remaining');
  const splitTxId = signals.splitTxId.value;
  if (!el || !splitTxId) return;

  const transactions = signals.transactions.value;
  const origTx = transactions.find(t => t.__backendId === splitTxId);
  if (!origTx) return;

  const rows = document.querySelectorAll<HTMLElement>('#split-rows .split-row');
  const saveBtn = DOM.get('save-split') as HTMLButtonElement | null;

  let total = 0;
  let hasEmptyAmount = false;
  let hasInvalidCategory = false;

  // Validate each row in real-time
  rows.forEach(row => {
    const inp = row.querySelector('.split-amt') as HTMLInputElement | null;
    const catSelect = row.querySelector('.split-cat') as HTMLSelectElement | null;
    const val = parseAmount(inp?.value || '');

    // Check if amount is empty
    if (!inp?.value || val === 0) {
      hasEmptyAmount = true;
      inp?.classList.add('border-warning');
      inp?.setAttribute('aria-invalid', 'true');
    } else {
      inp?.classList.remove('border-warning');
      inp?.removeAttribute('aria-invalid');
    }

    // Check if category is selected
    if (!catSelect?.value) {
      hasInvalidCategory = true;
      catSelect?.classList.add('border-warning');
      catSelect?.setAttribute('aria-invalid', 'true');
    } else {
      catSelect?.classList.remove('border-warning');
      catSelect?.removeAttribute('aria-invalid');
    }

    total += val;
  });

  const rem = origTx.amount - total;

  // Visual feedback based on remaining amount
  if (rem === 0 && rows.length > 0 && !hasEmptyAmount && !hasInvalidCategory) {
    el.textContent = '✓ Splits total matches original';
    el.style.color = 'var(--color-income)';
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  } else if (rem > 0) {
    el.textContent = `${fmtCur(rem)} remaining to allocate`;
    el.style.color = 'var(--color-warning)';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
  } else if (rem < 0) {
    el.textContent = `Over by ${fmtCur(Math.abs(rem))}`;
    el.style.color = 'var(--color-expense)';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
  } else if (hasEmptyAmount || hasInvalidCategory) {
    el.textContent = 'Complete all split rows';
    el.style.color = 'var(--color-warning)';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
  }

  // Update ARIA live region for screen readers
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('role', 'status');
}

// ==========================================
// EVENT HANDLERS
// ==========================================

/**
 * Initialize split transaction event handlers
 */
export function initSplitHandlers(): void {
  // Cancel split
  DOM.get('cancel-split')?.addEventListener('click', () => {
    closeModal('split-modal');
    modal.clearSplitTxId();
  });

  // Add split row
  DOM.get('add-split-row')?.addEventListener('click', () => {
    const container = DOM.get('split-rows');
    if (!container) return;

    const transactions = signals.transactions.value;
    const splitTxId = signals.splitTxId.value;
    const origTx = transactions.find(t => t.__backendId === splitTxId);
    const cats = getAllCats(origTx ? origTx.type : 'expense', true) as FlattenedCategory[];

    const row = document.createElement('div');
    row.className = 'split-row';
    row.innerHTML = `<select class="split-cat px-2 py-1 rounded text-sm" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-input);">
      ${cats.map(c => {
        const indent = c.parent ? '&nbsp;&nbsp;↳ ' : '';
        return `<option value="${c.id}">${indent}${esc(c.emoji)} ${esc(c.name)}</option>`;
      }).join('')}
    </select>
    <input type="number" class="split-amt px-2 py-1 rounded text-sm text-right" step="0.01" min="0" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-input);" placeholder="0.00">
    <button type="button" class="del-split-row text-sm px-2" style="color:var(--color-expense);">✕</button>`;
    container.appendChild(row);

    const deleteBtn = row.querySelector('.del-split-row');
    deleteBtn?.addEventListener('click', () => {
      row.remove();
      updateSplitRemaining();
    });

    const amountInput = row.querySelector('.split-amt');
    amountInput?.addEventListener('input', updateSplitRemaining);
  });

  // Save split
  DOM.get('save-split')?.addEventListener('click', async () => {
    const splitTxId = signals.splitTxId.value;
    if (!splitTxId) return;

    const transactions = signals.transactions.value;
    const origTx = transactions.find(t => t.__backendId === splitTxId);
    if (!origTx) return;

    const rows = document.querySelectorAll<HTMLElement>('#split-rows .split-row');
    if (!rows.length) return;

    // Validate split amounts sum to original
    // Use integer cents to avoid floating point accumulation errors
    let splitTotalCents = 0;
    const splits: SplitRowData[] = [];

    for (const row of rows) {
      const catSelect = row.querySelector('.split-cat') as HTMLSelectElement | null;
      const amtInput = row.querySelector('.split-amt') as HTMLInputElement | null;
      const cat = catSelect?.value || '';
      const amt = parseAmount(amtInput?.value || '');

      if (amt > 0) {
        splits.push({ cat, amt });
        splitTotalCents += toCents(amt);
      }
    }
    if (splits.length === 0) return;

    const origCents = toCents(origTx.amount);
    const splitTotal = splitTotalCents / 100;

    if (splitTotalCents !== origCents) {
      const rem = DOM.get('split-remaining');
      if (rem) {
        rem.style.color = 'var(--color-expense)';
        rem.textContent = fmtCur(origTx.amount - splitTotal) + ' remaining!';
        setTimeout(() => {
          rem.style.color = '';
          updateSplitRemaining();
        }, splitResetMs);
      }
      return;
    }

    // Use atomic split operation - either all succeeds or all fails
    // This prevents partial failures that could leave duplicate spending
    const splitData: SplitData[] = splits.map(({ cat, amt }) => ({
      category: cat,
      amount: amt
    }));

    const result = await dataSdk.splitTransaction(origTx, splitData);

    if (!result.isOk) {
      showToast(`Split failed: ${result.error}`, 'error');
      return; // keep modal open
    }

    closeModal('split-modal');
    modal.clearSplitTxId();
    showToast('Transaction split successfully');
  });
}
