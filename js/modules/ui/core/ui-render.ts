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
import { allExpenseCategories, allIncomeCategories, deleteCategoryWithCleanup } from '../../core/category-store.js';
import * as signals from '../../core/signals.js';
import { getMonthAlloc } from '../../core/month-alloc.js';
// CR-Apr22-B slice 1: `data` dropped — only the delete-custom-cat path used
// `data.setMonthlyAllocations`, and that flow now routes through
// `deleteCategoryWithCleanup` which owns the allocation sweep.
import { filters, form } from '../../core/state-actions.js';
import { DOM } from '../../core/dom-cache.js';
import { getAllCats, getCatInfo, DEFAULT_CATEGORY_COLOR } from '../../core/categories.js';
import { showToast, openModal } from './ui.js';
import { asyncConfirm } from '../components/async-modal.js';
import { monthLabel, formatCategoryChartLabel } from '../../core/utils-pure.js';
import { renderTrendChart, renderDonutChart, renderBarChart, getTrendChartMonths, setTrendChartMonths } from '../charts/chart-renderers.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from '../../core/monthly-totals-cache.js';
import { calculateCategoryTrends } from '../../features/analytics/trend-analysis.js';
// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// route category-trend month-over-month math through `computeBaselineDelta`
// so `updateCategoryBreakdownChart` stops fabricating `change: 100` for
// new baselines and `change: 0` for no-data baselines. The helper's
// three-case discriminated return ('comparable' | 'new' | 'no-data')
// maps 1:1 onto the direction/change pair the UI already consumed.
import { computeBaselineDelta } from '../../core/baseline.js';
import { getMonthBadge } from '../widgets/calendar.js';
import { revealTransactionsForm, switchMainTab } from './ui-navigation.js';
import { html, render, repeat } from '../../core/lit-helpers.js';
import { applyTransactionFilters } from '../../data/transaction-surface-coordinator.js';
// CR-Apr22-B slice 1: category-delete orchestration migrated to
// `deleteCategoryWithCleanup`; `dataSdk`, `emit`, `Events`, and the
// `Transaction` type are no longer referenced from this module.
import type { UserCategory, CategoryTrendChange } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): widened for `exactOptionalPropertyTypes`
// — insights.ts:69 passes `{ category: typeof data === 'string' ? data : undefined }`.
interface InsightActionData {
  category?: string | undefined;
}

