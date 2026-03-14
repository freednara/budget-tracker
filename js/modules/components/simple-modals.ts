/**
 * Simple Modals Component
 *
 * Lit templates for simple modals: delete confirmation, edit recurring,
 * import options, and add savings.
 *
 * These maintain existing element IDs for backward compatibility with
 * event handlers in modal-events.ts and other modules.
 *
 * @module components/simple-modals
 */
'use strict';

import { html, nothing, type TemplateResult } from '../core/lit-helpers.js';

// ==========================================
// DELETE MODAL
// ==========================================

/**
 * Render the delete transaction confirmation modal
 * Dynamic content (emoji, category, amount, date, desc) is populated by modal-events.ts
 */
export function renderDeleteModal(): TemplateResult {
  return html`
    <div id="delete-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section);">
        <h3 id="delete-modal-title" class="text-xl font-black mb-2 text-primary">Delete Transaction?</h3>
        <div id="delete-tx-details" class="p-3 rounded-lg mb-4" style="background: var(--bg-input);">
          <div class="flex items-center gap-2 mb-2">
            <span id="delete-tx-emoji" class="text-xl"></span>
            <span id="delete-tx-category" class="font-bold text-primary"></span>
          </div>
          <div id="delete-tx-amount" class="text-lg font-black mb-1"></div>
          <div id="delete-tx-date" class="text-sm text-secondary"></div>
          <div id="delete-tx-desc" class="text-sm mt-1 text-secondary"></div>
        </div>
        <p class="text-sm mb-4 text-secondary">This cannot be undone.</p>
        <div class="flex gap-3">
          <button id="cancel-delete" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--bg-input); color: var(--text-primary);">Cancel</button>
          <button id="confirm-delete" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--color-expense); color: white;">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// EDIT RECURRING MODAL
// ==========================================

/**
 * Render the edit recurring transaction modal
 * Allows user to choose between editing single occurrence or entire series
 */
export function renderEditRecurringModal(): TemplateResult {
  return html`
    <div id="edit-recurring-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-recurring-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section);">
        <h3 id="edit-recurring-title" class="text-xl font-black mb-2 text-primary">Edit Recurring Transaction</h3>
        <p class="text-sm mb-4 text-secondary">This is part of a recurring series. What would you like to edit?</p>
        <div class="space-y-2">
          <button id="edit-single" class="w-full py-3 rounded-lg font-bold text-left px-4 flex items-center gap-3" style="background: var(--bg-input); color: var(--text-primary);">
            <span class="text-xl">📝</span>
            <div>
              <div class="font-bold">This occurrence only</div>
              <div class="text-xs text-tertiary">Edit just this transaction</div>
            </div>
          </button>
          <button id="edit-series" class="w-full py-3 rounded-lg font-bold text-left px-4 flex items-center gap-3" style="background: var(--bg-input); color: var(--text-primary);">
            <span class="text-xl">↻</span>
            <div>
              <div class="font-bold">All future occurrences</div>
              <div class="text-xs text-tertiary">Edit this and all future transactions in series</div>
            </div>
          </button>
          <button id="cancel-edit-recurring" class="w-full py-2 rounded-lg text-sm text-tertiary">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// IMPORT OPTIONS MODAL
// ==========================================

/**
 * Render the import options modal
 * Allows user to choose between replacing all data or merging
 */
export function renderImportModal(): TemplateResult {
  return html`
    <div id="import-options-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="import-options-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section);">
        <h3 id="import-options-modal-title" class="text-xl font-black mb-2 text-primary">Import Data</h3>
        <p class="text-sm mb-4 text-secondary">How would you like to import?</p>
        <div class="space-y-2">
          <button id="import-overwrite" class="w-full py-3 rounded-lg font-bold text-sm" style="background: var(--color-expense); color: white;">Replace All Data</button>
          <button id="import-merge" class="w-full py-3 rounded-lg font-bold text-sm btn-primary">Merge with Existing</button>
          <button id="cancel-import" class="w-full py-3 rounded-lg font-bold text-sm" style="background: var(--bg-input); color: var(--text-primary);">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// ADD SAVINGS MODAL
// ==========================================

/**
 * Render the add savings amount modal
 * Goal name is populated dynamically by savings-goals.ts
 */
export function renderAddSavingsModal(): TemplateResult {
  return html`
    <div id="add-savings-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-savings-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow savings-card-bg">
        <h3 id="add-savings-modal-title" class="text-xl font-black mb-2 text-primary">Add to Savings</h3>
        <p id="add-savings-goal-name" class="text-sm mb-4 text-secondary">Goal name</p>
        <div class="mb-4">
          <label for="add-savings-amount" class="block text-xs font-bold mb-1 text-secondary">AMOUNT TO ADD</label>
          <input type="number" id="add-savings-amount" step="0.01" min="0.01" max="999999.99" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm"
            style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" placeholder="100.00">
          <div id="add-savings-amount-error" class="text-xs mt-1 hidden text-expense">Please enter a valid amount</div>
        </div>
        <div class="flex gap-3">
          <button id="cancel-add-savings" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--bg-input); color: var(--text-primary);">Cancel</button>
          <button id="confirm-add-savings" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--color-income); color: white;">Add Funds</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// SAVINGS GOAL MODAL
// ==========================================

/**
 * Render the create savings goal modal
 */
export function renderSavingsGoalModal(): TemplateResult {
  return html`
    <div id="savings-goal-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="savings-goal-modal-title">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow savings-card-bg">
        <h3 id="savings-goal-modal-title" class="text-xl font-black mb-4 text-primary">Create Savings Goal</h3>
        <div class="space-y-3 mb-4">
          <div>
            <label for="savings-goal-name" class="block text-xs font-bold mb-1 text-secondary">GOAL NAME</label>
            <input type="text" id="savings-goal-name" class="w-full px-3 py-2 rounded-lg text-sm" maxlength="100"
              style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" placeholder="e.g., Vacation Fund">
            <div id="savings-goal-name-error" class="text-xs mt-1 hidden text-expense">Please enter a goal name</div>
          </div>
          <div>
            <label for="savings-goal-amount" class="block text-xs font-bold mb-1 text-secondary">TARGET AMOUNT</label>
            <input type="number" id="savings-goal-amount" step="0.01" min="5" max="999999.99" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm"
              style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);" placeholder="5000.00">
            <div id="savings-goal-amount-error" class="text-xs mt-1 hidden text-expense">Target amount must be at least $5.00</div>
          </div>
          <div>
            <label for="savings-goal-deadline" class="block text-xs font-bold mb-1 text-secondary">DEADLINE</label>
            <input type="date" id="savings-goal-deadline" class="w-full px-3 py-2 rounded-lg text-sm"
              style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
          </div>
        </div>
        <div class="flex gap-3">
          <button id="cancel-savings-goal" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--bg-input); color: var(--text-primary);">Cancel</button>
          <button id="save-savings-goal" class="flex-1 py-3 rounded-lg font-bold" style="background: var(--color-income); color: white;">Save Goal</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// COMBINED SIMPLE MODALS
// ==========================================

/**
 * Render all simple modals at once
 * Useful for mounting all modals in a single container
 */
export function renderSimpleModals(): TemplateResult {
  return html`
    ${renderDeleteModal()}
    ${renderEditRecurringModal()}
    ${renderImportModal()}
    ${renderAddSavingsModal()}
    ${renderSavingsGoalModal()}
  `;
}
