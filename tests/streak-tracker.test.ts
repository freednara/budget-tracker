/**
 * Tests for streak-tracker.ts pure streak calculation functions
 *
 * calculateCurrentStreak and getLongestStreak read from signals.transactions.value
 * and call getTodayStr(), so we mock both. daysBetween is private but exercised
 * through the public API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Transaction, StreakData } from '../js/types/index.js';

// ==========================================
// Mock setup — vi.hoisted so factories can reference them
// ==========================================

const { mockTransactions, mockStreak, mockTodayRef } = vi.hoisted(() => ({
  mockTransactions: { value: [] as Transaction[] },
  mockStreak: { value: { current: 0, longest: 0, lastDate: '' } as StreakData },
  mockTodayRef: { value: '2025-06-15' },
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: mockTransactions,
  streak: mockStreak,
  savingsGoals: { value: {} },
  savingsContribs: { value: [] },
}));

vi.mock('../js/modules/core/utils.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../js/modules/core/utils.js');
  return {
    ...actual,
    getTodayStr: () => mockTodayRef.value,
  };
});

vi.mock('../js/modules/core/state.js', () => ({
  SK: {},
  persist: vi.fn(),
  lsGet: vi.fn(),
  getStored: vi.fn(),
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  default: { get: vi.fn(() => null) },
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  on: vi.fn(),
  Events: {},
}));

vi.mock('../js/modules/core/feature-event-interface.js', () => ({
  FeatureEvents: { CHECK_STREAK: 'feature:check-streak' },
}));

import { calculateCurrentStreak, setStreakConfig } from '../js/modules/features/gamification/streak-tracker.js';

// ==========================================
// Helpers
// ==========================================

function tx(date: string): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 10,
    date,
    category: 'food',
    description: 'Test',
    currency: 'USD',
    recurring: false,
  } as Transaction;
}

/**
 * Build an array of transactions with one per day for the given dates.
 */
function txOnDates(dates: string[]): Transaction[] {
  return dates.map(d => tx(d));
}

/**
 * Generate consecutive date strings ending on endDate going back numDays.
 * e.g., consecutiveDates('2025-06-15', 5) => ['2025-06-11', ..., '2025-06-15']
 */
