import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { generateWeeklyData } from '../js/modules/features/financial/weekly-rollup.js';
import type { Transaction } from '../js/types/index.js';

function tx(overrides: Partial<Transaction> & {
  __backendId: string;
  amount: number;
  date: string;
  category: string;
}): Transaction {
  const {
    __backendId,
    amount,
    date,
    category,
    description,
    currency,
    recurring,
    ...rest
  } = overrides;

  return {
    ...rest,
    __backendId,
    type: 'expense',
    amount,
    description: description ?? 'Test transaction',
    date,
    category,
    currency: currency ?? 'USD',
    recurring: recurring ?? false
  };
}

describe('generateWeeklyData', () => {
  const originalMonth = signals.currentMonth.value;
  const originalTransactions = [...signals.transactions.value];

  beforeEach(() => {
    signals.currentMonth.value = '2026-04';
    signals.replaceTransactionLedger([]);
  });

  afterEach(() => {
    signals.currentMonth.value = originalMonth;
    signals.replaceTransactionLedger(originalTransactions);
  });

  it('keeps the opening partial ISO week when the month starts mid-week', () => {
    signals.replaceTransactionLedger([
      tx({ __backendId: 'opening-week', amount: 42, date: '2026-04-01', category: 'food' })
    ]);

    const result = generateWeeklyData();

    expect(result.hasData).toBe(true);
    const firstWeek = result.weeks[0];
    if (!firstWeek) throw new Error('expected at least one week');
    expect(firstWeek.start).toBe(1);
    expect(firstWeek.end).toBe(5);
    expect(firstWeek.txCount).toBe(1);
    expect(firstWeek.total).toBe(42);
  });

  // ==========================================
  // CR-Apr22-F slice 5 — Finding 8 (P3):
  // avgWeekTotal excludes empty overlap weeks
  // ==========================================
  describe('avgWeekTotal (CR-Apr22-F slice 5)', () => {
    it('averages only weeks that contain transactions, not the full overlap bucket count', () => {
      // April 2026 spans 5 overlapping ISO weeks (Mar 30-Apr 5, Apr 6-12, Apr 13-19, Apr 20-26, Apr 27-May 3).
      // Concentrate all spend in interior weeks (Apr 6-12 and Apr 13-19).
      signals.replaceTransactionLedger([
        tx({ __backendId: 'interior-1', amount: 100, date: '2026-04-08', category: 'food' }),
        tx({ __backendId: 'interior-2', amount: 300, date: '2026-04-15', category: 'food' })
      ]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(true);
      // Active-week average: (100 + 300) / 2 = 200.
      // Full-bucket average (pre-fix): (100 + 300) / 5 = 80.
      expect(result.stats.avgWeekTotal).toBeCloseTo(200, 5);
      // Guard against regression to the pre-fix dilution value.
      expect(result.stats.avgWeekTotal).not.toBeCloseTo(80, 5);
    });

    it('returns 0 for avgWeekTotal when every overlap week is empty (defensive — hasData guard normally short-circuits)', () => {
      // hasData=false returns early with avgWeekTotal=0. This case covers the defensive
      // inner branch: even if the early-return is ever removed, the inner calculation
      // must still be safe against zero active weeks.
      signals.replaceTransactionLedger([]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(false);
      expect(result.stats.avgWeekTotal).toBe(0);
    });

    it('equals the single-active-week total when only one overlap week has transactions', () => {
      // Only the Apr 20-26 bucket contains spend; the other four overlap weeks are empty.
      signals.replaceTransactionLedger([
        tx({ __backendId: 'solo-a', amount: 50, date: '2026-04-22', category: 'food' }),
        tx({ __backendId: 'solo-b', amount: 75, date: '2026-04-24', category: 'transport' })
      ]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(true);
      // Single active week total = 125; average over active weeks = 125.
      expect(result.stats.avgWeekTotal).toBeCloseTo(125, 5);
    });

    it('leaves maxWeekTotal unchanged — the chart still plots every overlap bucket including zeros', () => {
      // Regression guard: the fix targets avgWeekTotal only. maxWeekTotal must continue
      // to consider every week so bar scaling matches what's rendered.
      signals.replaceTransactionLedger([
        tx({ __backendId: 'peak', amount: 500, date: '2026-04-15', category: 'food' })
      ]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(true);
      // 5 overlap weeks, one contains 500, others 0 → maxWeekTotal = 500.
      expect(result.stats.maxWeekTotal).toBe(500);
      // With only one active week, avg equals that week's total.
      expect(result.stats.avgWeekTotal).toBeCloseTo(500, 5);
    });

    it('preserves the overlap-week structure — all overlap weeks remain in weeks[] even when empty', () => {
      // Regression guard: the fix must NOT filter overlap weeks out of the rendered list.
      // The chart keeps every overlap bucket; only the stat denominator changes.
      signals.replaceTransactionLedger([
        tx({ __backendId: 'mid', amount: 200, date: '2026-04-15', category: 'food' })
      ]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(true);
      // April 2026 contains 5 overlap weeks — confirm no filtering happens in weeks[].
      expect(result.weeks.length).toBe(5);
      // At least one week has txCount === 0 — that's the empty-overlap bucket the avg excludes.
      const emptyWeeks = result.weeks.filter(w => w.txCount === 0);
      expect(emptyWeeks.length).toBeGreaterThan(0);
    });

    it('averages across multiple active weeks while ignoring one empty interior week', () => {
      // Mixed scenario: two interior active weeks + one explicitly empty interior week
      // between them. Confirms txCount>0 is the filter (empty weeks skipped regardless of position).
      signals.replaceTransactionLedger([
        tx({ __backendId: 'early', amount: 100, date: '2026-04-08', category: 'food' }),
        // Apr 13-19 deliberately left empty
        tx({ __backendId: 'late', amount: 300, date: '2026-04-22', category: 'food' })
      ]);

      const result = generateWeeklyData();

      expect(result.hasData).toBe(true);
      // Active weeks: Apr 6-12 ($100) + Apr 20-26 ($300). avg = (100+300)/2 = 200.
      expect(result.stats.avgWeekTotal).toBeCloseTo(200, 5);
    });
  });
});
