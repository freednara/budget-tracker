/**
 * Transactions Module
 *
 * Transaction rendering, templates, pagination, and editing.
 * Handles transaction list display, filtering, sorting, and CRUD operations.
 */
'use strict';

import { SK, lsGet, lsSet, persist } from './core/state.js';
import * as signals from './core/signals.js';
import { form, modal, pagination, data, navigation } from './core/state-actions.js';
import { parseLocalDate, getMonthKey } from './core/utils.js';
import { getCatInfo, EXPENSE_CATS, INCOME_CATS } from './core/categories.js';
import { dataSdk } from './data/data-manager.js';
import { showToast, openModal } from './ui/core/ui.js';
import { swipeManager } from './ui/interactions/swipe-manager.js';
import DOM from './core/dom-cache.js';
import { filterTransactions, shouldUseWorker } from './orchestration/worker-manager.js';
import { VirtualScroller } from './ui/widgets/virtual-scroller.js';
import { html, render, nothing, styleMap, type LitTemplate } from './core/lit-helpers.js';
import { transactionRowTemplate, renderTransactionRowIntoContainer } from './transactions/transaction-row.js';
import {
  saveAsTemplate,
  applyTemplate,
  deleteTemplate,
  renderTemplates,
  setTemplateFmtCurFn,
  setTemplateRenderCategoriesFn
} from './transactions/template-manager.js';
import {
  startEditing,
  cancelEditing,
  updateRecurringPreview,
  setSwitchTabFn,
  setGetTodayStrFn,
  setEditRenderCategoriesFn,
  setEditConfig
} from './transactions/edit-mode.js';
import type { Transaction, TxTemplate, CategoryDefinition, CustomCategory, TransactionType } from '../types/index.js';

// Re-export template functions
export { saveAsTemplate, applyTemplate, deleteTemplate, renderTemplates };

// Re-export edit mode functions
export { startEditing, cancelEditing, updateRecurringPreview, setSwitchTabFn, setGetTodayStrFn };

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;
type RenderCategoriesCallback = () => void;
type UpdateSplitRemainingCallback = () => void;

interface EmptyStateAction {
  id: string;
  label: string;
}

type EmptyStateRenderer = (emoji: string, title: string, subtitle: string, action: EmptyStateAction | null) => LitTemplate;

interface TxConfig {
  PAGINATION: { PAGE_SIZE: number };
  RECURRING_MAX_ENTRIES: number;
}

interface FilterValues {
  showAll: boolean | undefined;
  type: string;
  category: string;
  search: string;
  tags: string;
  fromDate: string;
  toDate: string | undefined;
  recurring: boolean | undefined;
  unreconciled: boolean | undefined;
  minAmount: number;
  maxAmount: number;
}

interface WorkerFilters {
  monthKey: string;
  showAllMonths: boolean | undefined;
  type: 'expense' | 'income' | 'all';
  category: string;
  childCatIds: string[] | null;
  categoryMap: Record<string, { name: string; children?: string[]; parent?: string }>;
  searchQuery: string;
  tagsFilter: string;
  dateFrom: string;
  dateTo: string | undefined;
  minAmount: string;
  maxAmount: string;
  recurringOnly: boolean | undefined;
  reconciled: 'yes' | 'no' | 'all';
}

interface SortOptions {
  sortBy: 'date' | 'amount' | 'description' | 'category';
  sortDir: 'asc' | 'desc';
}

// ==========================================
// CALLBACKS (set by app.js to avoid circular deps)
// ==========================================

// Callback for currency formatting
let fmtCurFn: CurrencyFormatter = (v: number): string => '$' + Math.abs(v).toFixed(2);

// ==========================================
// WORKER INTEGRATION HELPERS
// ==========================================

// Token for cancelling stale async renders
let pendingRenderToken: symbol | null = null;

/**
 * Build a serializable category map for the worker
 * Includes parent/child relationships and category names
 */
