/**
 * UI Render Module
 *
 * Core UI rendering functions extracted from app.ts.
 * Handles month navigation, quick shortcuts, category chips, charts, and filters.
 *
 * @module ui-render
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import { dataSdk } from '../../data/data-manager.js';
import * as signals from '../../core/signals.js';
import { filters, form, data } from '../../core/state-actions.js';
import { DOM } from '../../core/dom-cache.js';
import { getAllCats, getCatInfo, DEFAULT_CATEGORY_COLOR } from '../../core/categories.js';
import { showToast, openModal } from './ui.js';
import { asyncConfirm } from '../components/async-modal.js';
import { emit, Events } from '../../core/event-bus.js';
import { monthLabel, parseLocalDate, toCents, toDollars } from '../../core/utils.js';
import { renderTrendChart, renderDonutChart, renderBarChart, getTrendChartMonths, setTrendChartMonths } from '../charts/chart-renderers.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { calculateCategoryTrends } from '../../features/analytics/trend-analysis.js';
import { getMonthBadge } from '../widgets/calendar.js';
import { revealTransactionsForm, switchMainTab } from './ui-navigation.js';
import { html, render } from '../../core/lit-helpers.js';
import { applyTransactionFilters } from '../../data/transaction-surface-coordinator.js';
import type { Transaction, CustomCategory, TransactionType, CategoryTrendChange } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface InsightActionData {
  category?: string;
}

function revealAfterTabSwitch(sectionId: string, focusId?: string): void {
  window.setTimeout(() => {
    const section = DOM.get(sectionId) as HTMLElement | null;
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (focusId) {
      const focusTarget = DOM.get(focusId) as HTMLElement | null;
      focusTarget?.focus();
      if (focusTarget instanceof HTMLInputElement) focusTarget.select();
    }
  }, 80);
}

// Legacy setter functions - deprecated but kept for backwards compatibility
export function setSwitchMainTabFn(_fn: (tab: string) => void): void {}
export function setRenderTransactionsFn(_fn: () => void): void {}

// ==========================================
// RENDER FUNCTIONS
// ==========================================

/**
 * Updates the month navigation label with the current month.
 */
export function renderMonthNav(): void {
  const monthLabel_el = DOM.get('current-month-label');
  if (monthLabel_el) monthLabel_el.textContent = monthLabel(signals.currentMonth.value);
}

/**
 * Handles insight action button clicks.
 * Routes to appropriate views based on action type.
 */
export function handleInsightAction(actionType: string, data: InsightActionData): void {
  switch (actionType) {
    case 'filter-category':
      switchMainTab('transactions');
      if (data.category) {
        void applyTransactionFilters({ category: data.category, showAllMonths: false });
      }
      filters.setExpanded(true);
      persist(SK.FILTER_EXPANDED, true);
      revealAfterTabSwitch('filter-category', 'filter-category');
      showToast(data.category === 'savings_transfer' ? 'Showing savings transfers' : 'Filtered by category', 'info');
      break;
    case 'goto-budget':
      switchMainTab('budget');
      revealAfterTabSwitch('envelope-section', 'open-plan-budget');
      break;
    case 'goto-budget-goals':
      switchMainTab('budget');
      revealAfterTabSwitch('savings-goals-section', 'add-savings-goal-btn');
      break;
    case 'goto-transactions':
      switchMainTab('transactions');
      revealAfterTabSwitch('transactions-list');
      break;
  }
}

/**
 * Renders quick shortcut buttons for the top 6 categories.
 * Used in the form section for fast transaction entry.
 */
export function renderQuickShortcuts(): void {
  const container = DOM.get('quick-shortcuts');
  if (!container) return;

  const currentType = signals.currentType.value;
  const cats = getAllCats(currentType).slice(0, 6);
  const renderKey = JSON.stringify({
    type: currentType,
    cats: cats.map((cat) => ({
    id: cat.id,
    emoji: cat.emoji,
    color: cat.color,
    name: cat.name
    }))
  });

  if (container.dataset.renderKey === renderKey) {
    return;
  }

  const template = html`
    ${cats.map(cat => html`
      <button type="button" 
              class="quick-add-shortcut quick-shortcut p-3 rounded-lg text-center transition-all hover:opacity-80"
              data-category="${cat.id}" 
              data-type="${currentType}"
              style="background: ${cat.color}20; border: 2px solid ${cat.color}; color: ${cat.color}; font-weight: 600;">
        <div class="text-2xl mb-1">${cat.emoji}</div>
        <div class="text-xs">${cat.name}</div>
      </button>
    `)}
  `;

  render(template, container);
  bindQuickShortcutHandlers(container);
  container.dataset.renderKey = renderKey;
}

