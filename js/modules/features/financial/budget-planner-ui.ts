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
import { data } from '../../core/state-actions.js';
import { showToast, openModal, closeModal } from '../../ui/core/ui.js';
import { parseAmount, toCents, toDollars, generateId } from '../../core/utils.js';
import { getEffectiveIncome } from './calculations.js';
import { isRolloverEnabled, calculateMonthRollovers } from './rollover.js';
import { DEFAULT_CATEGORY_COLOR, getAllCats } from '../../core/categories.js';
import DOM from '../../core/dom-cache.js';
import { html, render, type TemplateResult } from '../../core/lit-helpers.js';
import type { CustomCategory, TransactionType } from '../../../types/index.js';

// ==========================================
// CALLBACKS & STATE
// ==========================================

interface BudgetPlannerCallbacks {
  renderCategories?: () => void;
  renderQuickShortcuts?: () => void;
  populateCategoryFilter?: () => void;
  renderCustomCatsList?: () => void;
}

let renderCategoriesFn: (() => void) | null = null;
let renderQuickShortcutsFn: (() => void) | null = null;
let populateCategoryFilterFn: (() => void) | null = null;
let renderCustomCatsListFn: (() => void) | null = null;
let fmtCurFn: ((v: number) => string) | null = null;
const budgetPlannerCleanupFns: Array<() => void> = [];

interface CategoryModalElements {
  nameInput: HTMLInputElement | null;
  emojiInput: HTMLInputElement | null;
  colorInput: HTMLInputElement | null;
  typeSelect: HTMLSelectElement | null;
}

function getCategoryModalElements(): CategoryModalElements {
  return {
    nameInput: document.getElementById('custom-cat-name') as HTMLInputElement | null,
    emojiInput: document.getElementById('custom-cat-emoji') as HTMLInputElement | null,
    colorInput: document.getElementById('custom-cat-color') as HTMLInputElement | null,
    typeSelect: document.getElementById('custom-cat-type') as HTMLSelectElement | null
  };
}

function bindBudgetPlannerEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject
): void {
  target.addEventListener(type, handler);
  budgetPlannerCleanupFns.push(() => {
    target.removeEventListener(type, handler);
  });
}

export function cleanupBudgetPlannerHandlers(): void {
  const cleanups = budgetPlannerCleanupFns.splice(0, budgetPlannerCleanupFns.length);
  cleanups.forEach((cleanup) => cleanup());
}

// ==========================================
// UTILITIES
// ==========================================

// Cache the DI-resolved currency formatter to avoid container lookup on every call
let cachedDIFormatter: ((v: number) => string) | null = null;

function formatCurrency(amount: number): string {
  if (!cachedDIFormatter) {
    const container = signals.getDefaultContainer();
    const formatter = container.resolveSync<any>(signals.Services.CURRENCY_FORMATTER);
    if (formatter) {
      cachedDIFormatter = formatter;
    }
  }
  return cachedDIFormatter ? cachedDIFormatter(amount) : '$' + amount.toFixed(2);
}

/**
 * Set currency formatter function
 */
export function setBudgetPlannerFmtCur(fn: (v: number) => string): void {
  fmtCurFn = fn;
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
  const remText = (fmtCurFn || formatCurrency)(toDollars(Math.abs(remCents)));

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
    // Allow saving when allocations are at or under income (partial budgets are OK)
    // Only block when over-allocated (remCents < 0)
    const isOverAllocated = remCents < 0;
    saveBtn.disabled = isOverAllocated;
    saveBtn.classList.toggle('opacity-50', isOverAllocated);
    saveBtn.classList.toggle('cursor-not-allowed', isOverAllocated);
  }
}

// ==========================================
// BUDGET GRID RENDERING
// ==========================================

/**
 * Render the budget grid using Lit
 */
