/**
 * Dashboard Welcome Component
 *
 * Shows a welcoming empty state when the dashboard has no data (no transactions
 * and no budget allocations for the current month). Replaces the wall of $0.00
 * values with a friendly first-launch experience.
 *
 * Reactively hides itself the moment a transaction or budget entry is added,
 * revealing the real dashboard underneath.
 *
 * @module components/dashboard-welcome
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, nothing } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';

// ==========================================
// COMPUTED SIGNAL
// ==========================================

/**
 * CR-Apr22-E slice 1 (finding 58, [P2]): the prior gate keyed emptiness
 * to the CURRENT month's transactions + budget, which meant any user
 * with an existing populated ledger saw the full first-launch welcome
 * hero the moment they navigated to a historical or future month that
 * happened to have no entries. Concrete repro: user has 18 months of
 * transactions, navigates to December two years ago to double-check a
 * forgotten restaurant expense, empty-month gate fires, "Welcome to
 * Harbor Ledger — Set a monthly budget or log your first transaction"
 * hero replaces the dashboard.
 *
 * The correct semantic is "has this user ever put anything into the
 * app?" — not "is the viewed month empty?". The fix widens the gate to
 * total ledger emptiness: zero transactions across every month and
 * zero budget allocations ever configured. Empty historical/future
 * months now reveal the real dashboard's per-month empty states (pace
 * card "no data", BvA chart hidden, etc.), reserving the welcome hero
 * for the genuine first-launch experience.
 *
 * Why this set of signals: transactions + monthlyAlloc is the
 * intersection of the two storage keys that every new user mutates
 * during onboarding (either by logging a transaction or setting a
 * budget). Savings goals, debts, and templates are intentionally NOT
 * checked — a user who configured a savings goal but hasn't logged a
 * tx yet is still "new enough" that the welcome hero is useful.
 *
 * `currentMonth.value` is no longer read, so changing months is no
 * longer a dep-track edge for this computed — the welcome-vs-dashboard
 * decision is stable across month navigation.
 */
const showWelcome = computed(() => {
  const onboarding = signals.onboarding.value;
  if (onboarding.active) return false;   // let onboarding own the screen

  // Ledger emptiness: zero transactions across the entire history.
  if (signals.transactions.value.length > 0) return false;

  // Budget emptiness: every month's allocation bucket is empty (or the
  // map itself has no keys). A single populated month — even a future
  // one the user is planning ahead for — disqualifies the welcome hero.
  const allocByMonth = signals.monthlyAlloc.value;
  for (const mkAlloc of Object.values(allocByMonth)) {
    if (mkAlloc && Object.keys(mkAlloc).length > 0) return false;
  }

  return true;
});

/** CSS class applied to #tab-dashboard when welcome is visible.
 *  The stylesheet uses this to hide every sibling section via CSS only. */
const WELCOME_ACTIVE_CLASS = 'dashboard--welcome-active';

// ==========================================
// TEMPLATE
// ==========================================

function welcomeTemplate() {
  return html`
    <div class="dashboard-welcome__inner">
      <div class="dashboard-welcome__illustration">
        <div class="dashboard-welcome__harbor">
          <span class="dashboard-welcome__boat" aria-hidden="true">⛵</span>
          <div class="dashboard-welcome__waves" aria-hidden="true"></div>
        </div>
      </div>

      <h2 class="dashboard-welcome__title">Welcome to Harbor Ledger</h2>
      <p class="dashboard-welcome__copy">
        Your private budget dashboard lives right here. Set a monthly budget
        or log your first transaction and the numbers will come alive.
      </p>

      <div class="dashboard-welcome__actions">
        <button type="button"
                class="dashboard-welcome__btn dashboard-welcome__btn--primary empty-state-cta"
                data-action="add-transaction">
          Add First Transaction
        </button>
        <button type="button"
                class="dashboard-welcome__btn dashboard-welcome__btn--secondary empty-state-cta"
                data-action="load-sample">
          Load Sample Data
        </button>
      </div>

      <p class="dashboard-welcome__hint">
        Everything stays on your device — nothing leaves the browser.
      </p>
    </div>
  `;
}

// ==========================================
// DOM HELPERS
// ==========================================

function setWelcomeActive(active: boolean): void {
  const tab = document.getElementById('tab-dashboard');
  if (!tab) return;
  tab.classList.toggle(WELCOME_ACTIVE_CLASS, active);
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive dashboard welcome component.
 * Returns a cleanup function that disposes effects and restores visibility.
 */
export function mountDashboardWelcome(): () => void {
  const container = document.getElementById('dashboard-welcome');
  if (!container) return () => {};

  mountEffects('dashboard-welcome', [
    () => effect(() => {
      const show = showWelcome.value;

      if (show) {
        render(welcomeTemplate(), container);
        container.classList.remove('hidden');
        setWelcomeActive(true);
      } else {
        container.classList.add('hidden');
        render(nothing, container);
        setWelcomeActive(false);
      }
    }),
  ]);

  return () => {
    unmountEffects('dashboard-welcome');
    // Ensure sections are restored on teardown
    setWelcomeActive(false);
    const el = document.getElementById('dashboard-welcome');
    if (el) {
      el.classList.add('hidden');
      render(nothing, el);
    }
  };
}
