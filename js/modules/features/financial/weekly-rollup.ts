/**
 * Weekly Rollup Chart Module
 *
 * Renders weekly spending breakdown with SVG bar chart.
 * Shows spending by week with trend arrows, category breakdown,
 * and budget line comparison.
 *
 * @module weekly-rollup
 */
'use strict';

import * as signals from '../../core/signals.js';
import { getMonthTx } from './calculations.js';
import { parseMonthKey, parseLocalDate, toCents, toDollars } from '../../core/utils-pure.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthBadge } from '../../core/utils-dom.js';

// Re-export needed types and functions for component
export { getMonthBadge };
import type {
  Transaction,
  WeekData
} from '../../../types/index.js';

// Re-export needed types for component
export type { WeekData };

// Phase 5g-1 (Inline-Behavior-Review rev 12, L16): removed the
// `WeeklyRollupElement` interface and its `_weeklyRollupHandlers` slot.
// The slot had zero assignments — Lit's template bindings handle listener
// teardown. Callers in `components/weekly-rollup.ts` now use plain
// `HTMLElement` for the chart host element.
//
// Phase 6 cleanup: removed `initWeeklyRollup` and the `switchMainTabFn` /
// `renderTransactionsFn` module slots. Neither slot was ever read and
// `initWeeklyRollup` had no callers — the callbacks were a DI-era relic.

// ==========================================
// CHART ELEMENT TYPE EXTENSION
// ==========================================

// ==========================================
// MAIN RENDER FUNCTION
// ==========================================

/**
 * Render weekly spending rollup chart
 * Shows bar chart with weekly totals, trend arrows, and interactive tooltips
 */
// ==========================================
// BUSINESS LOGIC FUNCTIONS
// ==========================================

/**
 * Generate weekly data for the current month
 * FIXED: Uses proper ISO calendar weeks (Monday-Sunday) and correctly handles month boundaries
 */
export function generateWeeklyData(): { hasData: boolean; weeks: WeekData[]; stats: { maxWeekTotal: number; avgWeekTotal: number } } {
  const currentMonthKey = signals.currentMonth.value;
  const monthTx = (getMonthTx(currentMonthKey)).filter((tx: Transaction) => isTrackedExpenseTransaction(tx));
  
  if (monthTx.length === 0) {
    return { hasData: false, weeks: [], stats: { maxWeekTotal: 0, avgWeekTotal: 0 } };
  }

  const viewDate = parseMonthKey(currentMonthKey);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthStart = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  
  // 1. Find every ISO week (Monday-Sunday) that overlaps the current month.
  // This preserves leading/trailing partial weeks so month-edge spending stays visible.
  const weeks: WeekData[] = [];
  
  // Start at the 1st of the month
  const iter = new Date(year, month, 1);
  
  // Go back to the preceding Monday if the month doesn't start on a Monday
  const dayOfWeek = iter.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  iter.setDate(iter.getDate() - daysToMonday);

  // Generate weeks until the week start is past the end of the month
  // Use an absolute end boundary (first day of next month) for safe termination
  const monthEnd = new Date(year, month + 1, 1); // first day of next month
  const MAX_WEEKS = 7; // safety limit (a month spans at most ~6 weeks)

  for (let w = 0; w < MAX_WEEKS; w++) {
    const weekStart = new Date(iter);
    const weekEnd = new Date(iter);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // Stop if the week starts after the month
    if (weekStart >= monthEnd) break;

    const overlapsCurrentMonth = weekStart < monthEnd && weekEnd >= monthStart;

    if (overlapsCurrentMonth) {
      const visibleStart = weekStart < monthStart ? 1 : weekStart.getDate();
      const visibleEnd = weekEnd >= monthEnd ? lastDayOfMonth : weekEnd.getDate();
      weeks.push({
        start: visibleStart,
        end: visibleEnd,
        startDate: new Date(weekStart),
        endDate: new Date(weekEnd),
        totalCents: 0,
        txCount: 0,
        categoriesCents: {},
        get total(): number { return toDollars(this.totalCents); },
        get categories(): Record<string, number> {
          return Object.fromEntries(
            Object.entries(this.categoriesCents).map(([cat, cents]) => [cat, toDollars(cents)])
          );
        }
      });
    }

    iter.setDate(iter.getDate() + 7);
  }

  // 2. Assign transactions to weeks
  monthTx.forEach(tx => {
    const txDate = parseLocalDate(tx.date);
    const txTime = txDate.getTime();
    
    const week = weeks.find(w => {
      const start = w.startDate?.getTime();
      const end = w.endDate?.getTime();
      if (typeof start !== 'number' || typeof end !== 'number') return false;
      // Use inclusive boundaries for the whole day
      return txTime >= start && txTime <= (end + 86399999);
    });

    if (week) {
      const amtCents = toCents(tx.amount);
      week.totalCents += amtCents;
      week.txCount++;
      week.categoriesCents[tx.category] = (week.categoriesCents[tx.category] || 0) + amtCents;
    }
  });

  // 3. Finalize data
  weeks.forEach(week => {
    const sorted = Object.entries(week.categoriesCents).sort((a, b) => b[1] - a[1]).slice(0, 3);
    week.topCategories = sorted.map(([cat, amtCents]) => ({ cat, amt: toDollars(amtCents) }));
  });

  const maxWeekTotal = Math.max(...weeks.map(w => w.total), 1);

  // CR-Apr22-F slice 5 (Finding 8, P3): average only weeks that actually
  // contain transactions. The overlap loop intentionally keeps leading and
  // trailing partial weeks so month-edge spending stays visible in the
  // chart, but those buckets are frequently empty (e.g. a month that
  // starts mid-week generates a zero-activity Mon-to-partial-week-end
  // bucket). Averaging across the full bucket count dilutes the "Average
  // Week" reading below the average of weeks the user actually spent in —
  // especially noticeable for months where spend concentrates in interior
  // weeks. Filtering by `txCount > 0` is equivalent to "weeks whose range
  // intersects any transaction", which is the semantically meaningful
  // baseline for the average. `maxWeekTotal` is left unchanged — the chart
  // still plots every overlap bucket, including zeros, so the max must
  // consider every rendered bar.
  const activeWeeks = weeks.filter(w => w.txCount > 0);
  const avgWeekTotal = activeWeeks.length > 0
    ? activeWeeks.reduce((s, w) => s + w.total, 0) / activeWeeks.length
    : 0;

  return { hasData: true, weeks, stats: { maxWeekTotal, avgWeekTotal } };
}

// renderWeeklyRollup() removed — rendering is handled by reactive components/weekly-rollup.ts (mountWeeklyRollup)
