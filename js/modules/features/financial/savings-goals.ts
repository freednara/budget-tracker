/**
 * Savings Goals Module
 *
 * Handles savings goal rendering and forecast calculations.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { batchUpdates, modal, savingsGoals } from '../../core/state-actions.js';
import { toCents, toDollars, parseLocalDate } from '../../core/utils-pure.js';
import { emit, Events } from '../../core/event-bus.js';
import type {
  SavingsGoal,
  SavingsContribution,
  GoalForecast
} from '../../../types/index.js';
import { SavingsGoalsEvents } from './savings-goals-interface.js';

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
 * Return the wall-clock timestamp (ms) when a contribution was recorded.
 * Prefers `createdAt` (written for all new contributions), falls back to
 * `date` at midday UTC for legacy records that predate the field.
 *
 * This indirection is the core of why backdating no longer distorts the
 * forecast: `createdAt` reflects when the user clicked Add Funds, not the
 * ledger date they chose — so adding a backdated contribution always
 * extends the velocity window forward, never backward.
 */
function contributionRecordedAtMs(c: SavingsContribution): number {
  if (c.createdAt) {
    const t = new Date(c.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  // Legacy fallback — midday UTC avoids DST edge cases
  return new Date(`${c.date}T12:00:00Z`).getTime();
}

const FORECAST_WINDOW_DAYS = 60;
const MS_PER_DAY = 86400000;

/**
 * Calculate forecast for a savings goal based on contribution history.
 *
 * Velocity is derived from a trailing 60-day window of contribution
 * `createdAt` timestamps. If fewer than 2 contributions fall in that
 * window (dormant goal, or all recent ones were rapidly added), we
 * fall back to the full contribution history so the card still shows
 * a finish estimate instead of disappearing.
 *
 * Fixes H7: previously accepted a `GoalWithId | LegacySavingsGoal &
 * { id: string }` union and branched on `'target_amount' in goal` at
 * runtime. After H7 every caller feeds normalized `SavingsGoal` data
 * (see `normalizeSavingsGoalsRecord` in state.ts), so the signature
 * collapses to the canonical modern shape.
 */
export function calculateGoalForecast(goal: GoalWithId): GoalForecast | null {
  const allContribs = signals.savingsContribs.value.filter(c => c.goalId === goal.id);
  if (allContribs.length < 2) return null;

  // Prefer the last 60 days of activity; fall back to full history if the window is sparse.
  const cutoffMs = Date.now() - FORECAST_WINDOW_DAYS * MS_PER_DAY;
  let windowContribs = allContribs.filter(c => contributionRecordedAtMs(c) >= cutoffMs);
  if (windowContribs.length < 2) windowContribs = allContribs;

  const sorted = [...windowContribs].sort(
    (a, b) => contributionRecordedAtMs(a) - contributionRecordedAtMs(b)
  );
  // Phase 6 Slice 1i (rev 12 L6): `sorted[i]` is
  // `SavingsContribution | undefined` under `noUncheckedIndexedAccess`;
  // `windowContribs.length < 2` guard above guarantees presence, but a
  // local narrow keeps the helper arguments type-safe.
  const firstContrib = sorted[0];
  const lastContrib = sorted[sorted.length - 1];
  if (!firstContrib || !lastContrib) return null;
  const firstMs = contributionRecordedAtMs(firstContrib);
  const lastMs = contributionRecordedAtMs(lastContrib);
  const daysDiff = Math.max(1, (lastMs - firstMs) / MS_PER_DAY);
  const totalContributed = toDollars(
    sorted.reduce((sumCents, c) => sumCents + toCents(c.amount || 0), 0)
  );
  const dailyRate = totalContributed / daysDiff;

  if (dailyRate <= 0) return null;

  const remaining = toDollars(toCents(goal.target || 0) - toCents(goal.saved || 0));
  if (remaining <= 0) return { completed: true };

  const daysToComplete = Math.ceil(remaining / dailyRate);
  const projectedDate = new Date();
  projectedDate.setDate(projectedDate.getDate() + daysToComplete);

  return {
    completed: false,
    projectedDate,
    daysToComplete,
    dailyRate,
    // CR-Apr22-E slice 4 (finding 61b [P2]): route `goal.deadline` through
    // `parseLocalDate` (H16 contract — local-midnight parser) rather than
    // `new Date(deadline)`. `new Date('2026-04-21')` parses YYYY-MM-DD as
    // UTC midnight, which in any western timezone resolves to the
    // PREVIOUS local day's afternoon — e.g. 2026-04-21 in PST reads as
    // 2026-04-20T16:00 local. A perfectly on-track projection that lands
    // on the deadline day at local noon would then compare greater than
    // the stale-by-a-day reference and get flagged `onTrack: false`.
    // `parseLocalDate` parses as local midnight, aligning the comparison
    // with the projectedDate's local-time semantics.
    onTrack: goal.deadline ? projectedDate <= parseLocalDate(goal.deadline) : null
  };
}

// ==========================================
// GOAL MANAGEMENT ACTIONS
// ==========================================

/**
 * Delete a savings goal and its associated contributions atomically
 */
export async function deleteGoal(goalId: string): Promise<void> {
  // Fixes H7: signal now holds canonical `Record<string, SavingsGoal>`
  // (see normalizeSavingsGoalsRecord at hydration). No cast needed.
  const goalsRecord = signals.savingsGoals.value;
  const deletedGoal = goalsRecord[goalId];

  if (!deletedGoal) return;

  // Round 7 fix: Save state before modifications to enable rollback if second persist fails
  const savedGoalsRecord = { ...goalsRecord };
  const savedContribs = [...signals.savingsContribs.value];

  // Perform atomic multi-signal update without firing SAVINGS_UPDATED until persistence completes
  batchUpdates(() => {
    // 1. Remove goal
    const { [goalId]: _, ...rest } = goalsRecord;
    savingsGoals.setGoals(rest, { emitEvent: false });

    // 2. Remove contributions
    const currentContribs = signals.savingsContribs.value;
    savingsGoals.setContributions(currentContribs.filter(c => c.goalId !== goalId));
  });

  // Persist updated state with atomic error handling
  try {
    persist(SK.SAVINGS, signals.savingsGoals.value);
    persist(SK.SAVINGS_CONTRIB, signals.savingsContribs.value);
  } catch (error) {
    // Round 7 fix: Rollback both signals if second persist fails
    batchUpdates(() => {
      savingsGoals.setGoals(savedGoalsRecord, { emitEvent: false });
      savingsGoals.setContributions(savedContribs);
    });
    throw error;
  }

  // Emit events for system coordination
  emit(SavingsGoalsEvents.GOAL_DELETED, {
    goalId,
    goal: deletedGoal
  });
  emit(Events.SAVINGS_UPDATED, signals.savingsGoals.value);

  emit(Events.SHOW_TOAST, { message: 'Savings goal deleted', type: 'success' });
}

/**
 * Initiate adding savings to a goal (business logic only)
 */
export function initiateAddSavings(goalId: string): void {
  // Fixes H7: signal now holds canonical `Record<string, SavingsGoal>`.
  const goal = signals.savingsGoals.value[goalId];
  
  if (!goal) return;
  
  // Set modal state for UI to handle
  modal.setAddSavingsGoalId(goalId);
  
  // Emit event for UI components to handle display logic
  emit('modal:open', { modalId: 'add-savings-modal', goalId, goalName: goal.name });
}
