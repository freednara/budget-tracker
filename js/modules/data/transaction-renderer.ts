/**
 * Transaction Renderer Module
 * 
 * Handles rendering the transaction list with advanced filtering, 
 * sorting, and pagination using the off-main-thread Worker Manager.
 * 
 * @module transaction-renderer
 */

import { dataSdk } from './data-manager.js';
import * as signals from '../core/signals.js';
import { 
  transactionRowTemplate, 
  emptyTransactionListTemplate, 
  loadingTransactionListTemplate,
  TransactionRowOptions 
} from '../ui/templates/transaction-row-template.js';
import { render, html } from '../core/lit-helpers.js';
import { formatCurrency } from '../core/currency-service.js';
import { modal } from '../core/state-actions.js';
import { openModal, showToast } from '../ui/core/ui.js';
import { swipeManager } from '../ui/interactions/swipe-manager.js';
import { filterTransactions, isWorkerReady, syncWorkerDataset } from '../orchestration/worker-manager.js';
import { monthLabel } from '../core/utils.js';
import DOM from '../core/dom-cache.js';
import type { Transaction, TransactionType, WorkerTransactionFilters } from '../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

let activeAbortController: AbortController | null = null;

// Track last pagination state to avoid unnecessary DOM updates
let lastPaginationState = { totalItems: -1, currentPage: -1, itemsPerPage: -1 };

function countActiveFilters(f: signals.FilterState): number {
  let count = 0;
  if (f.searchText) count++;
  if (f.type !== 'all') count++;
  if (f.category) count++;
  if (f.tags) count++;
  if (f.dateFrom || f.dateTo) count++;
  if (f.minAmount || f.maxAmount) count++;
  if (f.reconciled !== 'all') count++;
  if (f.recurring) count++;
  if (f.showAllMonths) count++;
  return count;
}

function updateTransactionSummary(totalItems: number): void {
  const summaryEl = DOM.get('tx-results-summary');
  if (!summaryEl) return;

  const f = signals.filters.value;
  const activeFilterCount = countActiveFilters(f);
  const scopeLabel = f.showAllMonths ? 'all months' : monthLabel(signals.currentMonth.value);
  const itemLabel = totalItems === 1 ? 'transaction' : 'transactions';
  summaryEl.textContent = `Showing ${totalItems} ${itemLabel} for ${scopeLabel}${activeFilterCount > 0 ? ` · ${activeFilterCount} active filter${activeFilterCount === 1 ? '' : 's'}` : ''}`;
}

// ==========================================
// CONFIGURATION
// ==========================================

export interface RendererConfig {
  itemsPerPage?: number;
  enableSwipeActions?: boolean;
  enablePinIcon?: boolean;
  onEdit?: (tx: Transaction) => void;
  onDelete?: (tx: Transaction) => void;
  onReconcile?: (tx: Transaction) => void;
  onSplit?: (tx: Transaction) => void;
}

let config: RendererConfig = {
  itemsPerPage: 50,
  enableSwipeActions: true,
  enablePinIcon: true,
  onEdit: async (tx) => {
    const { startEditing } = await import('../transactions/index.js');
    startEditing(tx);
  },
  onDelete: (tx) => {
    modal.setDeleteTargetId(tx.__backendId);
    openModal('delete-modal');
  },
  onReconcile: async (tx) => {
    const updated = { ...tx, reconciled: !tx.reconciled };
    const result = await dataSdk.update(updated);
    if (result.isOk) {
      showToast(updated.reconciled ? 'Marked as reconciled' : 'Unmarked as reconciled', 'info');
    }
  },
  onSplit: (tx) => {
    modal.setSplitTxId(tx.__backendId);
    openModal('split-modal');
  }
};

/**
 * Configure the renderer
 */
export function configureRenderer(newConfig: Partial<RendererConfig>): void {
  config = { ...config, ...newConfig };
}

// ==========================================
// RENDERING FUNCTIONS
// ==========================================

/**
 * Render transactions list with full filtering and sorting
 */
