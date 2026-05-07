/**
 * Savings Goals Component
 *
 * Reactive component that renders savings goals with progress bars and forecasts.
 * Automatically updates when savingsGoals or savingsContribs signals change.
 *
 * @module components/savings-goals
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { savingsGoals as savingsGoalsActions, modal } from '../core/state-actions.js';
import { calculateGoalForecast } from '../features/financial/savings-goals.js';
import { emit, Events } from '../core/event-bus.js';
import { fmtCur, parseLocalDate, getTodayStr } from '../core/utils-pure.js';
import { localeService } from '../core/locale-service.js';
import { html, render, nothing, repeat } from '../core/lit-helpers.js';
import DOM from '../core/dom-cache.js';
import { selectedSavingsGoal } from './transaction-detail-panel.js';
import type { GoalForecast } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Using types from central registry

interface GoalDisplayData {
  id: string;
  name: string;
  targetAmount: number;
  savedAmount: number;
  deadline: string;
  daysLeft: number | null;
  percentage: number;
  forecast: GoalForecast | null;
  /** Emoji icon (falls back to 💚 when the goal has no stored icon). */
  icon: string;
}

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Goals with computed display data
 * Recomputes when savingsGoals or savingsContribs change
 */
const goalsDisplayData = computed((): GoalDisplayData[] => {
  // Fixes H7: signal is canonical `Record<string, SavingsGoal>` post-hydration
  // (see normalizeSavingsGoalsRecord). Legacy `{target_amount, saved_amount}`
  // and legacy `{emoji}` are folded into the modern shape at the boundary,
  // so this reader no longer needs the dual-shape accessors.
  const goals = Object.entries(signals.savingsGoals.value);

  // Force recomputation when contributions change (for forecasts)
  const _contribCount = signals.savingsContribs.value.length;

  // CR-Apr22-E slice 4 (finding 61a [P2]): subscribe to the midnight-
  // rollover signal so `daysLeft` and the `forecast` (via `Date.now()`
  // inside `calculateGoalForecast`) refresh when the local date flips
  // at 00:00. Without this edge, a user leaving the app open overnight
  // would still see yesterday's countdown — "2 days left" persisting
  // into a day where the goal is actually already overdue. Matches the
  // pattern CR-Apr22-D slice 3 used for `dailyAllowanceData` and
  // `spendingPaceData`.
  const _today = signals.todayStr.value;

  if (!goals.length) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return goals.map(([gid, g]) => {
    const saved = g.saved ?? 0;
    const target = g.target ?? 0;
    const pct = target > 0 ? Math.min((saved / target) * 100, 100) : 0;
    // CR-Apr22-G slice 3: dropped the `Math.max(0, ...)` clamp so overdue
    // goals carry a negative day count through to the renderer. The clamp
    // flattened every past-deadline goal to "0 days left" regardless of
    // how far past due it actually was — users couldn't tell whether a
    // goal was due today, two weeks ago, or two years ago. The footer
    // branches on the sign of this value to emit "Due today" / "N days
    // overdue" / "N days left".
    const daysLeft = g.deadline
      ? Math.round((parseLocalDate(g.deadline).getTime() - today.getTime()) / 86400000)
      : null;
    const forecast = calculateGoalForecast({ ...g, id: gid });
    const icon = g.icon || '💚';

    return {
      id: gid,
      name: g.name,
      targetAmount: target,
      savedAmount: saved,
      deadline: g.deadline || '',
      daysLeft,
      percentage: pct,
      forecast,
      icon
    };
  });
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Handle adding savings to a goal (opens modal with context)
 */
function handleAddSavings(goal: GoalDisplayData): void {
  modal.setAddSavingsGoalId(goal.id);
  const nameEl = DOM.get('add-savings-goal-name');
  const amountEl = DOM.get<HTMLInputElement>('add-savings-amount');
  const dateEl = DOM.get<HTMLInputElement>('add-savings-date');
  const currentEl = DOM.get('add-savings-current');
  const remainingEl = DOM.get('add-savings-remaining');

  if (nameEl) nameEl.textContent = goal.name;

  // Populate context card
  if (currentEl) currentEl.textContent = fmtCur(goal.savedAmount);
  const remaining = Math.max(0, goal.targetAmount - goal.savedAmount);
  if (remainingEl) remainingEl.textContent = fmtCur(remaining);

  // Smart placeholder: derive a "monthly pace" suggestion from the recent
  // savings velocity (dailyRate × 30), capped at the remaining amount so we
  // never suggest overshooting the goal. Falls back to $100 when there is
  // no usable history yet.
  const monthlyPace = goal.forecast && !goal.forecast.completed
    ? goal.forecast.dailyRate * 30
    : 0;
  const suggested = Math.min(monthlyPace, remaining);
  const suggestedAmount = suggested > 0 ? suggested.toFixed(2) : '100.00';

  if (amountEl) {
    amountEl.value = '';
    amountEl.placeholder = suggestedAmount;
    // Design-Review-Apr21 P2: mirror the dateEl reset for the amount
    // field. The confirm-add-savings handler paints `--color-expense`
    // and un-hides `add-savings-amount-error` when validation fails;
    // without a reset on reopen, a failed confirm (e.g., "amount
    // required") would leave the error styling in place across a
    // dismiss → reopen cycle even though the value itself was cleared
    // two lines up. Keeping the visual state in sync with the empty
    // value is the whole point.
    amountEl.style.borderColor = 'var(--border-input)';
    const amountErr = DOM.get('add-savings-amount-error');
    if (amountErr) {
      amountErr.classList.add('hidden');
      // Design-Review-Apr21 P2 follow-up: the confirm handler rewrites
      // `textContent` to a custom `Amount cannot exceed …` message on
      // max-limit overflow but never restores the default "Please
      // enter a valid amount" copy afterwards. If the user then
      // submits an empty/zero amount on a later attempt, the empty-
      // amount failure branch falls through to `classList.remove
      // ('hidden')` with the STALE max-limit text still in place —
      // user sees "Amount cannot exceed $999k" for a blank input.
      // Restoring the default copy on reopen anchors the error node
      // back to its required-amount guidance so subsequent failures
      // display the right message by default. Matches the HTML seed
      // text in simple-modals.ts (`<div id="add-savings-amount-error"
      // …>Please enter a valid amount</div>`).
      amountErr.textContent = 'Please enter a valid amount';
    }
  }

  // Default date to today, cap at today (no future-dated contributions).
  // Use local-time getTodayStr, not UTC toISOString. See ADR-001 §9.5 Step 8.
  const today = getTodayStr();
  if (dateEl) {
    dateEl.value = today;
    dateEl.max = today;
    // Reset any prior error state
    dateEl.style.borderColor = 'var(--border-input)';
    const dateErr = DOM.get('add-savings-date-error');
    if (dateErr) dateErr.classList.add('hidden');
  }

  emit(Events.OPEN_MODAL, { id: 'add-savings-modal' });
  if (amountEl) amountEl.focus();
}

/**
 * Handle deleting a goal with two-tap confirmation
 */
const pendingDeletes = new Map<string, number>();
const CONFIRM_TIMEOUT = 3000;

function handleDeleteGoal(goalId: string, goalName: string, btn: HTMLElement): void {
  if (pendingDeletes.has(goalId)) {
    // Second tap — confirmed, delete
    clearTimeout(pendingDeletes.get(goalId));
    pendingDeletes.delete(goalId);
    savingsGoalsActions.deleteGoal(goalId);
    emit(Events.SHOW_TOAST, { message: 'Savings goal deleted', type: 'success' });
    return;
  }

  // First tap — enter confirm state
  btn.classList.add('savings-goal-action-btn--confirming');
  btn.textContent = 'Delete?';
  // Design-Review-Apr21 P3: thread the goal name through both the
  // confirming and reset aria-labels. Initial render emits
  // `aria-label="Delete ${goal.name}"`, but the confirming state used
  // to overwrite it with the generic "Tap again to confirm delete"
  // and the timeout reset used a bare "Delete goal" — both dropped
  // the only cue an AT user had about *which* goal was about to be
  // removed at the very moment the action is most destructive
  // (identical fix as the debt-list two-tap confirm, same rationale).
  btn.setAttribute('aria-label', `Tap again to confirm deleting ${goalName}`);

  const timerId = window.setTimeout(() => {
    // Reset if not confirmed in time
    pendingDeletes.delete(goalId);
    btn.classList.remove('savings-goal-action-btn--confirming');
    btn.textContent = '✕';
    btn.setAttribute('aria-label', `Delete ${goalName}`);
  }, CONFIRM_TIMEOUT);

  pendingDeletes.set(goalId, timerId);
}

/**
 * Render forecast badge
 */
function renderForecast(forecast: GoalForecast | null) {
  if (!forecast) return nothing;

  if (forecast.completed) {
    return html`<span class="goal-badge--complete text-xs px-2 py-0.5 rounded-full">Goal reached!</span>`;
  }

  // Use the app's configured locale so the forecast badge stays consistent
  // with the rest of the app (was hardcoded 'en-US'). Preserves the
  // short-month + day + year presentation so "Jan 15, 2026"-style output
  // continues to render compactly for locales where it's appropriate.
  const forecastDateStr = forecast.projectedDate.toLocaleDateString(
    localeService.getLocale(),
    { month: 'short', day: 'numeric', year: 'numeric' }
  );

  const forecastClass = forecast.onTrack === null
    ? 'goal-forecast--unknown'
    : (forecast.onTrack ? 'goal-forecast--on-track' : 'goal-forecast--at-risk');

  const statusIcon = forecast.onTrack === null ? '—' : (forecast.onTrack ? '✓' : '⚠');

  return html`<span class="text-xs ${forecastClass}">${statusIcon} Est. ${forecastDateStr}</span>`;
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive savings goals component
 * Returns cleanup function to dispose effects
 */
export function mountSavingsGoals(): () => void {
  const container = DOM.get('savings-goals-list');
  const section = DOM.get('savings-goals-section');

  if (!container) {
    return () => {};
  }

  const headerActions = section?.querySelector('.app-panel__actions') as HTMLElement | null;

  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const goals = goalsDisplayData.value;

    if (goals.length === 0) {
      if (headerActions) headerActions.classList.add('hidden');
      render(html`
        <div class="app-panel-empty">
          <div class="app-panel-empty__icon">💚</div>
          <p class="app-panel-empty__title">No savings goals yet</p>
          <p class="app-panel-empty__copy">Start saving toward something special — set a target and track your progress here.</p>
          <button type="button"
                  class="empty-state-cta empty-state-cta--income mt-3 px-4 py-2 rounded-lg text-sm font-bold"
                  data-action="add-goal">
            + Add Goal
          </button>
        </div>
      `, container);
      return;
    }

    // Show header button when goals exist
    if (headerActions) headerActions.classList.remove('hidden');

    render(html`
      ${repeat(goals, goal => goal.id, goal => html`
        <div class="savings-goal-row">
          <div class="savings-goal-row__head savings-goal-row__head--clickable"
               role="button" tabindex="0"
               aria-label=${`View contributions for ${goal.name}`}
               @click=${() => { selectedSavingsGoal.value = { id: goal.id, name: goal.name, emoji: goal.icon }; }}
               @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedSavingsGoal.value = { id: goal.id, name: goal.name, emoji: goal.icon }; } }}>
            <div class="savings-goal-row__title">
              <span class="text-lg">${goal.icon}</span>
              <span>${goal.name}</span>
            </div>
            <div class="savings-goal-row__summary">
              <span class="savings-goal-row__status">${goal.percentage.toFixed(0)}% funded</span>
              <span class="savings-goal-row__amount">
                Saved ${fmtCur(goal.savedAmount)} of ${fmtCur(goal.targetAmount)}
              </span>
            </div>
          </div>
          <div class="goal-bar" role="progressbar" aria-valuenow=${Math.round(goal.percentage)} aria-valuemin="0" aria-valuemax="100" aria-label="${goal.name} savings progress">
            <div class="goal-fill" style="width:${goal.percentage}%;"></div>
          </div>
          <div class="savings-goal-row__foot">
            <div class="savings-goal-row__meta">
              <!-- CR-Apr22-G slice 3: branch on daysLeft sign so overdue
                   goals surface a real countdown instead of collapsing to
                   "0 days left". Uses Math.abs() for the overdue copy so
                   the number always reads naturally ("5 days overdue"
                   rather than "-5"). daysLeft === 0 gets a dedicated
                   "Due today" string — it's the single moment when the
                   goal is still on time but the counter has run out. -->
              <span>
                ${goal.daysLeft === null
                  ? 'No deadline'
                  : goal.daysLeft > 0
                    ? `${goal.daysLeft} days left`
                    : goal.daysLeft === 0
                      ? 'Due today'
                      : `${Math.abs(goal.daysLeft)} days overdue`}
              </span>
              ${renderForecast(goal.forecast)}
            </div>
            <div class="savings-goal-row__actions">
              <button
                class="savings-goal-action-btn savings-goal-action-btn--add"
                @click=${() => handleAddSavings(goal)}
                aria-label=${`Add funds to ${goal.name}`}
                title="Add savings"
              >
                <span aria-hidden="true">+</span>
                <span class="label">Add Funds</span>
              </button>
              <button
                class="savings-goal-action-btn savings-goal-action-btn--delete"
                @click=${(e: Event) => handleDeleteGoal(goal.id, goal.name, e.currentTarget as HTMLElement)}
                aria-label=${`Delete ${goal.name}`}
                title="Delete goal"
              >🗑️</button>
            </div>
          </div>
        </div>
      `)}
    `, container);
  });

  // CR-Apr24-C2b [P2] finding 105 + CR-Apr24-C2c [P2] finding 104:
  // Refresh the open Add-Savings modal's context labels on BOTH currency
  // and savings-goal data changes. Pre-fix the labels were populated
  // imperatively in `handleAddSavings` at open and never re-rendered.
  //
  // Finding 105 (C2b): currency change with modal open left stale "$".
  // Finding 104 (C2c): renaming a goal or changing its saved progress
  // elsewhere left the modal name/current/remaining stale.
  //
  // Both `signals.currency` and `signals.savingsGoals` are read eagerly
  // (before the active-guard) so Preact's dependency tracker subscribes
  // to them on every execution — not just on runs where the modal
  // happened to be open. The active-guard merely skips the DOM writes
  // when the modal is hidden.
  const addSavingsDataEffect = effect(() => {
    void signals.currency.value;
    const goals = signals.savingsGoals.value;
    const modalEl = document.getElementById('add-savings-modal');
    if (!modalEl?.classList.contains('active')) return;
    const goalId = signals.addSavingsGoalId.value;
    if (!goalId) return;
    const goal = goals[goalId];
    if (!goal) return;
    // Refresh name (stale on rename — finding 104)
    const nameEl = DOM.get('add-savings-goal-name');
    if (nameEl) nameEl.textContent = goal.name;
    // Refresh current/remaining
    const currentEl = DOM.get('add-savings-current');
    const remainingEl = DOM.get('add-savings-remaining');
    if (currentEl) currentEl.textContent = fmtCur(goal.saved ?? 0);
    const remaining = Math.max(0, (goal.target ?? 0) - (goal.saved ?? 0));
    if (remainingEl) remainingEl.textContent = fmtCur(remaining);
  });

  return () => {
    cleanup();
    addSavingsDataEffect();
  };
}
