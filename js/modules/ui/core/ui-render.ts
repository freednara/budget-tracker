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
import * as signals from '../../core/signals.js';
import { pagination, form } from '../../core/state-actions.js';
import { DOM } from '../../core/dom-cache.js';
import { getAllCats, getCatInfo } from '../../core/categories.js';
import { showToast, openModal } from './ui.js';
import { emit, Events } from '../../core/event-bus.js';
import { monthLabel, esc, toCents, toDollars } from '../../core/utils.js';
import { renderTrendChart, renderDonutChart, renderBarChart } from '../charts/chart-renderers.js';
import { getMonthTx, getMonthExpByCat } from '../../features/financial/calculations.js';
import { calcCategoryTrends } from '../../analytics.js';
import { getMonthBadge } from '../widgets/calendar.js';
import type { Transaction, CustomCategory, TransactionType } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type SwitchMainTabCallback = (tab: string) => void;
type RenderTransactionsCallback = () => void;

interface InsightActionData {
  category?: string;
}

// ==========================================
// MODULE STATE (Callback Injection)
// ==========================================

let switchMainTabFn: SwitchMainTabCallback | null = null;
let renderTransactionsFn: RenderTransactionsCallback | null = null;

// Self-reference for renderCategories (needed by renderQuickShortcuts)
let _renderCategories: (() => void) | null = null;

// ==========================================
// CALLBACK SETTERS
// ==========================================

export function setSwitchMainTabFn(fn: SwitchMainTabCallback): void {
  switchMainTabFn = fn;
}

export function setRenderTransactionsFn(fn: RenderTransactionsCallback): void {
  renderTransactionsFn = fn;
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
      if (switchMainTabFn) switchMainTabFn('transactions');
      const filterCat = DOM.get('filter-category') as HTMLSelectElement | null;
      if (filterCat && data.category) filterCat.value = data.category;
      const showAllMonths = DOM.get('tx-show-all-months') as HTMLInputElement | null;
      if (showAllMonths) showAllMonths.checked = false;
      pagination.resetPage();
      if (renderTransactionsFn) renderTransactionsFn();
      showToast('Filtered by category', 'info');
      break;
    case 'goto-budget':
      if (switchMainTabFn) switchMainTabFn('budget');
      break;
  }
}

/**
 * Renders quick shortcut buttons for the top 6 categories.
 * Used in the form section for fast transaction entry.
 */
