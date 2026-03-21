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
import { parseMonthKey, parseLocalDate, toCents, toDollars } from '../../core/utils.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthBadge } from '../../core/utils-dom.js';

// Re-export needed types and functions for component
export { getMonthBadge };
import type {
  Transaction,
  CurrencyFormatter,
  ShortCurrencyFormatter,
  MainTab,
  WeeklyRollupCallbacks,
  WeekData,
  ChartHandlerRecord
} from '../../../types/index.js';

// Re-export needed types for component
export type { WeekData };

// Define interface locally for DOM elements
export interface WeeklyRollupElement extends HTMLElement {
  _weeklyRollupHandlers?: ChartHandlerRecord[] | null;
}

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v: number): string => '$' + v.toFixed(2);
let fmtShort: ShortCurrencyFormatter = (v: number): string => '$' + v.toFixed(0);
let switchMainTabFn: ((tab: MainTab) => void) | null = null;
let renderTransactionsFn: (() => void) | null = null;

/**
 * Initialize weekly rollup with callback functions
 */
export function initWeeklyRollup(callbacks: WeeklyRollupCallbacks): void {
  if (callbacks.fmtCur) fmtCur = callbacks.fmtCur;
  if (callbacks.fmtShort) fmtShort = callbacks.fmtShort;
  if (callbacks.switchMainTab) switchMainTabFn = callbacks.switchMainTab;
  if (callbacks.renderTransactions) renderTransactionsFn = callbacks.renderTransactions;
}

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
  const currentMonthKey = signals.currentMonth.value as string;
  const monthTx = (getMonthTx(currentMonthKey) as Transaction[]).filter((tx: Transaction) => isTrackedExpenseTransaction(tx));
  
  if (monthTx.length === 0) {
    return { hasData: false, weeks: [], stats: { maxWeekTotal: 0, avgWeekTotal: 0 } };
  }

  const viewDate = parseMonthKey(currentMonthKey);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  
  // 1. Find all Mondays that fall in this month OR are the start of a week that overlaps this month
  const weeks: WeekData[] = [];
  
  // Start at the 1st of the month
  let iter = new Date(year, month, 1);
  
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

    // Only include week if at least one day is in the current month
    const hasDaysInMonth = (weekStart.getMonth() === month && weekStart.getFullYear() === year) ||
                          (weekEnd.getMonth() === month && weekEnd.getFullYear() === year);

    if (hasDaysInMonth) {
      weeks.push({
        start: weekStart.getDate(),
        end: weekEnd.getDate(),
        startDate: new Date(weekStart),
        endDate: new Date(weekEnd),
        totalCents: 0,
        txCount: 0,
        categoriesCents: {},
        get total(): number { return toDollars(this.totalCents); }
      } as any);
    }

    iter.setDate(iter.getDate() + 7);
  }

  // 2. Assign transactions to weeks
  monthTx.forEach(tx => {
    const txDate = parseLocalDate(tx.date);
    const txTime = txDate.getTime();
    
    const week = weeks.find(w => {
      const start = (w as any).startDate.getTime();
      const end = (w as any).endDate.getTime();
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
    // Populate the legacy getter compatibility if needed
    (week as any).categories = {};
    for (const [cat, cents] of Object.entries(week.categoriesCents)) {
      (week as any).categories[cat] = toDollars(cents);
    }
  });

  const maxWeekTotal = Math.max(...weeks.map(w => w.total), 1);
  const avgWeekTotal = weeks.length > 0 ? weeks.reduce((s, w) => s + w.total, 0) / weeks.length : 0;

  return { hasData: true, weeks, stats: { maxWeekTotal, avgWeekTotal } };
}

// renderWeeklyRollup() removed — rendering is handled by reactive components/weekly-rollup.ts (mountWeeklyRollup)
