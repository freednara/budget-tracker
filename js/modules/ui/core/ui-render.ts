/**
 * UI Render Module
 *
 * Core UI rendering functions extracted from app.ts.
 * Handles month navigation, quick shortcuts, category chips, charts, and filters.
 *
 * @module ui-render
 */
'use strict';

import { SK, persist, lsSet } from '../../core/state.js';
import { dataSdk } from '../../data/data-manager.js';
import * as signals from '../../core/signals.js';
import { pagination, form } from '../../core/state-actions.js';
import { DOM } from '../../core/dom-cache.js';
import { getAllCats, getCatInfo, DEFAULT_CATEGORY_COLOR } from '../../core/categories.js';
import { showToast, openModal } from './ui.js';
import { asyncConfirm } from '../components/async-modal.js';
import { emit, Events } from '../../core/event-bus.js';
import { monthLabel, parseLocalDate, toCents, toDollars } from '../../core/utils.js';
import { renderTrendChart, renderDonutChart, renderBarChart } from '../charts/chart-renderers.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { calculateCategoryTrends } from '../../orchestration/analytics.js';
import { getMonthBadge } from '../widgets/calendar.js';
import { revealTransactionsForm } from './ui-navigation.js';
import { html, render } from '../../core/lit-helpers.js';
import type { Transaction, CustomCategory, TransactionType, CategoryTrendChange } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type SwitchMainTabCallback = (tab: string) => void;
type RenderTransactionsCallback = () => void;

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

// ==========================================
// DEPENDENCY INJECTION
// ==========================================

import { getDefaultContainer, Services } from '../../core/di-container.js';

/**
 * Get switch main tab function from DI container
 */
function getSwitchMainTab(): SwitchMainTabCallback {
  try {
    return getDefaultContainer().resolveSync<SwitchMainTabCallback>(Services.SWITCH_MAIN_TAB);
  } catch {
    return () => {};
  }
}

/**
 * Get render transactions function from DI container
 */
function getRenderTransactions(): RenderTransactionsCallback {
  try {
    return getDefaultContainer().resolveSync<RenderTransactionsCallback>(Services.RENDER_TRANSACTIONS);
  } catch {
    return () => {};
  }
}

// Legacy setter functions - deprecated but kept for backwards compatibility
/**
 * @deprecated Use DI container instead
 */
export function setSwitchMainTabFn(fn: SwitchMainTabCallback): void {
  if (import.meta.env.DEV) console.warn('setSwitchMainTabFn is deprecated. Services are now resolved from DI container.');
}

/**
 * @deprecated Use DI container instead
 */
export function setRenderTransactionsFn(fn: RenderTransactionsCallback): void {
  if (import.meta.env.DEV) console.warn('setRenderTransactionsFn is deprecated. Services are now resolved from DI container.');
}

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
      getSwitchMainTab()('transactions');
      // Update filter signal directly (not just DOM) so the filter actually applies
      if (data.category) {
        signals.filters.value = { ...signals.filters.value, category: data.category, showAllMonths: false };
      }
      signals.filtersExpanded.value = true;
      persist(SK.FILTER_EXPANDED, true);
      pagination.resetPage();
      getRenderTransactions()();
      revealAfterTabSwitch('filter-category', 'filter-category');
      showToast(data.category === 'savings_transfer' ? 'Showing savings transfers' : 'Filtered by category', 'info');
      break;
    case 'goto-budget':
      getSwitchMainTab()('budget');
      revealAfterTabSwitch('envelope-section', 'open-plan-budget');
      break;
    case 'goto-budget-goals':
      getSwitchMainTab()('budget');
      revealAfterTabSwitch('savings-goals-section', 'add-savings-goal-btn');
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

  const template = html`
    ${cats.map(cat => html`
      <button type="button" 
              class="quick-add-shortcut quick-shortcut p-3 rounded-lg text-center transition-all hover:opacity-80"
              data-category="${cat.id}" 
              data-type="${currentType}"
              style="background: ${cat.color}20; border: 2px solid ${cat.color}; color: ${cat.color}; font-weight: 600;"
              @click=${() => {
                form.setSelectedCategory(cat.id);
                renderCategories();
                revealTransactionsForm('amount', true);
              }}>
        <div class="text-2xl mb-1">${cat.emoji}</div>
        <div class="text-xs">${cat.name}</div>
      </button>
    `)}
  `;

  render(template, container);
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

  const template = html`
    ${cats.map(cat => html`
      <button type="button" 
              data-category="${cat.id}"
              class="category-chip px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
              style="background: ${selectedCategory === cat.id ? cat.color : 'var(--bg-chip-unselected)'};
                     color: ${selectedCategory === cat.id ? 'white' : 'var(--text-secondary)'}; 
                     border: 1px solid ${selectedCategory === cat.id ? 'transparent' : 'var(--border-input)'};"
              @click=${() => {
                form.setSelectedCategory(cat.id);
                const chips = DOM.get('category-chips');
                const catErr = DOM.get('category-error');
                if (chips) {
                  chips.style.outline = '';
                  chips.style.outlineOffset = '';
                  chips.removeAttribute('aria-invalid');
                }
                if (catErr) catErr.classList.add('hidden');
                renderCategories();
              }}>
        <span class="text-lg">${cat.emoji}</span>
        <span>${cat.name}</span>
      </button>
    `)}
    <button type="button" id="inline-add-cat"
            class="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
            style="background: transparent; color: var(--text-tertiary); border: 1px dashed var(--border-input);"
            @click=${() => {
              const catName = document.getElementById('custom-cat-name') as HTMLInputElement | null;
              const catColor = document.getElementById('custom-cat-color') as HTMLInputElement | null;
              const catType = document.getElementById('custom-cat-type') as HTMLSelectElement | null;
              if (catName) catName.value = '';
              if (catColor) catColor.value = DEFAULT_CATEGORY_COLOR;
              if (catType) catType.value = signals.currentType.value;
              if (window.resetEmojiPicker) window.resetEmojiPicker();
              openModal('category-modal');
            }}>
      <span class="text-lg">+</span>
      <span>Custom</span>
    </button>
  `;

  render(template, container);
}

