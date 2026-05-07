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
import { data, filters } from '../../core/state-actions.js';
import { replaceTransactionFilters } from '../../data/transaction-surface-coordinator.js';
import { formatDateForInput, generateId } from '../../core/utils-pure.js';
import { showToast } from '../core/ui.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat } from '../../core/lit-helpers.js';
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
        filters.setExpanded(false);
        // Round 7 fix: only persist if value changed
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
    // A11y (Design-Review-Apr21 P2): the collapse is visual-only (max-height
    // + opacity animation). Without `inert`, the date preset buttons, from/to
    // inputs, and saved-preset controls remain in the keyboard tab order and
    // exposed to assistive tech even while the panel looks closed — which
    // lets keyboard users tab into hidden controls. `inert` removes the
    // whole subtree from focus, clicks, and the accessibility tree while
    // leaving the CSS transition intact.
    if (isExpanded) {
      panel.removeAttribute('inert');
    } else {
      panel.setAttribute('inert', '');
    }

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
    const el = DOM.get<HTMLInputElement | HTMLSelectElement>(id);
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!val;
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
  const unreconciledEl = DOM.get<HTMLInputElement>('filter-unreconciled');
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
  // Design-Review-Apr21 P2: case-insensitive, trimmed duplicate check
  // mirrors the category-manager uniqueness pattern. Without this,
  // saving "This Month" twice created two presets with identical
  // visible names — the load button text and delete-button aria-label
  // both render `p.name`, so AT users and sighted users alike had no
  // way to tell the duplicates apart. Treat a casing-only or leading/
  // trailing-whitespace collision as a duplicate since the filter-
  // preset list shows `p.name` verbatim and the human reader
  // perceives "this month " and "This Month" as the same label.
  const trimmed = name.trim();
  const needle = trimmed.toLowerCase();
  if (!trimmed) {
    showToast('Preset name cannot be empty', 'error');
    return;
  }
  const collision = signals.filterPresets.value.find(
    p => p.name.trim().toLowerCase() === needle
  );
  if (collision) {
    showToast(`A preset named "${collision.name}" already exists`, 'error');
    return;
  }

  // CR-Apr22-E slice 5 [P3]: id sourced from `generateId()` (UUID) instead
  // of `Date.now()`. Two presets saved in the same millisecond produced
  // identical ids under the old scheme — the load/delete handlers key
  // off `preset.id`, so a collision meant the second save would silently
  // overwrite or shadow the first in list operations. `generateId`
  // (utils-pure.ts) wraps `crypto.randomUUID()` with a Math.random
  // fallback, matching the canonical id pattern used elsewhere in the
  // codebase (debts, transactions, categories).
  const preset: FilterPreset = {
    id: `preset_${generateId()}`,
    name: trimmed,
    filters: { ...signals.filters.value }
  };

  data.setFilterPresets([...signals.filterPresets.value, preset]);
  persist(SK.FILTER_PRESETS, signals.filterPresets.value);
  renderFilterPresets();
  showToast(`Filter preset "${trimmed}" saved`, 'success');
}

/**
 * Delete a filter preset
 */
export function deleteFilterPreset(presetId: string): void {
  // Capture name before removal for specific toast feedback
  const presets = signals.filterPresets.value;
  const preset = Array.isArray(presets) ? presets.find((p: { id: string; name: string }) => p.id === presetId) : undefined;
  const presetName = preset?.name || 'Filter preset';

  data.removeFilterPreset(presetId);
  persist(SK.FILTER_PRESETS, signals.filterPresets.value);
  renderFilterPresets();
  showToast(`"${presetName}" deleted`, 'info');
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
    void replaceTransactionFilters({ ...preset.filters }, { resetPage: true });
    showToast(`Filter preset "${preset.name}" applied`);
  };

  render(html`
    ${repeat(presets, p => p.id, p => html`
      <div class="flex items-center gap-2 mb-1">
        <button class="load-preset-btn flex-1 px-2 py-1.5 rounded text-xs font-semibold text-left transition-all form-input"
          @click=${() => handleLoadPreset(p)}>
          ${p.name}
        </button>
        <button class="delete-preset-btn px-2 py-1.5 rounded text-xs text-expense"
          @click=${() => deleteFilterPreset(p.id)}
          title=${`Delete preset "${p.name}"`}
          aria-label=${`Delete preset "${p.name}"`}>✕</button>
      </div>
    `)}
  `, container);
}
