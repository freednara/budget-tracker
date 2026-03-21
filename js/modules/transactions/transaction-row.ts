/**
 * Transaction Row Component
 *
 * Single source of truth for transaction row rendering.
 * Used by both paginated and virtual scroll rendering.
 *
 * @module transactions/transaction-row
 */
'use strict';

import { html, render, nothing, styleMap, type LitTemplate } from '../core/lit-helpers.js';
import { parseLocalDate } from '../core/utils.js';
import type { Transaction, CategoryChild, TransactionType } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type CurrencyFormatter = (value: number) => string;
export type CategoryInfoGetter = (type: TransactionType, catId: string) => CategoryChild;

// ==========================================
// CATEGORY LOOKUP CACHE
// ==========================================

/**
 * Module-level cache for category lookups to avoid repeated computation.
 * Call clearCatInfoCache() when categories change.
 */
const catInfoCache = new Map<string, CategoryChild>();

/**
 * Clear the category info cache (call when categories are updated)
 */
export function clearCatInfoCache(): void {
  catInfoCache.clear();
}

// ==========================================
// TRANSACTION ROW TEMPLATE
// ==========================================

/**
 * Generate the transaction row template
 * Returns a lit-html template that can be used in render() or map()
 */
export function transactionRowTemplate(
  t: Transaction,
  getCatInfo: CategoryInfoGetter,
  fmtCur: CurrencyFormatter
): LitTemplate {
  const cacheKey = `${t.type}:${t.category}`;
  let cat = catInfoCache.get(cacheKey);
  if (!cat) {
    cat = getCatInfo(t.type, t.category);
    catInfoCache.set(cacheKey, cat);
  }
  const isExp = t.type === 'expense';
  const noteIcon = t.notes ? '📝' : '';
  const splitIcon = t.splits ? '✂️' : '';
  const tagsList = t.tags ? t.tags.split(',').map(tg => tg.trim()).filter(Boolean) : [];

  const reconcileBtnStyle = t.reconciled
    ? 'color: var(--color-income); background: color-mix(in srgb, var(--color-income) 15%, transparent);'
    : 'color: var(--color-accent); border: 2px dashed var(--color-accent);';

  return html`
    <div class="swipe-container" data-tx-id=${t.__backendId}>
      <div class="swipe-actions-right">
        <button class="swipe-action-btn reconcile-swipe-btn" data-id=${t.__backendId} aria-label=${t.reconciled ? 'Unreconcile' : 'Reconcile'}>
          <span class="swipe-icon">${t.reconciled ? '☑' : '☐'}</span>
          <span>${t.reconciled ? 'Undo' : 'Reconcile'}</span>
        </button>
      </div>
      <div class="swipe-actions-left">
        <button class="swipe-action-btn edit-swipe-btn" data-id=${t.__backendId} style="background: var(--color-accent);" aria-label="Edit">
          <span class="swipe-icon">✏️</span>
          <span>Edit</span>
        </button>
        <button class="swipe-action-btn delete-swipe-btn" data-id=${t.__backendId} style="background: var(--color-expense);" aria-label="Delete">
          <span class="swipe-icon">🗑️</span>
          <span>Delete</span>
        </button>
      </div>
      <div class="swipe-content transaction-row flex items-center gap-3 p-3 rounded-lg" style="background: var(--bg-input); border: 1px solid var(--border-light);" data-id=${t.__backendId}>
        <div class="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0" style=${styleMap({ background: `${cat.color}20` })}>${cat.emoji}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <p class="font-bold text-sm truncate" style="color: var(--text-primary);">${t.description || cat.name}</p>${t.recurring ? html`<span class="insight-badge insight-up text-xs">↻ ${t.recurring_type || ''}</span>` : nothing}${noteIcon}${splitIcon}
          </div>
          <p class="text-xs" style="color: var(--text-secondary);">${parseLocalDate(t.date).toLocaleDateString()} · ${cat.name}</p>
          <div class="flex gap-1 flex-wrap mt-1">${tagsList.map(tag => html`<span class="tag-badge">${tag}</span>`)}</div>
        </div>
        <div class="text-right shrink-0">
          <p class="font-black text-lg" style=${styleMap({ color: isExp ? 'var(--color-expense)' : 'var(--color-income)' })}>${isExp ? '-' : '+'}${fmtCur(t.amount)}</p>
        </div>
        <div class="desktop-actions flex gap-1">
          <button class="reconcile-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-70 flex items-center justify-center text-xl font-bold" data-id=${t.__backendId} title=${t.reconciled ? 'Reconciled - click to unmark' : 'Click to mark as reconciled'} aria-label=${t.reconciled ? 'Mark as unreconciled' : 'Mark as reconciled'} style=${reconcileBtnStyle}>${t.reconciled ? '☑' : '☐'}</button>
          <button class="split-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-70 flex items-center justify-center" data-id=${t.__backendId} title="Split transaction" aria-label="Split this transaction into multiple categories" style="color: var(--color-purple);">✂️</button>
          <button class="edit-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-70 flex items-center justify-center" data-id=${t.__backendId} title="Edit" aria-label="Edit this transaction" style="color: var(--color-accent);">✏️</button>
          <button class="delete-btn min-w-11 min-h-11 p-2 rounded-lg hover:opacity-70 flex items-center justify-center" data-id=${t.__backendId} title="Delete" aria-label="Delete this transaction" style="color: var(--color-expense);">✕</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render a transaction row into a container element
 * Used by virtual scroller for DOM recycling
 */
export function renderTransactionRowIntoContainer(
  containerEl: HTMLElement,
  t: Transaction,
  getCatInfo: CategoryInfoGetter,
  fmtCur: CurrencyFormatter
): void {
  render(transactionRowTemplate(t, getCatInfo, fmtCur), containerEl);
  // Add margin for spacing (matches the space-y-2 in the original)
  containerEl.style.marginBottom = '0.5rem';
}
