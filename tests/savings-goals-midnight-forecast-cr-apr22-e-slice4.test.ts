import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { mountSavingsGoals } from '../js/modules/components/savings-goals.js';
import { calculateGoalForecast } from '../js/modules/features/financial/savings-goals.js';
import { parseLocalDate } from '../js/modules/core/utils-pure.js';
import type { SavingsGoal, SavingsContribution } from '../js/types/index.js';

/**
 * CR-Apr22-E slice 4 coverage — Savings goals midnight refresh +
 * deadline parsing (findings 61a [P2] and 61b [P2]).
 *
 * Two bugs locked down here:
 *
 *   (61a) `components/savings-goals.ts` — the `goalsDisplayData` computed
 *         derived `daysLeft` and `forecast` from `new Date()` / `Date.now()`
 *         but did NOT subscribe to `signals.todayStr`. A user who left the
 *         app open across local midnight would see yesterday's countdown
 *         frozen until some unrelated signal (tx add, currency flip) happened
 *         to wake the computed. The fix adds `const _today = signals.todayStr.value;`
 *         inside the computed so it re-runs whenever the midnight timer flips
 *         the wall-clock date string.
 *
 *   (61b) `features/financial/savings-goals.ts` — the `onTrack` comparison
 *         used `new Date(goal.deadline)`, which parses YYYY-MM-DD as UTC
 *         midnight. In any timezone west of UTC+12, UTC-midnight resolves
 *         to the previous local day, making an on-track projection that
 *         lands exactly on the deadline read as "not on track" by a full
 *         calendar day. The fix routes `goal.deadline` through
 *         `parseLocalDate` (H16 contract — local-noon parser).
 *
 * The midnight test (61a) follows the same pattern CR-Apr22-D slice 3
 * used for `dailyAllowanceData` — anchor the system clock, mutate
 * `todayStr.value`, observe that the `daysLeft` value in the rendered
 * DOM updates accordingly.
 *
 * The deadline test (61b) locks the parseLocalDate contract by
 * comparing `calculateGoalForecast` output against the exact comparison
 * it would produce with the canonical local-date parser. We rely on
 * `projectedDate <= parseLocalDate(deadline)` as the ground truth —
 * that is what the production code must compute after the fix.
 */

// ==========================================
// (61a) — goalsDisplayData midnight refresh via mounted component
// ==========================================

function anchorAtApril15Noon(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 15, 12, 0, 0, 0));
}

function seedDom(): void {
  document.body.innerHTML = `
    <section id="savings-goals-section">
      <div class="app-panel__actions"></div>
      <div id="savings-goals-list"></div>
    </section>
  `;
}

function makeGoal(partial: Partial<SavingsGoal> & { name: string; target: number; deadline: string; saved?: number }): SavingsGoal {
  return {
    name: partial.name,
    target: partial.target,
    saved: partial.saved ?? 0,
    deadline: partial.deadline,
    createdAt: '2026-04-01'
  } as SavingsGoal;
}

