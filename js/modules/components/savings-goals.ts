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
import { openModal, showToast } from '../ui/core/ui.js';
import { fmtCur, parseLocalDate } from '../core/utils.js';
import { html, render, nothing, repeat } from '../core/lit-helpers.js';
import DOM from '../core/dom-cache.js';
import type { SavingsContribution, LegacySavingsGoal, GoalForecast, GoalForecastComplete, GoalForecastInProgress } from '../../types/index.js';

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
}

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Goals with computed display data
 * Recomputes when savingsGoals or savingsContribs change
 */
const goalsDisplayData = computed((): GoalDisplayData[] => {
  const goalsRecord = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const goals = Object.entries(goalsRecord);

  // Force recomputation when contributions change (for forecasts)
  const _contribCount = signals.savingsContribs.value.length;

  if (!goals.length) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return goals.map(([gid, g]) => {
    // Handle both SavingsGoal (target/saved) and LegacySavingsGoal (target_amount/saved_amount)
    const saved = g.saved_amount ?? (g as any).saved ?? 0;
    const target = g.target_amount ?? (g as any).target ?? 0;
    const pct = target > 0 ? Math.min((saved / target) * 100, 100) : 0;
    const daysLeft = g.deadline
      ? Math.max(0, Math.round((parseLocalDate(g.deadline).getTime() - today.getTime()) / 86400000))
      : null;
    const forecast = calculateGoalForecast({ ...g, id: gid });

    return {
      id: gid,
      name: g.name,
      targetAmount: target,
      savedAmount: saved,
      deadline: g.deadline || '',
      daysLeft,
      percentage: pct,
      forecast
    };
  });
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Handle adding savings to a goal (opens modal)
 */
function handleAddSavings(goalId: string, goalName: string): void {
  modal.setAddSavingsGoalId(goalId);
  const nameEl = DOM.get('add-savings-goal-name');
  const amountEl = DOM.get('add-savings-amount') as HTMLInputElement | null;
  if (nameEl) nameEl.textContent = goalName;
  if (amountEl) {
    amountEl.value = '';
    openModal('add-savings-modal');
    amountEl.focus();
  }
}

/**
 * Handle deleting a goal
 */
function handleDeleteGoal(goalId: string): void {
  savingsGoalsActions.deleteGoal(goalId);
  showToast('Savings goal deleted');
}

/**
 * Render forecast badge
 */
function renderForecast(forecast: GoalForecast | null) {
  if (!forecast) return nothing;

  if (forecast.completed) {
    return html`<span class="text-xs px-2 py-0.5 rounded-full" style="background: var(--color-income); color: white;">Goal reached!</span>`;
  }

  const forecastDateStr = forecast.projectedDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const statusColor = forecast.onTrack === null
    ? 'var(--text-tertiary)'
    : (forecast.onTrack ? 'var(--color-income)' : 'var(--color-warning)');

  const statusIcon = forecast.onTrack === null ? '—' : (forecast.onTrack ? '✓' : '⚠');

  return html`<span class="text-xs" style="color: ${statusColor};">${statusIcon} Est. ${forecastDateStr}</span>`;
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

  if (!container) {
    return () => {};
  }

  const cleanup = effect(() => {
    const goals = goalsDisplayData.value;

    if (goals.length === 0) {
      render(html`
        <div class="app-panel-empty">
          <div class="app-panel-empty__icon">💚</div>
          <p class="app-panel-empty__title">No savings goals yet</p>
          <p class="app-panel-empty__copy">Start saving toward something special and track progress here once your first goal is created.</p>
        </div>
      `, container);
      return;
    }

    render(html`
      ${repeat(goals, goal => goal.id, goal => html`
        <div class="savings-goal-row">
          <div class="savings-goal-row__head">
            <div class="savings-goal-row__title">
              <span class="text-lg">💚</span>
              <span>${goal.name}</span>
            </div>
            <div class="savings-goal-row__summary">
              <span class="savings-goal-row__status">${goal.percentage.toFixed(0)}% funded</span>
              <span class="savings-goal-row__amount">
                Saved ${fmtCur(goal.savedAmount)} of ${fmtCur(goal.targetAmount)}
              </span>
            </div>
          </div>
          <div class="goal-bar">
            <div class="goal-fill" style="width:${goal.percentage}%;"></div>
          </div>
          <div class="savings-goal-row__foot">
            <div class="savings-goal-row__meta">
              <span>
                ${goal.daysLeft !== null ? `${goal.daysLeft} days left` : 'No deadline'}
              </span>
              ${renderForecast(goal.forecast)}
            </div>
            <div class="savings-goal-row__actions">
              <button
                class="savings-goal-action-btn savings-goal-action-btn--add"
                @click=${() => handleAddSavings(goal.id, goal.name)}
                aria-label=${`Add savings to ${goal.name}`}
                title="Add savings"
              >
                <span aria-hidden="true">+</span>
                <span class="label">Add Funds</span>
              </button>
              <button
                class="savings-goal-action-btn savings-goal-action-btn--delete"
                @click=${() => handleDeleteGoal(goal.id)}
                aria-label=${`Delete ${goal.name}`}
                title="Delete goal"
              >✕</button>
            </div>
          </div>
        </div>
      `)}
    `, container);
  });

  return cleanup;
}
