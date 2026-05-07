import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { mountDashboardWelcome } from '../js/modules/components/dashboard-welcome.js';
import type { Transaction, MonthlyAllocation } from '../js/types/index.js';

/**
 * CR-Apr22-E slice 1 coverage — Dashboard welcome hero gates on total
 * ledger emptiness rather than the viewed month's emptiness
 * (finding 58, `[P2]`).
 *
 * Before this slice, `showWelcome` keyed on the CURRENT month's
 * transactions + budget via `calculateEffectiveMonthBudgetTotal`. A user
 * with an established ledger who navigated to a historical or future
 * month that happened to be empty would see the full first-launch
 * welcome hero replace the dashboard. Concrete repro: a user with 18
 * months of transactions navigates to December two years ago to double-
 * check a forgotten restaurant expense, the empty-month gate fires, and
 * "Welcome to Harbor Ledger — Set a monthly budget or log your first
 * transaction" hides the real dashboard.
 *
 * The fix widens the gate to total ledger emptiness: zero transactions
 * across every month AND zero budget allocations configured anywhere.
 * Empty historical/future months now reveal the real dashboard's
 * per-month empty states (pace card "no data", BvA chart hidden, etc.),
 * reserving the welcome hero for the genuine first-launch experience.
 *
 * A secondary correctness property: `currentMonth.value` is no longer
 * read by the computed, so month navigation must NOT toggle the welcome
 * hero on a populated ledger.
 *
 * These tests exercise the mounted component through its DOM surface
 * (`#tab-dashboard` class + `#dashboard-welcome` `.hidden` class) —
 * integration-style, so the full effect + DOM-mutation pipeline is
 * under test, not just the computed.
 */

const WELCOME_ACTIVE_CLASS = 'dashboard--welcome-active';