function buildCategoryMap(): Record<string, { name: string; children?: string[]; parent?: string }> {
  const catMap: Record<string, { name: string; children?: string[]; parent?: string }> = {};

  // Expense categories with children
  (EXPENSE_CATS as CategoryDefinition[]).forEach(cat => {
    catMap[cat.id] = { name: cat.name, children: (cat.children || []).map(c => c.id) };
    (cat.children || []).forEach(child => {
      catMap[child.id] = { name: child.name, parent: cat.id };
    });
  });

  // Income categories
  (INCOME_CATS as CategoryDefinition[]).forEach(cat => {
    catMap[cat.id] = { name: cat.name };
  });

  // Custom categories
  ((signals.customCats.value || []) as CustomCategory[]).forEach(cat => {
    catMap[cat.id] = { name: cat.name };
  });

  return catMap;
}

/**
 * Map UI sort options to worker format
 */
function mapSortOption(sortValue: string | undefined): SortOptions {
  const map: Record<string, SortOptions> = {
    'date-desc': { sortBy: 'date', sortDir: 'desc' },
    'date-asc': { sortBy: 'date', sortDir: 'asc' },
    'amount-desc': { sortBy: 'amount', sortDir: 'desc' },
    'amount-asc': { sortBy: 'amount', sortDir: 'asc' },
    'category': { sortBy: 'category', sortDir: 'asc' }
  };
  return map[sortValue || 'date-desc'] || map['date-desc'];
}

// Callback for rendering categories (used by applyTemplate)
let renderCategoriesFn: RenderCategoriesCallback | null = null;

// Callback for emptyState HTML generation
let emptyStateFn: EmptyStateRenderer | null = null;

// Callback for updateSplitRemaining
let updateSplitRemainingFn: UpdateSplitRemainingCallback | null = null;

// Configuration passed from app.js
let txConfig: TxConfig = {
  PAGINATION: { PAGE_SIZE: 20 },
  RECURRING_MAX_ENTRIES: 365
};

// ==========================================
// VIRTUAL SCROLLING
// ==========================================

// Threshold for switching to virtual scrolling (items count)
const VIRTUAL_SCROLL_THRESHOLD = 100;

// Module-level virtual scroller instance
let virtualScroller: VirtualScroller<Transaction> | null = null;

// Track if virtual scrolling is currently active
let isVirtualScrollActive = false;

/**
 * Set the currency formatting function
 */
export function setTxFmtCurFn(fn: CurrencyFormatter): void {
  fmtCurFn = fn;
  setTemplateFmtCurFn(fn); // Also set for template-manager
}

/**
 * Set the renderCategories callback
 */
export function setRenderCategoriesFn(fn: RenderCategoriesCallback): void {
  renderCategoriesFn = fn;
  setTemplateRenderCategoriesFn(fn); // Also set for template-manager
  setEditRenderCategoriesFn(fn); // Also set for edit-mode
}

/**
 * Set the emptyState callback
 */
export function setEmptyStateFn(fn: EmptyStateRenderer): void {
  emptyStateFn = fn;
}

/**
 * Set the updateSplitRemaining callback
 */
export function setUpdateSplitRemainingFn(fn: UpdateSplitRemainingCallback): void {
  updateSplitRemainingFn = fn;
}

/**
 * Set transactions configuration
 */
export function setTxConfig(config: Partial<TxConfig>): void {
  if (config.PAGINATION) txConfig.PAGINATION = config.PAGINATION;
  if (config.RECURRING_MAX_ENTRIES) {
    txConfig.RECURRING_MAX_ENTRIES = config.RECURRING_MAX_ENTRIES;
    setEditConfig({ RECURRING_MAX_ENTRIES: config.RECURRING_MAX_ENTRIES }); // Also set for edit-mode
  }
}

// ==========================================
// TRANSACTION RENDERING
// ==========================================

/**
 * Render a single transaction row into a container element
 * Used by virtual scroller for DOM recycling
 */
function renderTransactionRow(containerEl: HTMLElement, t: Transaction, _index: number): void {
  renderTransactionRowIntoContainer(containerEl, t, getCatInfo, fmtCurFn);
}

/**
 * Render transactions using virtual scrolling
 */
