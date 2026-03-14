/**
 * Filters Module
 *
 * Filter preset management and date range helpers.
 * Handles filter panel initialization and state tracking.
 *
 * @module filters
 * @requires state
 * @requires utils
 * @requires ui
 */
'use strict';

import { SK, lsGet, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { pagination, data } from '../../core/state-actions.js';
import { formatDateForInput } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, nothing } from '../../core/lit-helpers.js';
import type { FilterPreset, FilterState, DatePresetRange } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type FilterChangeCallback = () => void;

// ==========================================
// MODULE STATE
// ==========================================

// Callback for re-rendering transactions (set by app.js)
let onFilterChange: FilterChangeCallback | null = null;

/**
 * Set the callback function to call when filters change
 */
export function setFilterChangeCallback(callback: FilterChangeCallback): void {
  onFilterChange = callback;
}

/**
 * Get date range for a preset
 */
export function getDatePresetRange(preset: string): DatePresetRange {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let from: string, to: string;

  switch (preset) {
    case 'today':
      from = to = formatDateForInput(today);
      break;
    case 'yesterday': {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      from = to = formatDateForInput(yesterday);
      break;
    }
    case 'this-week': {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay()); // Sunday start
      from = formatDateForInput(weekStart);
      to = formatDateForInput(today);
      break;
    }
    case 'last-7': {
      const last7 = new Date(today);
      last7.setDate(today.getDate() - 6);
      from = formatDateForInput(last7);
      to = formatDateForInput(today);
      break;
    }
    case 'last-30': {
      const last30 = new Date(today);
      last30.setDate(today.getDate() - 29);
      from = formatDateForInput(last30);
      to = formatDateForInput(today);
      break;
    }
    case 'this-month': {
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      from = formatDateForInput(monthStart);
      to = formatDateForInput(today);
      break;
    }
    case 'last-month': {
      // Handle year boundary correctly (January -> December of previous year)
      const currentMonth = today.getMonth();
      const currentYear = today.getFullYear();

      const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const lastYear = currentMonth === 0 ? currentYear - 1 : currentYear;

      const lastMonthStart = new Date(lastYear, lastMonth, 1);
      const lastMonthEnd = new Date(currentYear, currentMonth, 0);
      from = formatDateForInput(lastMonthStart);
      to = formatDateForInput(lastMonthEnd);
      break;
    }
    case 'this-year': {
      const yearStart = new Date(today.getFullYear(), 0, 1);
      from = formatDateForInput(yearStart);
      to = formatDateForInput(today);
      break;
    }
    default:
      from = to = '';
  }
  return { start: from, end: to };
}

/**
 * Clear date preset button selection styles
 */
export function clearDatePresetSelection(): void {
  document.querySelectorAll('.date-preset-btn').forEach(btn => {
    btn.classList.remove('btn-primary');
    btn.classList.add('form-input-secondary');
  });
}

/**
 * Initialize the advanced filter panel with collapse/expand functionality
 */
export function initFilterPanel(): void {
  const toggle = DOM.get('toggle-advanced-filters');
  const panel = DOM.get('advanced-filters');
  const chevron = DOM.get('filter-chevron');

  if (!toggle || !panel) return;

  // Restore saved preference
  const wasExpanded = lsGet(SK.FILTER_EXPANDED, false) as boolean;
  if (wasExpanded) {
    panel.classList.add('expanded');
    chevron?.classList.add('rotated');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', () => {
    const isExpanded = panel.classList.contains('expanded');
    panel.classList.toggle('expanded');
    chevron?.classList.toggle('rotated');
    toggle.setAttribute('aria-expanded', String(!isExpanded));
    persist(SK.FILTER_EXPANDED, !isExpanded);
  });

  // Initial count update
  updateActiveFilterCount();
}

/**
 * Update the badge showing count of active filters
 */
