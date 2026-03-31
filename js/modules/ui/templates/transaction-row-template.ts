/**
 * Centralized Transaction Row Template
 * 
 * Single source of truth for transaction row HTML structure,
 * eliminating duplication across transaction list, virtual scroller, and legacy views.
 * 
 * @module transaction-row-template
 */

import { html, TemplateResult } from '../../core/lit-helpers.js';
import { getCatInfo } from '../../core/categories.js';
import { escapeHtml, parseLocalDate } from '../../core/utils.js';
import { isSavingsTransferTransaction, getSavingsTransferGoalName } from '../../core/transaction-classification.js';
import type { Transaction, CurrencyFormatter } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface TransactionRowOptions {
  showSwipeActions?: boolean;
  showPinIcon?: boolean;
  showSplitBadge?: boolean;
  currencyFormatter?: CurrencyFormatter;
  onEdit?: (tx: Transaction) => void;
  onDelete?: (tx: Transaction) => void;
  onReconcile?: (tx: Transaction) => void;
  onSplit?: (tx: Transaction) => void;
  onClick?: (tx: Transaction) => void;
}

// ==========================================
// TEMPLATE COMPONENTS
// ==========================================

/**
 * Transaction amount display
 */
function renderAmount(tx: Transaction, fmtCur: CurrencyFormatter): TemplateResult {
  const isSavingsTransfer = isSavingsTransferTransaction(tx);
  const amountClass = isSavingsTransfer
    ? 'savings-transfer-amount'
    : (tx.type === 'income' ? 'income-amount' : 'expense-amount');
  const formattedAmount = fmtCur(typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount));
  
  return html`
    <div class="tx-amount ${amountClass}" style="font-weight: 900; font-size: 1.125rem; white-space: nowrap; text-align: right;">
      ${tx.type === 'income' ? '+' : '-'}${formattedAmount}
    </div>
  `;
}

/**
 * Transaction category chip
 */
function renderCategory(tx: Transaction): TemplateResult {
  const catInfo = getCatInfo(tx.type, tx.category);
  
  return html`
    <span class="cat-chip" style="background: ${catInfo.color}22; color: ${catInfo.color}; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: bold; display: flex; align-items: center; gap: 4px;">
      <span class="cat-emoji">${catInfo.emoji}</span>
      <span class="cat-name">${catInfo.name}</span>
    </span>
  `;
}

function renderTypeBadge(tx: Transaction): TemplateResult {
  if (isSavingsTransferTransaction(tx)) {
    return html`
      <span class="tx-type-badge tx-type-badge--transfer">
        Savings Transfer
      </span>
    `;
  }
  const isIncome = tx.type === 'income';
  return html`
    <span class="tx-type-badge ${isIncome ? 'tx-type-badge--income' : 'tx-type-badge--expense'}">
      ${isIncome ? 'Income' : 'Expense'}
    </span>
  `;
}

/**
 * Transaction badges (recurring, split, etc.)
 */
function renderBadges(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  return html`
    ${tx.recurring ? html`
      <span class="badge badge-recurring" title="Recurring transaction" style="color: var(--color-accent);">
        🔄
      </span>
    ` : ''}
    ${tx.splits && options.showSplitBadge ? html`
      <span class="badge badge-split" title="Split transaction" style="color: var(--color-purple);">
        ✂️
      </span>
    ` : ''}
    ${(tx as any).isPinned && options.showPinIcon ? html`
      <span class="badge badge-pinned" title="Pinned transaction" style="color: var(--color-warning);">
        📌
      </span>
    ` : ''}
  `;
}

/**
 * Transaction actions (edit, delete, reconcile, split)
 */