function renderVirtualized(filteredItems: Transaction[]): void {
  const list = DOM.get('transactions-list');
  if (!list) return;

  // Destroy existing scroller if switching datasets
  if (virtualScroller) {
    virtualScroller.destroy();
  }

  // Update display count
  const countEl = DOM.get('tx-display-count');
  if (countEl) countEl.textContent = String(filteredItems.length);

  // Handle empty state
  if (filteredItems.length === 0) {
    isVirtualScrollActive = false;
    const hasAny = signals.transactions.value.length > 0;
    if (emptyStateFn) {
      const emptyTemplate = hasAny
        ? emptyStateFn('🔍', 'No matches', 'Try adjusting your filters', { id: 'clear-filters', label: 'Clear Filters' })
        : emptyStateFn('📝', 'No transactions yet', 'Start tracking your spending', { id: 'add-transaction', label: '+ Add Transaction' });
      render(emptyTemplate, list);
    } else {
      render(html`<div class="text-center py-8" style="color: var(--text-tertiary);">No transactions</div>`, list);
    }
    // Hide pagination for virtual scroll
    const paginationEl = DOM.get('pagination-controls');
    if (paginationEl) render(nothing, paginationEl);
    return;
  }

  // Set container height for virtual scrolling
  list.style.height = 'calc(100vh - 360px)';
  list.style.maxHeight = '600px';
  list.style.minHeight = '300px';

  // Create and initialize virtual scroller
  virtualScroller = new VirtualScroller<Transaction>({
    estimatedRowHeight: 88, // Row height + margin
    bufferSize: 8,
    enableSwipe: true
  });

  virtualScroller.init(list, filteredItems, renderTransactionRow);
  isVirtualScrollActive = true;

  // Update pagination area to show total count (no prev/next needed)
  const paginationEl = DOM.get('pagination-controls');
  if (paginationEl) {
    render(html`
      <span class="text-sm" style="color: var(--text-secondary);">
        Showing all ${filteredItems.length} transactions (virtual scroll)
      </span>
    `, paginationEl);
  }

  // Show swipe hint for first-time users
  showSwipeHint();
}

/**
 * Render transactions using traditional pagination
 */
function renderPaginated(filteredItems: Transaction[]): void {
  // Destroy virtual scroller if it was active
  if (virtualScroller) {
    virtualScroller.destroy();
    virtualScroller = null;
    isVirtualScrollActive = false;
  }

  const list = DOM.get('transactions-list');
  if (!list) return;

  // Reset container height
  list.style.height = '';
  list.style.maxHeight = '';
  list.style.minHeight = '';

  // Clean up existing swipe listeners
  list.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
    swipeManager.detach(container);
  });

  // Calculate pagination
  const pageSize = txConfig.PAGINATION.PAGE_SIZE;
  const total = filteredItems.length;
  const totalPages = Math.ceil(total / pageSize);
  let currentPage = signals.pagination.value.page;

  // Ensure current page is valid
  if (currentPage >= totalPages) {
    currentPage = Math.max(0, totalPages - 1);
  }

  // Update pagination state
  pagination.setPagination({ page: currentPage, totalPages, totalItems: total });

  // Slice to current page
  const start = currentPage * pageSize;
  const pageItems = filteredItems.slice(start, start + pageSize);

  const countEl = DOM.get('tx-display-count');
  if (countEl) countEl.textContent = String(total);

  if (!total) {
    const hasAny = signals.transactions.value.length > 0;
    if (emptyStateFn) {
      const emptyTemplate = hasAny
        ? emptyStateFn('🔍', 'No matches', 'Try adjusting your filters', { id: 'clear-filters', label: 'Clear Filters' })
        : emptyStateFn('📝', 'No transactions yet', 'Start tracking your spending', { id: 'add-transaction', label: '+ Add Transaction' });
      render(emptyTemplate, list);
    } else {
      render(html`<div class="text-center py-8" style="color: var(--text-tertiary);">No transactions</div>`, list);
    }
    renderPaginationControls();
    return;
  }

  // Render page items using shared row template
  render(html`
    ${pageItems.map(t => transactionRowTemplate(t, getCatInfo, fmtCurFn))}
  `, list);

  renderPaginationControls();

  // Attach swipe handlers for mobile
  document.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
    swipeManager.attach(container);
  });

  // Show swipe hint for first-time users
  showSwipeHint();
}

/**
 * Render the transaction list with filtering, sorting, and pagination
 */
