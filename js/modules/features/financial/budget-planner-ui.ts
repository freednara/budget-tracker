/**
 * Budget Planner UI Module
 *
 * Handles budget planning modal and custom category creation.
 *
 * @module budget-planner-ui
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { showToast, openModal, closeModal } from '../../ui/core/ui.js';
import { parseAmount, toCents, toDollars, esc, generateId } from '../../core/utils.js';
import { getEffectiveIncome } from './calculations.js';
import { isRolloverEnabled, calculateMonthRollovers } from './rollover.js';
import { getAllCats } from '../../core/categories.js';
import { emit, Events } from '../../core/event-bus.js';
import { checkAchievements } from '../gamification/achievements.js';
import DOM from '../../core/dom-cache.js';
import type { CustomCategory, TransactionType } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface BudgetPlannerCallbacks {
  renderCategories?: () => void;
  renderQuickShortcuts?: () => void;
  populateCategoryFilter?: () => void;
  renderCustomCatsList?: () => void;
}

// Extend window for emoji picker global
declare global {
  interface Window {
    resetEmojiPicker?: () => void;
  }
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: (v: number) => string = (v) => '$' + v.toFixed(2);
let renderCategoriesFn: (() => void) | null = null;
let renderQuickShortcutsFn: (() => void) | null = null;
let populateCategoryFilterFn: (() => void) | null = null;
let renderCustomCatsListFn: (() => void) | null = null;

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Set the currency formatter function
 */
export function setBudgetPlannerFmtCur(fn: (v: number) => string): void {
  fmtCur = fn;
}

/**
 * Set callback functions for UI refresh
 */
export function setBudgetPlannerCallbacks(callbacks: BudgetPlannerCallbacks): void {
  if (callbacks.renderCategories) renderCategoriesFn = callbacks.renderCategories;
  if (callbacks.renderQuickShortcuts) renderQuickShortcutsFn = callbacks.renderQuickShortcuts;
  if (callbacks.populateCategoryFilter) populateCategoryFilterFn = callbacks.populateCategoryFilter;
  if (callbacks.renderCustomCatsList) renderCustomCatsListFn = callbacks.renderCustomCatsList;
}

// ==========================================
// BUDGET CALCULATIONS
// ==========================================

/**
 * Calculate remaining cents to allocate in budget plan
 * @returns Remaining cents (positive = unassigned, negative = over)
 */
export function getPlanRemainingCents(): number {
  const incomeCents = toCents(getEffectiveIncome(signals.currentMonth.value));
  let totalAllocatedCents = 0;
  document.querySelectorAll<HTMLInputElement>('.plan-cat-input').forEach(inp => {
    totalAllocatedCents += toCents(parseAmount(inp.value));
  });
  return incomeCents - totalAllocatedCents;
}

/**
 * Update the plan remaining display with real-time validation
 */
export function updatePlanRemaining(): void {
  const el = DOM.get('plan-remaining');
  if (!el) return;
  const saveBtn = DOM.get('save-plan-budget') as HTMLButtonElement | null;
  const remCents = getPlanRemainingCents();
  const remText = fmtCur(toDollars(Math.abs(remCents)));

  if (remCents > 0) {
    el.textContent = `${remText} unassigned`;
    el.style.color = 'var(--color-accent)';
  } else if (remCents < 0) {
    el.textContent = `${remText} over budget`;
    el.style.color = 'var(--color-expense)';
  } else {
    el.textContent = 'Fully allocated';
    el.style.color = 'var(--color-income)';
  }

  if (saveBtn) {
    saveBtn.disabled = remCents !== 0;
    saveBtn.classList.toggle('opacity-50', remCents !== 0);
    saveBtn.classList.toggle('cursor-not-allowed', remCents !== 0);
  }
}

// ==========================================
// BUDGET GRID RENDERING
// ==========================================

/**
 * Render the budget grid HTML
 */
function renderBudgetGridHtml(): string {
  const cats = getAllCats('expense');
  const currentMonth = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[currentMonth] || {};
  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(currentMonth) : {};

  return cats.map(c => {
    const rollover = rollovers[c.id] || 0;
    const rolloverBadge = rolloverEnabled && rollover !== 0
      ? `<span class="rollover-badge text-xs px-1.5 py-0.5 rounded ml-1" style="background: ${rollover > 0 ? 'color-mix(in srgb, var(--color-income) 20%, transparent)' : 'color-mix(in srgb, var(--color-expense) 20%, transparent)'}; color: ${rollover > 0 ? 'var(--color-income)' : 'var(--color-expense)'};">${rollover > 0 ? '+' : ''}${fmtCur(rollover)}</span>`
      : '';
    return `<div class="flex items-center gap-3">
      <span class="text-lg w-8">${esc(c.emoji)}</span>
      <span class="flex-1 text-sm font-bold" style="color: var(--text-primary);">${esc(c.name)}${rolloverBadge}</span>
      <input type="number" class="plan-cat-input w-24 px-2 py-1 rounded text-sm text-right" data-cat="${c.id}" step="0.01" min="0" value="${esc(String(alloc[c.id] || ''))}"
        style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" placeholder="0">
    </div>`;
  }).join('');
}

