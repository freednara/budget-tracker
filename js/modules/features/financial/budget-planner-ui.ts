/**
 * Budget Planner UI Module
 *
 * Handles budget planning modal and custom category creation.
 *
 * @module budget-planner-ui
 */
'use strict';

import { createEventBinder } from '../../core/event-binding.js';
import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getMonthAlloc } from '../../core/month-alloc.js';
import { data } from '../../core/state-actions.js';
import { emit, Events } from '../../core/event-bus.js';
import { parseAmount, toCents, toDollars, fmtCur } from '../../core/utils-pure.js';
import { getEffectiveIncome } from './calculations.js';
import { isRolloverEnabled, calculateMonthRollovers } from './rollover.js';
import { DEFAULT_CATEGORY_COLOR, getAllCats } from '../../core/categories.js';
import { expenseCategories } from '../../core/category-store.js';
import DOM from '../../core/dom-cache.js';
import { html, render } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import type { TransactionType } from '../../../types/index.js';

// ==========================================
// CALLBACKS & STATE
// ==========================================

interface BudgetPlannerCallbacks {
  renderCategories?: () => void;
  renderQuickShortcuts?: () => void;
  populateCategoryFilter?: () => void;
  renderCustomCatsList?: () => void;
}

// Rev 13 L72 (Inline-Behavior-Review): `renderCategories`,
// `populateCategoryFilter`, and `renderCustomCatsList` are driven off the
// CATEGORY_UPDATED event contract wired in app-events.ts. Only the quick-
// shortcuts refresh lives outside that contract, so we retain it locally.
let renderQuickShortcutsFn: (() => void) | null = null;
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

const bindBudgetPlannerEvent = createEventBinder(budgetPlannerCleanupFns);

export function cleanupBudgetPlannerHandlers(): void {
  const cleanups = budgetPlannerCleanupFns.splice(0, budgetPlannerCleanupFns.length);
  cleanups.forEach((cleanup) => cleanup());
}

// ==========================================
// UTILITIES
// ==========================================

/**
 * Set callback functions for UI refresh
 */