export function renderTransactions(resetPage: boolean = false): void {
  if (resetPage) pagination.resetPage();

  // Get all filter values once
  const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;
  const typeEl = DOM.get('filter-type') as HTMLSelectElement | null;
  const categoryEl = DOM.get('filter-category') as HTMLSelectElement | null;
  const searchEl = DOM.get('search-text') as HTMLInputElement | null;
  const tagsEl = DOM.get('filter-tags') as HTMLInputElement | null;
  const fromEl = DOM.get('filter-from') as HTMLInputElement | null;
  const toEl = DOM.get('filter-to') as HTMLInputElement | null;
  const recurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
  const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  const minAmtEl = DOM.get('filter-min-amt') as HTMLInputElement | null;
  const maxAmtEl = DOM.get('filter-max-amt') as HTMLInputElement | null;

  const filters: FilterValues = {
    showAll: showAllEl?.checked,
    type: typeEl?.value || 'all',
    category: categoryEl?.value || '',
    search: (searchEl?.value || '').toLowerCase(),
    tags: (tagsEl?.value || '').toLowerCase(),
    fromDate: fromEl?.value || '',
    toDate: toEl?.value,
    recurring: recurringEl?.checked,
    unreconciled: unreconciledEl?.checked,
    minAmount: parseFloat(minAmtEl?.value || '0') || 0,
    maxAmount: parseFloat(maxAmtEl?.value || '0') || 0
  };

  // Cache category data for parent/child checks
  const allCats = [...EXPENSE_CATS, ...INCOME_CATS] as CategoryDefinition[];
  const parentCat = filters.category ? allCats.find(cat => cat.id === filters.category) : null;
  const childCatIds = parentCat?.children ? new Set(parentCat.children.map(c => c.id)) : null;

  // Pre-calculate expensive filter values
  const filterFromDate = filters.fromDate ? parseLocalDate(filters.fromDate) : null;
  const filterToDate = filters.toDate ? parseLocalDate(filters.toDate) : null;

  // Cache category names for search
  const catNamesCache = new Map<string, string>();

  // Single pass filtering
  const transactions = signals.transactions.value;
  let filtered = transactions.filter(t => {
    // Month filter
    if (!filters.showAll && t.date && getMonthKey(t.date) !== signals.currentMonth.value) return false;

    // Type filter
    if (filters.type !== 'all' && t.type !== filters.type) return false;

    // Category filter (with parent/child support)
    if (filters.category) {
      if (t.category !== filters.category && (!childCatIds || !childCatIds.has(t.category))) {
        return false;
      }
    }

    // Search filter (search across description, notes, tags, and category name)
    if (filters.search) {
      const desc = (t.description || '').toLowerCase();
      const notes = (t.notes || '').toLowerCase();
      const tags = (t.tags || '').toLowerCase();
      // Use cache for category name
      let catName = catNamesCache.get(t.category);
      if (catName === undefined) {
        catName = getCatInfo(t.type, t.category).name.toLowerCase();
        catNamesCache.set(t.category, catName);
      }
      if (!desc.includes(filters.search) && !notes.includes(filters.search) &&
          !tags.includes(filters.search) && !catName.includes(filters.search)) return false;
    }

    // Tags filter
    if (filters.tags && !(t.tags || '').toLowerCase().includes(filters.tags)) return false;

    // Date range filters
    if (filterFromDate && parseLocalDate(t.date) < filterFromDate) return false;
    if (filterToDate && parseLocalDate(t.date) > filterToDate) return false;

    // Checkbox filters
    if (filters.recurring && t.recurring !== true) return false;
    if (filters.unreconciled && t.reconciled) return false;

    // Amount filters
    if (filters.minAmount > 0 && t.amount < filters.minAmount) return false;
    if (filters.maxAmount > 0 && t.amount > filters.maxAmount) return false;

    return true;
  });

  // Sort based on selected option
  const sortEl = DOM.get('tx-sort') as HTMLSelectElement | null;
  const sortOption = sortEl?.value || 'date-desc';
  switch (sortOption) {
    case 'date-desc':
      // YYYY-MM-DD format allows string comparison
      filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      break;
    case 'date-asc':
      filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      break;
    case 'amount-desc':
      filtered.sort((a, b) => (b.amount || 0) - (a.amount || 0));
      break;
    case 'amount-asc':
      filtered.sort((a, b) => (a.amount || 0) - (b.amount || 0));
      break;
    case 'category': {
      // Pre-calculate category names to avoid repeated getCatInfo calls
      const catNames = new Map<string, string>();
      filtered.forEach(t => {
        if (!catNames.has(t.category)) {
          catNames.set(t.category, getCatInfo(t.type, t.category).name);
        }
      });
      filtered.sort((a, b) => {
        const catA = catNames.get(a.category) || '';
        const catB = catNames.get(b.category) || '';
        return catA.localeCompare(catB);
      });
      break;
    }
    default:
      filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  // Choose rendering strategy based on dataset size
  if (filtered.length >= VIRTUAL_SCROLL_THRESHOLD) {
    renderVirtualized(filtered);
  } else {
    renderPaginated(filtered);
  }
}

/**
 * Render filtered transaction items (used by both sync and async paths)
 */
function renderFilteredItems(pageItems: Transaction[], total: number): void {
  const countEl = DOM.get('tx-display-count');
  if (countEl) countEl.textContent = String(total);
  const list = DOM.get('transactions-list');
  if (!list) return;

  // Clean up existing swipe listeners
  list.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
    swipeManager.detach(container);
  });

  if (!total) {
    const hasAny = signals.transactions.value.length > 0;
    if (emptyStateFn) {
      const emptyTemplate = hasAny
        ? emptyStateFn('🔍', 'No matches', 'Try adjusting your filters', { id: 'clear-filters', label: 'Clear Filters' })
        : emptyStateFn('📝', 'No transactions yet', 'Start tracking your spending', { id: 'add-transaction', label: '+ Add Transaction' });
      render(emptyTemplate, list);
    } else {
      render(html`<div class="text-center py-8" style="color: var(--text-tertiary);">No transactions</div>`, list);
    }
    renderPaginationControls();
    return;
  }

  // Render page items using shared row template
  render(html`
    ${pageItems.map(t => transactionRowTemplate(t, getCatInfo, fmtCurFn))}
  `, list);

  renderPaginationControls();

  // Attach swipe handlers
  document.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
    swipeManager.attach(container);
  });

  showSwipeHint();
}

