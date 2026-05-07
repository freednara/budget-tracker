/**
 * Form Modals Component
 *
 * Lit templates for complex form modals: debt, payment, category, split, budget.
 * These maintain existing element IDs for backward compatibility with event handlers.
 *
 * @module components/form-modals
 */
'use strict';

import { html, type TemplateResult } from '../core/lit-helpers.js';
import { DEFAULT_CATEGORY_COLOR } from '../core/categories.js';

// ==========================================
// DEBT MODAL
// ==========================================

/**
 * Render the add/edit debt modal
 */
export function renderDebtModal(): TemplateResult {
  return html`
    <div id="debt-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="debt-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow modal-panel">
        <h3 id="debt-modal-title" class="text-xl font-black mb-4 text-primary">Add Debt</h3>
        <input type="hidden" id="edit-debt-id" value="">

        <div class="space-y-4">
          <div>
            <label for="debt-name" class="block text-xs font-bold mb-1 text-secondary">NAME</label>
            <input type="text" id="debt-name" maxlength="100" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="Credit Card, Car Loan, etc." aria-describedby="debt-name-error">
            <div id="debt-name-error" class="text-xs mt-1 hidden" role="alert" class="text-expense">Please enter a name</div>
          </div>

          <div>
            <label for="debt-type" class="block text-xs font-bold mb-1 text-secondary">TYPE</label>
            <select id="debt-type" class="w-full px-3 py-2 rounded-lg text-sm cursor-pointer form-input">
              <option value="credit_card">💳 Credit Card</option>
              <option value="student_loan">🎓 Student Loan</option>
              <option value="mortgage">🏠 Mortgage</option>
              <option value="auto">🚗 Auto Loan</option>
              <option value="personal">💰 Personal Loan</option>
              <option value="medical">🏥 Medical Debt</option>
              <option value="other">📄 Other</option>
            </select>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="debt-balance" class="block text-xs font-bold mb-1 text-secondary">CURRENT BALANCE</label>
              <input type="number" id="debt-balance" step="0.01" min="0" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="5000.00" aria-describedby="debt-balance-error">
              <div id="debt-balance-error" class="text-xs mt-1 hidden" role="alert" class="text-expense">Enter a balance greater than zero</div>
            </div>
            <div>
              <label for="debt-interest" class="block text-xs font-bold mb-1 text-secondary">APR %</label>
              <input type="number" id="debt-interest" step="0.01" min="0" max="100" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="19.99" aria-describedby="debt-interest-hint">
              <p id="debt-interest-hint" class="text-xs mt-1 text-tertiary">Annual rate, e.g. 19.99</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="debt-minimum" class="block text-xs font-bold mb-1 text-secondary">MIN PAYMENT</label>
              <input type="number" id="debt-minimum" step="0.01" min="0" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="150.00" aria-describedby="debt-minimum-hint">
              <p id="debt-minimum-hint" class="text-xs mt-1 text-tertiary">Monthly minimum due</p>
            </div>
            <div>
              <label for="debt-due-day" class="block text-xs font-bold mb-1 text-secondary">DUE DAY</label>
              <input type="number" id="debt-due-day" min="1" max="31" inputmode="numeric" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="15" aria-describedby="debt-due-hint">
              <p id="debt-due-hint" class="text-xs mt-1 text-tertiary">Day of month (1–31)</p>
            </div>
          </div>
        </div>

        <div class="flex gap-3 mt-6">
          <button id="delete-debt" class="hidden px-4 py-3 rounded-lg font-bold form-input-secondary text-expense" aria-label="Delete debt">🗑️</button>
          <button id="cancel-debt" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="save-debt" class="flex-1 py-3 rounded-lg font-bold btn btn-primary">Save Debt</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// DEBT PAYMENT MODAL
// ==========================================

/**
 * Render the make payment modal
 */
export function renderDebtPaymentModal(): TemplateResult {
  return html`
    <div id="debt-payment-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="debt-payment-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow modal-panel">
        <h3 id="debt-payment-modal-title" class="text-xl font-black mb-2 text-primary">Make Payment</h3>
        <input type="hidden" id="debt-payment-id" value="">
        <p id="debt-payment-name" class="text-sm mb-4 text-secondary">Debt name</p>

        <div class="p-3 rounded-lg mb-4 form-input">
          <div class="flex justify-between text-sm">
            <span class="text-secondary">Current Balance:</span>
            <span id="debt-payment-balance" class="font-bold text-expense">$0.00</span>
          </div>
          <div class="flex justify-between text-sm mt-1">
            <span class="text-secondary">Minimum Payment:</span>
            <span id="debt-payment-minimum" class="font-bold text-primary">$0.00</span>
          </div>
        </div>

        <div class="mb-4">
          <label for="debt-payment-amount" class="block text-xs font-bold mb-1 text-secondary">PAYMENT AMOUNT</label>
          <input type="number" id="debt-payment-amount" step="0.01" min="0.01" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="150.00" aria-describedby="debt-payment-error">
          <div id="debt-payment-error" class="text-xs mt-1 hidden" role="alert" class="text-expense">Enter a payment amount greater than zero</div>
          <p class="text-xs mt-2 text-tertiary">This will create an expense transaction and reduce your debt balance.</p>
        </div>

        <div class="mb-4">
          <label for="debt-payment-date" class="block text-xs font-bold mb-1 text-secondary">PAYMENT DATE</label>
          <input type="date" id="debt-payment-date" class="w-full px-3 py-2 rounded-lg text-sm form-input">
        </div>

        <div class="flex gap-3">
          <button id="cancel-debt-payment" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="confirm-debt-payment" class="flex-1 py-3 rounded-lg font-bold btn btn-success">Pay Now</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// DEBT STRATEGY MODAL
// ==========================================

/**
 * Render the debt strategy comparison modal
 */
export function renderDebtStrategyModal(): TemplateResult {
  return html`
    <div id="debt-strategy-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="debt-strategy-modal-title" data-backdrop-close="force">
      <div class="rounded-2xl p-6 max-w-lg w-full card-shadow modal-panel modal-panel--scroll">
        <h3 id="debt-strategy-modal-title" class="text-xl font-black mb-4 text-primary">📊 Payoff Strategies</h3>

        <div class="mb-4">
          <label for="extra-payment" class="block text-xs font-bold mb-1 text-secondary">EXTRA MONTHLY PAYMENT</label>
          <input type="number" id="extra-payment" value="100" step="50" min="0" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input">
          <p class="text-xs mt-1 text-tertiary">Amount above minimums to accelerate payoff</p>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-4">
          <!-- Snowball Strategy -->
          <div class="p-4 rounded-lg form-input">
            <h4 class="font-bold mb-1 text-primary">❄️ Snowball</h4>
            <p class="text-xs mb-2 text-secondary">Smallest balance first</p>
            <p id="snowball-months" class="text-lg font-black text-primary">-- months</p>
            <p id="snowball-interest" class="text-xs text-tertiary">$-- interest</p>
          </div>
          <!-- Avalanche Strategy -->
          <div class="p-4 rounded-lg form-input">
            <h4 class="font-bold mb-1 text-primary">🏔️ Avalanche</h4>
            <p class="text-xs mb-2 text-secondary">Highest interest first</p>
            <p id="avalanche-months" class="text-lg font-black text-primary">-- months</p>
            <p id="avalanche-interest" class="text-xs text-tertiary">$-- interest</p>
          </div>
        </div>

        <!-- Recommendation -->
        <div id="strategy-recommendation" class="p-3 rounded-lg mb-4 bg-accent-light">
          <p class="text-sm text-primary"><strong>💡 Recommendation:</strong> <span id="strategy-rec-text">--</span></p>
        </div>

        <!-- Dynamic strategy comparison results -->
        <div id="strategy-results" class="space-y-4 mb-4"></div>

        <!-- Payoff Order -->
        <div class="mb-4">
          <p class="text-xs font-bold mb-2 text-secondary">PAYOFF ORDER (AVALANCHE)</p>
          <div id="payoff-order-list" class="space-y-1"></div>
        </div>

        <button id="close-strategy-modal" class="w-full py-3 rounded-lg font-bold btn btn-secondary">Close</button>
      </div>
    </div>
  `;
}

// ==========================================
// PLAN BUDGET MODAL
// ==========================================

/**
 * Render the plan budget modal
 */
export function renderPlanBudgetModal(): TemplateResult {
  return html`
    <div id="plan-budget-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="plan-budget-modal-title">
      <div class="rounded-2xl p-6 max-w-lg w-full card-shadow modal-panel modal-panel--scroll">
        <h3 id="plan-budget-modal-title" class="text-xl font-black mb-4 text-primary">📋 Plan Your Budget</h3>
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div class="p-3 rounded-lg form-input">
            <span class="block text-xs font-bold mb-1 text-secondary">INCOME</span>
            <span id="plan-monthly-income" class="text-lg font-black text-income">$0.00</span>
          </div>
          <div class="p-3 rounded-lg bg-accent-light">
            <span class="block text-xs font-bold mb-1 text-secondary">REMAINING</span>
            <span id="plan-remaining" class="text-lg font-black text-accent">$0.00</span>
          </div>
        </div>
        <div id="plan-budget-grid" class="space-y-3 mb-4"></div>
        <button id="add-cat-from-budget" class="w-full py-2 rounded-lg text-sm font-bold mb-4 btn-dashed">+ Add Category</button>
        <div class="flex gap-3">
          <button id="cancel-plan-budget" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="save-plan-budget" class="flex-1 py-3 rounded-lg font-bold btn-primary">Save Budget</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// CATEGORY MODAL
// ==========================================

/**
 * Render the custom category modal
 */
export function renderCategoryModal(): TemplateResult {
  return html`
    <div id="category-modal" class="modal-overlay modal-overlay--stacked" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow modal-panel">
        <h3 id="category-modal-title" class="text-xl font-black mb-4 text-primary">Custom Category</h3>
        <div class="space-y-3 mb-4">
          <div>
            <label for="custom-cat-name" class="block text-xs font-bold mb-1 text-secondary">NAME</label>
            <input type="text" id="custom-cat-name" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="Category name" aria-describedby="custom-cat-name-error" aria-required="true">
            <div id="custom-cat-name-error" role="alert" class="text-xs font-bold mt-1 hidden text-warning"></div>
          </div>
          <div>
            <label class="block text-xs font-bold mb-1 text-secondary">EMOJI</label>
            <div id="emoji-picker-container">
              <button type="button" id="emoji-picker-trigger" class="w-full px-3 py-2 rounded-lg text-left flex items-center justify-between form-input" aria-label="Choose category emoji" aria-expanded="false">
                <span id="selected-emoji-preview" class="text-2xl">🎨</span>
                <span class="text-xs text-tertiary">Click to choose</span>
              </button>
              <div id="emoji-picker-dropdown" class="hidden mt-2 p-3 rounded-lg form-input">
                <div id="emoji-category-tabs" class="flex gap-1 mb-2 overflow-x-auto pb-1"></div>
                <div id="emoji-grid" class="grid grid-cols-8 gap-1"></div>
              </div>
            </div>
            <input type="hidden" id="custom-cat-emoji" value="🎨">
          </div>
          <div>
            <label for="custom-cat-color" class="block text-xs font-bold mb-1 text-secondary">COLOR</label>
            <input type="color" id="custom-cat-color" value="${DEFAULT_CATEGORY_COLOR}" class="w-full h-10 rounded-lg cursor-pointer form-input">
          </div>
          <div>
            <label for="custom-cat-type" class="block text-xs font-bold mb-1 text-secondary">TYPE</label>
            <select id="custom-cat-type" class="w-full px-3 py-2 rounded-lg text-sm cursor-pointer form-input">
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </div>
        </div>
        <div class="flex gap-3">
          <button id="cancel-custom-cat" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="save-custom-cat" class="flex-1 py-3 rounded-lg font-bold btn-primary">Save Category</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// SPLIT TRANSACTION MODAL
// ==========================================

/**
 * Render the split transaction modal container.
 * Content is rendered reactively by split-transactions.ts mountSplitModal()
 */
export function renderSplitModal(): TemplateResult {
  return html`
    <div id="split-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-label="Split Transaction"></div>
  `;
}

// ==========================================
// COMBINED FORM MODALS
// ==========================================

/**
 * Render all form modals at once
 */
export function renderFormModals(): TemplateResult {
  return html`
    ${renderDebtModal()}
    ${renderDebtPaymentModal()}
    ${renderDebtStrategyModal()}
    ${renderPlanBudgetModal()}
    ${renderCategoryModal()}
    ${renderSplitModal()}
  `;
}