describe('goalsDisplayData — midnight refresh (CR-Apr22-E slice 4, finding 61a)', () => {
  const originalGoals = signals.savingsGoals.value;
  const originalContribs = signals.savingsContribs.value;
  const originalCurrency = signals.currency.value;
  const originalToday = signals.todayStr.value;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    anchorAtApril15Noon();
    seedDom();
    signals.savingsGoals.value = {};
    signals.savingsContribs.value = [];
    signals.todayStr.value = '2026-04-15';
  });

  afterEach(() => {
    if (cleanup) {
      try { cleanup(); } catch { /* swallow */ }
      cleanup = null;
    }
    signals.savingsGoals.value = originalGoals;
    signals.savingsContribs.value = originalContribs;
    signals.currency.value = originalCurrency;
    signals.todayStr.value = originalToday;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renders initial days-left count on mount', () => {
    // Today (midnight): 2026-04-15 00:00 local. Deadline parses to
    // 2026-04-20 12:00 local (parseLocalDate anchors at noon). The
    // production code computes diff = (deadline - today) / 86400000
    // = 5.5 days, and Math.round(5.5) = 6. The value is cosmetic to
    // this test — what we're locking is that some countdown renders.
    signals.savingsGoals.value = {
      g1: makeGoal({ name: 'Vacation', target: 500, saved: 100, deadline: '2026-04-20' })
    };

    cleanup = mountSavingsGoals();

    const container = document.getElementById('savings-goals-list');
    expect(container?.textContent).toContain('6 days left');
  });

  it('re-computes daysLeft when todayStr flips across local midnight', () => {
    signals.savingsGoals.value = {
      g1: makeGoal({ name: 'Vacation', target: 500, saved: 100, deadline: '2026-04-20' })
    };

    cleanup = mountSavingsGoals();

    const container = document.getElementById('savings-goals-list');
    // Baseline on April 15: Apr 20 noon − Apr 15 00:00 = 5.5 → round = 6.
    expect(container?.textContent).toContain('6 days left');

    // Simulate the midnight timer fire — advance the real clock AND flip
    // the midnight-rollover signal as the production `_scheduleNextMidnight`
    // handler would.
    vi.setSystemTime(new Date(2026, 3, 16, 0, 0, 1, 0));
    signals.todayStr.value = '2026-04-16';

    // One day later, the countdown must advance: Apr 20 noon − Apr 16 00:00
    // = 4.5 → round = 5. The number decremented by one, proving the midnight
    // subscription woke the computed.
    expect(container?.textContent).toContain('5 days left');
    expect(container?.textContent).not.toContain('6 days left');
  });

  it('flips "Due today" → "1 day overdue" on midnight rollover past the deadline', () => {
    // Deadline 2026-04-14 (parseLocalDate → Apr 14 noon). With today
    // anchored at Apr 15 00:00, diff = -0.5 → Math.round(-0.5) = 0 in
    // JS (half rounds toward +∞), so the template emits "Due today".
    signals.savingsGoals.value = {
      g1: makeGoal({ name: 'Rent', target: 1000, saved: 500, deadline: '2026-04-14' })
    };

    cleanup = mountSavingsGoals();

    const container = document.getElementById('savings-goals-list');
    expect(container?.textContent).toContain('Due today');

    // Cross midnight — today becomes Apr 16 00:00. Diff = Apr 14 noon −
    // Apr 16 00:00 = -1.5 → Math.round(-1.5) = -1 → "1 days overdue".
    vi.setSystemTime(new Date(2026, 3, 16, 0, 0, 1, 0));
    signals.todayStr.value = '2026-04-16';

    expect(container?.textContent).toContain('1 days overdue');
    expect(container?.textContent).not.toContain('Due today');
  });

  it('is inert when the goal has no deadline (no stale countdown to refresh)', () => {
    signals.savingsGoals.value = {
      g1: makeGoal({ name: 'Rainy Day', target: 500, saved: 100, deadline: '' })
    };

    cleanup = mountSavingsGoals();

    const container = document.getElementById('savings-goals-list');
    expect(container?.textContent).toContain('No deadline');

    // Crossing midnight should not regress the deadline-less copy.
    vi.setSystemTime(new Date(2026, 3, 16, 0, 0, 1, 0));
    signals.todayStr.value = '2026-04-16';

    expect(container?.textContent).toContain('No deadline');
  });
});

// ==========================================
// (61b) — calculateGoalForecast deadline parsing
// ==========================================

function makeContrib(partial: Partial<SavingsContribution> & { goalId: string; amount: number; date: string }): SavingsContribution {
  return {
    id: partial.id ?? `contrib_${Math.random().toString(36).slice(2, 10)}`,
    goalId: partial.goalId,
    amount: partial.amount,
    date: partial.date,
    createdAt: partial.createdAt ?? `${partial.date}T12:00:00.000Z`
  };
}