export function setBudgetPlannerCallbacks(callbacks: BudgetPlannerCallbacks): void {
  // Only renderQuickShortcuts is retained; the rest are handled via the
  // CATEGORY_UPDATED event bus (see comment at the module-state block).
  if (callbacks.renderQuickShortcuts) renderQuickShortcutsFn = callbacks.renderQuickShortcuts;
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
  const saveBtn = DOM.get<HTMLButtonElement>('save-plan-budget');
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
  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
  // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
  // once-per-session trackError on a genuine miss (map non-empty but the
  // requested month is missing), which is the data-loss signal the review
  // targets. Shape is identical on the hit path.
  const alloc = getMonthAlloc(monthKey, signals.monthlyAlloc.value);
  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(monthKey) : {};

  // Design-Review-Apr21 P2: each budget input now carries an `aria-label`
  // built from the category name (plus rollover when active) so SR users
  // reading the grid hear the category context for every field. Previously
  // the name rendered as adjacent text with no programmatic association —
  // an SR sweeping through the grid heard only a column of unlabeled
  // "number" fields.
  const template = html`
    ${cats.map(c => {
      const rollover = rollovers[c.id] || 0;
      const rolloverHint = rolloverEnabled && rollover !== 0
        ? ` (rollover ${rollover > 0 ? '+' : ''}${fmtCur(rollover)})`
        : '';
      const inputAriaLabel = `${c.name} monthly allocation${rolloverHint}`;
      return html`
        <div class="flex items-center gap-3">
          <span class="text-lg w-8" aria-hidden="true">${c.emoji}</span>
          <span class="flex-1 text-sm font-bold text-primary">
            ${c.name}
            ${rolloverEnabled && rollover !== 0 ? html`
              <span class="rollover-badge text-xs px-1.5 py-0.5 rounded ml-1 ${rollover > 0 ? 'rollover-badge--positive' : 'rollover-badge--negative'}">
                ${rollover > 0 ? '+' : ''}${fmtCur(rollover)}
              </span>
            ` : ''}
          </span>
          <input type="number"
                 class="plan-cat-input form-input w-24 px-2 py-1 rounded text-sm text-right"
                 data-cat="${c.id}"
                 step="0.01"
                 min="0"
                 .value="${String(alloc[c.id] || '')}"
                 placeholder="0"
                 aria-label=${inputAriaLabel}
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

  if (nameInput) {
    nameInput.value = '';
    nameInput.setAttribute('aria-invalid', 'false');
  }
  if (colorInput) colorInput.value = DEFAULT_CATEGORY_COLOR;
  if (typeSelect) typeSelect.value = 'expense';

  // Clear any stale validation error from a previous open (the modal markup
  // is rendered once; resetting here keeps the aria-alert slot quiet on
  // fresh opens so SR users don't hear a stale "name required" toast).
  const nameErrorEl = DOM.get('custom-cat-name-error');
  if (nameErrorEl) {
    nameErrorEl.textContent = '';
    nameErrorEl.classList.add('hidden');
  }

  if (window.resetEmojiPicker) window.resetEmojiPicker();
  emit(Events.OPEN_MODAL, { id: 'category-modal' });
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize budget planner event handlers
 */
export function initBudgetPlannerHandlers(): void {
  cleanupBudgetPlannerHandlers();

  // CR-Apr24-C2b [P2] finding 102 + CR-Apr24-C2e [P2] finding 101:
  // Refresh the open Plan Budget modal on currency AND category changes.
  //
  // Finding 102 (C2b): currency change left stale symbol/formatting.
  // Finding 101 (C2e): category renames/recolors made elsewhere (or
  // via the CATEGORY_UPDATED event bus) didn't refresh the budget grid,
  // leaving stale category names and emoji in the open modal.
  //
  // Both signals are read eagerly (before the active-guard) so Preact
  // subscribes on every execution regardless of modal visibility.
  const currencyEffectCleanup = effect(() => {
    void signals.currency.value;
    void expenseCategories.value; // subscribe to category rename/recolor/reorder
    const modal = DOM.get('plan-budget-modal');
    if (!modal?.classList.contains('active')) return;
    const income = getEffectiveIncome(signals.currentMonth.value);
    const incomeDisplay = DOM.get('plan-monthly-income');
    if (incomeDisplay) incomeDisplay.textContent = fmtCur(income);
    renderBudgetGrid();
  });
  budgetPlannerCleanupFns.push(currencyEffectCleanup);

  // Plan Budget modal - open
  const openPlanBudget = DOM.get('open-plan-budget');
  if (openPlanBudget) bindBudgetPlannerEvent(openPlanBudget, 'click', () => {
    const income = getEffectiveIncome(signals.currentMonth.value);
    const incomeDisplay = DOM.get('plan-monthly-income');
    if (incomeDisplay) incomeDisplay.textContent = fmtCur(income);
    renderBudgetGrid();
    emit(Events.OPEN_MODAL, { id: 'plan-budget-modal' });
  });

  // Plan Budget modal - cancel
  const cancelPlanBudget = DOM.get('cancel-plan-budget');
  if (cancelPlanBudget) bindBudgetPlannerEvent(cancelPlanBudget, 'click', () => {
    emit(Events.CLOSE_MODAL, { id: 'plan-budget-modal' });
  });

  // Plan Budget modal - save
  const savePlanBudget = DOM.get('save-plan-budget');
  if (savePlanBudget) bindBudgetPlannerEvent(savePlanBudget, 'click', () => {
    const remCents = getPlanRemainingCents();
    // Only block saving when over-allocated (not when under-allocated — partial budgets are valid)
    if (remCents < 0) {
      const remText = fmtCur(toDollars(Math.abs(remCents)));
      emit(Events.SHOW_TOAST, { message: `Reduce allocations by ${remText} — exceeds income`, type: 'error' });
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
    emit(Events.CLOSE_MODAL, { id: 'plan-budget-modal' });
  });

  // Custom category modal - open from budget planner
  const addCategoryFromBudget = DOM.get('add-cat-from-budget');
  if (addCategoryFromBudget) bindBudgetPlannerEvent(addCategoryFromBudget, 'click', openCustomCategoryModal);

  // Custom category modal - cancel
  const cancelCustomCategory = DOM.get('cancel-custom-cat');
  if (cancelCustomCategory) bindBudgetPlannerEvent(cancelCustomCategory, 'click', () => {
    emit(Events.CLOSE_MODAL, { id: 'category-modal' });
  });

  // Custom category modal - save (now uses user-owned category store)
  const saveCustomCategory = DOM.get('save-custom-cat');
  if (saveCustomCategory) bindBudgetPlannerEvent(saveCustomCategory, 'click', async () => {
    const { nameInput, emojiInput, colorInput, typeSelect } = getCategoryModalElements();

    const name = nameInput?.value.trim() || '';
    const emoji = emojiInput?.value.trim() || '📌';
    const color = colorInput?.value || DEFAULT_CATEGORY_COLOR;
    const type = (typeSelect?.value || 'expense') as TransactionType;

    // Design-Review-Apr21 P2: missing-name used to be a silent no-op —
    // the primary action appeared broken. Now surfaces inline (role="alert"
    // slot next to the field), announces via toast, and returns focus to
    // the name input so keyboard/SR users have a clear recovery path.
    const nameErrorEl = DOM.get('custom-cat-name-error');
    const clearNameError = (): void => {
      if (nameErrorEl) {
        nameErrorEl.textContent = '';
        nameErrorEl.classList.add('hidden');
      }
      if (nameInput) nameInput.setAttribute('aria-invalid', 'false');
    };

    if (!name) {
      if (nameErrorEl) {
        nameErrorEl.textContent = 'Enter a category name to save';
        nameErrorEl.classList.remove('hidden');
      }
      if (nameInput) {
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
      }
      emit(Events.SHOW_TOAST, { message: 'Category name is required', type: 'error' });
      return;
    }

    clearNameError();

    // Validate color to prevent CSS injection
    if (!/^#[0-9A-Fa-f]{6}$/i.test(color)) {
      emit(Events.SHOW_TOAST, { message: 'Please enter a valid hex color (e.g., #FF5733)', type: 'error' });
      return;
    }

    // Use the new category store instead of legacy signals.customCats
    const { addCategory } = await import('../../core/category-store.js');
    addCategory({ name, emoji, color, type });
    emit(Events.CLOSE_MODAL, { id: 'category-modal' });

    // Rev 13 L72 (Inline-Behavior-Review): category-list / filter /
    // custom-cats refreshes are driven off the CATEGORY_UPDATED event
    // contract wired in app-events.ts. The quick-shortcuts strip and
    // the inline budget modal have no category subscriber on the bus,
    // so we still nudge them locally.
    if (renderQuickShortcutsFn) renderQuickShortcutsFn();

    // Refresh budget grid if plan-budget-modal is open
    const budgetModal = DOM.get('plan-budget-modal');
    if (budgetModal && budgetModal.classList.contains('active')) {
      renderBudgetGrid();
    }
  });
}