function renderActions(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  const isReconciled = !!tx.reconciled;
  
  const reconcileBtnStyle = isReconciled
    ? 'color: var(--color-income); background: color-mix(in srgb, var(--color-income) 15%, transparent); border: 1px solid color-mix(in srgb, var(--color-income) 32%, var(--border-input));'
    : 'color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--border-input));';

  return html`
    <div class="desktop-actions transaction-row-actions flex gap-1">
      <button 
        class="reconcile-btn min-w-9 min-h-9 p-2 rounded-lg hover:opacity-100 flex items-center justify-center text-lg font-bold transition-all" 
        style="${reconcileBtnStyle}"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onReconcile?.(tx);
        }}
        title="${isReconciled ? 'Reconciled - click to unmark' : 'Click to mark as reconciled'}"
        aria-label="${isReconciled ? 'Mark as unreconciled' : 'Mark as reconciled'}"
      >
        ${isReconciled ? '☑' : '☐'}
      </button>
      
      <button 
        class="split-btn min-w-9 min-h-9 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all" 
        style="color: var(--color-purple); background: color-mix(in srgb, var(--color-purple) 10%, transparent);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onSplit?.(tx);
        }}
        title="Split transaction"
        aria-label="Split this transaction"
      >
        ✂️
      </button>

      <button 
        class="edit-btn action-btn min-w-9 min-h-9 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all"
        style="color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 10%, transparent);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onEdit?.(tx);
        }}
        aria-label="Edit transaction"
        title="Edit"
      >
        ✏️
      </button>
      
      <button 
        class="delete-btn action-btn min-w-9 min-h-9 p-2 rounded-lg hover:opacity-100 flex items-center justify-center transition-all"
        style="color: var(--color-expense); background: color-mix(in srgb, var(--color-expense) 10%, transparent);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onDelete?.(tx);
        }}
        aria-label="Delete transaction"
        title="Delete"
      >
        ✕
      </button>
    </div>
  `;
}

function renderSwipeActions(tx: Transaction, options: TransactionRowOptions): TemplateResult {
  const isReconciled = !!tx.reconciled;

  return html`
    <div class="swipe-actions-right">
      <button
        class="swipe-action-btn reconcile-swipe-btn"
        style="background: color-mix(in srgb, var(--color-accent) 82%, black 6%);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onReconcile?.(tx);
        }}
        aria-label="${isReconciled ? 'Mark as unreconciled' : 'Mark as reconciled'}"
      >
        <span class="swipe-icon">${isReconciled ? '☑' : '☐'}</span>
        <span>${isReconciled ? 'Undo' : 'Reconcile'}</span>
      </button>
      <button
        class="swipe-action-btn split-swipe-btn"
        style="background: color-mix(in srgb, var(--color-purple) 82%, black 6%);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onSplit?.(tx);
        }}
        aria-label="Split this transaction"
      >
        <span class="swipe-icon">✂️</span>
        <span>Split</span>
      </button>
    </div>
    <div class="swipe-actions-left">
      <button
        class="swipe-action-btn edit-swipe-btn"
        style="background: color-mix(in srgb, var(--color-accent2) 82%, black 6%);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onEdit?.(tx);
        }}
        aria-label="Edit transaction"
      >
        <span class="swipe-icon">✏️</span>
        <span>Edit</span>
      </button>
      <button
        class="swipe-action-btn delete-swipe-btn"
        style="background: color-mix(in srgb, var(--color-expense) 88%, black 4%);"
        @click=${(e: Event) => {
          e.stopPropagation();
          options.onDelete?.(tx);
        }}
        aria-label="Delete transaction"
      >
        <span class="swipe-icon">✕</span>
        <span>Delete</span>
      </button>
    </div>
  `;
}

// ==========================================
// MAIN TEMPLATE
// ==========================================

/**
 * Main transaction row template
 */