/**
 * Refresh the budget grid and attach event listeners
 */
function refreshBudgetGrid(): void {
  const grid = DOM.get('plan-budget-grid');
  if (!grid) return;
  grid.innerHTML = renderBudgetGridHtml();
  updatePlanRemaining();
  grid.querySelectorAll('.plan-cat-input').forEach(inp => {
    inp.addEventListener('input', updatePlanRemaining);
  });
}

// ==========================================
// CUSTOM CATEGORY MODAL
// ==========================================

/**
 * Open the custom category modal with reset fields
 */
function openCustomCategoryModal(): void {
  const nameInput = DOM.get('custom-cat-name') as HTMLInputElement | null;
  const colorInput = DOM.get('custom-cat-color') as HTMLInputElement | null;
  const typeSelect = DOM.get('custom-cat-type') as HTMLSelectElement | null;

  if (nameInput) nameInput.value = '';
  if (colorInput) colorInput.value = '#8b5cf6';
  if (typeSelect) typeSelect.value = 'expense';
  if (window.resetEmojiPicker) window.resetEmojiPicker();
  openModal('category-modal');
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize budget planner event handlers
 */
export function initBudgetPlannerHandlers(): void {
  // Plan Budget modal - open
  DOM.get('open-plan-budget')?.addEventListener('click', () => {
    const income = getEffectiveIncome(signals.currentMonth.value);
    const incomeDisplay = DOM.get('plan-monthly-income');
    if (incomeDisplay) incomeDisplay.textContent = fmtCur(income);
    refreshBudgetGrid();
    openModal('plan-budget-modal');
  });

  // Plan Budget modal - cancel
  DOM.get('cancel-plan-budget')?.addEventListener('click', () => {
    closeModal('plan-budget-modal');
  });

  // Plan Budget modal - save
  DOM.get('save-plan-budget')?.addEventListener('click', () => {
    const remCents = getPlanRemainingCents();
    if (remCents !== 0) {
      const remText = fmtCur(toDollars(Math.abs(remCents)));
      showToast(
        remCents > 0
          ? `Allocate ${remText} before saving`
          : `Reduce allocations by ${remText} before saving`,
        'error'
      );
      return;
    }

    const alloc: Record<string, number> = {};
    document.querySelectorAll<HTMLInputElement>('.plan-cat-input').forEach(inp => {
      const v = parseAmount(inp.value);
      if (v > 0 && inp.dataset.cat) alloc[inp.dataset.cat] = v;
    });
    const currentMonth = signals.currentMonth.value;
    signals.monthlyAlloc.value = { ...signals.monthlyAlloc.value, [currentMonth]: alloc };
    persist(SK.ALLOC, signals.monthlyAlloc.value);
    closeModal('plan-budget-modal');
    emit(Events.BUDGET_UPDATED);
    checkAchievements();
  });

  // Custom category modal - open from various buttons
  DOM.get('add-custom-cat-btn')?.addEventListener('click', openCustomCategoryModal);
  DOM.get('add-cat-from-budget')?.addEventListener('click', openCustomCategoryModal);

  // Custom category modal - cancel
  DOM.get('cancel-custom-cat')?.addEventListener('click', () => {
    closeModal('category-modal');
  });

  // Custom category modal - save
  DOM.get('save-custom-cat')?.addEventListener('click', () => {
    const nameInput = DOM.get('custom-cat-name') as HTMLInputElement | null;
    const emojiInput = DOM.get('custom-cat-emoji') as HTMLInputElement | null;
    const colorInput = DOM.get('custom-cat-color') as HTMLInputElement | null;
    const typeSelect = DOM.get('custom-cat-type') as HTMLSelectElement | null;

    const name = nameInput?.value.trim() || '';
    const emoji = emojiInput?.value.trim() || '📌';
    const color = colorInput?.value || '#8b5cf6';
    const type = (typeSelect?.value || 'expense') as TransactionType;

    // Validate color to prevent CSS injection
    if (!/^#[0-9A-Fa-f]{6}$/i.test(color)) {
      showToast('Please enter a valid hex color (e.g., #FF5733)', 'error');
      return;
    }

    if (name) {
      const newCategory: CustomCategory = {
        id: `custom_${generateId()}`,
        name,
        emoji,
        color,
        type
      };
      signals.customCats.value = [...signals.customCats.value, newCategory];
      persist(SK.CUSTOM_CAT, signals.customCats.value);
      closeModal('category-modal');

      // Refresh UI via callbacks
      if (renderCategoriesFn) renderCategoriesFn();
      if (renderQuickShortcutsFn) renderQuickShortcutsFn();
      if (populateCategoryFilterFn) populateCategoryFilterFn();
      if (renderCustomCatsListFn) renderCustomCatsListFn();

      // Refresh budget grid if plan-budget-modal is open
      const budgetModal = DOM.get('plan-budget-modal');
      if (budgetModal && budgetModal.classList.contains('active')) {
        refreshBudgetGrid();
      }
    }
  });
}