function seedDom(): void {
  document.body.innerHTML = `
    <div id="tab-dashboard">
      <div id="dashboard-welcome" class="hidden"></div>
      <div id="dashboard-real-content">real dashboard sections</div>
    </div>
  `;
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
    type: 'expense',
    category: 'food',
    amount: 25,
    description: 'Test lunch',
    date: '2026-04-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

function welcomeVisible(): boolean {
  const container = document.getElementById('dashboard-welcome');
  const tab = document.getElementById('tab-dashboard');
  if (!container || !tab) return false;
  // Visible iff `hidden` is removed AND the tab got the active class.
  return !container.classList.contains('hidden') && tab.classList.contains(WELCOME_ACTIVE_CLASS);
}

describe('dashboard-welcome — CR-Apr22-E slice 1 ledger-emptiness gate', () => {
  const originalTx = signals.transactions.value;
  const originalAlloc = signals.monthlyAlloc.value;
  const originalMonth = signals.currentMonth.value;
  const originalOnboarding = signals.onboarding.value;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    seedDom();
    signals.transactions.value = [];
    signals.monthlyAlloc.value = {};
    signals.currentMonth.value = '2026-04';
    signals.onboarding.value = { active: false, step: 0, completed: false };
  });

  afterEach(() => {
    if (cleanup) {
      try { cleanup(); } catch { /* swallow */ }
      cleanup = null;
    }
    signals.transactions.value = originalTx;
    signals.monthlyAlloc.value = originalAlloc;
    signals.currentMonth.value = originalMonth;
    signals.onboarding.value = originalOnboarding;
    document.body.innerHTML = '';
  });

  describe('welcome shows only on a genuinely empty ledger', () => {
    it('shows welcome when transactions are empty AND allocation map is empty', () => {
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);
    });

    it('shows welcome when alloc map has keys but every entry is an empty bucket', () => {
      // `{ '2026-04': {} }` encodes "user navigated to this month but
      // allocated nothing". Not a signal of ledger usage — still first
      // launch. Guards the per-month empty-bucket normalization that
      // some storage-layer code paths produce.
      signals.monthlyAlloc.value = { '2026-04': {}, '2026-05': {} };
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);
    });
  });

  describe('regression lock for finding 58 — populated ledger never shows welcome', () => {
    it('hides welcome when a transaction exists even in a DIFFERENT month than the viewed one', () => {
      // The exact repro from the review: user viewing 2026-04, but a
      // transaction is logged against 2024-12. Legacy code would have
      // fired the welcome hero; fixed gate keeps it hidden.
      signals.transactions.value = [makeTx({ date: '2024-12-20' })];
      signals.currentMonth.value = '2026-04';
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });

    it('hides welcome when a transaction exists in a FUTURE month (planning-ahead user)', () => {
      signals.transactions.value = [makeTx({ date: '2027-01-05' })];
      signals.currentMonth.value = '2026-04';
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });

    it('hides welcome when a single allocation exists in a DIFFERENT month than the viewed one', () => {
      // User set a budget in April 2024, then navigates to the empty
      // April 2026 month. The legacy current-month gate would have
      // fired; the fix treats the historical budget as evidence the
      // ledger is non-empty.
      signals.monthlyAlloc.value = {
        '2024-04': { food: 300 } satisfies MonthlyAllocation
      };
      signals.currentMonth.value = '2026-04';
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });

    it('hides welcome when allocation exists in a FUTURE month (forward planner)', () => {
      signals.monthlyAlloc.value = {
        '2027-01': { rent: 1500 } satisfies MonthlyAllocation
      };
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });
  });

  describe('current-month populated ledger also keeps welcome hidden (positive path)', () => {
    it('hides welcome when a tx exists in the viewed month', () => {
      signals.transactions.value = [makeTx({ date: '2026-04-15' })];
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });

    it('hides welcome when an allocation exists in the viewed month', () => {
      signals.monthlyAlloc.value = {
        '2026-04': { food: 400 } satisfies MonthlyAllocation
      };
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });
  });

  describe('onboarding takes precedence over the ledger gate', () => {
    it('hides welcome when onboarding is active, even on an empty ledger', () => {
      signals.onboarding.value = { active: true, step: 1, completed: false };
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);
    });
  });

  describe('reactivity — signal changes flip the welcome hero live', () => {
    it('reveals the welcome hero when the last transaction is removed', () => {
      signals.transactions.value = [makeTx({ date: '2026-04-15' })];
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);

      signals.transactions.value = [];

      expect(welcomeVisible()).toBe(true);
    });

    it('hides the welcome hero the moment a transaction is added', () => {
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);

      signals.transactions.value = [makeTx({ date: '2026-04-15' })];

      expect(welcomeVisible()).toBe(false);
    });

    it('hides the welcome hero the moment a budget allocation is set', () => {
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);

      signals.monthlyAlloc.value = {
        '2026-04': { food: 200 } satisfies MonthlyAllocation
      };

      expect(welcomeVisible()).toBe(false);
    });

    it('hides welcome when onboarding starts, reveals it when onboarding ends on an empty ledger', () => {
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);

      signals.onboarding.value = { active: true, step: 1, completed: false };
      expect(welcomeVisible()).toBe(false);

      signals.onboarding.value = { active: false, step: 0, completed: true };
      expect(welcomeVisible()).toBe(true);
    });
  });

  describe('month-navigation no longer toggles the welcome hero', () => {
    it('flipping currentMonth across empty/populated months is inert on a populated ledger', () => {
      // This is the core semantic the fix restores: the welcome
      // decision is stable across month navigation. Seed a ledger with
      // activity only in 2026-04, then walk the viewed month through
      // three adjacent empty months. Welcome must remain hidden
      // throughout — the pre-fix behavior would have flipped it visible.
      signals.transactions.value = [makeTx({ date: '2026-04-15' })];
      signals.currentMonth.value = '2026-04';
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(false);

      signals.currentMonth.value = '2024-12';
      expect(welcomeVisible()).toBe(false);

      signals.currentMonth.value = '2027-01';
      expect(welcomeVisible()).toBe(false);

      signals.currentMonth.value = '2019-06';
      expect(welcomeVisible()).toBe(false);
    });

    it('flipping currentMonth across months is inert on a truly empty ledger too', () => {
      // Symmetric check: stability holds both ways. Welcome stays
      // visible across month navigation when there's nothing logged.
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);

      signals.currentMonth.value = '2024-12';
      expect(welcomeVisible()).toBe(true);

      signals.currentMonth.value = '2027-01';
      expect(welcomeVisible()).toBe(true);
    });
  });

  describe('cleanup disposes effects so further signal changes are inert', () => {
    it('cleanup restores the hidden state and unsubscribes from signals', () => {
      cleanup = mountDashboardWelcome();
      expect(welcomeVisible()).toBe(true);

      cleanup();
      cleanup = null;

      // Post-teardown the container must be hidden again, regardless
      // of signal state (the cleanup function in the module sets
      // `hidden` and clears the active class explicitly).
      expect(welcomeVisible()).toBe(false);

      // And a subsequent signal flip must not re-toggle the DOM —
      // the effect is gone.
      const container = document.getElementById('dashboard-welcome')!;
      const tab = document.getElementById('tab-dashboard')!;
      const hiddenBefore = container.classList.contains('hidden');
      const activeBefore = tab.classList.contains(WELCOME_ACTIVE_CLASS);

      signals.transactions.value = [makeTx()];
      signals.transactions.value = [];

      expect(container.classList.contains('hidden')).toBe(hiddenBefore);
      expect(tab.classList.contains(WELCOME_ACTIVE_CLASS)).toBe(activeBefore);
    });
  });

  describe('missing container is a clean no-op', () => {
    it('mountDashboardWelcome returns a no-op cleanup when #dashboard-welcome is absent', () => {
      document.body.innerHTML = '<div id="tab-dashboard"></div>';
      cleanup = mountDashboardWelcome();

      // Cleanup must be callable and not throw.
      expect(() => cleanup && cleanup()).not.toThrow();
      cleanup = null;

      // Tab class must never have been toggled.
      const tab = document.getElementById('tab-dashboard');
      expect(tab?.classList.contains(WELCOME_ACTIVE_CLASS)).toBe(false);
    });
  });
});
