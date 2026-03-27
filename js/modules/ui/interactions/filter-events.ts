/**
 * Filter Events Module
 * 
 * Reactive filter management using signals.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { SK, persist } from '../../core/state.js';
import { filters } from '../../core/state-actions.js';
import { debounce } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import { getDatePresetRange, saveFilterPreset } from '../widgets/filters.js';
import { applyTransactionFilters, clearTransactionFilters } from '../../data/transaction-surface-coordinator.js';
import { saveAsTemplate } from '../../transactions/template-manager.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { TransactionType } from '../../../types/index.js';

type PromptTextInputFn = (message: string, title?: string, defaultValue?: string, placeholder?: string) => Promise<string | null>;

// ==========================================
// MODULE-LEVEL DEBOUNCED FUNCTIONS
// ==========================================

const debouncedSearch = debounce((val: string) => {
  updateFilter({ searchText: val });
}, CONFIG.PAGINATION.FILTER_DEBOUNCE_MS);

const debouncedTags = debounce((val: string) => {
  updateFilter({ tags: val });
}, CONFIG.PAGINATION.FILTER_DEBOUNCE_MS);

const debouncedMinAmt = debounce((val: string) => {
  updateFilter({ minAmount: val });
}, CONFIG.PAGINATION.FILTER_DEBOUNCE_MS);

const debouncedMaxAmt = debounce((val: string) => {
  updateFilter({ maxAmount: val });
}, CONFIG.PAGINATION.FILTER_DEBOUNCE_MS);

let promptTextInputFn: PromptTextInputFn = async (message: string, title?: string, defaultValue?: string) => {
  const response = window.prompt(message, defaultValue || '');
  const trimmed = response?.trim() || '';
  return trimmed || null;
};

const filterEventCleanups: Array<() => void> = [];

function bindFilterEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject
): void {
  target.addEventListener(type, handler);
  filterEventCleanups.push(() => {
    target.removeEventListener(type, handler);
  });
}

export function cleanupFilterEvents(): void {
  const cleanups = filterEventCleanups.splice(0, filterEventCleanups.length);
  cleanups.forEach((cleanup) => cleanup());
}

export function setFilterPromptFn(fn: PromptTextInputFn): void {
  promptTextInputFn = fn;
}

// ==========================================
// ACTIONS
// ==========================================

/**
 * Update a filter value
 */
export function updateFilter(updates: Partial<signals.FilterState>): void {
  void applyTransactionFilters(updates);
}

/**
 * Clear all filters
 */
export function clearFilters(): void {
  void clearTransactionFilters();
}

/**
 * Toggle advanced filters panel
 */
export function toggleAdvancedFilters(): void {
  const next = !signals.filtersExpanded.value;
  filters.setExpanded(next);
  persist(SK.FILTER_EXPANDED, next);
}

/**
 * Apply a date preset
 */