export async function renderTransactionsList(resetPage: boolean = false): Promise<void> {
  const container = DOM.get('transactions-list');
  if (!container) return;

  // Cancel any active render request
  if (activeAbortController) {
    activeAbortController.abort();
  }
  
  // Create new controller for this request
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  // Show loading state for large datasets
  if (signals.transactions.value.length > 500) {
    render(loadingTransactionListTemplate(), container);
  }

  // Reset pagination if requested
  if (resetPage) {
    signals.pagination.value = { ...signals.pagination.value, page: 0 };
  }

  // 1. Gather filter values from signals (single source of truth, not DOM)
  const f = signals.filters.value;
  const filters: WorkerTransactionFilters = {
    monthKey: signals.currentMonth.value,
    showAllMonths: f.showAllMonths,
    type: f.type as TransactionType | 'all',
    category: f.category || 'all',
    searchQuery: f.searchText || '',
    tagsFilter: f.tags || '',
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    minAmount: f.minAmount,
    maxAmount: f.maxAmount,
    recurringOnly: f.recurring,
    reconciled: f.reconciled
  };

  // 2. Determine sort options from signal
  const txSort = f.sortBy || 'date-desc';
  const [sortBy, sortDir] = txSort.split('-') as [any, any];

  try {
    // 3. Execute smart filtering (Worker vs Sync) with cancellation support
    const result = await filterTransactions(signals.transactions.value, filters, {
      sortBy: sortBy === 'date' ? 'date' : sortBy === 'amount' ? 'amount' : sortBy === 'category' ? 'category' : 'date',
      sortDir: sortDir === 'asc' ? 'asc' : 'desc',
      page: signals.pagination.value.page || 0,
      pageSize: config.itemsPerPage || 50
    }, activeAbortController);

    // If signal was aborted after await, stop here
    if (signal.aborted) return;

    // 4. Update pagination state
    signals.pagination.value = {
      ...signals.pagination.value,
      totalItems: result.totalItems,
      totalPages: result.totalPages
    };

    // 5. Update display count (skip DOM write if unchanged)
    const countEl = DOM.get('tx-display-count');
    if (countEl) {
      const newCount = String(result.items.length);
      if (countEl.textContent !== newCount) {
        countEl.textContent = newCount;
      }
    }
    updateTransactionSummary(result.totalItems);

    // 6. Render results
    if (result.items.length === 0) {
      render(emptyTransactionListTemplate({
        hasTransactions: signals.transactions.value.length > 0,
        hasActiveFilters: countActiveFilters(f) > 0,
        isAllMonths: f.showAllMonths
      }), container);
      renderPaginationControls(0, 0, config.itemsPerPage || 50);
      return;
    }

    const rowOptions: TransactionRowOptions = {
      showSwipeActions: config.enableSwipeActions,
      showPinIcon: config.enablePinIcon,
      currencyFormatter: formatCurrency,
      onEdit: config.onEdit,
      onDelete: config.onDelete,
      onReconcile: config.onReconcile,
      onSplit: config.onSplit
    };

    const template = html`
      <div class="transactions-container space-y-2">
        ${result.items.map(tx => transactionRowTemplate(tx, rowOptions))}
      </div>
    `;

    render(template, container);

    if (config.enableSwipeActions) {
      container.querySelectorAll<HTMLElement>('.swipe-container').forEach((swipeContainer) => {
        swipeManager.attach(swipeContainer);
      });
    }

    // 7. Render pagination controls
    renderPaginationControls(result.totalItems, result.currentPage, config.itemsPerPage || 50);
  } catch (err) {
    if (err instanceof Error && err.message === 'Request aborted') {
      // Ignore abort errors
      return;
    }
    if (import.meta.env.DEV) console.error('Render error:', err);
    showToast('Failed to render transactions', 'error');
  } finally {
    if (activeAbortController?.signal === signal) {
      activeAbortController = null;
    }
  }
}

/**
 * Render pagination controls
 */
function renderPaginationControls(
  totalItems: number,
  currentPage: number,
  itemsPerPage: number
): void {
  // Skip re-render if pagination values haven't changed
  if (
    lastPaginationState.totalItems === totalItems &&
    lastPaginationState.currentPage === currentPage &&
    lastPaginationState.itemsPerPage === itemsPerPage
  ) {
    return;
  }
  lastPaginationState = { totalItems, currentPage, itemsPerPage };

  const paginationContainer = DOM.get('pagination-controls');
  if (!paginationContainer) return;

  const totalPages = Math.ceil(totalItems / itemsPerPage);
  
  if (totalPages <= 1) {
    paginationContainer.style.display = 'none';
    return;
  }

  paginationContainer.style.display = 'flex';

  const template = html`
    <div class="flex items-center justify-between w-full mt-6 px-2">
      <button 
        class="px-4 py-2 rounded-lg font-bold text-sm btn-secondary"
        ?disabled=${currentPage === 0}
        style="${currentPage === 0 ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
        @click=${() => {
          signals.pagination.value = { ...signals.pagination.value, page: currentPage - 1 };
          renderTransactionsList();
        }}
      >
        ← Previous
      </button>
      
      <span class="text-xs font-bold text-tertiary uppercase tracking-widest">
        Page ${currentPage + 1} of ${totalPages}
      </span>
      
      <button 
        class="px-4 py-2 rounded-lg font-bold text-sm btn-secondary"
        ?disabled=${currentPage >= totalPages - 1}
        style="${currentPage >= totalPages - 1 ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
        @click=${() => {
          signals.pagination.value = { ...signals.pagination.value, page: currentPage + 1 };
          renderTransactionsList();
        }}
      >
        Next →
      </button>
    </div>
  `;

  render(template, paginationContainer);
}

// ==========================================
// EXPORT FOR MIGRATION
// ==========================================

/**
 * Legacy compatibility wrapper
 */
export const legacyCompat = {
  renderTransactions: renderTransactionsList,
  renderTransactionsAsync: renderTransactionsList,
  setTxConfig: configureRenderer,
  setTxFmtCurFn: () => {},
  setRenderCategoriesFn: () => {},
  setEmptyStateFn: () => {},
  setUpdateSplitRemainingFn: () => {}
};