function consecutiveDates(endDate: string, numDays: number): string[] {
  const dates: string[] = [];
  const end = new Date(endDate + 'T12:00:00');
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

// ==========================================
// TESTS
// ==========================================

describe('calculateCurrentStreak', () => {
  beforeEach(() => {
    mockTransactions.value = [];
    mockTodayRef.value = '2025-06-15';
    // Reset to default config before each test
    setStreakConfig({ gracePeriodDays: 2, maxBackfillDays: 7, enableBackfill: true });
  });

  it('returns zero streak with no transactions', () => {
    const result = calculateCurrentStreak();
    expect(result).toEqual({ current: 0, longest: 0, lastDate: '' });
  });

  it('returns streak of 1 when only today has a transaction', () => {
    mockTransactions.value = txOnDates(['2025-06-15']);
    const result = calculateCurrentStreak();

    expect(result.current).toBe(1);
    expect(result.lastDate).toBe('2025-06-15');
  });

  it('counts consecutive days ending today', () => {
    // 5 consecutive days ending on today (2025-06-15)
    const dates = consecutiveDates('2025-06-15', 5);
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(5);
    expect(result.longest).toBe(5);
    expect(result.lastDate).toBe('2025-06-15');
  });

  it('counts consecutive days ending yesterday (grace period)', () => {
    // 3 consecutive days ending yesterday
    const dates = consecutiveDates('2025-06-14', 3);
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(3);
    expect(result.lastDate).toBe('2025-06-14');
  });

  it('detects broken streak when gap exceeds grace period', () => {
    // Last transaction was 5 days ago (beyond default 2-day grace)
    mockTransactions.value = txOnDates(['2025-06-10']);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(0);
    expect(result.lastDate).toBe('2025-06-10');
  });

  it('handles a gap in the middle — only counts recent consecutive run', () => {
    // 3 days: June 8,9,10 then gap on 11, then 12,13,14,15
    const dates = ['2025-06-08', '2025-06-09', '2025-06-10',
                   /* gap on 11 */
                   '2025-06-12', '2025-06-13', '2025-06-14', '2025-06-15'];
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    // Current streak should be 4 (June 12-15)
    expect(result.current).toBe(4);
    // Longest should also be 4 (the longer run in recent segment)
    // The earlier run was 3 days (8,9,10)
    expect(result.longest).toBe(4);
  });

  it('handles duplicate transaction dates correctly', () => {
    // Multiple transactions on the same day should not inflate the streak
    mockTransactions.value = [
      tx('2025-06-14'), tx('2025-06-14'), tx('2025-06-14'),
      tx('2025-06-15'), tx('2025-06-15'),
    ];

    const result = calculateCurrentStreak();
    expect(result.current).toBe(2);
  });

  it('reports longest streak from history even when current is zero', () => {
    // Historical streak of 4 days, but last activity was 10 days ago
    const dates = consecutiveDates('2025-06-05', 4);
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(0);
    expect(result.longest).toBe(4);
  });
});

describe('getLongestStreak (via calculateCurrentStreak)', () => {
  beforeEach(() => {
    mockTransactions.value = [];
    mockTodayRef.value = '2025-06-15';
    setStreakConfig({ gracePeriodDays: 2, maxBackfillDays: 7, enableBackfill: true });
  });

  it('finds longest streak across multiple separate streaks', () => {
    // Streak 1: Jan 1-3 (3 days)
    // Streak 2: Mar 1-7 (7 days) <-- longest
    // Streak 3: Jun 14-15 (2 days, current)
    const dates = [
      ...consecutiveDates('2025-01-03', 3),
      ...consecutiveDates('2025-03-07', 7),
      '2025-06-14', '2025-06-15',
    ];
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(2);
    expect(result.longest).toBe(7);
  });

  it('returns 1 when all transaction dates are non-consecutive', () => {
    mockTransactions.value = txOnDates([
      '2025-01-01', '2025-02-01', '2025-03-01',
    ]);
    // All far apart, none consecutive; current is 0 (last was months ago)
    const result = calculateCurrentStreak();
    expect(result.longest).toBe(1);
  });

  it('handles single transaction as longest=1', () => {
    mockTransactions.value = txOnDates(['2025-06-15']);
    const result = calculateCurrentStreak();
    expect(result.longest).toBe(1);
  });
});

describe('daysBetween DST safety (via calculateCurrentStreak)', () => {
  beforeEach(() => {
    mockTransactions.value = [];
    setStreakConfig({ gracePeriodDays: 2, maxBackfillDays: 7, enableBackfill: true });
  });

  it('counts correctly across US spring-forward DST transition (March)', () => {
    // US DST spring forward: March 9, 2025 (clocks jump ahead 1 hour)
    // A naive midnight-based diff could produce 0.958.. days instead of 1
    mockTodayRef.value = '2025-03-12';
    const dates = consecutiveDates('2025-03-12', 5);
    // dates = ['2025-03-08', '2025-03-09', '2025-03-10', '2025-03-11', '2025-03-12']
    // This crosses the DST boundary on March 9
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(5);
  });

  it('counts correctly across US fall-back DST transition (November)', () => {
    // US DST fall back: November 2, 2025 (clocks go back 1 hour)
    mockTodayRef.value = '2025-11-05';
    const dates = consecutiveDates('2025-11-05', 5);
    // dates span Nov 1-5, crossing DST boundary on Nov 2
    mockTransactions.value = txOnDates(dates);

    const result = calculateCurrentStreak();
    expect(result.current).toBe(5);
  });

  it('correctly identifies gap=1 day across DST (not 0 or 2)', () => {
    // If daysBetween gave wrong result across DST, a 1-day gap might read as 0 or 2
    // which would either merge separate streaks or break a valid one.
    // March 8 and March 10 are 2 days apart (gap of 1 day on the 9th)
    mockTodayRef.value = '2025-03-10';
    mockTransactions.value = txOnDates(['2025-03-08', '2025-03-10']);

    const result = calculateCurrentStreak();
    // These dates are NOT consecutive (gap on March 9), so current streak = 1 (just today)
    expect(result.current).toBe(1);
    // Longest should also be 1 since each "streak" is a single day
    expect(result.longest).toBe(1);
  });
});
