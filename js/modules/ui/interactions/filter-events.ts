/**
 * Filter Events Module
 *
 * Handles all filter input event listeners, date presets, and filter presets.
 *
 * @module filter-events
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { pagination } from '../../core/state-actions.js';
import { debounce } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import {
  setFilterChangeCallback,
  initFilterPanel,
  getDatePresetRange,
  clearDatePresetSelection,
  updateActiveFilterCount,
  renderFilterPresets,
  saveFilterPreset
} from '../widgets/filters.js';
import { renderTransactions, renderTransactionsAsync, saveAsTemplate, renderTemplates } from '../../transactions.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { PaginationState } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface FilterEventCallbacks {
  handleTransactionListClick?: (e: Event) => void;
  handlePaginationClick?: (e: Event) => void;
  swipeManagerCloseAll?: () => void;
  initEmojiPicker?: () => void;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let handleTransactionListClickFn: ((e: Event) => void) | null = null;
let handlePaginationClickFn: ((e: Event) => void) | null = null;
let swipeManagerCloseAllFn: (() => void) | null = null;
let initEmojiPickerFn: (() => void) | null = null;

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize filter event handlers
 */
export function initFilterEvents(callbacks: FilterEventCallbacks): void {
  if (callbacks.handleTransactionListClick) handleTransactionListClickFn = callbacks.handleTransactionListClick;
  if (callbacks.handlePaginationClick) handlePaginationClickFn = callbacks.handlePaginationClick;
  if (callbacks.swipeManagerCloseAll) swipeManagerCloseAllFn = callbacks.swipeManagerCloseAll;
  if (callbacks.initEmojiPicker) initEmojiPickerFn = callbacks.initEmojiPicker;

  setupFilterInputs();
  setupDelegatedListeners();
  setupQuickDateDropdown();
  setupDatePresetButtons();
  setupFilterPresets();
  setupTemplates();

  // Set up filter change callback for re-rendering transactions (use async path)
  setFilterChangeCallback(async () => {
    pagination.resetPage();
    await renderTransactionsAsync();
  });

  // Advanced filter panel toggle
  initFilterPanel();

  // Initialize emoji picker for custom categories
  initEmojiPickerFn?.();
}

// ==========================================
// FILTER INPUTS
// ==========================================

/**
 * Set up filter input event listeners with debouncing
 */
function setupFilterInputs(): void {
  const debouncedRender = debounce(async () => {
    pagination.resetPage();
    await renderTransactionsAsync();
    updateActiveFilterCount();
  }, CONFIG.PAGINATION.FILTER_DEBOUNCE_MS);

  ['filter-type', 'search-text', 'filter-tags', 'filter-category', 'filter-from', 'filter-to', 'filter-min-amt', 'filter-max-amt'].forEach(id => {
    const el = DOM.get(id);
    if (!el) return;
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        pagination.resetPage();
        renderTransactions();
        updateActiveFilterCount();
      });
    } else {
      el.addEventListener('input', debouncedRender);
    }
  });

  // Recurring filter checkbox
  const filterRecurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
  if (filterRecurringEl) {
    filterRecurringEl.addEventListener('change', () => {
      pagination.resetPage();
      renderTransactions();
      updateActiveFilterCount();
    });
  }

  // Unreconciled filter checkbox
  const filterUnreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  if (filterUnreconciledEl) {
    filterUnreconciledEl.addEventListener('change', () => {
      pagination.resetPage();
      renderTransactions();
      updateActiveFilterCount();
    });
  }

  // Show all months checkbox
  DOM.get('tx-show-all-months')?.addEventListener('change', () => {
    pagination.resetPage();
    renderTransactions();
  });

  // Sort dropdown
  DOM.get('tx-sort')?.addEventListener('change', () => {
    pagination.resetPage();
    renderTransactions();
  });

  // Clear filters button
  DOM.get('clear-filters-btn')?.addEventListener('click', () => {
    const searchText = DOM.get('search-text') as HTMLInputElement | null;
    const filterType = DOM.get('filter-type') as HTMLSelectElement | null;
    const filterCategory = DOM.get('filter-category') as HTMLSelectElement | null;
    const filterTags = DOM.get('filter-tags') as HTMLInputElement | null;
    const filterFrom = DOM.get('filter-from') as HTMLInputElement | null;
    const filterTo = DOM.get('filter-to') as HTMLInputElement | null;
    const filterMinAmt = DOM.get('filter-min-amt') as HTMLInputElement | null;
    const filterMaxAmt = DOM.get('filter-max-amt') as HTMLInputElement | null;

    if (searchText) searchText.value = '';
    if (filterType) filterType.value = 'all';
    if (filterCategory) filterCategory.value = '';
    if (filterTags) filterTags.value = '';
    if (filterFrom) filterFrom.value = '';
    if (filterTo) filterTo.value = '';
    if (filterMinAmt) filterMinAmt.value = '';
    if (filterMaxAmt) filterMaxAmt.value = '';
    if (filterRecurringEl) filterRecurringEl.checked = false;
    if (filterUnreconciledEl) filterUnreconciledEl.checked = false;
    clearDatePresetSelection();
    // Reset quick date dropdown
    const quickDateEl = DOM.get('filter-date-quick') as HTMLSelectElement | null;
    if (quickDateEl) quickDateEl.value = '';
    // Hide custom date range section
    DOM.get('custom-date-range')?.classList.add('hidden');
    // Update active filter count
    updateActiveFilterCount();
    pagination.resetPage();
    renderTransactions();
  });
}