export function applyDatePreset(preset: string): void {
  const { start: from, end: to } = getDatePresetRange(preset);
  updateFilter({ 
    dateFrom: from, 
    dateTo: to,
    showAllMonths: true 
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize filter event handlers (Reactive Bridge)
 */
export function initFilterEvents(callbacks: any = {}): void {
  void callbacks;
  cleanupFilterEvents();

  // Search input (debounced functions are at module level, created only once)
  const searchText = DOM.get('search-text');
  if (searchText) bindFilterEvent(searchText, 'input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    debouncedSearch(target.value);
  });

  // Basic filters
  const filterType = DOM.get('filter-type');
  if (filterType) bindFilterEvent(filterType, 'change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    updateFilter({ type: target.value as TransactionType | 'all' });
  });

  const filterCategory = DOM.get('filter-category');
  if (filterCategory) bindFilterEvent(filterCategory, 'change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    updateFilter({ category: target.value });
  });

  // Sort
  const txSort = DOM.get('tx-sort');
  if (txSort) bindFilterEvent(txSort, 'change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    updateFilter({ sortBy: target.value });
  });

  // Date quick filter dropdown
  const filterDateQuick = DOM.get('filter-date-quick');
  if (filterDateQuick) bindFilterEvent(filterDateQuick, 'change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const preset = target.value;
    if (preset === 'custom') {
      // Show the custom date range panel
      const customPanel = DOM.get('custom-date-range');
      if (customPanel) customPanel.classList.remove('hidden');
    } else if (preset) {
      applyDatePreset(preset);
      // Hide custom range panel if it was open
      const customPanel = DOM.get('custom-date-range');
      if (customPanel) customPanel.classList.add('hidden');
    } else {
      // "This Month" selected — clear date filters
      updateFilter({ dateFrom: '', dateTo: '', showAllMonths: false });
      const customPanel = DOM.get('custom-date-range');
      if (customPanel) customPanel.classList.add('hidden');
    }
  });

  // Toggle advanced
  const toggleAdvancedFiltersButton = DOM.get('toggle-advanced-filters');
  if (toggleAdvancedFiltersButton) bindFilterEvent(toggleAdvancedFiltersButton, 'click', toggleAdvancedFilters);

  // Advanced filters (Advanced section)
  const filterTags = DOM.get('filter-tags');
  if (filterTags) bindFilterEvent(filterTags, 'input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    debouncedTags(target.value);
  });
  const filterFrom = DOM.get('filter-from');
  if (filterFrom) bindFilterEvent(filterFrom, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    updateFilter({ dateFrom: target.value });
  });
  const filterTo = DOM.get('filter-to');
  if (filterTo) bindFilterEvent(filterTo, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    updateFilter({ dateTo: target.value });
  });
  const filterMinAmount = DOM.get('filter-min-amt');
  if (filterMinAmount) bindFilterEvent(filterMinAmount, 'input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    debouncedMinAmt(target.value);
  });
  const filterMaxAmount = DOM.get('filter-max-amt');
  if (filterMaxAmount) bindFilterEvent(filterMaxAmount, 'input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    debouncedMaxAmt(target.value);
  });
  // Unreconciled checkbox (show only unreconciled transactions when checked)
  const filterUnreconciled = DOM.get('filter-unreconciled');
  if (filterUnreconciled) bindFilterEvent(filterUnreconciled, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    updateFilter({ reconciled: target.checked ? 'no' : 'all' });
  });
  const filterRecurring = DOM.get('filter-recurring');
  if (filterRecurring) bindFilterEvent(filterRecurring, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    updateFilter({ recurring: target.checked });
  });
  const showAllMonths = DOM.get('tx-show-all-months');
  if (showAllMonths) bindFilterEvent(showAllMonths, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    updateFilter({ showAllMonths: target.checked });
  });

  // Date Presets
  document.querySelectorAll<HTMLButtonElement>('.date-preset-btn').forEach(btn => {
    bindFilterEvent(btn, 'click', () => applyDatePreset(btn.dataset.preset || ''));
  });

  // Clear button
  const clearFiltersButton = DOM.get('clear-filters-btn');
  if (clearFiltersButton) bindFilterEvent(clearFiltersButton, 'click', clearFilters);

  // Save filter preset button
  const saveFilterPresetButton = DOM.get('save-filter-preset-btn');
  if (saveFilterPresetButton) bindFilterEvent(saveFilterPresetButton, 'click', async () => {
    const name = await promptTextInputFn('Name this filter preset:', 'Save Filter Preset', '', 'Preset name');
    if (name) {
      saveFilterPreset(name);
    }
  });

  // Template saving
  const saveAsTemplateButton = DOM.get('save-as-template-btn');
  if (saveAsTemplateButton) bindFilterEvent(saveAsTemplateButton, 'click', async () => {
    if (!signals.selectedCategory.value) {
      showToast('Select a category first', 'error');
      return;
    }
    const name = await promptTextInputFn('Enter a name for this template:', 'Save Transaction Template', '', 'Template name');
    if (name) {
      saveAsTemplate(name);
    }
  });
}