/**
 * Renders category selection chips for the transaction form.
 * Highlights the currently selected category.
 */
export function renderCategories(): void {
  const container = DOM.get('category-chips');
  if (!container) return;

  const currentType = signals.currentType.value;
  const selectedCategory = signals.selectedCategory.value;
  const cats = getAllCats(currentType);
  const renderKey = JSON.stringify({
    type: currentType,
    cats: cats.map((cat) => ({
    id: cat.id,
    emoji: cat.emoji,
    color: cat.color,
    name: cat.name
    }))
  });

  if (container.dataset.renderKey === renderKey) {
    syncCategoryChipSelection(container, selectedCategory);
    return;
  }

  const template = html`
    ${cats.map(cat => html`
      <button type="button" 
              data-category="${cat.id}"
              data-color="${cat.color}"
              class="category-chip px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
              >
        <span class="text-lg">${cat.emoji}</span>
        <span>${cat.name}</span>
      </button>
    `)}
    <button type="button" id="inline-add-cat"
            class="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
            style="background: transparent; color: var(--text-tertiary); border: 1px dashed var(--border-input);">
      <span class="text-lg">+</span>
      <span>Custom</span>
    </button>
  `;

  render(template, container);
  bindCategoryChipHandlers(container);
  container.dataset.renderKey = renderKey;
  syncCategoryChipSelection(container, selectedCategory);
}

// renderCategories is available as a direct function reference

function getTrackedMonths(): string[] {
  return signals.activeTransactionMonths.value;
}

/**
 * Update the dashboard trend chart without re-rendering unrelated charts.
 */
export function updateTrendChart(): void {
  const trendContainer = DOM.get('trend-chart-container');
  const trackedMonths = getTrackedMonths();
  
  if (trendContainer) {
    if (signals.transactionCount.value === 0) {
      render(html`<p class="text-xs text-center py-8" style="color: var(--text-tertiary);">Add transactions to explain how income and spending are shaping the month.</p>`, trendContainer);
    } else if (trackedMonths.length < 2) {
      render(
        html`<p class="text-xs text-center py-8" style="color: var(--text-tertiary);">
          Need at least two months of history to show the ${getTrendChartMonths()}-month trend.
        </p>`,
        trendContainer
      );
    } else {
      renderTrendChart('trend-chart-container');
    }
  }
}

function openInlineCategoryModal(): void {
  const catName = document.getElementById('custom-cat-name') as HTMLInputElement | null;
  const catColor = document.getElementById('custom-cat-color') as HTMLInputElement | null;
  const catType = document.getElementById('custom-cat-type') as HTMLSelectElement | null;
  if (catName) catName.value = '';
  if (catColor) catColor.value = DEFAULT_CATEGORY_COLOR;
  if (catType) catType.value = signals.currentType.value;
  if (window.resetEmojiPicker) window.resetEmojiPicker();
  openModal('category-modal');
}

function clearCategoryValidationState(): void {
  const chips = DOM.get('category-chips');
  const catErr = DOM.get('category-error');
  if (chips) {
    chips.style.outline = '';
    chips.style.outlineOffset = '';
    chips.removeAttribute('aria-invalid');
  }
  if (catErr) catErr.classList.add('hidden');
}

function syncCategoryChipSelection(container: HTMLElement, selectedCategory: string): void {
  container.querySelectorAll<HTMLButtonElement>('.category-chip').forEach((button) => {
    const isSelected = button.dataset.category === selectedCategory;
    const color = button.dataset.color || 'var(--color-accent)';
    button.style.background = isSelected ? color : 'var(--bg-chip-unselected)';
    button.style.color = isSelected ? 'white' : 'var(--text-secondary)';
    button.style.border = `1px solid ${isSelected ? 'transparent' : 'var(--border-input)'}`;
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });
}

function bindCategoryChipHandlers(container: HTMLElement): void {
  if (container.dataset.bound === 'true') return;
  container.dataset.bound = 'true';

  container.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const customButton = target?.closest('#inline-add-cat') as HTMLButtonElement | null;
    if (customButton) {
      openInlineCategoryModal();
      return;
    }

    const chip = target?.closest('.category-chip') as HTMLButtonElement | null;
    if (!chip) return;

    const categoryId = chip.dataset.category || '';
    if (!categoryId) return;

    form.setSelectedCategory(categoryId);
    clearCategoryValidationState();
    syncCategoryChipSelection(container, categoryId);
  });
}