describe('calculateGoalForecast — deadline parsed via parseLocalDate (CR-Apr22-E slice 4, finding 61b)', () => {
  const originalContribs = signals.savingsContribs.value;

  beforeEach(() => {
    // Anchor the clock so projectedDate's construction (new Date() + setDate)
    // is deterministic across test runs. Use a noon anchor because
    // parseLocalDate returns local noon, making the intended "projectedDate
    // lands on deadline day = onTrack" semantics observable regardless of
    // the test runner's timezone (up to UTC+~11).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 20, 12, 0, 0, 0));
    signals.savingsContribs.value = [];
  });

  afterEach(() => {
    signals.savingsContribs.value = originalContribs;
    vi.useRealTimers();
  });

  it('onTrack mirrors the parseLocalDate(deadline) comparison — positive case', () => {
    // Two contributions 1 day apart, $50 each → daily rate ≈ $50/day,
    // remaining $50 → daysToComplete ≈ 1. projectedDate ≈ today + 1
    // = 2026-04-21 noon local.
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-19',
        createdAt: new Date(2026, 3, 19, 12, 0, 0, 0).toISOString()
      }),
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const goal: SavingsGoal & { id: string } = {
      id: 'g1',
      name: 'Trip',
      target: 150,
      saved: 100,
      deadline: '2026-04-21',
      createdAt: '2026-04-19'
    } as SavingsGoal & { id: string };

    const forecast = calculateGoalForecast(goal);
    expect(forecast).not.toBeNull();
    expect(forecast?.completed).toBe(false);
    if (forecast && !forecast.completed) {
      // Ground truth: the production code must agree with a
      // parseLocalDate-based comparison to the same projectedDate.
      const expectedOnTrack = forecast.projectedDate <= parseLocalDate(goal.deadline!);
      expect(forecast.onTrack).toBe(expectedOnTrack);
      // And for this scenario that ground truth is TRUE — projectedDate
      // is 2026-04-21 noon, parseLocalDate('2026-04-21') is 2026-04-21
      // noon → ≤ holds.
      expect(forecast.onTrack).toBe(true);
    }
  });

  it('onTrack is FALSE when projectedDate exceeds the deadline by a full day', () => {
    // Slower rate: two contribs $10 each → daily rate ≈ $10/day,
    // remaining $50 → daysToComplete = 5. projectedDate ≈ 2026-04-25.
    // Deadline 2026-04-22 is 3 days before projectedDate.
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 10,
        date: '2026-04-19',
        createdAt: new Date(2026, 3, 19, 12, 0, 0, 0).toISOString()
      }),
      makeContrib({
        goalId: 'g1',
        amount: 10,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const goal: SavingsGoal & { id: string } = {
      id: 'g1',
      name: 'Trip',
      target: 70,
      saved: 20,
      deadline: '2026-04-22',
      createdAt: '2026-04-19'
    } as SavingsGoal & { id: string };

    const forecast = calculateGoalForecast(goal);
    expect(forecast).not.toBeNull();
    if (forecast && !forecast.completed) {
      const expectedOnTrack = forecast.projectedDate <= parseLocalDate(goal.deadline!);
      expect(forecast.onTrack).toBe(expectedOnTrack);
      expect(forecast.onTrack).toBe(false);
    }
  });

  it('onTrack reflects parseLocalDate comparison for every deadline offset in a sweep', () => {
    // Seed a consistent velocity ($50/day, $50 remaining → daysToComplete = 1).
    // Then iterate a band of deadlines around today+1 and verify the
    // forecast's onTrack flag matches `projectedDate <= parseLocalDate(d)`.
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-19',
        createdAt: new Date(2026, 3, 19, 12, 0, 0, 0).toISOString()
      }),
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const deadlines = [
      '2026-04-19', // two days before projection → onTrack false
      '2026-04-20', // one day before → onTrack false
      '2026-04-21', // projection day (tie) → onTrack true
      '2026-04-22', // day after → onTrack true
      '2026-04-30'  // comfortably after → onTrack true
    ];

    for (const deadline of deadlines) {
      const goal: SavingsGoal & { id: string } = {
        id: 'g1',
        name: 'Trip',
        target: 150,
        saved: 100,
        deadline,
        createdAt: '2026-04-19'
      } as SavingsGoal & { id: string };

      const forecast = calculateGoalForecast(goal);
      expect(forecast).not.toBeNull();
      if (forecast && !forecast.completed) {
        const expectedOnTrack = forecast.projectedDate <= parseLocalDate(deadline);
        expect(forecast.onTrack, `deadline=${deadline}`).toBe(expectedOnTrack);
      }
    }
  });

  it('onTrack is null when the goal has no deadline (no comparison to make)', () => {
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-19',
        createdAt: new Date(2026, 3, 19, 12, 0, 0, 0).toISOString()
      }),
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const goal: SavingsGoal & { id: string } = {
      id: 'g1',
      name: 'Trip',
      target: 150,
      saved: 100,
      createdAt: '2026-04-19'
    } as SavingsGoal & { id: string };

    const forecast = calculateGoalForecast(goal);
    expect(forecast).not.toBeNull();
    if (forecast && !forecast.completed) {
      expect(forecast.onTrack).toBeNull();
    }
  });

  it('returns completed=true (not onTrack) when saved already meets target', () => {
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 100,
        date: '2026-04-19',
        createdAt: new Date(2026, 3, 19, 12, 0, 0, 0).toISOString()
      }),
      makeContrib({
        goalId: 'g1',
        amount: 100,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const goal: SavingsGoal & { id: string } = {
      id: 'g1',
      name: 'Trip',
      target: 150,
      saved: 200, // already above target
      deadline: '2026-04-21',
      createdAt: '2026-04-19'
    } as SavingsGoal & { id: string };

    const forecast = calculateGoalForecast(goal);
    expect(forecast).toEqual({ completed: true });
  });

  it('returns null when there are fewer than two contributions (no velocity signal)', () => {
    signals.savingsContribs.value = [
      makeContrib({
        goalId: 'g1',
        amount: 50,
        date: '2026-04-20',
        createdAt: new Date(2026, 3, 20, 12, 0, 0, 0).toISOString()
      }),
    ];

    const goal: SavingsGoal & { id: string } = {
      id: 'g1',
      name: 'Trip',
      target: 150,
      saved: 50,
      deadline: '2026-04-21',
      createdAt: '2026-04-19'
    } as SavingsGoal & { id: string };

    expect(calculateGoalForecast(goal)).toBeNull();
  });
});
