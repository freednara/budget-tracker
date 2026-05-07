/**
 * Open-Modal Data Freshness (CR-Apr24-C2c, findings 104 + 106 + 108)
 *
 * Regression tests for reactive refresh of modal context when underlying
 * data changes while the modal is open:
 *
 * - Finding 104: Add-Savings modal stale on goal rename / saved-amount change
 * - Finding 106: Debt-Payment modal stale on debt edits
 * - Finding 108: Debt-Edit modal detects concurrent modifications at save
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { mountSavingsGoals } from '../js/modules/components/savings-goals.js';
import { settings as settingsActions } from '../js/modules/core/actions/data-actions.js';
import { modal } from '../js/modules/core/state-actions.js';
import type { SavingsGoal, Debt } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function createGoal(overrides: Partial<SavingsGoal> & { id?: string } = {}): [string, SavingsGoal] {
  const id = overrides.id || `goal_${Math.random().toString(36).slice(2)}`;
  const goal: SavingsGoal = {
    name: 'Vacation Fund',
    target: 5000,
    saved: 1200,
    deadline: '2026-12-31',
    icon: '🏖️',
    ...overrides
  } as SavingsGoal;
  return [id, goal];
}

function createDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: `debt_${Math.random().toString(36).slice(2)}`,
    name: 'Credit Card',
    balance: 3000,
    originalBalance: 5000,
    interestRate: 0.1999,
    minimumPayment: 75,
    type: 'credit_card',
    isActive: true,
    dueDay: 15,
    ...overrides
  } as Debt;
}

/**
 * Simulate a modal being in "active" state (as the OPEN_MODAL handler does).
 */