function renderBudgetGrid(): void {
  const container = DOM.get('plan-budget-grid');
  if (!container) return;

  const cats = getAllCats('expense');
  const monthKey = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[monthKey] || {};
  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(monthKey) : {};

  const template = html`
    ${cats.map(c => {
      const rollover = rollovers[c.id] || 0;
      return html`
        <div class="flex items-center gap-3">
          <span class="text-lg w-8">${c.emoji}</span>
          <span class="flex-1 text-sm font-bold text-primary">
            ${c.name}
            ${rolloverEnabled && rollover !== 0 ? html`
              <span class="rollover-badge text-xs px-1.5 py-0.5 rounded ml-1" 
                    style="background: ${rollover > 0 ? 'color-mix(in srgb, var(--color-income) 20%, transparent)' : 'color-mix(in srgb, var(--color-expense) 20%, transparent)'}; 
                           color: ${rollover > 0 ? 'var(--color-income)' : 'var(--color-expense)'};">
                ${rollover > 0 ? '+' : ''}${formatCurrency(rollover)}
              </span>
            ` : ''}
          </span>
          <input type="number" 
                 class="plan-cat-input w-24 px-2 py-1 rounded text-sm text-right" 
                 data-cat="${c.id}" 
                 step="0.01" 
                 min="0" 
                 .value="${String(alloc[c.id] || '')}"
                 style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" 
                 placeholder="0"
                 @input=${updatePlanRemaining}>
        </div>
      `;
    })}
  `;

  render(template, container);
  updatePlanRemaining();
}

// ==========================================
// CUSTOM CATEGORY MODAL
// ==========================================

/**
 * Open the custom category modal with reset fields
 */
function openCustomCategoryModal(): void {
  const { nameInput, colorInput, typeSelect } = getCategoryModalElements();

  if (nameInput) nameInput.value = '';
  if (colorInput) colorInput.value = DEFAULT_CATEGORY_COLOR;
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
  cleanupBudgetPlannerHandlers();

  // Plan Budget modal - open
  const openPlanBudget = DOM.get('open-plan-budget');
  if (openPlanBudget) bindBudgetPlannerEvent(openPlanBudget, 'click', () => {
    const income = getEffectiveIncome(signals.currentMonth.value);
    const incomeDisplay = DOM.get('plan-monthly-income');
    if (incomeDisplay) incomeDisplay.textContent = formatCurrency(income);
    renderBudgetGrid();
    openModal('plan-budget-modal');
  });

  // Plan Budget modal - cancel
  const cancelPlanBudget = DOM.get('cancel-plan-budget');
  if (cancelPlanBudget) bindBudgetPlannerEvent(cancelPlanBudget, 'click', () => {
    closeModal('plan-budget-modal');
  });

  // Plan Budget modal - save
  const savePlanBudget = DOM.get('save-plan-budget');
  if (savePlanBudget) bindBudgetPlannerEvent(savePlanBudget, 'click', () => {
    const remCents = getPlanRemainingCents();
    // Only block saving when over-allocated (not when under-allocated — partial budgets are valid)
    if (remCents < 0) {
      const remText = (fmtCurFn || formatCurrency)(toDollars(Math.abs(remCents)));
      showToast(`Reduce allocations by ${remText} — exceeds income`, 'error');
      return;
    }

    const alloc: Record<string, number> = {};
    document.querySelectorAll<HTMLInputElement>('.plan-cat-input').forEach(inp => {
      const v = parseAmount(inp.value);
      if (v > 0 && inp.dataset.cat) alloc[inp.dataset.cat] = v;
    });
    const currentMonth = signals.currentMonth.value;
    data.setMonthlyAllocations({ ...signals.monthlyAlloc.value, [currentMonth]: alloc });
    persist(SK.ALLOC, signals.monthlyAlloc.value);
    closeModal('plan-budget-modal');
  });

  // Custom category modal - open from various buttons
  const addCustomCategory = DOM.get('add-custom-cat-btn');
  if (addCustomCategory) bindBudgetPlannerEvent(addCustomCategory, 'click', openCustomCategoryModal);
  const addCategoryFromBudget = DOM.get('add-cat-from-budget');
  if (addCategoryFromBudget) bindBudgetPlannerEvent(addCategoryFromBudget, 'click', openCustomCategoryModal);

  // Custom category modal - cancel
  const cancelCustomCategory = DOM.get('cancel-custom-cat');
  if (cancelCustomCategory) bindBudgetPlannerEvent(cancelCustomCategory, 'click', () => {
    closeModal('category-modal');
  });

  // Custom category modal - save
  const saveCustomCategory = DOM.get('save-custom-cat');
  if (saveCustomCategory) bindBudgetPlannerEvent(saveCustomCategory, 'click', () => {
    const { nameInput, emojiInput, colorInput, typeSelect } = getCategoryModalElements();

    const name = nameInput?.value.trim() || '';
    const emoji = emojiInput?.value.trim() || '📌';
    const color = colorInput?.value || DEFAULT_CATEGORY_COLOR;
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
      data.setCustomCategories([...signals.customCats.value, newCategory]);
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
        renderBudgetGrid();
      }
    }
  });
}