// renderCategories is available as a direct function reference

/**
 * Orchestrates all chart updates in the dashboard.
 * FIXED: Uses cached monthly totals instead of manual filtering/summing
 */
export async function updateCharts(): Promise<void> {
  const currentMonth = signals.currentMonth.value;
  
  // 1. Trend Chart (uses its own multi-month logic)
  renderTrendChart('trend-chart-container');

  // 2. Donut Chart - use pre-calculated category totals from cache
  const totals = calculateMonthlyTotalsWithCacheSync(currentMonth);
  const donutData = Object.entries(totals.categoryTotals || {})
    .map(([catId, amount]) => {
      const c = getCatInfo('expense', catId);
      return { catId, label: c.name, value: amount, color: c.color };
    })
    .sort((a, b) => b.value - a.value);

  const trendsResult = calculateCategoryTrends();
  const trends: Record<string, CategoryTrendChange> = {};
  for (const t of trendsResult.trends) {
    trends[t.category.id] = {
      change: Math.round(t.percentageChange),
      direction: t.trend.direction === 'increasing' ? 'up' : t.trend.direction === 'decreasing' ? 'down' : 'flat'
    };
  }
  
  renderDonutChart('donut-chart-container', donutData, trends);
  
  const breakdownBadge = DOM.get('category-breakdown-badge');
  if (breakdownBadge) breakdownBadge.innerHTML = getMonthBadge(signals.currentMonth.value);

  // 3. Budget vs Actual
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
      if (bvaChartBadge) bvaChartBadge.innerHTML = getMonthBadge(signals.currentMonth.value);
    } else { 
      bvaSec.classList.add('hidden'); 
    }
  }
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
  signals.customCats.value = cats.filter(c => c.id !== catId);
  persist(SK.CUSTOM_CAT, signals.customCats.value);
  
  // 2. Clean orphaned allocations
  const monthlyAlloc = { ...signals.monthlyAlloc.value };
  Object.keys(monthlyAlloc).forEach(mk => {
    if (catId in monthlyAlloc[mk]) {
      monthlyAlloc[mk] = { ...monthlyAlloc[mk] };
      delete monthlyAlloc[mk][catId];
    }
  });
  signals.monthlyAlloc.value = monthlyAlloc;
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
    // Update all transactions in one write via dataSdk's internal persist
    signals.transactions.value = updatedTransactions;
    lsSet(SK.TX, updatedTransactions);
    emit(Events.TRANSACTION_UPDATED);
  }

  // 4. Update UI
  renderCustomCatsList();
  renderCategories();
  populateCategoryFilter();
  emit(Events.BUDGET_UPDATED);
}

// ==========================================
// WINDOW EXTENSION (for emoji picker reset)
// ==========================================

declare global {
  interface Window {
    resetEmojiPicker?: () => void;
  }
}