function activateModal(id: string): void {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ==========================================
// FINDING 104: Add-Savings modal freshness
// ==========================================

describe('finding 104 — add-savings modal refreshes on goal data change', () => {
  const originalGoals = { ...signals.savingsGoals.value };
  const originalCurrency = { ...signals.currency.value };
  let cleanup = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <section id="savings-goals-section">
        <div class="app-panel__actions"></div>
        <div id="savings-goals-list"></div>
      </section>
      <div id="add-savings-modal" class="modal-overlay" role="dialog">
        <p id="add-savings-goal-name">Goal name</p>
        <span id="add-savings-current">$0.00</span>
        <span id="add-savings-remaining">$0.00</span>
        <input id="add-savings-amount" type="number" />
        <input id="add-savings-date" type="date" />
      </div>
    `;
    settingsActions.setCurrency('USD', '$');
    signals.savingsGoals.value = {};
    signals.addSavingsGoalId.value = null;
  });

  afterEach(() => {
    cleanup();
    cleanup = (): void => {};
    signals.savingsGoals.value = originalGoals;
    signals.addSavingsGoalId.value = null;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('refreshes name label when goal is renamed while modal is open', () => {
    const [id, goal] = createGoal({ name: 'Vacation Fund' });
    signals.savingsGoals.value = { [id]: goal };

    cleanup = mountSavingsGoals();

    // Simulate opening the add-savings modal for this goal
    signals.addSavingsGoalId.value = id;
    activateModal('add-savings-modal');

    // Trigger the effect by touching currency (to establish subscriptions)
    // then change the goal name
    const nameEl = document.getElementById('add-savings-goal-name');

    // Rename the goal while modal is open
    signals.savingsGoals.value = {
      [id]: { ...goal, name: 'Emergency Fund' }
    };

    expect(nameEl?.textContent).toBe('Emergency Fund');
  });

  it('refreshes current/remaining when saved amount changes while modal is open', () => {
    const [id, goal] = createGoal({ name: 'Car', target: 10000, saved: 2000 });
    signals.savingsGoals.value = { [id]: goal };

    cleanup = mountSavingsGoals();

    signals.addSavingsGoalId.value = id;
    activateModal('add-savings-modal');

    const currentEl = document.getElementById('add-savings-current');
    const remainingEl = document.getElementById('add-savings-remaining');

    // Change saved amount while modal is open
    signals.savingsGoals.value = {
      [id]: { ...goal, saved: 5000 }
    };

    expect(currentEl?.textContent).toContain('5,000');
    expect(remainingEl?.textContent).toContain('5,000');
  });

  it('does not crash when goal is deleted while modal is open', () => {
    const [id, goal] = createGoal();
    signals.savingsGoals.value = { [id]: goal };

    cleanup = mountSavingsGoals();

    signals.addSavingsGoalId.value = id;
    activateModal('add-savings-modal');

    // Delete the goal while modal is open — should not throw
    expect(() => {
      signals.savingsGoals.value = {};
    }).not.toThrow();
  });
});

// ==========================================
// FINDING 106: Debt-Payment modal freshness
// ==========================================

describe('finding 106 — debt-payment modal refreshes on debt data change', () => {
  const originalDebts = [...signals.debts.value];
  const originalCurrency = { ...signals.currency.value };
  let cleanupList: Array<() => void> = [];

  beforeEach(async () => {
    DOM.clearAll();
    // Minimal DOM for the debt handler setup — only the payment modal
    // elements we're testing. The full debt-ui-handlers.ts setup needs
    // various buttons/inputs; we'll provide the minimal set.
    document.body.innerHTML = `
      <section id="debt-planner-section">
        <div id="debts-list"></div>
        <div id="compare-strategies-wrapper" class="hidden"></div>
        <div id="debt-summary-cards" class="hidden"></div>
        <div class="app-panel__actions"></div>
      </section>
      <div id="debt-payment-modal" class="modal-overlay" role="dialog">
        <input id="debt-payment-id" type="hidden" />
        <span id="debt-payment-name">—</span>
        <span id="debt-payment-balance">$0.00</span>
        <span id="debt-payment-minimum">$0.00</span>
        <input id="debt-payment-amount" type="number" />
        <input id="debt-payment-date" type="date" />
        <div id="debt-payment-error" class="hidden"></div>
        <button id="cancel-debt-payment">Cancel</button>
        <button id="confirm-debt-payment">Confirm</button>
      </div>
      <div id="debt-modal" class="modal-overlay" role="dialog">
        <h3 id="debt-modal-title">Add Debt</h3>
        <input id="edit-debt-id" type="hidden" />
        <input id="debt-name" />
        <div id="debt-name-error" class="hidden"></div>
        <select id="debt-type"><option value="credit_card">CC</option></select>
        <input id="debt-balance" type="number" />
        <div id="debt-balance-error" class="hidden"></div>
        <input id="debt-interest" type="number" />
        <input id="debt-minimum" type="number" />
        <input id="debt-due-day" type="number" />
        <button id="add-debt-btn">Add</button>
        <button id="save-debt">Save</button>
        <button id="cancel-debt">Cancel</button>
        <button id="delete-debt" class="hidden">Delete</button>
      </div>
      <div id="debt-strategy-modal" class="modal-overlay" role="dialog">
        <input id="extra-payment" type="number" />
        <div id="strategy-results"></div>
        <span id="snowball-months"></span>
        <span id="avalanche-months"></span>
        <span id="snowball-interest"></span>
        <span id="avalanche-interest"></span>
        <span id="snowball-savings"></span>
        <button id="compare-strategies-btn">Compare</button>
        <button id="close-strategy-modal">Close</button>
      </div>
    `;
    settingsActions.setCurrency('USD', '$');
    signals.debts.value = [];
  });

  afterEach(() => {
    cleanupList.forEach(fn => fn());
    cleanupList = [];
    signals.debts.value = originalDebts;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('refreshes balance and name when debt changes while payment modal is open', async () => {
    const { initDebtHandlers, cleanupDebtHandlers } = await import('../js/modules/ui/widgets/debt-ui-handlers.js');


    const debt = createDebt({ id: 'debt_1', name: 'Visa', balance: 3000, minimumPayment: 75 });
    signals.debts.value = [debt];

    initDebtHandlers();
    cleanupList.push(cleanupDebtHandlers);

    // Simulate opening payment modal for this debt
    const paymentIdEl = document.getElementById('debt-payment-id') as HTMLInputElement;
    paymentIdEl.value = 'debt_1';
    activateModal('debt-payment-modal');

    const nameEl = document.getElementById('debt-payment-name');
    const balanceEl = document.getElementById('debt-payment-balance');

    // Mutate the debt while modal is open
    signals.debts.value = [{ ...debt, name: 'Visa Platinum', balance: 2500 }];

    expect(nameEl?.textContent).toBe('Visa Platinum');
    expect(balanceEl?.textContent).toContain('2,500');
  });

  it('refreshes minimum payment label when debt changes while modal is open', async () => {
    const { initDebtHandlers, cleanupDebtHandlers } = await import('../js/modules/ui/widgets/debt-ui-handlers.js');


    const debt = createDebt({ id: 'debt_2', name: 'Amex', balance: 5000, minimumPayment: 100 });
    signals.debts.value = [debt];

    initDebtHandlers();
    cleanupList.push(cleanupDebtHandlers);

    const paymentIdEl = document.getElementById('debt-payment-id') as HTMLInputElement;
    paymentIdEl.value = 'debt_2';
    activateModal('debt-payment-modal');

    const minEl = document.getElementById('debt-payment-minimum');

    // Increase minimum payment while modal is open
    signals.debts.value = [{ ...debt, minimumPayment: 150 }];

    expect(minEl?.textContent).toContain('150');
  });
});

// ==========================================
// FINDING 108: Debt-Edit staleness detection
// ==========================================

describe('finding 108 — debt-edit modal detects concurrent modifications', () => {
  const originalDebts = [...signals.debts.value];
  const originalCurrency = { ...signals.currency.value };
  let cleanupList: Array<() => void> = [];

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <section id="debt-planner-section">
        <div id="debts-list">
          <div class="debt-item" data-debt-id="debt_edit_1">
            <button class="debt-edit-btn">Edit</button>
            <button class="debt-payment-btn">Pay</button>
          </div>
        </div>
        <div id="compare-strategies-wrapper" class="hidden"></div>
        <div id="debt-summary-cards" class="hidden"></div>
        <div class="app-panel__actions"></div>
      </section>
      <div id="debt-modal" class="modal-overlay" role="dialog">
        <h3 id="debt-modal-title">Add Debt</h3>
        <input id="edit-debt-id" type="hidden" />
        <input id="debt-name" />
        <div id="debt-name-error" class="hidden"></div>
        <select id="debt-type"><option value="credit_card">CC</option></select>
        <input id="debt-balance" type="number" />
        <div id="debt-balance-error" class="hidden"></div>
        <input id="debt-interest" type="number" />
        <input id="debt-minimum" type="number" />
        <input id="debt-due-day" type="number" />
        <button id="add-debt-btn">Add</button>
        <button id="save-debt">Save</button>
        <button id="cancel-debt">Cancel</button>
        <button id="delete-debt" class="hidden">Delete</button>
      </div>
      <div id="debt-payment-modal" class="modal-overlay" role="dialog">
        <input id="debt-payment-id" type="hidden" />
        <span id="debt-payment-name">—</span>
        <span id="debt-payment-balance">$0.00</span>
        <span id="debt-payment-minimum">$0.00</span>
        <input id="debt-payment-amount" type="number" />
        <input id="debt-payment-date" type="date" />
        <div id="debt-payment-error" class="hidden"></div>
        <button id="cancel-debt-payment">Cancel</button>
        <button id="confirm-debt-payment">Confirm</button>
      </div>
      <div id="debt-strategy-modal" class="modal-overlay" role="dialog">
        <input id="extra-payment" type="number" />
        <div id="strategy-results"></div>
        <span id="snowball-months"></span>
        <span id="avalanche-months"></span>
        <span id="snowball-interest"></span>
        <span id="avalanche-interest"></span>
        <span id="snowball-savings"></span>
        <button id="compare-strategies-btn">Compare</button>
        <button id="close-strategy-modal">Close</button>
      </div>
    `;
    settingsActions.setCurrency('USD', '$');
    signals.debts.value = [];
  });

  afterEach(() => {
    cleanupList.forEach(fn => fn());
    cleanupList = [];
    signals.debts.value = originalDebts;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('populates the edit snapshot when the edit button is clicked', async () => {
    const { initDebtHandlers, cleanupDebtHandlers } = await import('../js/modules/ui/widgets/debt-ui-handlers.js');


    const debt = createDebt({ id: 'debt_edit_1', name: 'Student Loan', balance: 20000 });
    signals.debts.value = [debt];

    initDebtHandlers();
    cleanupList.push(cleanupDebtHandlers);

    // Click the edit button
    const editBtn = document.querySelector('.debt-edit-btn') as HTMLElement;
    editBtn.click();

    // The hidden edit-debt-id input should be populated
    const editIdEl = document.getElementById('edit-debt-id') as HTMLInputElement;
    expect(editIdEl.value).toBe('debt_edit_1');

    // The name field should be populated
    const nameEl = document.getElementById('debt-name') as HTMLInputElement;
    expect(nameEl.value).toBe('Student Loan');
  });
});