/**
 * Async version of renderTransactions for large datasets (5000+ transactions)
 * Uses Web Worker for filtering/sorting to keep UI responsive
 */
export async function renderTransactionsAsync(resetPage: boolean = false): Promise<void> {
  if (resetPage) pagination.resetPage();

  // Small dataset - use sync rendering
  if (!shouldUseWorker(signals.transactions.value.length)) {
    return renderTransactions(resetPage);
  }

  // Cancel any stale pending renders
  const token = Symbol();
  pendingRenderToken = token;

  // Show loading indicator (only if not using virtual scroll which handles its own state)
  const list = DOM.get('transactions-list');
  if (list && !isVirtualScrollActive) {
    render(html`<div class="tx-loading">Loading transactions...</div>`, list);
  }

  try {
    // Build category data for worker
    const categoryMap = buildCategoryMap();
    const categoryEl = DOM.get('filter-category') as HTMLSelectElement | null;
    const selectedCat = categoryEl?.value || '';
    const childCatIds = selectedCat && categoryMap[selectedCat]?.children || null;

    // Get filter element values
    const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;
    const typeEl = DOM.get('filter-type') as HTMLSelectElement | null;
    const searchEl = DOM.get('search-text') as HTMLInputElement | null;
    const tagsEl = DOM.get('filter-tags') as HTMLInputElement | null;
    const fromEl = DOM.get('filter-from') as HTMLInputElement | null;
    const toEl = DOM.get('filter-to') as HTMLInputElement | null;
    const minAmtEl = DOM.get('filter-min-amt') as HTMLInputElement | null;
    const maxAmtEl = DOM.get('filter-max-amt') as HTMLInputElement | null;
    const recurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
    const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
    const sortEl = DOM.get('tx-sort') as HTMLSelectElement | null;

    // Build filters in worker-compatible format
    const typeValue = typeEl?.value || 'all';
    const filters: WorkerFilters = {
      monthKey: signals.currentMonth.value,
      showAllMonths: showAllEl?.checked,
      type: (typeValue === 'expense' || typeValue === 'income' ? typeValue : 'all') as 'expense' | 'income' | 'all',
      category: selectedCat,
      childCatIds,
      categoryMap,
      searchQuery: searchEl?.value || '',
      tagsFilter: (tagsEl?.value || '').toLowerCase(),
      dateFrom: fromEl?.value || '',
      dateTo: toEl?.value,
      minAmount: minAmtEl?.value || '',
      maxAmount: maxAmtEl?.value || '',
      recurringOnly: recurringEl?.checked,
      reconciled: unreconciledEl?.checked ? 'no' : 'all'
    };

    const sortOpt = mapSortOption(sortEl?.value);

    // For large datasets, request all filtered items for virtual scrolling
    const useVirtualScroll = signals.transactions.value.length >= VIRTUAL_SCROLL_THRESHOLD;
    const pageSize = useVirtualScroll ? 999999 : txConfig.PAGINATION.PAGE_SIZE;

    const result = await filterTransactions(signals.transactions.value, filters, {
      ...sortOpt,
      page: 0,
      pageSize
    });

    // Check if this render is still current (not cancelled)
    if (pendingRenderToken !== token) return;

    // Choose rendering strategy based on result size
    if (result.totalItems >= VIRTUAL_SCROLL_THRESHOLD) {
      renderVirtualized(result.items);
    } else {
      // Update pagination state for paginated rendering
      pagination.setPagination({
        page: signals.pagination.value.page,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / txConfig.PAGINATION.PAGE_SIZE)
      });
      renderPaginated(result.items);
    }

  } catch (err) {
    console.warn('Worker filtering failed, falling back to sync:', err);
    // Fallback to sync rendering if worker fails
    if (pendingRenderToken === token) {
      renderTransactions(resetPage);
    }
  }
}