export function updateActiveFilterCount(): void {
  const badge = DOM.get('active-filter-count');
  if (!badge) return;

  let count = 0;
  const categoryEl = DOM.get('filter-category') as HTMLSelectElement | null;
  const tagsEl = DOM.get('filter-tags') as HTMLInputElement | null;
  const minAmtEl = DOM.get('filter-min-amt') as HTMLInputElement | null;
  const maxAmtEl = DOM.get('filter-max-amt') as HTMLInputElement | null;
  const recurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
  const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  const fromEl = DOM.get('filter-from') as HTMLInputElement | null;
  const toEl = DOM.get('filter-to') as HTMLInputElement | null;

  if (categoryEl?.value) count++;
  if (tagsEl?.value) count++;
  if (minAmtEl?.value) count++;
  if (maxAmtEl?.value) count++;
  if (recurringEl?.checked) count++;
  if (unreconciledEl?.checked) count++;
  if (fromEl?.value) count++;
  if (toEl?.value) count++;

  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/**
 * Get current state of all filter controls
 */
export function getCurrentFilterState(): FilterState {
  const typeEl = DOM.get('filter-type') as HTMLSelectElement | null;
  const categoryEl = DOM.get('filter-category') as HTMLSelectElement | null;
  const searchEl = DOM.get('search-text') as HTMLInputElement | null;
  const tagsEl = DOM.get('filter-tags') as HTMLInputElement | null;
  const fromEl = DOM.get('filter-from') as HTMLInputElement | null;
  const toEl = DOM.get('filter-to') as HTMLInputElement | null;
  const minAmtEl = DOM.get('filter-min-amt') as HTMLInputElement | null;
  const maxAmtEl = DOM.get('filter-max-amt') as HTMLInputElement | null;
  const recurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
  const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;

  return {
    type: typeEl?.value || 'all',
    category: categoryEl?.value || '',
    search: searchEl?.value || '',
    tags: tagsEl?.value || '',
    from: fromEl?.value || '',
    to: toEl?.value || '',
    minAmt: minAmtEl?.value || '',
    maxAmt: maxAmtEl?.value || '',
    recurring: recurringEl?.checked || false,
    unreconciled: unreconciledEl?.checked || false,
    showAllMonths: showAllEl?.checked || false
  };
}

/**
 * Apply a filter preset to the filter controls
 */
export function applyFilterPreset(preset: FilterState): void {
  const typeEl = DOM.get('filter-type') as HTMLSelectElement | null;
  const categoryEl = DOM.get('filter-category') as HTMLSelectElement | null;
  const searchEl = DOM.get('search-text') as HTMLInputElement | null;
  const tagsEl = DOM.get('filter-tags') as HTMLInputElement | null;
  const fromEl = DOM.get('filter-from') as HTMLInputElement | null;
  const toEl = DOM.get('filter-to') as HTMLInputElement | null;
  const minAmtEl = DOM.get('filter-min-amt') as HTMLInputElement | null;
  const maxAmtEl = DOM.get('filter-max-amt') as HTMLInputElement | null;
  const recurringEl = DOM.get('filter-recurring') as HTMLInputElement | null;
  const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  const showAllEl = DOM.get('tx-show-all-months') as HTMLInputElement | null;

  if (typeEl) typeEl.value = preset.type || 'all';
  if (categoryEl) categoryEl.value = preset.category || '';
  if (searchEl) searchEl.value = preset.search || '';
  if (tagsEl) tagsEl.value = preset.tags || '';
  if (fromEl) fromEl.value = preset.from || '';
  if (toEl) toEl.value = preset.to || '';
  if (minAmtEl) minAmtEl.value = preset.minAmt || '';
  if (maxAmtEl) maxAmtEl.value = preset.maxAmt || '';
  if (recurringEl) recurringEl.checked = preset.recurring || false;
  if (unreconciledEl) unreconciledEl.checked = preset.unreconciled || false;
  // Restore "All months" setting from preset (default to true for backwards compatibility)
  if (showAllEl) showAllEl.checked = preset.showAllMonths ?? true;

  clearDatePresetSelection();
  updateActiveFilterCount();
  pagination.resetPage();
  // Call the registered callback to re-render transactions
  if (onFilterChange) onFilterChange();
}

/**
 * Save current filter state as a preset
 */
export function saveFilterPreset(name: string): void {
  const state = getCurrentFilterState();
  const preset: FilterPreset = { id: `preset_${Date.now()}`, name, filters: state };
  data.setFilterPresets([...signals.filterPresets.value, preset]);
  persist(SK.FILTER_PRESETS, signals.filterPresets.value);
  renderFilterPresets();
  showToast(`Filter preset "${name}" saved`, 'success');
}

/**
 * Delete a filter preset
 */
export function deleteFilterPreset(presetId: string): void {
  data.removeFilterPreset(presetId);
  persist(SK.FILTER_PRESETS, signals.filterPresets.value);
  renderFilterPresets();
  showToast('Filter preset deleted', 'info');
}

/**
 * Render the saved filter presets list
 */
export function renderFilterPresets(): void {
  const container = DOM.get('saved-presets-list');
  if (!container) return;

  const presets = signals.filterPresets.value;

  if (!presets.length) {
    render(html`<p class="text-xs" style="color: var(--text-tertiary);">No saved presets</p>`, container);
    return;
  }

  const handleLoadPreset = (presetId: string) => {
    const preset = presets.find(p => p.id === presetId);
    if (preset) applyFilterPreset(preset.filters);
  };

  const handleDeletePreset = (presetId: string) => {
    deleteFilterPreset(presetId);
  };

  render(html`
    ${repeat(presets, p => p.id, p => html`
      <div class="flex items-center gap-2 mb-1">
        <button class="load-preset-btn flex-1 px-2 py-1.5 rounded text-xs font-semibold text-left transition-all"
          @click=${() => handleLoadPreset(p.id)}
          style="background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border-input);">
          ${p.name}
        </button>
        <button class="delete-preset-btn px-2 py-1.5 rounded text-xs"
          @click=${() => handleDeletePreset(p.id)}
          style="color: var(--color-expense);"
          title="Delete preset">✕</button>
      </div>
    `)}
  `, container);
}
