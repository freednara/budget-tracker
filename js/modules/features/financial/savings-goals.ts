/**
 * Savings Goals Module
 *
 * Handles savings goal rendering and forecast calculations.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { batch } from '@preact/signals-core';
import { modal, data } from '../../core/state-actions.js';
import { parseLocalDate, addAmounts, toCents, toDollars } from '../../core/utils.js';
import { showToast } from '../../ui/core/ui.js';
import { emit, Events } from '../../core/event-bus.js';
import { getDefaultContainer, Services } from '../../core/di-container.js';
import type { 
  SavingsGoal, 
  SavingsContribution, 
  LegacySavingsGoal,
  GoalForecast,
  GoalForecastComplete,
  GoalForecastInProgress 
} from '../../../types/index.js';
import { 
  SavingsGoalsEvents, 
  type GoalAddedEvent, 
  type GoalUpdatedEvent,
  type ContributionAddedEvent 
} from './savings-goals-interface.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface GoalWithId extends SavingsGoal {
  id: string;
}

// ==========================================
// BUSINESS LOGIC SERVICE LAYER
// ==========================================

// This module now follows the debt-planner.ts pattern:
// Pure business logic with no UI rendering concerns

// ==========================================
// FORECAST CALCULATIONS
// ==========================================

/**
 * Calculate forecast for a savings goal based on contribution history
 */
export function calculateGoalForecast(goal: GoalWithId | LegacySavingsGoal & { id: string }): GoalForecast | null {
  // Get contributions for this goal from history
  const contribs = signals.savingsContribs.value.filter(c => c.goalId === goal.id);
  if (contribs.length < 2) return null;

  // Calculate daily savings rate based on contribution history
  const sortedContribs = contribs.sort((a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime());
  const firstDate = parseLocalDate(sortedContribs[0].date);
  const lastDate = parseLocalDate(sortedContribs[sortedContribs.length - 1].date);
  const daysDiff = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / 86400000);
  const totalContributed = toDollars(contribs.reduce((sumCents, c) => sumCents + toCents(c.amount || 0), 0));
  const dailyRate = totalContributed / daysDiff;

  if (dailyRate <= 0) return null;

  const targetAmount = 'target_amount' in goal ? goal.target_amount : (goal as SavingsGoal).target;
  const savedAmount = 'saved_amount' in goal ? goal.saved_amount : (goal as SavingsGoal).saved;
  const remaining = toDollars(toCents(targetAmount || 0) - toCents(savedAmount || 0));
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
// GOAL MANAGEMENT ACTIONS
// ==========================================

/**
 * Delete a savings goal and its associated contributions atomically
 */
export async function deleteGoal(goalId: string): Promise<void> {
  const goalsRecord = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const deletedGoal = goalsRecord[goalId];
  
  if (!deletedGoal) return;

  // Perform atomic multi-signal update
  batch(() => {
    // 1. Remove goal
    const { [goalId]: _, ...rest } = goalsRecord;
    signals.savingsGoals.value = rest as any;
    
    // 2. Remove contributions
    const currentContribs = signals.savingsContribs.value;
    signals.savingsContribs.value = currentContribs.filter(c => c.goalId !== goalId);
  });

  // Persist updated state
  persist(SK.SAVINGS, signals.savingsGoals.value);
  persist(SK.SAVINGS_CONTRIB, signals.savingsContribs.value);
  
  // Emit events for system coordination
  emit(SavingsGoalsEvents.GOAL_DELETED, {
    goalId,
    goal: deletedGoal
  });
  emit(Events.SAVINGS_UPDATED);
  
  showToast('Savings goal deleted');
}

/**
 * Initiate adding savings to a goal (business logic only)
 */
export function initiateAddSavings(goalId: string): void {
  const goalsRecord = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const goal = goalsRecord[goalId];
  
  if (!goal) return;
  
  // Set modal state for UI to handle
  modal.setAddSavingsGoalId(goalId);
  
  // Emit event for UI components to handle display logic
  emit('modal:open', { modalId: 'add-savings-modal', goalId, goalName: goal.name });
}

