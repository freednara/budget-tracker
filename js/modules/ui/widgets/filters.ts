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

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { pagination, data } from '../../core/state-actions.js';
import { formatDateForInput } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap, nothing } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import type { FilterPreset, DatePresetRange } from '../../../types/index.js';

/**
 * Mount the reactive filter panel component
 * Handles active count badge and expanded/collapsed state
 */
export function mountFilterPanel(): () => void {
  const badgeContainer = DOM.get('active-filter-count');
  const panel = DOM.get('advanced-filters');
  const chevron = DOM.get('filter-chevron');
  const toggle = DOM.get('toggle-advanced-filters');
  let normalizedInitialExpansion = false;

  if (!badgeContainer || !panel || !toggle) return () => {};

  const cleanup = effect(() => {
    const count = signals.activeFilterCount.value;
    const f = signals.filters.value;
    const hasAdvancedFiltersActive = Boolean(
      f.category ||
      f.tags ||
      f.dateFrom ||
      f.dateTo ||
      f.minAmount ||
      f.maxAmount ||
      f.reconciled !== 'all' ||
      f.recurring
    );

    if (!normalizedInitialExpansion) {
      normalizedInitialExpansion = true;
      if (signals.filtersExpanded.value && !hasAdvancedFiltersActive) {
        signals.filtersExpanded.value = false;
        persist(SK.FILTER_EXPANDED, false);
      }
    }

    const isExpanded = signals.filtersExpanded.value;

    // 1. Update Badge
    if (count > 0) {
      badgeContainer.textContent = String(count);
      badgeContainer.classList.remove('hidden');
    } else {
      badgeContainer.classList.add('hidden');
    }

    // 2. Update Panel Expansion
    panel.classList.toggle('expanded', isExpanded);
    chevron?.classList.toggle('rotated', isExpanded);
    toggle.setAttribute('aria-expanded', String(isExpanded));

    // 3. Sync inputs if needed (for preset loading)
    syncFilterInputsFromSignal();
  });

  return cleanup;
}

/**
 * Synchronize DOM inputs with signal state
 * Use this when signal changes from external source (like presets)
 */
function syncFilterInputsFromSignal(): void {
  const f = signals.filters.value;
  
  const setVal = (id: string, val: string | boolean) => {
    const el = DOM.get(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    if (el.type === 'checkbox') (el as HTMLInputElement).checked = !!val;
    else el.value = String(val);
  };

  setVal('search-text', f.searchText);
  setVal('filter-type', f.type);
  setVal('filter-category', f.category);
  setVal('filter-tags', f.tags);
  setVal('filter-from', f.dateFrom);
  setVal('filter-to', f.dateTo);
  setVal('filter-min-amt', f.minAmount);
  setVal('filter-max-amt', f.maxAmount);
  // Sync the unreconciled checkbox (checked when reconciled filter is 'no')
  const unreconciledEl = DOM.get('filter-unreconciled') as HTMLInputElement | null;
  if (unreconciledEl) unreconciledEl.checked = f.reconciled === 'no';
  setVal('filter-recurring', f.recurring);
  setVal('tx-show-all-months', f.showAllMonths);
  setVal('tx-sort', f.sortBy);
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
 * Save current filter state as a preset
 */
export function saveFilterPreset(name: string): void {
  const preset: FilterPreset = { 
    id: `preset_${Date.now()}`, 
    name, 
    filters: { ...signals.filters.value } as any
  };
  
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
    render(html`
      <div class="filter-empty-state">
        <p class="text-sm font-semibold text-primary">No saved presets yet</p>
        <p class="text-xs text-tertiary">Save a filter set once you have a ledger view worth revisiting.</p>
      </div>
    `, container);
    return;
  }

  const handleLoadPreset = (preset: FilterPreset) => {
    signals.filters.value = { ...preset.filters as any };
    pagination.resetPage();
    showToast(`Filter preset "${preset.name}" applied`);
  };

  render(html`
    ${repeat(presets, p => p.id, p => html`
      <div class="flex items-center gap-2 mb-1">
        <button class="load-preset-btn flex-1 px-2 py-1.5 rounded text-xs font-semibold text-left transition-all"
          @click=${() => handleLoadPreset(p)}
          style="background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border-input);">
          ${p.name}
        </button>
        <button class="delete-preset-btn px-2 py-1.5 rounded text-xs"
          @click=${() => deleteFilterPreset(p.id)}
          style="color: var(--color-expense);"
          title="Delete preset">✕</button>
      </div>
    `)}
  `, container);
}