export function renderQuickShortcuts(): void {
  const el = DOM.get('quick-shortcuts');
  if (!el) return;
  const currentType = signals.currentType.value;
  const cats = getAllCats(currentType).slice(0, 6);
  el.innerHTML = cats.map(cat => `
    <button type="button" class="quick-add-shortcut quick-shortcut p-3 rounded-lg text-center transition-all hover:opacity-80"
      data-category="${cat.id}" data-type="${currentType}"
      style="background: ${esc(cat.color)}20; border: 2px solid ${esc(cat.color)}; color: ${esc(cat.color)}; font-weight: 600;">
      <div class="text-2xl mb-1">${esc(cat.emoji)}</div>
      <div class="text-xs">${esc(cat.name)}</div>
    </button>
  `).join('');
  el.querySelectorAll('.quick-add-shortcut').forEach(btn => {
    btn.addEventListener('click', () => {
      const button = btn as HTMLElement;
      form.setSelectedCategory(button.dataset.category || '');
      if (_renderCategories) _renderCategories();
      const amountInput = DOM.get('amount');
      if (amountInput) amountInput.focus();
      const formSection = DOM.get('form-section');
      if (formSection) formSection.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

/**
 * Renders category selection chips for the transaction form.
 * Highlights the currently selected category.
 */
export function renderCategories(): void {
  const currentType = signals.currentType.value;
  const selectedCategory = signals.selectedCategory.value;
  const cats = getAllCats(currentType);
  const el = DOM.get('category-chips');
  if (!el) return;
  el.innerHTML = cats.map(cat => `
    <button type="button" data-category="${esc(cat.id)}"
      class="category-chip px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
      style="background: ${selectedCategory === cat.id ? esc(cat.color) : 'var(--bg-chip-unselected)'};
             color: ${selectedCategory === cat.id ? 'white' : 'var(--text-secondary)'}; border: 1px solid ${selectedCategory === cat.id ? 'transparent' : 'var(--border-input)'};">
      <span class="text-lg">${esc(cat.emoji)}</span><span>${esc(cat.name)}</span>
    </button>
  `).join('') + `<button type="button" id="inline-add-cat"
      class="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all"
      style="background: transparent; color: var(--text-tertiary); border: 1px dashed var(--border-input);">
      <span class="text-lg">+</span><span>Custom</span>
    </button>`;
  el.querySelectorAll('.category-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const button = btn as HTMLElement;
      form.setSelectedCategory(button.dataset.category || '');
      // Clear category validation error
      const chips = DOM.get('category-chips');
      const catErr = DOM.get('category-error');
      if (chips) {
        chips.style.outline = '';
        chips.style.outlineOffset = '';
        chips.removeAttribute('aria-invalid');
      }
      if (catErr) catErr.classList.add('hidden');
      renderCategories();
    });
  });
  const inlineAddCat = el.querySelector('#inline-add-cat');
  if (inlineAddCat) {
    inlineAddCat.addEventListener('click', () => {
      const catName = DOM.get('custom-cat-name') as HTMLInputElement | null;
      const catColor = DOM.get('custom-cat-color') as HTMLInputElement | null;
      const catType = DOM.get('custom-cat-type') as HTMLSelectElement | null;
      if (catName) catName.value = '';
      if (catColor) catColor.value = '#8b5cf6';
      if (catType) catType.value = signals.currentType.value;
      if (window.resetEmojiPicker) window.resetEmojiPicker();
      openModal('category-modal');
    });
  }
}

// Store self-reference for use in renderQuickShortcuts
_renderCategories = renderCategories;

/**
 * Orchestrates all chart updates in the dashboard.
 * Updates trend, donut, and budget vs. actual charts.
 */
export function updateCharts(): void {
  renderTrendChart('trend-chart-container');
  // Donut chart - use cents for accurate accumulation
  const expByCatCents: Record<string, number> = {};
  const expTx = getMonthTx().filter(t => t.type === 'expense');
  expTx.forEach(t => { expByCatCents[t.category] = (expByCatCents[t.category]||0) + toCents(t.amount); });
  const donutData = Object.entries(expByCatCents).map(([catId, cents]) => {
    const c = getCatInfo('expense', catId);
    return { catId, label: c.name, value: toDollars(cents), color: c.color };
  }).sort((a, b) => b.value - a.value);
  const trends = calcCategoryTrends();
  renderDonutChart('donut-chart-container', donutData, trends);
  const breakdownBadge = DOM.get('category-breakdown-badge');
  if (breakdownBadge) breakdownBadge.innerHTML = getMonthBadge();
  // Budget vs Actual
  const bvaSec = DOM.get('budget-vs-actual-section');
  const currentMonth = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[currentMonth] || {};
  const allocCats = Object.keys(alloc);
  if (bvaSec) {
    if (allocCats.length) {
      bvaSec.classList.remove('hidden');
      const labels = allocCats.map(c => { const info = getCatInfo('expense', c); return info.emoji + ' ' + info.name.split(' ')[0]; });
      const budgetVals = allocCats.map(c => alloc[c]);
      const actualVals = allocCats.map(c => getMonthExpByCat(c, currentMonth));
      renderBarChart('budget-actual-chart', labels, [
        { label: 'Budget', data: budgetVals, color: 'var(--color-accent)' },
        { label: 'Actual', data: actualVals, color: 'var(--color-expense)' }
      ]);
      const bvaChartBadge = DOM.get('budget-actual-badge');
      if (bvaChartBadge) bvaChartBadge.innerHTML = getMonthBadge();
    } else { bvaSec.classList.add('hidden'); }
  }
}

/**
 * Populates the category filter dropdown with all categories.
 * Preserves the current selection after repopulating.
 */
export function populateCategoryFilter(): void {
  const sel = DOM.get('filter-category') as HTMLSelectElement | null;
  if (!sel) return;
  const current = sel.value;
  const allCats = [...getAllCats('expense', true), ...getAllCats('income', true)];
  sel.innerHTML = '<option value="">All Categories</option>' + allCats.map(c => {
    const indent = c.parent ? '&nbsp;&nbsp;↳ ' : '';
    return `<option value="${esc(c.id)}">${indent}${esc(c.emoji)} ${esc(c.name)}</option>`;
  }).join('');
  sel.value = current;
}

/**
 * Renders the custom categories list in settings.
 * Handles category deletion with cascading updates.
 */
export function renderCustomCatsList(): void {
  const el = DOM.get('custom-categories-list');
  if (!el) return;
  const customCats = signals.customCats.value;
  if (!customCats.length) {
    el.innerHTML = '<p class="text-xs" style="color: var(--text-tertiary);">No custom categories</p>';
    return;
  }
  el.innerHTML = customCats.map((c: CustomCategory, i: number) => `<div class="flex items-center justify-between p-2 rounded" style="background: var(--bg-input);">
    <div class="flex items-center gap-2">
      <span>${esc(c.emoji)}</span>
      <span class="text-sm font-bold" style="color: var(--text-primary);">${esc(c.name)}</span>
      <span class="text-xs px-1 rounded" style="color: var(--text-tertiary);">${esc(c.type)}</span>
    </div>
    <button class="del-custom-cat text-xs" data-idx="${i}" aria-label="Delete custom category ${esc(c.name)}" style="color: var(--color-expense);">✕</button>
  </div>`).join('');
  el.querySelectorAll('.del-custom-cat').forEach(btn => {
    btn.addEventListener('click', () => {
      const button = btn as HTMLElement;
      const idx = parseInt(button.dataset.idx || '0');
      const cats = signals.customCats.value;
      const cat = cats[idx];
      if (!confirm(`Delete custom category "${cat.name}"?\n\nThis will:\n• Remove budget allocations\n• Show old transactions as "Unknown"\n• Cannot be undone\n\nContinue?`)) return;
      const catId = cat.id;
      signals.customCats.value = cats.filter((_, i) => i !== idx);
      persist(SK.CUSTOM_CAT, signals.customCats.value);
      // Clean orphaned data
      const monthlyAlloc = { ...signals.monthlyAlloc.value };
      Object.keys(monthlyAlloc).forEach(mk => {
        if (catId in monthlyAlloc[mk]) {
          monthlyAlloc[mk] = { ...monthlyAlloc[mk] };
          delete monthlyAlloc[mk][catId];
        }
      });
      signals.monthlyAlloc.value = monthlyAlloc;
      persist(SK.ALLOC, signals.monthlyAlloc.value);

      // Migrate existing transactions to fallback category
      const fallbackCat = cat.type === 'expense' ? 'other' : 'other_income';
      let txModified = false;
      const transactions = signals.transactions.value.map((t: Transaction) => {
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
        signals.transactions.value = transactions;
        persist(SK.TX, signals.transactions.value);
        emit(Events.TRANSACTION_UPDATED);
      }

      renderCustomCatsList();
      renderCategories();
      populateCategoryFilter();
      emit(Events.BUDGET_UPDATED);  // Refresh budget views after allocation changes
    });
  });
}

// ==========================================
// WINDOW EXTENSION (for emoji picker reset)
// ==========================================

declare global {
  interface Window {
    resetEmojiPicker?: () => void;
  }
}
