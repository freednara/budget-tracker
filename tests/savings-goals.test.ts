/**
 * Tests for savings-goals.ts calculateGoalForecast
 *
 * calculateGoalForecast reads signals.savingsContribs.value directly,
 * so we mock the signals module to inject test data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SavingsContribution, GoalForecastInProgress } from '../js/types/index.js';

// ==========================================
// Mock signals — vi.hoisted so factory can reference them
// ==========================================

const { mockSavingsContribs } = vi.hoisted(() => ({
  mockSavingsContribs: { value: [] as SavingsContribution[] },
}));

vi.mock('../js/modules/core/signals.js', () => ({
  savingsContribs: mockSavingsContribs,
  savingsGoals: { value: {} },
  transactions: { value: [] },
  streak: { value: { current: 0, longest: 0, lastDate: '' } },
}));

// Stub event-bus (imported transitively)
vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  on: vi.fn(),
  Events: {},
}));

// Stub DI container (imported transitively)
vi.mock('../js/modules/core/di-container.js', () => ({
  getDefaultContainer: vi.fn(() => ({ get: vi.fn() })),
  Services: {},
}));

// Stub state persistence
vi.mock('../js/modules/core/state.js', () => ({
  SK: {},
  persist: vi.fn(),
  lsGet: vi.fn(),
  getStored: vi.fn(),
}));

// Stub UI toast
vi.mock('../js/modules/ui/core/ui.js', () => ({
  showToast: vi.fn(),
}));

// Stub state-actions
vi.mock('../js/modules/core/state-actions.js', () => ({
  modal: { setAddSavingsGoalId: vi.fn() },
  data: {},
}));

// Stub savings-goals-interface
vi.mock('../js/modules/features/financial/savings-goals-interface.js', () => ({
  SavingsGoalsEvents: {
    GOAL_ADDED: 'savings:goal-added',
    GOAL_UPDATED: 'savings:goal-updated',
    GOAL_DELETED: 'savings:goal-deleted',
    CONTRIBUTION_ADDED: 'savings:contribution-added',
  },
}));

import { calculateGoalForecast } from '../js/modules/features/financial/savings-goals.js';

// ==========================================
// Helpers
// ==========================================

interface GoalInput {
  id: string;
  name: string;
  target: number;
  saved: number;
  deadline?: string;
}

function makeGoal(overrides: Partial<GoalInput> = {}): GoalInput {
  return {
    id: 'goal-1',
    name: 'Test Goal',
    target: 1000,
    saved: 0,
    ...overrides,
  };
}

function makeContrib(goalId: string, amount: number, date: string): SavingsContribution {
  return {
    id: `c-${Math.random().toString(36).slice(2)}`,
    goalId,
    amount,
    date,
  };
}

// ==========================================
// TESTS
// ==========================================

describe('calculateGoalForecast', () => {
  beforeEach(() => {
    mockSavingsContribs.value = [];
  });

  it('returns null when goal has fewer than 2 contributions (no daily rate)', () => {
    // Zero contributions
    const goal = makeGoal();
    expect(calculateGoalForecast(goal)).toBeNull();

    // One contribution — still not enough to calculate rate
    mockSavingsContribs.value = [makeContrib('goal-1', 100, '2025-01-01')];
    expect(calculateGoalForecast(goal)).toBeNull();
  });

  it('returns null when daily rate is zero (contributions sum to zero)', () => {
    // Two contributions that net zero total
    mockSavingsContribs.value = [
      makeContrib('goal-1', 0, '2025-01-01'),
      makeContrib('goal-1', 0, '2025-01-10'),
    ];
    const goal = makeGoal();
    expect(calculateGoalForecast(goal)).toBeNull();
  });

  it('computes projected date for goal with regular contributions (positive daily rate)', () => {
    // $100 over 10 days = $10/day rate
    mockSavingsContribs.value = [
      makeContrib('goal-1', 50, '2025-01-01'),
      makeContrib('goal-1', 50, '2025-01-11'),
    ];
    const goal = makeGoal({ target: 1000, saved: 100 });
    // remaining = 1000 - 100 = 900, dailyRate = 100/10 = 10, daysToComplete = 90
    const result = calculateGoalForecast(goal);

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(false);

    const forecast = result as GoalForecastInProgress;
    expect(forecast.dailyRate).toBeCloseTo(10, 2);
    expect(forecast.daysToComplete).toBe(90);
    expect(forecast.projectedDate).toBeInstanceOf(Date);
  });

  it('returns completed forecast when saved >= target', () => {
    mockSavingsContribs.value = [
      makeContrib('goal-1', 500, '2025-01-01'),
      makeContrib('goal-1', 600, '2025-01-15'),
    ];
    const goal = makeGoal({ target: 1000, saved: 1000 });
    const result = calculateGoalForecast(goal);

    expect(result).toEqual({ completed: true });
  });

  it('returns completed when saved exceeds target', () => {
    mockSavingsContribs.value = [
      makeContrib('goal-1', 500, '2025-01-01'),
      makeContrib('goal-1', 600, '2025-01-15'),
    ];
    const goal = makeGoal({ target: 1000, saved: 1500 });
    const result = calculateGoalForecast(goal);

    expect(result).toEqual({ completed: true });
  });

  it('sets onTrack=false when projected date is past deadline', () => {
    // $10/day rate, $900 remaining => 90 days from today
    mockSavingsContribs.value = [
      makeContrib('goal-1', 50, '2025-01-01'),
      makeContrib('goal-1', 50, '2025-01-11'),
    ];
    // Deadline 30 days from now — far sooner than 90-day projection
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const deadlineStr = soon.toISOString().slice(0, 10);

    const goal = makeGoal({ target: 1000, saved: 100, deadline: deadlineStr });
    const result = calculateGoalForecast(goal);

    expect(result).not.toBeNull();
    const forecast = result as GoalForecastInProgress;
    expect(forecast.completed).toBe(false);
    expect(forecast.onTrack).toBe(false);
  });

  it('sets onTrack=true when projected date is before deadline', () => {
    // $10/day rate, $900 remaining => 90 days from today
    mockSavingsContribs.value = [
      makeContrib('goal-1', 50, '2025-01-01'),
      makeContrib('goal-1', 50, '2025-01-11'),
    ];
    // Deadline 200 days out — plenty of time
    const far = new Date();
    far.setDate(far.getDate() + 200);
    const deadlineStr = far.toISOString().slice(0, 10);

    const goal = makeGoal({ target: 1000, saved: 100, deadline: deadlineStr });
    const result = calculateGoalForecast(goal);

    const forecast = result as GoalForecastInProgress;
    expect(forecast.onTrack).toBe(true);
  });

  it('sets onTrack=null for open-ended goal (no deadline)', () => {
    mockSavingsContribs.value = [
      makeContrib('goal-1', 50, '2025-01-01'),
      makeContrib('goal-1', 50, '2025-01-11'),
    ];
    const goal = makeGoal({ target: 1000, saved: 100 });
    // No deadline set
    const result = calculateGoalForecast(goal);

    const forecast = result as GoalForecastInProgress;
    expect(forecast.onTrack).toBeNull();
  });

  it('only considers contributions matching the goal id', () => {
    mockSavingsContribs.value = [
      makeContrib('goal-1', 50, '2025-01-01'),
      makeContrib('goal-1', 50, '2025-01-11'),
      makeContrib('other-goal', 500, '2025-01-05'),
      makeContrib('other-goal', 500, '2025-01-10'),
    ];
    const goal = makeGoal({ id: 'goal-1', target: 1000, saved: 100 });
    const result = calculateGoalForecast(goal);

    const forecast = result as GoalForecastInProgress;
    // Should use only goal-1 contributions: $100 over 10 days = $10/day
    expect(forecast.dailyRate).toBeCloseTo(10, 2);
  });

  it('handles LegacySavingsGoal shape (target_amount / saved_amount)', () => {
    mockSavingsContribs.value = [
      makeContrib('legacy-1', 200, '2025-02-01'),
      makeContrib('legacy-1', 200, '2025-02-11'),
    ];
    // Legacy shape uses target_amount / saved_amount
    const legacyGoal = {
      id: 'legacy-1',
      name: 'Legacy Goal',
      target_amount: 2000,
      saved_amount: 400,
      deadline: undefined,
    };

    const result = calculateGoalForecast(legacyGoal as any);

    expect(result).not.toBeNull();
    const forecast = result as GoalForecastInProgress;
    // $400 over 10 days = $40/day, remaining = 2000-400 = 1600, daysToComplete = 40
    expect(forecast.dailyRate).toBeCloseTo(40, 2);
    expect(forecast.daysToComplete).toBe(40);
  });
});