function bindQuickShortcutHandlers(container: HTMLElement): void {
  if (container.dataset.bound === 'true') return;
  container.dataset.bound = 'true';

  container.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const shortcut = target?.closest('.quick-shortcut') as HTMLButtonElement | null;
    if (!shortcut) return;

    const categoryId = shortcut.dataset.category || '';
    if (!categoryId) return;

    form.setSelectedCategory(categoryId);
    renderCategories();
    revealTransactionsForm('amount', true);
  });
}

/**
 * Update the dashboard category breakdown without touching other charts.
 */
export function updateCategoryBreakdownChart(): void {
  const currentMonth = signals.currentMonth.value;
  const donutContainer = DOM.get('donut-chart-container');
  const categoryTrends = calculateCategoryTrends(2);
  const donutTrends: Record<string, CategoryTrendChange> = {};

  categoryTrends.trends.forEach((trend) => {
    const previousAmount = trend.monthlyData.at(-2)?.amount || 0;
    const currentAmount = trend.monthlyData.at(-1)?.amount || 0;

    if (currentAmount > 0 && previousAmount <= 0) {
      donutTrends[trend.category.id] = { change: 100, direction: 'new' };
      return;
    }

    if (previousAmount <= 0) {
      donutTrends[trend.category.id] = { change: 0, direction: 'flat' };
      return;
    }

    const percentChange = ((currentAmount - previousAmount) / Math.abs(previousAmount)) * 100;
    donutTrends[trend.category.id] = {
      change: Math.round(Math.abs(percentChange)),
      direction: percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'flat'
    };
  });

  const donutData = Object.entries(signals.currentMonthSummary.value.categoryTotals)
    .map(([catId, amount]) => {
      const c = getCatInfo('expense', catId);
      return { catId, label: c.name, value: amount, color: c.color };
    })
    .sort((a, b) => b.value - a.value);
  
  if (donutContainer) {
    if (donutData.length === 0) {
      render(html`<p class="text-xs text-center py-8" style="color: var(--text-tertiary);">Add expense activity to see which categories are creating the most pressure.</p>`, donutContainer);
    } else {
      renderDonutChart('donut-chart-container', donutData, donutTrends);
    }
  }
  
  const breakdownBadge = DOM.get('category-breakdown-badge');
  if (breakdownBadge) {
    render(html`<span class="time-badge">${getMonthBadge(signals.currentMonth.value)}</span>`, breakdownBadge);
  }
}

/**
 * Update the budget-vs-actual chart without re-rendering other dashboard charts.
 */
export function updateBudgetVsActualChart(): void {
  const currentMonth = signals.currentMonth.value;
  const totals = calculateMonthlyTotalsWithCacheSync(currentMonth);
  const bvaSec = DOM.get('budget-vs-actual-section');
  const alloc = signals.monthlyAlloc.value[currentMonth] || {};
  const allocCats = Object.keys(alloc);

  if (bvaSec) {
    if (allocCats.length) {
      bvaSec.classList.remove('hidden');
      const labels = allocCats.map(c => { 
        const info = getCatInfo('expense', c); 
        return info.emoji + ' ' + info.name.split(' ')[0]; 
      });
      const budgetVals = allocCats.map(c => alloc[c]);
      const actualVals = allocCats.map(c => (totals.categoryTotals || {})[c] || 0);
      
      renderBarChart('budget-actual-chart', labels, [
        { label: 'Budget', data: budgetVals, color: 'var(--color-accent)' },
        { label: 'Actual', data: actualVals, color: 'var(--color-expense)' }
      ]);
      
      const bvaChartBadge = DOM.get('budget-actual-badge');
      if (bvaChartBadge) {
        render(html`<span class="time-badge">${getMonthBadge(signals.currentMonth.value)}</span>`, bvaChartBadge);
      }
    } else { 
      bvaSec.classList.add('hidden'); 
    }
  }
}

/**
 * Orchestrates all chart updates in the dashboard.
 */
export async function updateCharts(): Promise<void> {
  updateTrendChart();
  updateCategoryBreakdownChart();
  updateBudgetVsActualChart();
}