/**
 * Render pagination controls
 */
export function renderPaginationControls(): void {
  const container = DOM.get('pagination-controls');
  if (!container) return;

  const { page, totalPages, totalItems } = signals.pagination.value;
  if (totalPages <= 1) {
    render(nothing, container);
    return;
  }

  const pageSize = txConfig.PAGINATION.PAGE_SIZE;
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  render(html`
    <button class="pagination-btn px-3 py-2 rounded-lg text-sm font-bold transition-all" data-page="prev" ?disabled=${page === 0} style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">← Prev</button>
    <span class="text-sm px-3" style="color: var(--text-secondary);">${start}-${end} of ${totalItems}</span>
    <button class="pagination-btn px-3 py-2 rounded-lg text-sm font-bold transition-all" data-page="next" ?disabled=${page >= totalPages - 1} style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">Next →</button>
  `, container);
}

/**
 * Handle pagination button clicks (delegated)
 */
export function handlePaginationClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest('.pagination-btn') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;

  const action = btn.dataset.page;
  const { page, totalPages } = signals.pagination.value;
  if (action === 'prev' && page > 0) {
    pagination.prevPage();
    renderTransactionsAsync(); // Use async for consistent behavior with large datasets
  } else if (action === 'next' && page < totalPages - 1) {
    pagination.nextPage();
    renderTransactionsAsync(); // Use async for consistent behavior with large datasets
  }
}

/**
 * Show swipe hint for first-time users (mobile only)
 */
export function showSwipeHint(): void {
  const hasSeenSwipeHint = lsGet('budget_tracker_swipe_hint_seen', false);

  if (!hasSeenSwipeHint && window.innerWidth <= 768) {
    const firstTransaction = document.querySelector('.swipe-container');

    if (firstTransaction) {
      // Create hint overlay
      const hint = document.createElement('div');
      hint.className = 'swipe-hint';

      // Auto-dismiss after 5 seconds or on click
      const dismissHint = (): void => {
        hint.classList.add('fade-out');
        setTimeout(() => hint.remove(), 300);
        lsSet('budget_tracker_swipe_hint_seen', true);
      };

      render(html`
        <div class="swipe-hint-content">
          <div class="swipe-hint-arrow">←</div>
          <p class="text-sm font-semibold">Swipe to reveal actions</p>
          <button class="swipe-hint-close" @click=${dismissHint}>Got it!</button>
        </div>
      `, hint);

      firstTransaction.appendChild(hint);
      setTimeout(dismissHint, 5000);
    }
  }
}

// ==========================================
// TRANSACTION CLICK HANDLERS
// ==========================================

/**
 * Handle transaction list clicks (delegated event handler)
 */