function revealAfterTabSwitch(sectionId: string, focusId?: string): void {
  // CR-Apr24-I finding 124: capture the current tab so we can bail if
  // the user navigated away before the timer fires.
  const capturedTab = signals.activeMainTab.value;
  window.setTimeout(() => {
    if (signals.activeMainTab.value !== capturedTab) return;
    const section = DOM.get(sectionId);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (focusId) {
      const focusTarget = DOM.get(focusId);
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
    ${repeat(cats, cat => cat.id, cat => html`
      <button type="button"
              class="quick-add-shortcut quick-shortcut p-3 rounded-lg text-center transition-all hover:opacity-80 chip-category"
              data-category="${cat.id}"
              data-type="${currentType}"
              style="--cat-color: ${cat.color};">
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
    ${repeat(cats, cat => cat.id, cat => html`
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
            class="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all btn-ghost-outline">
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
      render(html`<p class="text-xs text-center py-8 text-tertiary">Add transactions to explain how income and spending are shaping the month.</p>`, trendContainer);
    } else if (trackedMonths.length < 2) {
      render(
        html`<p class="text-xs text-center py-8 text-tertiary">
          Need at least two months of history to show the ${getTrendChartMonths()}-month trend.
        </p>`,
        trendContainer
      );
    } else {
      // REND-04: catch async errors from trend chart render
      void renderTrendChart('trend-chart-container').catch((e) => { if (import.meta.env.DEV) console.error('[ui-render] trend chart render failed:', e); });
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
  // Design-Review-Apr21 P2: parallel entrypoint to the budget-planner
  // opener (`openCustomCategoryModal` in `budget-planner-ui.ts`), which
  // clears `#custom-cat-name-error` + `aria-invalid` on each open. This
  // path was missing the same cleanup, so a failed save from the
  // transaction form would leave the modal decorated with error state
  // that persisted across dismiss → reopen. Mirroring the cleanup here
  // keeps both entrypoints into the same modal behaviorally identical.
  const nameErr = document.getElementById('custom-cat-name-error');
  if (nameErr) nameErr.classList.add('hidden');
  if (catName) catName.removeAttribute('aria-invalid');
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

// REND-06: memoize the category breakdown chart so it only recomputes
// when the month or the underlying category totals actually change.
let _lastBreakdownKey = '';

/**
 * Update the dashboard category breakdown without touching other charts.
 */
export function updateCategoryBreakdownChart(): void {
  const donutContainer = DOM.get('donut-chart-container');

  // REND-06: build a cheap fingerprint from month + category totals so we
  // skip the expensive calculateCategoryTrends() call when nothing changed.
  const catTotals = signals.currentMonthSummary.value.categoryTotals;
  const breakdownKey = signals.currentMonth.value + '|' + JSON.stringify(catTotals);
  if (breakdownKey === _lastBreakdownKey) return;
  _lastBreakdownKey = breakdownKey;

  const categoryTrends = calculateCategoryTrends(2);
  const donutTrends: Record<string, CategoryTrendChange> = {};

  categoryTrends.trends.forEach((trend) => {
    const previousAmount = trend.monthlyData.at(-2)?.amount || 0;
    const currentAmount = trend.monthlyData.at(-1)?.amount || 0;

    // 7a (Inline-Behavior-Review, Period/scope coherence + baseline
    // helper): the prior inline branching fabricated `change: 100` for
    // the new-baseline case (previous zero, current positive) and
    // `change: 0` for the no-data case (both zero). Consumers ignored
    // both fabrications via direction-branch guards in chart-renderers,
    // but the type shape `change: number` lied about the semantics and
    // the test suite actively locked in `change: 100` for new. Routing
    // through `computeBaselineDelta` and surfacing `change: null` when
    // no baseline exists aligns the type, the producer, and the test
    // contract with `core/baseline.ts`'s three-case discriminated union.
    const baseline = computeBaselineDelta(currentAmount, previousAmount);

    if (baseline.status === 'new') {
      donutTrends[trend.category.id] = { change: null, direction: 'new' };
      return;
    }

    if (baseline.status === 'no-data') {
      donutTrends[trend.category.id] = { change: null, direction: 'flat' };
      return;
    }

    // status === 'comparable' — `baseline.percent` is a signed number.
    const percent = baseline.percent ?? 0;
    donutTrends[trend.category.id] = {
      change: Math.round(Math.abs(percent)),
      direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat'
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
      render(html`<p class="text-xs text-center py-8" class="text-tertiary">Add expense activity to see which categories are creating the most pressure.</p>`, donutContainer);
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
  const totals = calculateMonthlyTotalsWithCache(currentMonth);
  const bvaSec = DOM.get('budget-vs-actual-section');
  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
  // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
  // once-per-session trackError on a genuine miss (map non-empty but the
  // requested month is missing), which is the data-loss signal the review
  // targets. Shape is identical on the hit path.
  const alloc = getMonthAlloc(currentMonth, signals.monthlyAlloc.value);
  const allocCats = Object.keys(alloc);

  if (bvaSec) {
    if (allocCats.length) {
      bvaSec.classList.remove('hidden');
      // CR-Apr22-D slice 5 (finding 63): the legacy
      // `info.name.split(' ')[0]` pattern collapsed multi-word category
      // names that shared a first token ("Car Insurance" / "Car Payment"
      // / "Car Loan") into the single label "Car" on the budget-vs-actual
      // x-axis — making adjacent bars indistinguishable by label.
      // `formatCategoryChartLabel` keeps the full name when it fits
      // (default budget of 14 visible chars covers every default preset
      // and most custom names) and otherwise truncates with a trailing
      // ellipsis at a position that preserves inter-category uniqueness.
      const labels = allocCats.map(c => {
        const info = getCatInfo('expense', c);
        return formatCategoryChartLabel(info);
      });
      // Phase 6 Slice 1i (rev 12 L6): `alloc[c]` is `number | undefined`
      // under `noUncheckedIndexedAccess`; `allocCats` was derived from
      // `Object.keys(alloc)` so presence is guaranteed — `?? 0` keeps the
      // chart-data array well-typed.
      const budgetVals = allocCats.map(c => alloc[c] ?? 0);
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
  const allCats = [...getAllCats('expense'), ...getAllCats('income')];

  const template = html`
    <option value="">All Categories</option>
    ${allCats.map(c => html`
      <option value="${c.id}">
        ${c.emoji} ${c.name}
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

  const allCats: UserCategory[] = [...allExpenseCategories.value, ...allIncomeCategories.value];

  if (!allCats.length) {
    render(html`<p class="text-xs text-tertiary">No custom categories</p>`, container);
    return;
  }

  const template = html`
    ${allCats.map((c) => html`
      <div class="flex items-center justify-between p-2 rounded bg-input">
        <div class="flex items-center gap-2">
          <span>${c.emoji}</span>
          <span class="text-sm font-bold text-primary">${c.name}</span>
          <span class="text-xs px-1 rounded text-tertiary">${c.type}</span>
        </div>
        <button class="del-custom-cat text-xs text-expense"
                @click=${() => handleDeleteCustomCat(c.id, c.type, c.name)}
                aria-label=${`Delete custom category ${c.name}`}>✕</button>
      </div>
    `)}
  `;

  render(template, container);
}

/**
 * Internal handler for custom category deletion.
 *
 * CR-Apr22-B slice 1: routed through `deleteCategoryWithCleanup` so this
 * path gets the same atomic sweep as the settings UI — previously this
 * function was the "partially correct" cleanup reference (it handled
 * allocations + transactions) while the settings path `category-manager`
 * did zero cleanup. Consolidation eliminates the behavior fork and fixes
 * two latent bugs flagged in CR-Apr22-D:
 *   (a) the hardcoded `'other' / 'other_income'` fallback that only
 *       exists on the Personal preset — deleting under Household /
 *       Freelancer / Business would migrate transactions to a phantom id;
 *   (b) the non-atomic ordering (category + allocations committed
 *       before the fallible `replaceAllTransactions`) which left a
 *       half-deleted state on tx-write failure.
 * The centralized helper picks a runtime fallback via
 * `pickFallbackCategoryId` and rewrites transactions FIRST so nothing
 * else is touched if that step fails.
 */
async function handleDeleteCustomCat(catId: string, _catType: 'expense' | 'income', catName: string): Promise<void> {
  const confirmed = await asyncConfirm({
    title: 'Delete Custom Category',
    message: `Delete custom category "${catName}"?`,
    details: 'Transactions, templates, and budget allocations referencing this category will be reassigned to a fallback "Other" category. This cannot be undone.',
    type: 'danger',
    confirmText: 'Delete Category',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;

  const outcome = await deleteCategoryWithCleanup(catId);

  if (!outcome.ok) {
    if (outcome.error === 'last_category_of_type') {
      showToast(outcome.message, 'warning');
      return;
    }
    if (outcome.error === 'tx_persist_failed') {
      showToast(outcome.message, 'error');
      return;
    }
    // 'not_found' — already gone; silently refresh.
    renderCustomCatsList();
    renderCategories();
    populateCategoryFilter();
    return;
  }

  // Summary toast — mirror the copy used by the settings-side handler so
  // both delete paths behave identically to the user.
  const reassignments: string[] = [];
  if (outcome.txMigrated > 0) reassignments.push(`${outcome.txMigrated} transaction${outcome.txMigrated === 1 ? '' : 's'}`);
  if (outcome.templatesMigrated > 0) reassignments.push(`${outcome.templatesMigrated} template${outcome.templatesMigrated === 1 ? '' : 's'}`);
  if (outcome.recurringMigrated > 0) reassignments.push(`${outcome.recurringMigrated} recurring`);
  if (outcome.allocationMonthsStripped > 0) reassignments.push(`${outcome.allocationMonthsStripped} allocation${outcome.allocationMonthsStripped === 1 ? '' : 's'}`);
  if (reassignments.length > 0) {
    showToast(`Reassigned ${reassignments.join(', ')} to "${outcome.fallbackCatName}".`, 'success');
  } else {
    showToast(`Category "${outcome.deletedCatName}" deleted.`, 'success');
  }

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
