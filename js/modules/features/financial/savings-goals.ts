/**
 * Savings Goals Module
 *
 * Handles savings goal rendering and forecast calculations.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { modal, data } from '../../core/state-actions.js';
import { parseLocalDate } from '../../core/utils.js';
import { openModal, showToast } from '../../ui/core/ui.js';
import { updateSummary } from '../../dashboard.js';
import DOM from '../../core/dom-cache.js';
import { html, render, nothing, type LitTemplate } from '../../core/lit-helpers.js';
import type { SavingsGoal, SavingsContribution } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;

interface EmptyStateAction {
  id: string;
  label: string;
}

type EmptyStateRenderer = (emoji: string, title: string, subtitle: string, action: EmptyStateAction | null) => LitTemplate;

interface GoalWithId extends SavingsGoal {
  id: string;
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

// Legacy goal structure (from state)
interface LegacySavingsGoal {
  name: string;
  target_amount: number;
  saved_amount: number;
  deadline?: string;
}

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v: number): string => '$' + v.toFixed(2);
let emptyStateFn: EmptyStateRenderer | null = null;

/**
 * Set the currency formatter function
 */
export function setSavingsGoalsFmtCur(fn: CurrencyFormatter): void {
  fmtCur = fn;
}

/**
 * Set the empty state renderer function
 */
export function setSavingsGoalsEmptyState(fn: EmptyStateRenderer): void {
  emptyStateFn = fn;
}

// ==========================================
// FORECAST CALCULATIONS
// ==========================================

/**
 * Calculate forecast for a savings goal based on contribution history
 */
export function calculateGoalForecast(goal: GoalWithId | { id: string; target_amount: number; saved_amount: number; deadline?: string }): GoalForecast | null {
  // Get contributions for this goal from history
  const contribs = signals.savingsContribs.value.filter(c => c.goalId === goal.id);
  if (contribs.length < 2) return null;

  // Calculate daily savings rate based on contribution history
  const sortedContribs = contribs.sort((a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime());
  const firstDate = parseLocalDate(sortedContribs[0].date);
  const lastDate = parseLocalDate(sortedContribs[sortedContribs.length - 1].date);
  const daysDiff = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / 86400000);
  const totalContributed = contribs.reduce((sum, c) => sum + (c.amount || 0), 0);
  const dailyRate = totalContributed / daysDiff;

  if (dailyRate <= 0) return null;

  const targetAmount = 'target_amount' in goal ? goal.target_amount : (goal as SavingsGoal).target;
  const savedAmount = 'saved_amount' in goal ? goal.saved_amount : (goal as SavingsGoal).saved;
  const remaining = (targetAmount || 0) - (savedAmount || 0);
  if (remaining <= 0) return { completed: true };

  const daysToComplete = Math.ceil(remaining / dailyRate);
  const projectedDate = new Date();
  projectedDate.setDate(projectedDate.getDate() + daysToComplete);

  return {
    completed: false,
    projectedDate,
    daysToComplete,
    dailyRate,
    onTrack: goal.deadline ? projectedDate <= new Date(goal.deadline) : null
  };
}

// ==========================================
// RENDERING
// ==========================================

/**
 * Render savings goals list with progress bars and forecasts
 */
export function renderSavingsGoals(): void {
  const el = DOM.get('savings-goals-list');
  if (!el) return;

  const goalsRecord = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const goals = Object.entries(goalsRecord);

  if (!goals.length) {
    if (emptyStateFn) {
      render(emptyStateFn('💚', 'No savings goals yet', 'Start saving toward something special', { id: 'add-goal', label: '+ Create Goal' }), el);
    } else {
      render(html`<p class="text-center py-4" style="color: var(--text-tertiary);">No savings goals yet</p>`, el);
    }
    return;
  }

  const handleAddSavings = (goalId: string) => {
    modal.setAddSavingsGoalId(goalId);
    const g = goalsRecord[goalId];
    if (!g) return;
    const nameEl = DOM.get('add-savings-goal-name');
    const amountEl = DOM.get('add-savings-amount') as HTMLInputElement | null;
    if (nameEl) nameEl.textContent = g.name;
    if (amountEl) {
      amountEl.value = '';
      openModal('add-savings-modal');
      amountEl.focus();
    }
  };

  const handleDeleteGoal = (goalId: string) => {
    delete goalsRecord[goalId];
    persist(SK.SAVINGS, signals.savingsGoals.value);
    data.removeContributionsForGoal(goalId);
    persist(SK.SAVINGS_CONTRIB, signals.savingsContribs.value);
    renderSavingsGoals();
    updateSummary();
    showToast('Savings goal deleted');
  };

  const renderForecast = (forecast: GoalForecast | null) => {
    if (!forecast) return nothing;
    if (forecast.completed) {
      return html`<span class="text-xs px-2 py-0.5 rounded-full" style="background: var(--color-income); color: white;">🎉 Goal reached!</span>`;
    }
    const forecastDateStr = forecast.projectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const statusColor = forecast.onTrack === null ? 'var(--text-tertiary)' : (forecast.onTrack ? 'var(--color-income)' : 'var(--color-warning)');
    const statusIcon = forecast.onTrack === null ? '📅' : (forecast.onTrack ? '✓' : '⚠️');
    return html`<span class="text-xs" style="color: ${statusColor};">${statusIcon} Est. ${forecastDateStr}</span>`;
  };

  render(html`
    ${goals.map(([gid, g]) => {
      const saved = g.saved_amount || 0;
      const pct = g.target_amount > 0 ? Math.min((saved / g.target_amount) * 100, 100) : 0;
      const _dlToday = new Date();
      _dlToday.setHours(0, 0, 0, 0);
      const daysLeft = g.deadline ? Math.max(0, Math.round((new Date(g.deadline).getTime() - _dlToday.getTime()) / 86400000)) : null;
      const forecast = calculateGoalForecast({ ...g, id: gid });

      return html`
        <div class="flex items-center gap-3 p-3 rounded-lg" style="background: var(--bg-input);">
          <span class="text-xl">💚</span>
          <div class="flex-1">
            <div class="flex justify-between mb-1">
              <div>
                <p class="text-sm font-bold" style="color: var(--text-primary);">${g.name}</p>
                <p class="text-xs" style="color: var(--text-tertiary);">${daysLeft !== null ? `${daysLeft} days left` : 'No deadline'}</p>
                ${renderForecast(forecast)}
              </div>
              <span class="text-sm font-bold" style="color: var(--color-income);">${fmtCur(saved)} / ${fmtCur(g.target_amount)}</span>
            </div>
            <div class="goal-bar"><div class="goal-fill" style="width:${pct}%;"></div></div>
          </div>
          <button class="add-savings-btn p-1 rounded hover:opacity-70 text-lg font-black"
                  @click=${() => handleAddSavings(gid)}
                  style="color: var(--color-income);">+</button>
          <button class="delete-savings-goal-btn p-1 rounded hover:opacity-70"
                  @click=${() => handleDeleteGoal(gid)}
                  style="color: var(--color-expense);">✕</button>
        </div>
      `;
    })}
  `, el);
}