function syncDashboardTrendRangeButtons(): void {
  const selector = DOM.get('trend-range-selector');
  if (!selector) return;

  const activeMonths = getTrendChartMonths();
  selector.querySelectorAll('.trend-range-btn').forEach((node) => {
    const button = node as HTMLButtonElement;
    const months = Number(button.dataset.months || 0);
    const isActive = months === activeMonths;

    button.classList.toggle('active', isActive);
    button.classList.toggle('btn-primary', isActive);
    button.classList.toggle('text-tertiary', !isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

/**
 * Wires the dashboard trend range buttons to the compact income vs expenses chart.
 */
export function initDashboardTrendRangeSelector(): void {
  const selector = DOM.get('trend-range-selector');
  if (!selector) return;

  syncDashboardTrendRangeButtons();

  if (selector.dataset.bound === 'true') return;
  selector.dataset.bound = 'true';

  selector.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('.trend-range-btn') as HTMLButtonElement | null;
    if (!button) return;

    const months = Number(button.dataset.months || 0);
    if (![3, 6, 12].includes(months)) return;

    if (months !== getTrendChartMonths()) {
      setTrendChartMonths(months);
    }

    syncDashboardTrendRangeButtons();
    void updateCharts();
  });
}

/**
 * Populates the category filter dropdown with all categories.
 */
export function populateCategoryFilter(): void {
  const container = DOM.get('filter-category');
  if (!container) return;

  const current = (container as HTMLSelectElement).value;
  const allCats = [...getAllCats('expense', true), ...getAllCats('income', true)];

  const template = html`
    <option value="">All Categories</option>
    ${allCats.map(c => html`
      <option value="${c.id}">
        ${c.parent ? html`&nbsp;&nbsp;↳ ` : ''}${c.emoji} ${c.name}
      </option>
    `)}
  `;

  render(template, container);
  (container as HTMLSelectElement).value = current;
}

/**
 * Renders the custom categories list in settings.
 */
export function renderCustomCatsList(): void {
  const container = DOM.get('custom-categories-list');
  if (!container) return;

  const customCats = signals.customCats.value;
  
  if (!customCats.length) {
    render(html`<p class="text-xs" style="color: var(--text-tertiary);">No custom categories</p>`, container);
    return;
  }

  const template = html`
    ${customCats.map((c, i) => html`
      <div class="flex items-center justify-between p-2 rounded" style="background: var(--bg-input);">
        <div class="flex items-center gap-2">
          <span>${c.emoji}</span>
          <span class="text-sm font-bold" style="color: var(--text-primary);">${c.name}</span>
          <span class="text-xs px-1 rounded" style="color: var(--text-tertiary);">${c.type}</span>
        </div>
        <button class="del-custom-cat text-xs"
                @click=${() => handleDeleteCustomCat(c.id)}
                aria-label="Delete custom category ${c.name}"
                style="color: var(--color-expense);">✕</button>
      </div>
    `)}
  `;

  render(template, container);
}

/**
 * Internal handler for custom category deletion
 */
async function handleDeleteCustomCat(catId: string): Promise<void> {
  const cats = signals.customCats.value;
  const cat = cats.find(c => c.id === catId);
  if (!cat) return;

  const confirmed = await asyncConfirm({
    title: 'Delete Custom Category',
    message: `Delete custom category "${cat.name}"?`,
    details: 'This will remove its budget allocations, show older transactions as "Unknown", and cannot be undone.',
    type: 'danger',
    confirmText: 'Delete Category',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;

  // 1. Remove from signals (by ID, not index — safe against stale closures)
  data.setCustomCategories(cats.filter(c => c.id !== catId));
  persist(SK.CUSTOM_CAT, signals.customCats.value);
  
  // 2. Clean orphaned allocations
  const monthlyAlloc = { ...signals.monthlyAlloc.value };
  Object.keys(monthlyAlloc).forEach(mk => {
    if (catId in monthlyAlloc[mk]) {
      monthlyAlloc[mk] = { ...monthlyAlloc[mk] };
      delete monthlyAlloc[mk][catId];
    }
  });
  data.setMonthlyAllocations(monthlyAlloc);
  persist(SK.ALLOC, signals.monthlyAlloc.value);

  // 3. Migrate transactions to fallback category in a single batch operation
  const fallbackCat = cat.type === 'expense' ? 'other' : 'other_income';
  let txModified = false;
  const updatedTransactions = signals.transactions.value.map((t: Transaction) => {
    if (t.category === catId) {
      txModified = true;
      return {
        ...t,
        category: fallbackCat,
        notes: t.notes ? `${t.notes}\n[Original Category: ${cat.name}]` : `[Original Category: ${cat.name}]`
      };
    }
    return t;
  });

  if (txModified) {
    const replaceResult = await dataSdk.replaceAllTransactions(updatedTransactions);
    if (!replaceResult.isOk) {
      showToast('Failed to update transactions for deleted category', 'error');
      return;
    }
    emit(Events.TRANSACTIONS_REPLACED);
  }

  // 4. Update UI
  renderCustomCatsList();
  renderCategories();
  populateCategoryFilter();
}

// ==========================================
// WINDOW EXTENSION (for emoji picker reset)
// ==========================================

declare global {
  interface Window {
    resetEmojiPicker?: () => void;
  }
}
