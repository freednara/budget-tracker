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
import { html, render, nothing } from '../core/lit-helpers.js';
import DOM from '../core/dom-cache.js';
import type { SavingsContribution } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface LegacySavingsGoal {
  name: string;
  target_amount: number;
  saved_amount: number;
  deadline?: string;
}

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

interface GoalForecastComplete {
  completed: true;
}

interface GoalForecastInProgress {
  completed: false;
  projectedDate: Date;
  daysToComplete: number;
  dailyRate: number;
  onTrack: boolean | null;
}

type GoalForecast = GoalForecastComplete | GoalForecastInProgress;

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
    const saved = g.saved_amount || 0;
    const pct = g.target_amount > 0 ? Math.min((saved / g.target_amount) * 100, 100) : 0;
    const daysLeft = g.deadline
      ? Math.max(0, Math.round((new Date(g.deadline).getTime() - today.getTime()) / 86400000))
      : null;
    const forecast = calculateGoalForecast({ ...g, id: gid });

    return {
      id: gid,
      name: g.name,
      targetAmount: g.target_amount,
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

  const statusIcon = forecast.onTrack === null ? '' : (forecast.onTrack ? '' : '');

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
        <div class="empty-state text-center py-6" style="color: var(--text-secondary);">
          <div class="text-4xl mb-2">💚</div>
          <p class="font-semibold mb-1">No savings goals yet</p>
          <p class="text-xs mb-3" style="color: var(--text-tertiary);">Start saving toward something special</p>
          <button id="add-goal" class="btn-primary text-sm px-4 py-2">+ Create Goal</button>
        </div>
      `, container);
      return;
    }

    render(html`
      ${goals.map(goal => html`
        <div class="flex items-center gap-3 p-3 rounded-lg" style="background: var(--bg-input);">
          <span class="text-xl">💚</span>
          <div class="flex-1">
            <div class="flex justify-between mb-1">
              <div>
                <p class="text-sm font-bold" style="color: var(--text-primary);">${goal.name}</p>
                <p class="text-xs" style="color: var(--text-tertiary);">
                  ${goal.daysLeft !== null ? `${goal.daysLeft} days left` : 'No deadline'}
                </p>
                ${renderForecast(goal.forecast)}
              </div>
              <span class="text-sm font-bold" style="color: var(--color-income);">
                ${fmtCur(goal.savedAmount)} / ${fmtCur(goal.targetAmount)}
              </span>
            </div>
            <div class="goal-bar">
              <div class="goal-fill" style="width:${goal.percentage}%;"></div>
            </div>
          </div>
          <button class="add-savings-btn p-1 rounded hover:opacity-70 text-lg font-black"
                  @click=${() => handleAddSavings(goal.id, goal.name)}
                  style="color: var(--color-income);">+</button>
          <button class="delete-savings-goal-btn p-1 rounded hover:opacity-70"
                  @click=${() => handleDeleteGoal(goal.id)}
                  style="color: var(--color-expense);">✕</button>
        </div>
      `)}
    `, container);
  });

  return cleanup;
}