export function transactionRowTemplate(
  tx: Transaction,
  options: TransactionRowOptions = {}
): TemplateResult {
  const fmtCur = options.currencyFormatter || ((v: number) => `$${v.toFixed(2)}`);
  const isSavingsTransfer = isSavingsTransferTransaction(tx);
  const goalName = getSavingsTransferGoalName(tx);
  const rowDescription = isSavingsTransfer && goalName
    ? `Transfer to ${goalName}`
    : tx.description;
  
  const rowContent = html`
    <div 
      class="swipe-content transaction-row flex items-center gap-3 p-3 rounded-lg ${tx.type}-row ${isSavingsTransfer ? 'savings-transfer-row' : ''} ${(tx as any).isPinned ? 'pinned' : ''} ${options.showSwipeActions ? 'transaction-row--swipe-ready' : ''}"
      data-id="${tx.__backendId}"
      @click=${() => options.onClick?.(tx)}
      style="transition: transform 0.2s, box-shadow 0.2s; cursor: pointer; margin-bottom: 8px;"
    >
      <div class="tx-main flex-1 min-w-0">
        <div class="tx-top">
          <div class="tx-info min-w-0">
            <div class="tx-description" style="margin-bottom: 4px;">
              <span class="tx-description-text font-bold text-sm" style="color: var(--text-primary);">${rowDescription}</span>
              <span class="tx-badges inline-flex items-center gap-1" style="margin-left: 6px;">${renderBadges(tx, options)}</span>
            </div>
          </div>
          <div class="tx-aside">
            ${renderAmount(tx, fmtCur)}
            ${renderActions(tx, options)}
          </div>
        </div>
        <div class="tx-meta flex items-center gap-2">
          <span class="tx-date text-xs text-secondary">${parseLocalDate(tx.date).toLocaleDateString()}</span>
          ${renderTypeBadge(tx)}
          ${isSavingsTransfer && goalName
            ? html`<span class="tx-goal-meta" title="Savings goal">${goalName}</span>`
            : renderCategory(tx)}
        </div>
      </div>
    </div>
  `;

  if (!options.showSwipeActions) {
    return rowContent;
  }

  return html`
    <div class="swipe-container" data-tx-id="${tx.__backendId}">
      ${renderSwipeActions(tx, options)}
      ${rowContent}
    </div>
  `;
}

/**
 * Simplified template for virtual scroller (performance optimized)
 */
export function transactionRowSimple(
  tx: Transaction,
  fmtCur: CurrencyFormatter = (v) => `$${v.toFixed(2)}`,
  options: TransactionRowOptions = {}
): string {
  const catInfo = getCatInfo(tx.type, tx.category);
  const amount = typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount);
  const isSavingsTransfer = isSavingsTransferTransaction(tx);
  const goalName = getSavingsTransferGoalName(tx);
  const amountClass = isSavingsTransfer ? 'savings-transfer-amount' : (tx.type === 'income' ? 'income-amount' : 'expense-amount');
  const amountSign = tx.type === 'income' ? '+' : '-';
  const rowDescription = isSavingsTransfer && goalName
    ? `Transfer to ${goalName}`
    : tx.description;
  const typeBadge = isSavingsTransfer
    ? '<span class="tx-type-badge tx-type-badge--transfer">Savings Transfer</span>'
    : `<span class="tx-type-badge ${tx.type === 'income' ? 'tx-type-badge--income' : 'tx-type-badge--expense'}">${tx.type === 'income' ? 'Income' : 'Expense'}</span>`;
  const metaSuffix = isSavingsTransfer && goalName
    ? `<span class="tx-goal-meta">${escapeHtml(goalName)}</span>`
    : `<span class="cat-chip" style="background: ${escapeHtml(catInfo.color)}22; color: ${escapeHtml(catInfo.color)}; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: bold; display: inline-flex; align-items: center; gap: 4px;">
              <span class="cat-emoji">${catInfo.emoji}</span>
              <span class="cat-name">${escapeHtml(catInfo.name)}</span>
            </span>`;
  
  const rowContent = `
    <div class="swipe-content transaction-row ${tx.type}-row ${isSavingsTransfer ? 'savings-transfer-row' : ''} ${options.showSwipeActions ? 'transaction-row--swipe-ready' : ''}" data-id="${escapeHtml(tx.__backendId)}">
      <div class="tx-main">
        <div class="tx-top">
          <div class="tx-info">
            <div class="tx-description">
              ${escapeHtml(rowDescription)}
              ${tx.recurring ? '<span class="badge badge-recurring">🔄</span>' : ''}
            </div>
          </div>
          <div class="tx-aside">
            <div class="tx-amount ${amountClass}">
              ${amountSign}${fmtCur(amount)}
            </div>
          </div>
        </div>
        <div class="tx-meta">
          <span class="tx-date">${parseLocalDate(tx.date).toLocaleDateString()}</span>
          ${typeBadge}
          ${metaSuffix}
        </div>
      </div>
    </div>
  `;

  if (!options.showSwipeActions) {
    return rowContent;
  }

  const reconcileLabel = tx.reconciled ? 'Undo' : 'Reconcile';
  const reconcileAria = tx.reconciled ? 'Mark as unreconciled' : 'Mark as reconciled';

  return `
    <div class="swipe-container" data-tx-id="${escapeHtml(tx.__backendId)}">
      <div class="swipe-actions-right">
        <button class="swipe-action-btn reconcile-swipe-btn" data-id="${escapeHtml(tx.__backendId)}" aria-label="${reconcileAria}">
          <span class="swipe-icon">${tx.reconciled ? '☑' : '☐'}</span>
          <span>${reconcileLabel}</span>
        </button>
        ${tx.notes ? `<button class="swipe-action-btn notes-swipe-btn" data-id="${escapeHtml(tx.__backendId)}" aria-label="View notes" title="${escapeHtml(tx.notes)}">
          <span class="swipe-icon">📝</span>
          <span>Notes</span>
        </button>` : ''}
      </div>
      <div class="swipe-actions-left">
        <button class="swipe-action-btn edit-swipe-btn" data-id="${escapeHtml(tx.__backendId)}" aria-label="Edit">
          <span class="swipe-icon">✏️</span>
          <span>Edit</span>
        </button>
        <button class="swipe-action-btn delete-swipe-btn" data-id="${escapeHtml(tx.__backendId)}" aria-label="Delete">
          <span class="swipe-icon">✕</span>
          <span>Delete</span>
        </button>
      </div>
      ${rowContent}
    </div>
  `;
}

