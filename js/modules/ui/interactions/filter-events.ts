/**
 * Filter Events Module
 * 
 * Reactive filter management using signals.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { SK, persist } from '../../core/state.js';
import { pagination } from '../../core/state-actions.js';
import { debounce } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import { getDatePresetRange, saveFilterPreset } from '../widgets/filters.js';
import { renderTransactionsList } from '../../data/transaction-renderer.js';
import { saveAsTemplate } from '../../transactions/template-manager.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';

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
  signals.filters.value = { ...signals.filters.value, ...updates };
  pagination.resetPage();
  renderTransactionsList();
}

/**
 * Clear all filters
 */
export function clearFilters(): void {
  signals.filters.value = {
    searchText: '',
    type: 'all',
    category: '',
    tags: '',
    dateFrom: '',
    dateTo: '',
    minAmount: '',
    maxAmount: '',
    reconciled: 'all',
    recurring: false,
    showAllMonths: false,
    sortBy: 'date-desc'
  };
  pagination.resetPage();
  renderTransactionsList();
}

/**
 * Toggle advanced filters panel
 */
export function toggleAdvancedFilters(): void {
  const next = !signals.filtersExpanded.value;
  signals.filtersExpanded.value = next;
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
  // Search input (debounced functions are at module level, created only once)
  DOM.get('search-text')?.addEventListener('input', (e: any) => {
    debouncedSearch(e.target.value);
  });

  // Basic filters
  DOM.get('filter-type')?.addEventListener('change', (e: any) => {
    updateFilter({ type: e.target.value });
  });

  DOM.get('filter-category')?.addEventListener('change', (e: any) => {
    updateFilter({ category: e.target.value });
  });

  // Sort
  DOM.get('tx-sort')?.addEventListener('change', (e: any) => {
    updateFilter({ sortBy: e.target.value });
  });

  // Date quick filter dropdown
  DOM.get('filter-date-quick')?.addEventListener('change', (e: any) => {
    const preset = e.target.value;
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
  DOM.get('toggle-advanced-filters')?.addEventListener('click', toggleAdvancedFilters);

  // Advanced filters (Advanced section)
  DOM.get('filter-tags')?.addEventListener('input', (e: any) => debouncedTags(e.target.value));
  DOM.get('filter-from')?.addEventListener('change', (e: any) => updateFilter({ dateFrom: e.target.value }));
  DOM.get('filter-to')?.addEventListener('change', (e: any) => updateFilter({ dateTo: e.target.value }));
  DOM.get('filter-min-amt')?.addEventListener('input', (e: any) => debouncedMinAmt(e.target.value));
  DOM.get('filter-max-amt')?.addEventListener('input', (e: any) => debouncedMaxAmt(e.target.value));
  // Unreconciled checkbox (show only unreconciled transactions when checked)
  DOM.get('filter-unreconciled')?.addEventListener('change', (e: any) => {
    updateFilter({ reconciled: e.target.checked ? 'no' : 'all' });
  });
  DOM.get('filter-recurring')?.addEventListener('change', (e: any) => updateFilter({ recurring: e.target.checked }));
  DOM.get('tx-show-all-months')?.addEventListener('change', (e: any) => updateFilter({ showAllMonths: e.target.checked }));

  // Date Presets
  document.querySelectorAll<HTMLButtonElement>('.date-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyDatePreset(btn.dataset.preset || ''));
  });

  // Clear button
  DOM.get('clear-filters-btn')?.addEventListener('click', clearFilters);

  // Save filter preset button
  DOM.get('save-filter-preset-btn')?.addEventListener('click', async () => {
    const name = await promptTextInputFn('Name this filter preset:', 'Save Filter Preset', '', 'Preset name');
    if (name) {
      saveFilterPreset(name);
      showToast(`Preset "${name}" saved`);
    }
  });

  // Template saving
  DOM.get('save-as-template-btn')?.addEventListener('click', async () => {
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
