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
import { render, html, repeat } from '../core/lit-helpers.js';
import { modal } from '../core/state-actions.js';
import { emit, Events } from '../core/event-bus.js';
import { swipeManager } from '../ui/interactions/swipe-manager.js';
import { filterTransactions } from '../orchestration/worker-manager.js';
import { fmtCur, monthLabel } from '../core/utils-pure.js';
import { formatDateWithYear } from '../core/locale-service.js';
import { getCatInfo } from '../core/categories.js';
import { countActiveFilters, filterStateToWorkerFilters } from '../core/filter-utils.js';
import DOM from '../core/dom-cache.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

let activeAbortController: AbortController | null = null;

// Track last pagination state to avoid unnecessary DOM updates
let lastPaginationState = { totalItems: -1, currentPage: -1, itemsPerPage: -1 };

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
  // Callbacks may be sync or async. Accepting `Promise<void>` explicitly lets
  // callers pass `async` handlers without wrapping in an IIFE; the renderer
  // never awaits these — it fires and forgets, so async callbacks must do
  // their own error routing (trackError) if needed.
  onEdit?: (tx: Transaction) => void | Promise<void>;
  onDelete?: (tx: Transaction) => void | Promise<void>;
  onReconcile?: (tx: Transaction) => void | Promise<void>;
  onSplit?: (tx: Transaction) => void | Promise<void>;
}

/**
 * Route a transaction-row edit click to the correct entry path.
 *
 * CR-Apr24-C3 [P2] finding 144: recurring transactions must go through
 * the edit-series chooser modal so the user can decide whether the
 * edit applies to this single occurrence only or to all future
 * occurrences (template + this row + every later instance). Pre-fix
 * every edit path jumped straight into single-occurrence edit mode
 * regardless of recurring status, making the "edit recurring" feature
 * a dead modal nobody could reach.
 *
 * The chooser handlers in `modal-events.ts:setupEditRecurringModal`
 * already exist and work correctly — they write `editSeriesMode` and
 * call `startEditing(tx)`. This routing helper supplies the missing
 * writer for `pendingEditTx` and the missing modal-open trigger.
 *
 * Recurring detection requires BOTH `tx.recurring` AND
 * `tx.recurringTemplateId` so a one-off "recurring" rounding-error
 * (legacy data with the recurring flag set but no template link)
 * doesn't open a chooser the user can't meaningfully complete —
 * those rows fall through to single-occurrence edit instead.
 *
 * Exported so tests can drive it without going through the full
 * renderer mount.
 */
/**
 * CR-Apr24-I finding 141: previously the `tx` snapshot was passed
 * unchanged through the async import boundary. If the row was updated
 * elsewhere before the import resolved, startEditing opened stale data
 * that could later overwrite newer fields on save. Now re-reads the
 * transaction from live signal state after the import, and bails if an
 * edit is already in progress.
 */
export async function routeTransactionEdit(tx: Transaction): Promise<void> {
  if (tx.recurring && tx.recurringTemplateId) {
    const [signalsModule, { openModal }] = await Promise.all([
      import('../core/signals.js'),
      import('../ui/core/ui.js')
    ]);
    // CR-Apr24-I finding 141: re-read fresh data for recurring path too
    const freshRecurring = signalsModule.transactions.value.find(
      (t: Transaction) => t.__backendId === tx.__backendId
    );
    signalsModule.pendingEditTx.value = freshRecurring ?? tx;
    openModal('edit-recurring-modal');
    return;
  }
  const { startEditing } = await import('../transactions/index.js');

  // CR-Apr24-I finding 141: bail if another edit started while awaiting
  if (signals.editingId.value) return;

  // Re-read from live state
  const fresh = signals.transactions.value.find(t => t.__backendId === tx.__backendId);
  startEditing(fresh ?? tx);
}

let config: RendererConfig = {
  itemsPerPage: 50,
  enableSwipeActions: true,
  onEdit: async (tx) => {
    await routeTransactionEdit(tx);
  },
  onDelete: (tx) => {
    // Populate delete confirmation details
    const cat = getCatInfo(tx.type, tx.category);
    const emojiEl = DOM.get('delete-tx-emoji');
    const catEl = DOM.get('delete-tx-category');
    const amtEl = DOM.get('delete-tx-amount');
    const dateEl = DOM.get('delete-tx-date');
    const descEl = DOM.get('delete-tx-desc');
    if (emojiEl) emojiEl.textContent = cat.emoji + ' ';
    if (catEl) {
      // emoji is nested inside category span, so set the text after the emoji child
      const textNode = catEl.childNodes[catEl.childNodes.length - 1];
      if (textNode?.nodeType === 3) textNode.textContent = ' ' + cat.name;
      else catEl.appendChild(document.createTextNode(' ' + cat.name));
    }
    if (amtEl) {
      amtEl.textContent = (tx.type === 'expense' ? '-' : '+') + fmtCur(tx.amount);
      amtEl.className = `text-3xl font-black mb-4 ${tx.type === 'income' ? 'text-income' : 'text-expense'}`;
    }
    if (dateEl) {
      // CR-Apr22-G slice 2: route the delete-transaction confirmation
      // modal's date label through the canonical locale service so a
      // user on de-DE / ja-JP / es-ES sees their preferred shape instead
      // of the browser-default one that `toLocaleDateString(undefined, …)`
      // produced. Preserves the "long month, day, year" no-weekday shape.
      dateEl.textContent = formatDateWithYear(tx.date, 'long');
    }
    if (descEl) descEl.textContent = tx.description || '';

    modal.setDeleteTargetId(tx.__backendId);
    emit(Events.OPEN_MODAL, { id: 'delete-modal' });
  },
  onReconcile: async (tx) => {
    const updated = { ...tx, reconciled: !tx.reconciled };
    const result = await dataSdk.update(updated);
    if (result.isOk) {
      emit(Events.SHOW_TOAST, { message: updated.reconciled ? 'Marked as reconciled' : 'Unmarked as reconciled', type: 'info' });
    }
  },
  onSplit: (tx) => {
    modal.setSplitTxId(tx.__backendId);
    emit(Events.OPEN_MODAL, { id: 'split-modal' });
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
  const filters = filterStateToWorkerFilters(f, signals.currentMonth.value);

  // 2. Determine sort options from signal
  const txSort = f.sortBy || 'date-desc';
  const [sortBy, sortDir] = txSort.split('-') as [string, string];

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
        isAllMonths: f.showAllMonths,
        // Design-Review-Apr21 P3 (batch 6 follow-up wave L): pass the
        // month the user is actually viewing so the empty-state title
        // reflects "No transactions for April 2026" when navigated
        // elsewhere, instead of the hardcoded "this month". The template
        // falls back to "this month" if `monthKey` is omitted, keeping
        // the legacy shape safe.
        monthKey: signals.currentMonth.value
      }), container);
      renderPaginationControls(0, 0, config.itemsPerPage || 50);
      return;
    }

    const rowOptions: TransactionRowOptions = {
      showSwipeActions: config.enableSwipeActions,
      currencyFormatter: fmtCur,
      onEdit: config.onEdit,
      onDelete: config.onDelete,
      onReconcile: config.onReconcile,
      onSplit: config.onSplit
    };

    const template = html`
      <div class="transactions-container space-y-2">
        ${repeat(result.items, tx => tx.__backendId, tx => transactionRowTemplate(tx, rowOptions))}
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
    emit(Events.SHOW_TOAST, { message: 'Couldn\u2019t display transactions \u2014 try refreshing the page.', type: 'error' });
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
          void renderTransactionsList();
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
          void renderTransactionsList();
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