/**
 * Empty state template
 */
export function emptyTransactionListTemplate(options: {
  hasTransactions?: boolean;
  hasActiveFilters?: boolean;
  isAllMonths?: boolean;
} = {}): TemplateResult {
  const { hasTransactions = false, hasActiveFilters = false, isAllMonths = false } = options;
  const title = hasTransactions
    ? (hasActiveFilters ? 'No transactions match these filters' : `No transactions for ${isAllMonths ? 'this view' : 'this month'}`)
    : 'No transactions yet';
  const body = hasTransactions
    ? (hasActiveFilters
        ? 'Adjust or clear filters to see more results.'
        : (isAllMonths ? 'Try a different filter or add a new transaction.' : 'Try another month or add a new transaction.'))
    : 'Add your first transaction to start tracking';

  return html`
    <div class="empty-state text-center py-12">
      <div class="empty-icon text-5xl mb-4">📊</div>
      <h3 class="text-lg font-black text-primary">${title}</h3>
      <p class="text-secondary">${body}</p>
    </div>
  `;
}

/**
 * Loading state template
 */
export function loadingTransactionListTemplate(): TemplateResult {
  return html`
    <div class="loading-state text-center py-12">
      <div class="spinner animate-spin rounded-full h-12 w-12 mx-auto mb-4" style="border: 2px solid transparent; border-bottom-color: var(--color-accent);"></div>
      <p class="text-secondary">Loading transactions...</p>
    </div>
  `;
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Create a row renderer function for virtual scroller
 */
export function createRowRenderer(
  options: TransactionRowOptions = {}
): (tx: Transaction, index: number) => string {
  const fmtCur = options.currencyFormatter || ((v: number) => `$${v.toFixed(2)}`);
  
  return (tx: Transaction, _index: number) => {
    return transactionRowSimple(tx, fmtCur, options);
  };
}

/**
 * Batch render multiple transactions
 */
export function batchRenderTransactions(
  transactions: Transaction[],
  options: TransactionRowOptions = {}
): TemplateResult {
  return html`
    ${transactions.map(tx => transactionRowTemplate(tx, options))}
  `;
}