// ==========================================
// DELEGATED LISTENERS
// ==========================================

/**
 * Set up delegated event listeners for transaction list and pagination
 */
function setupDelegatedListeners(): void {
  const txList = DOM.get('transactions-list');
  if (txList && handleTransactionListClickFn) {
    txList.addEventListener('click', handleTransactionListClickFn);
  }

  const paginationControls = DOM.get('pagination-controls');
  if (paginationControls && handlePaginationClickFn) {
    paginationControls.addEventListener('click', handlePaginationClickFn);
  }

  // Close swipes when clicking outside transaction list
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.swipe-container') && !target.closest('.swipe-action-btn')) {
      swipeManagerCloseAllFn?.();
    }
  });
}

// ==========================================
// DATE PRESETS
// ==========================================

/**
 * Set up quick date dropdown handler
 */
function setupQuickDateDropdown(): void {
  const quickDateEl = DOM.get('filter-date-quick') as HTMLSelectElement | null;
  if (!quickDateEl) return;

  quickDateEl.addEventListener('change', () => {
    const val = quickDateEl.value;
    const customDateRange = DOM.get('custom-date-range');
    const advancedFilters = DOM.get('advanced-filters');
    const chevron = DOM.get('filter-chevron');
    const toggle = DOM.get('toggle-advanced-filters');
    const filterFrom = DOM.get('filter-from') as HTMLInputElement | null;
    const filterTo = DOM.get('filter-to') as HTMLInputElement | null;

    if (val === 'custom') {
      // Show custom date range and expand advanced filters
      customDateRange?.classList.remove('hidden');
      if (advancedFilters && !advancedFilters.classList.contains('expanded')) {
        advancedFilters.classList.add('expanded');
        chevron?.classList.add('rotated');
        toggle?.setAttribute('aria-expanded', 'true');
        persist(SK.FILTER_EXPANDED, true);
      }
    } else {
      customDateRange?.classList.add('hidden');
      if (val) {
        const { start: from, end: to } = getDatePresetRange(val);
        if (filterFrom) filterFrom.value = from;
        if (filterTo) filterTo.value = to;
        // Enable "All months" checkbox when using date presets
        const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;
        if (showAllEl) showAllEl.checked = true;
      } else {
        if (filterFrom) filterFrom.value = '';
        if (filterTo) filterTo.value = '';
      }
      pagination.resetPage();
      renderTransactions();
    }
    updateActiveFilterCount();
  });
}

/**
 * Set up date preset button handlers
 */
function setupDatePresetButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.date-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset || '';
      const { start: from, end: to } = getDatePresetRange(preset);
      const filterFrom = DOM.get('filter-from') as HTMLInputElement | null;
      const filterTo = DOM.get('filter-to') as HTMLInputElement | null;
      if (filterFrom) filterFrom.value = from;
      if (filterTo) filterTo.value = to;
      // Enable "All months" checkbox when using date presets
      const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;
      if (showAllEl) showAllEl.checked = true;
      // Update visual selection
      document.querySelectorAll<HTMLButtonElement>('.date-preset-btn').forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('form-input-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('form-input-secondary');
      pagination.resetPage();
      renderTransactions();
    });
  });
}

// ==========================================
// FILTER PRESETS
// ==========================================

/**
 * Set up filter preset save/load handlers
 */
function setupFilterPresets(): void {
  DOM.get('save-filter-preset-btn')?.addEventListener('click', () => {
    const name = prompt('Enter a name for this filter preset:');
    if (name && name.trim()) {
      saveFilterPreset(name.trim());
    }
  });

  // Initialize saved filter presets
  renderFilterPresets();
}

// ==========================================
// TEMPLATES
// ==========================================

/**
 * Set up template save handlers
 */
function setupTemplates(): void {
  DOM.get('save-as-template-btn')?.addEventListener('click', () => {
    if (!signals.selectedCategory.value) {
      showToast('Select a category first', 'error');
      return;
    }
    const name = prompt('Enter a name for this template:');
    if (name && name.trim()) {
      saveAsTemplate(name.trim());
    }
  });

  // Initialize templates
  renderTemplates();
}
