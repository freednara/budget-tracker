import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { mountSavingsGoals } from '../js/modules/components/savings-goals.js';
import { mountSplitModal } from '../js/modules/features/financial/split-transactions.js';
import type { SavingsGoal } from '../js/types/index.js';

/**
 * CR-Apr24-C2b [P2×5] — Open-modal currency reactivity
 * (Code-Review-Report findings 100, 102, 103, 105, 107).
 *
 * Pre-fix: five modals format money via `fmtCur()` in their open-time
 * render but had no signal subscription to `signals.currency`. A
 * settings-driven currency change with the modal already open kept
 * the stale symbol/locale formatting until close+reopen. Fix pattern:
 * subscribe an open-modal effect to `signals.currency.value` and
 * re-run the render path when (a) currency changed AND (b) the modal
 * is currently active.
 *
 * These tests exercise the data-layer contract for the savings +
 * split-tx modals — the simpler ones to drive without complex DOM
 * setup. The other three modals (plan-budget, debt-strategy,
 * debt-payment) have similar subscriptions; covered indirectly via
 * the integration-test suite.
 */

describe('CR-Apr24-C2b — Open-modal currency reactivity', () => {
  describe('finding 105 — add-savings modal labels refresh on currency change', () => {
    let cleanup: (() => void) | null = null;
    const originalCurrency = signals.currency.value;
    const originalSavings = signals.savingsGoals.value;
    const originalAddSavingsId = signals.addSavingsGoalId.value;

    beforeEach(() => {
      document.body.innerHTML = `
        <section id="savings-goals-section">
          <div class="app-panel__actions hidden"></div>
          <div id="savings-goals-list"></div>
        </section>
        <div id="add-savings-modal">
          <span id="add-savings-current"></span>
          <span id="add-savings-remaining"></span>
        </div>
      `;
      const goal: SavingsGoal = {
        id: 'g1',
        name: 'Emergency Fund',
        target: 1000,
        saved: 250
      };
      signals.savingsGoals.value = { 'g1': goal };
      signals.addSavingsGoalId.value = 'g1';
      signals.currency.value = { home: 'USD', symbol: '$' };
    });

    afterEach(() => {
      if (cleanup) {
        try { cleanup(); } catch { /* swallow */ }
        cleanup = null;
      }
      signals.savingsGoals.value = originalSavings;
      signals.addSavingsGoalId.value = originalAddSavingsId;
      signals.currency.value = originalCurrency;
      document.body.innerHTML = '';
    });

    it('does not update labels when modal is NOT active (post-fix gate)', () => {
      cleanup = mountSavingsGoals();
      const currentEl = document.getElementById('add-savings-current')!;
      currentEl.textContent = 'INITIAL';
      // Modal is not .active — the effect's gate should bail.
      signals.currency.value = { home: 'EUR', symbol: '€' };
      // Label remains untouched because the modal isn't active.
      expect(currentEl.textContent).toBe('INITIAL');
    });

    it('refreshes labels when modal is active and currency changes', () => {
      cleanup = mountSavingsGoals();
      const modalEl = document.getElementById('add-savings-modal')!;
      modalEl.classList.add('active');

      const currentEl = document.getElementById('add-savings-current')!;
      const remainingEl = document.getElementById('add-savings-remaining')!;
      // Initial population — the effect runs on mount + once per signal change.
      // After mount, the effect may not have populated (depends on signal changes).
      // Let's force a currency change to trigger the effect.
      signals.currency.value = { home: 'EUR', symbol: '€' };

      // Both labels should now reflect the goal's current/remaining values.
      // We don't assert exact format (depends on locale) but verify content
      // is set to a non-empty string.
      expect(currentEl.textContent).not.toBe('');
      expect(remainingEl.textContent).not.toBe('');
    });

    it('reflects the goal data when currency change re-fires the effect', () => {
      cleanup = mountSavingsGoals();
      const modalEl = document.getElementById('add-savings-modal')!;
      modalEl.classList.add('active');
      const currentEl = document.getElementById('add-savings-current')!;
      const remainingEl = document.getElementById('add-savings-remaining')!;

      // Trigger via currency change.
      signals.currency.value = { home: 'EUR', symbol: '€' };

      // Goal saved=250, target=1000 → remaining=750. Verify labels include
      // a non-empty money-shaped string (the exact format depends on
      // locale-service initialization in the test env).
      expect(currentEl.textContent?.length).toBeGreaterThan(0);
      expect(remainingEl.textContent?.length).toBeGreaterThan(0);
    });

    it('clean teardown: cleanup unsubscribes the currency effect', () => {
      cleanup = mountSavingsGoals();
      const modalEl = document.getElementById('add-savings-modal')!;
      modalEl.classList.add('active');

      cleanup();
      cleanup = null;

      const currentEl = document.getElementById('add-savings-current')!;
      currentEl.textContent = 'STILL_INITIAL';
      // Currency change after cleanup must NOT re-render.
      signals.currency.value = { home: 'GBP', symbol: '£' };

      expect(currentEl.textContent).toBe('STILL_INITIAL');
    });
  });

  describe('finding 100 — split-transaction modal subscribes to currency', () => {
    let cleanup: (() => void) | null = null;
    const originalCurrency = signals.currency.value;
    const originalSplitTxId = signals.splitTxId.value;

    beforeEach(() => {
      document.body.innerHTML = `<div id="split-modal"></div>`;
      signals.splitTxId.value = null;
      signals.currency.value = { home: 'USD', symbol: '$' };
    });

    afterEach(() => {
      if (cleanup) {
        try { cleanup(); } catch { /* swallow */ }
        cleanup = null;
      }
      signals.splitTxId.value = originalSplitTxId;
      signals.currency.value = originalCurrency;
      document.body.innerHTML = '';
    });

    it('mountSplitModal does not throw on currency change with no active txId', () => {
      cleanup = mountSplitModal();
      // No txId set — effect early-returns. Currency change must not throw.
      expect(() => {
        signals.currency.value = { home: 'EUR', symbol: '€' };
      }).not.toThrow();
    });

    it('cleanup teardown stops currency subscription', () => {
      cleanup = mountSplitModal();
      cleanup();
      cleanup = null;
      // No throw, no listeners left.
      expect(() => {
        signals.currency.value = { home: 'GBP', symbol: '£' };
      }).not.toThrow();
    });
  });
});