export function handleTransactionListClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest('button[data-id]') as HTMLButtonElement | null;
  if (!btn) return;

  const id = btn.dataset.id;
  if (!id) return;
  const tx = signals.transactions.value.find(t => t.__backendId === id);
  if (!tx) return;

  // Get swipe container for closing after action
  const swipeContainer = btn.closest('.swipe-container') as HTMLElement | null;

  if (btn.classList.contains('delete-btn') || btn.classList.contains('delete-swipe-btn')) {
    modal.setDeleteTargetId(id);
    populateDeleteModal(tx);
    openModal('delete-modal');
    if (swipeContainer) swipeManager.closeSwipe(swipeContainer);
  } else if (btn.classList.contains('edit-btn') || btn.classList.contains('edit-swipe-btn')) {
    if (tx.recurring) {
      modal.setPendingEditTx(tx);
      openModal('edit-recurring-modal');
    } else {
      startEditing(tx);
    }
    if (swipeContainer) swipeManager.closeSwipe(swipeContainer);
  } else if (btn.classList.contains('split-btn')) {
    // Check if transaction is recurring
    if (tx.recurring) {
      showToast('⚠️ Cannot split recurring transactions. Edit the recurring bill instead.');
      if (swipeContainer) swipeManager.closeSwipe(swipeContainer);
      return;
    }
    modal.setSplitTxId(tx.__backendId);
    const splitOriginalEl = DOM.get('split-original-amount');
    const splitRowsEl = DOM.get('split-rows');
    if (splitOriginalEl) splitOriginalEl.textContent = fmtCurFn(tx.amount);
    if (splitRowsEl) render(nothing, splitRowsEl);
    if (updateSplitRemainingFn) updateSplitRemainingFn();
    openModal('split-modal');
    if (swipeContainer) swipeManager.closeSwipe(swipeContainer);
  } else if (btn.classList.contains('reconcile-btn') || btn.classList.contains('reconcile-swipe-btn')) {
    handleReconcileClick(tx);
    if (swipeContainer) swipeManager.closeSwipe(swipeContainer);
  }
}

/**
 * Handle reconcile button click
 */
export async function handleReconcileClick(tx: Transaction): Promise<void> {
  const wasReconciled = tx.reconciled;
  tx.reconciled = !tx.reconciled;
  try {
    const result = await dataSdk.update(tx);
    if (!result.isOk) {
      tx.reconciled = wasReconciled; // Revert
      showToast('Failed to update transaction', 'error');
      return;
    }
    renderTransactions();
    updateReconcileCount();
    showToast(tx.reconciled ? 'Transaction reconciled' : 'Transaction unreconciled', 'success');
  } catch (e) {
    tx.reconciled = wasReconciled; // Revert on error
    console.error('Reconcile failed:', e);
    showToast('Failed to update transaction', 'error');
  }
}

/**
 * Update the unreconciled transaction count badge
 */
export function updateReconcileCount(): void {
  const badge = DOM.get('unreconciled-badge');
  if (!badge) return;
  const count = signals.transactions.value.filter(t => !t.reconciled).length;
  if (count > 0) {
    badge.textContent = `${count} unreconciled`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ==========================================
// DELETE MODAL
// ==========================================

/**
 * Populate the delete confirmation modal with transaction details
 */
export function populateDeleteModal(tx: Transaction): void {
  const cat = getCatInfo(tx.type, tx.category);
  const emoji = DOM.get('delete-tx-emoji');
  const category = DOM.get('delete-tx-category');
  const amount = DOM.get('delete-tx-amount');
  const date = DOM.get('delete-tx-date');
  const desc = DOM.get('delete-tx-desc');

  if (emoji) emoji.textContent = cat?.emoji || '📦';
  if (category) category.textContent = cat?.name || tx.category;
  if (amount) {
    amount.textContent = (tx.type === 'expense' ? '-' : '+') + fmtCurFn(tx.amount);
    amount.classList.remove('text-expense', 'text-income');
    amount.classList.add(tx.type === 'expense' ? 'text-expense' : 'text-income');
  }
  if (date) date.textContent = parseLocalDate(tx.date).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  if (desc) {
    desc.textContent = tx.description || '';
    (desc as HTMLElement).style.display = tx.description ? 'block' : 'none';
  }
}

