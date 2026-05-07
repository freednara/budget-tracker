/**
 * Calculations Module
 *
 * Pure functions for financial calculations.
 * All functions use integer math (cents) to avoid floating-point errors.
 *
 * Uses signals for reactive state access.
 *
 * @module calculations
 */
'use strict';

import * as signals from '../../core/signals.js';
import { sumByType, getMonthKey, parseMonthKey, monthKeyParts, toCents, toDollars, monthsBetweenKeys } from '../../core/utils-pure.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthAlloc } from '../../core/month-alloc.js';
import { isRolloverEnabled, calculateMonthRollovers } from './rollover.js';
import monthlyTotalsCache from '../../core/monthly-totals-cache.js';
import { on, emit, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import { formatMonthShort } from '../../core/locale-service.js';
import type {
  Transaction,
  SavingsContribution,
  Totals,
  VelocityData,
  DailyAllowanceData,
  DailyAllowanceStatus,
  SpendingPaceData,
  SpendingPaceStatus,
  TopCategoryResult,
  YearStats,
  AllTimeStats,
  MonthBestWorst,
  DetailedMonthData,
  MonthlyComparison
} from '../../../types/index.js';

// ==========================================
// INTERNAL TYPES
// ==========================================

let calculationsListenerGroupId: string | null = null;

export function cleanupCalculations(): void {
  if (calculationsListenerGroupId) {
    destroyListenerGroup(calculationsListenerGroupId);
    calculationsListenerGroupId = null;
  }
}

interface TotalsAccumulator {
  incomeCents: number;
  expensesCents: number;
}

// ==========================================
// TRANSACTION QUERIES
// ==========================================

/**
 * Get transactions for a specific month
 * OPTIMIZED: Uses Map-based index from signals for O(1) month lookups
 */
export function getMonthTx(mk: string = signals.currentMonth.value): Transaction[] {
  // Always use the optimized transactionsByMonth Map from signals
  return signals.transactionsByMonth.value.get(mk) || [];
}

/**
 * Get expense transactions for a specific month
 * REFACTORED: Leverages signals when possible
 */
export function getMonthExpenses(mk: string = signals.currentMonth.value): Transaction[] {
  if (mk === signals.currentMonth.value) {
    // Use the already filtered current month transactions
    return signals.currentMonthTx.value.filter((t: Transaction) => isTrackedExpenseTransaction(t));
  }
  return getMonthTx(mk).filter((t: Transaction) => isTrackedExpenseTransaction(t));
}

// ==========================================
// TOTALS CALCULATIONS
// ==========================================

/**
 * Calculate totals from a transaction list
 * CRITICAL FIX: Now uses memoized cache to prevent cross-tab race conditions
 *
 * M33 (Inline-Behavior-Review rev 12, Phase 5f): call sites in this file
 * previously used the default-export `calculateSync` alias, which was the
 * sync twin of the now-deleted async variant. With the SHA-256 checksum
 * infrastructure removed, the cache is sync-only — `monthlyTotalsCache.calculate`
 * is the single, canonical entry point. All six call sites in this module
 * were migrated together; no behavioral change.
 */
export function calcTotals(txList: Transaction[], monthKey?: string): Totals {
  // If we have a month key, use the memoized cache
  if (monthKey) {
    return monthlyTotalsCache.calculate(monthKey);
  }
  
  // For arbitrary transaction lists, calculate directly
  const result = txList.reduce((acc: TotalsAccumulator, tx: Transaction) => {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') acc.incomeCents += amtCents;
    else if (isTrackedExpenseTransaction(tx)) acc.expensesCents += amtCents;
    return acc;
  }, { incomeCents: 0, expensesCents: 0 });

  const income = toDollars(result.incomeCents);
  const expenses = toDollars(result.expensesCents);
  return { income, expenses, balance: toDollars(result.incomeCents - result.expensesCents) };
}

/**
 * CRITICAL FIX: Race-condition-safe monthly totals calculation
 */
export function getMonthlyTotals(monthKey: string): Totals {
  return monthlyTotalsCache.calculate(monthKey);
}

/**
 * Invalidate monthly totals cache when data changes
 */
export function invalidateMonthlyTotalsCache(monthKey?: string): void {
  if (monthKey) {
    monthlyTotalsCache.invalidateMonth(monthKey);
  } else {
    monthlyTotalsCache.invalidateAll();
  }
}

/**
 * Get effective income for a month
 */
export function getEffectiveIncome(mk: string): number {
  return sumByType(getMonthTx(mk), 'income');
}

/**
 * Get monthly savings contributions (uses integer math)
 */
export function getMonthlySavings(mk: string): number {
  const cents = signals.savingsContribs.value
    .filter((c: SavingsContribution) => getMonthKey(c.date) === mk)
    .reduce((sum: number, c: SavingsContribution) => sum + toCents(c.amount), 0);
  return toDollars(cents);
}

/**
 * Get expenses for a specific category in a month
 */
export function getMonthExpByCat(catId: string, mk: string): number {
  const cents = getMonthTx(mk)
    .filter((t: Transaction) => isTrackedExpenseTransaction(t) && t.category === catId)
    .reduce((sum: number, t: Transaction) => sum + toCents(t.amount), 0);
  return toDollars(cents);
}

/**
 * Calculate unallocated income
 * OPTIMIZED: Uses transactionsByMonth keys instead of iterating over all transactions
 */
export function getUnassigned(mk: string): number {
  // For the current month, use the memoized signal if available (O(1))
  if (mk === signals.currentMonth.value) {
    return signals.unassignedBalance.value;
  }
  
  // 1. Find all relevant months chronologically using optimized Map keys
  const allMonths = new Set(signals.transactionsByMonth.value.keys());
  Object.keys(signals.monthlyAlloc.value).forEach(month => allMonths.add(month));
  
  const sortedMonths = Array.from(allMonths).sort();
  if (!allMonths.has(mk)) {
    sortedMonths.push(mk);
    sortedMonths.sort();
  }
  
  // 2. Accumulate unassigned using cached totals
  let cumulativeUnassignedCents = 0;
  
  for (const month of sortedMonths) {
    if (month > mk) break;
    
    const totals = monthlyTotalsCache.calculate(month);
    const monthIncomeCents = toCents(totals.income);
    // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
    // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
    // once-per-session trackError on a genuine miss (map non-empty but the
    // requested month is missing), which is the data-loss signal the review
    // targets. The helper returns MonthlyAllocation (= Record<string, number>
    // per types/index.ts), so the redundant cast here is dropped.
    const monthAlloc = getMonthAlloc(month, signals.monthlyAlloc.value);
    let monthAllocCents = 0;
    for (const key in monthAlloc) {
      // Phase 6 Slice 1i (rev 12 L6): `monthAlloc[key]` is `number | undefined`
      // — fall back to 0 for inherited/absent keys.
      monthAllocCents += toCents(monthAlloc[key] ?? 0);
    }
    
    cumulativeUnassignedCents += (monthIncomeCents - monthAllocCents);
  }
  
  return toDollars(cumulativeUnassignedCents);
}

// ==========================================
// ROLLOVER CACHE
// ==========================================

/**
 * Module-level cache for rollover results keyed by month
 * Shared by getDailyAllowance() and getSpendingPace() to avoid duplicate calls
 */
let rolloverCache: { month: string; rollovers: Record<string, number> } | null = null;

function getCachedRollovers(mk: string): Record<string, number> {
  if (rolloverCache && rolloverCache.month === mk) {
    return rolloverCache.rollovers;
  }
  const rollovers = calculateMonthRollovers(mk);
  rolloverCache = { month: mk, rollovers };
  return rollovers;
}

/**
 * Invalidate the rollover cache (call when transactions or allocations change)
 */
export function invalidateRolloverCache(): void {
  rolloverCache = null;
}

// ==========================================
// VELOCITY & PACE CALCULATIONS
// ==========================================

/**
 * Calculate spending velocity (uses pure function internally)
 */
export function calcVelocity(): VelocityData {
  const currentMk = signals.currentMonth.value;
  const transactions = signals.transactions.value;
  
  // Delegate to pure function for testability
  return calcVelocityPure(transactions, currentMk, new Date());
}

/**
 * Calculate daily spending allowance based on remaining budget (uses integer math)
 */
export function getDailyAllowance(mk: string = signals.currentMonth.value): DailyAllowanceData {
  const viewDate = parseMonthKey(mk);
  const now = new Date();
  const isCurrentMonth = getMonthKey(now) === mk;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - now.getDate() + 1) : 0;

  // Get total allocated budget for the month (including rollover if enabled)
  // Use cached calculateMonthRollovers to avoid redundant computation.
  // Rev 12 / #39 M4: getMonthAlloc — see getCumulativeUnassigned above for
  // helper rationale. Cast on Object.entries is also dropped since the
  // helper's return type is already Record<string, number>.
  const alloc = getMonthAlloc(mk, signals.monthlyAlloc.value);
  const rolloverActive = isRolloverEnabled();
  const rollovers = rolloverActive ? getCachedRollovers(mk) : {};
  let totalBudgetCents = 0;
  for (const [catId, amt] of Object.entries(alloc)) {
    totalBudgetCents += toCents(amt) + (rolloverActive ? toCents(rollovers[catId] || 0) : 0);
  }
  const totalBudget = toDollars(totalBudgetCents);

  // Get total spent
  const spentCents = getMonthExpenses(mk)
    .reduce((sum: number, tx: Transaction) => sum + toCents(tx.amount), 0);
  const spent = toDollars(spentCents);

  // Calculate remaining budget
  const remainingCents = totalBudgetCents - spentCents;
  const remaining = toDollars(remainingCents);

  // Calculate daily allowance
  const dailyAllowanceCents = daysRemaining > 0 ? Math.floor(remainingCents / daysRemaining) : 0;
  const dailyAllowance = toDollars(dailyAllowanceCents);

  // Determine status based on budget health
  let status: DailyAllowanceStatus = 'neutral';
  if (totalBudget === 0) {
    status = 'no-budget';
  } else if (remaining <= 0) {
    status = 'over';
  } else if (remaining < totalBudget * 0.1) {
    status = 'warning';
  } else {
    status = 'healthy';
  }

  return {
    dailyAllowance,
    daysRemaining,
    totalBudget,
    spent,
    remaining,
    status,
    isCurrentMonth
  };
}

/**
 * Get spending pace status (on track, ahead, or behind)
 */
export function getSpendingPace(mk: string = signals.currentMonth.value): SpendingPaceData {
  const viewDate = parseMonthKey(mk);
  const now = new Date();
  const isCurrentMonth = getMonthKey(now) === mk;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;

  // Expected percent of budget that should be spent by now
  const expectedPercent = daysInMonth > 0 ? (dayOfMonth / daysInMonth) * 100 : 0;

  // Get total budget and spent (including rollover if enabled)
  // Use cached calculateMonthRollovers to avoid redundant computation.
  // Rev 12 / #39 M4: getMonthAlloc — see getCumulativeUnassigned above.
  const alloc = getMonthAlloc(mk, signals.monthlyAlloc.value);
  const rolloverActive = isRolloverEnabled();
  const rollovers = rolloverActive ? getCachedRollovers(mk) : {};
  let totalBudgetCents = 0;
  for (const [catId, amt] of Object.entries(alloc)) {
    totalBudgetCents += toCents(amt) + (rolloverActive ? toCents(rollovers[catId] || 0) : 0);
  }

  if (totalBudgetCents === 0) {
    return { status: 'no-budget', percentOfBudget: 0, expectedPercent, difference: 0 };
  }

  const spentCents = getMonthExpenses(mk)
    .reduce((sum: number, tx: Transaction) => sum + toCents(tx.amount), 0);
  const percentOfBudget = totalBudgetCents > 0 ? (spentCents / totalBudgetCents) * 100 : 0;
  const difference = percentOfBudget - expectedPercent;

  let status: SpendingPaceStatus;
  if (difference > 10) {
    status = 'over'; // Red - spending too fast
  } else if (difference > -10) {
    status = 'on-track'; // Yellow - within 10%
  } else {
    status = 'under'; // Green - spending less than expected
  }

  return {
    status,
    percentOfBudget,
    expectedPercent,
    difference,
    isCurrentMonth
  };
}

// ==========================================
// CATEGORY ANALYSIS
// ==========================================

/**
 * Module-level cache for top category result.
 * CALC-02: keyed on month + transaction count so it auto-invalidates
 * when transactions are added/removed within the same month. Prior
 * version only checked month, so getTopCat() returned stale data after
 * transaction mutations until the user navigated away and back.
 */
// CALC-03: cache keyed on the month-specific array *reference* from the
// transactionsByMonth Map. When any transaction is added, edited, or
// removed, the Map is rebuilt with new arrays — so a reference-equality
// check catches every mutation, not just count changes. The prior
// `txCount`-only key missed edits that changed an amount or category
// without changing the array length, serving stale top-category data.
let topCatCache: { monthTxRef: readonly Transaction[]; result: TopCategoryResult | null } | null = null;

/**
 * Get top spending category (uses integer math)
 * Single-pass algorithm for optimal performance
 * Cached per month transaction array reference to avoid redundant recalculation
 */
export function getTopCat(): TopCategoryResult | null {
  const monthTxList = getMonthTx();
  if (topCatCache && topCatCache.monthTxRef === monthTxList) {
    return topCatCache.result;
  }

  // Single pass: filter and accumulate category totals together
  const catsCents = monthTxList.reduce((acc: Record<string, number>, t: Transaction) => {
    if (isTrackedExpenseTransaction(t)) {
      const amtCents = toCents(t.amount);
      acc[t.category] = (acc[t.category] || 0) + amtCents;
    }
    return acc;
  }, {});

  const sorted = Object.entries(catsCents).sort((a, b) => b[1] - a[1]);
  // Phase 6 Slice 1i (rev 12 L6): extract head via destructuring so
  // the tuple narrows — direct `sorted[0][0]` is `string | undefined`
  // under `noUncheckedIndexedAccess`.
  const [head] = sorted;
  const result = head ? { ...getCatInfo('expense', head[0]), amount: toDollars(head[1]) } : null;

  topCatCache = { monthTxRef: monthTxList, result };
  return result;
}


// ==========================================
// YEAR STATISTICS
// ==========================================

/**
 * Get comprehensive year statistics
 * FIXED: Now optimized with monthly totals cache
 */
export function getYearStats(year: string): YearStats {
  const transactions = signals.transactions.value;
  
  // 1. Get all month keys for the year
  const monthKeys: string[] = [];
  for (let m = 1; m <= 12; m++) {
    monthKeys.push(`${year}-${String(m).padStart(2, '0')}`);
  }

  // 2. Aggregate data from cached monthly totals
  const monthlyData: Record<string, { income: number; expenses: number }> = {};
  const catTotalsCents: Record<string, number> = {};
  let totalIncomeCents = 0;
  let totalExpensesCents = 0;
  let yearTxCount = 0;

  for (const mk of monthKeys) {
    const totals = monthlyTotalsCache.calculate(mk);
    
    // Skip months with no data to keep stats clean
    if (totals.income === 0 && totals.expenses === 0 && Object.keys(totals.categoryTotals || {}).length === 0) {
      continue;
    }

    totalIncomeCents += toCents(totals.income);
    totalExpensesCents += toCents(totals.expenses);
    
    monthlyData[mk] = {
      income: totals.income,
      expenses: totals.expenses
    };

    // Accumulate category totals
    Object.entries(totals.categoryTotals || {}).forEach(([catId, amount]) => {
      catTotalsCents[catId] = (catTotalsCents[catId] || 0) + toCents(amount);
    });
  }

  // Calculate txCount separately (not currently in basic monthly totals)
  yearTxCount = transactions.filter(t => t.date?.startsWith(year)).length;

  const income = toDollars(totalIncomeCents);
  const expenses = toDollars(totalExpensesCents);
  const net = toDollars(totalIncomeCents - totalExpensesCents);
  const savingsRate = income > 0 ? (net / income * 100) : 0;

  const topCategories: TopCategoryResult[] = Object.entries(catTotalsCents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([catId, cents]) => ({ ...getCatInfo('expense', catId), amount: toDollars(cents) }));

  // 7a (Inline-Behavior-Review, Period/scope coherence): denominator is the
  // **tracked-span within the year**, not the active-months count.
  //
  // Pre-fix: `Object.keys(monthlyData).length || 1` — this counts only
  // months that had at least one income / expense / category entry, which
  // silently drops zero-activity months from the denominator and inflates
  // the published "avg monthly" numbers. Concrete failure modes:
  //   (1) User tracks Jan-Nov 2024 diligently, skips Dec (vacation / no
  //       receipts). Active months = 11 → avg overstated by ~9%.
  //   (2) User starts mid-year (e.g., Jul 2024). Active months = 6 for
  //       2024, but the year-over-year comparison side-by-sides it with
  //       full-year 2023 (active = 12) and the denominators don't match.
  //   (3) Current year in progress (e.g., April 2026). Active months = 2
  //       if only Jan-Feb have data — a $400 Jan/Feb total reads as
  //       $200/mo instead of the honest $100/mo across the 4 elapsed
  //       months.
  //
  // Fix: derive the span from (a) the earliest tracked month overall
  // (intersected with the requested year — don't count months before the
  // user started tracking against this year) and (b) the latest month
  // that could plausibly contain data (min of current month + Dec of the
  // requested year, so past years always divide by 12 and in-progress
  // years divide by months-elapsed). Zero-activity months *within* the
  // tracked span are included in the denominator — that's the point.
  const sortedOverall = Array.from(signals.transactionsByMonth.value.keys()).sort();
  const firstTrackedOverall = sortedOverall[0];
  const currentMonthKey = getMonthKey(new Date());
  const yearStartKey = `${year}-01`;
  const yearEndKey = `${year}-12`;
  // spanStart: later of yearStart and first-ever-tracked (string compare
  // works because YYYY-MM sorts lexically).
  const spanStart = firstTrackedOverall && firstTrackedOverall > yearStartKey
    ? firstTrackedOverall
    : yearStartKey;
  // spanEnd: earlier of yearEnd and current month (caps in-progress years
  // to elapsed months, leaves completed past years at Dec).
  const spanEnd = currentMonthKey < yearEndKey ? currentMonthKey : yearEndKey;
  // If the requested year is entirely before first-tracked (or entirely
  // in the future), there's no meaningful tracked span — fall back to 12
  // so averages resolve to 0 via the zero totals rather than NaN.
  let monthCount = 12;
  if (spanStart <= spanEnd) {
    const span = monthsBetweenKeys(spanStart, spanEnd);
    if (Number.isFinite(span)) {
      monthCount = Math.min(12, Math.max(1, span + 1));
    }
  }

  return {
    year,
    income,
    expenses,
    net,
    savingsRate,
    topCategories,
    monthlyData,
    avgMonthlyIncome: income / monthCount,
    avgMonthlyExpenses: expenses / monthCount,
    txCount: yearTxCount
  };
}

// ==========================================
// ALL-TIME STATISTICS
// ==========================================

/**
 * Get lifetime statistics across all transactions
 * OPTIMIZED: Aggregates from monthly cache using Map-based index (O(M))
 */
export function getAllTimeStats(): AllTimeStats | null {
  const transactions = signals.transactions.value;
  if (transactions.length === 0) return null;

  // 1. Find all months with data using optimized Map keys
  const sortedMonths = Array.from(signals.transactionsByMonth.value.keys()).sort();
  if (sortedMonths.length === 0) return null;

  const yearsSet = new Set<string>();
  
  let totalIncomeCents = 0;
  let totalExpensesCents = 0;
  const monthlyData: Record<string, { income: number; expenses: number; net: number }> = {};
  let bestMonth: MonthBestWorst | null = null;
  let worstMonth: MonthBestWorst | null = null;

  // 2. Process each month from cache
  for (const mk of sortedMonths) {
    const totals = monthlyTotalsCache.calculate(mk);
    const income = totals.income;
    const expenses = totals.expenses;
    const net = income - expenses;
    
    totalIncomeCents += toCents(income);
    totalExpensesCents += toCents(expenses);
    yearsSet.add(String(monthKeyParts(mk)[0]));
    
    monthlyData[mk] = { income, expenses, net };

    if (!bestMonth || net > bestMonth.net) {
      bestMonth = { month: mk, income, expenses, net };
    }
    if (!worstMonth || expenses > worstMonth.expenses) {
      worstMonth = { month: mk, income, expenses, net };
    }
  }

  const totalIncome = toDollars(totalIncomeCents);
  const totalExpenses = toDollars(totalExpensesCents);

  // 7a (Inline-Behavior-Review, Period/scope coherence): denominator is
  // the **full tracked span**, not the active-months count.
  //
  // Pre-fix: `sortedMonths.length || 1` — equivalent to the active-months
  // pattern in `getYearStats`, with the same failure: a user who has any
  // zero-activity month in their history (vacation, moving, deployed,
  // simply forgot) gets that month dropped from the denominator,
  // overstating their "avg monthly spend" across the entire lifetime.
  //
  // Fix: span from the first-tracked month to the current month (or the
  // last-tracked month if, e.g., a future-dated import extends past
  // today). Includes every calendar month in between — zero-activity
  // months count, which is the point. `bestMonth` / `worstMonth` are
  // unchanged since they iterate `sortedMonths` (by construction the
  // only months that *could* be a best or worst).
  const firstMonth = sortedMonths[0];
  const lastMonth = sortedMonths[sortedMonths.length - 1];
  const currentMonthKey = getMonthKey(new Date());
  // spanEnd = max(lastDataMonth, currentMonth) — YYYY-MM sorts lexically.
  const spanEnd = lastMonth && lastMonth > currentMonthKey ? lastMonth : currentMonthKey;
  let monthCount = sortedMonths.length || 1;
  if (firstMonth) {
    const span = monthsBetweenKeys(firstMonth, spanEnd);
    if (Number.isFinite(span)) {
      monthCount = Math.max(1, span + 1);
    }
  }

  return {
    firstDate: sortedMonths[0] + '-01',
    lastDate: sortedMonths[sortedMonths.length - 1] + '-28', // Approximation
    totalIncome,
    totalExpenses,
    netSavings: toDollars(totalIncomeCents - totalExpensesCents),
    savingsRate: totalIncome > 0 ? (toDollars(totalIncomeCents - totalExpensesCents) / totalIncome * 100) : 0,
    txCount: transactions.length,
    avgMonthlySpend: totalExpenses / monthCount,
    // 7a (Inline-Behavior-Review, Period/scope coherence): expose the same
    // denominator used for `avgMonthlySpend` so the UI's "Months Tracked"
    // display reads straight off the canonical value. Pre-fix the
    // analytics modal re-derived months-tracked inline from firstDate /
    // lastDate, which (a) duplicated the math, (b) used a narrower span
    // (last-data-month rather than max(last-data-month, current-month)),
    // and (c) could silently drift from the divisor the same modal showed
    // under "Avg/Month". Now both numbers come from one source.
    monthsTracked: monthCount,
    bestMonth,
    worstMonth,
    years: Array.from(yearsSet).sort().reverse()
  };
}

// ==========================================
// FORMATTING & UTILITIES
// ==========================================

/**
 * Format month key as "Jan 2024"
 */
export function formatMonthDisplay(mk: string): string {
  const [y, m] = monthKeyParts(mk);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[m - 1] ?? ''} ${y}`;
}

// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// `calcPercentChange` was retired here. It used the pre-baseline-helper
// fabrication `prev === 0 ? (cur > 0 ? 100 : 0) : pct`, which is exactly
// the pattern `core/baseline.ts::computeBaselineDelta` replaces — a
// zero-prior baseline would silently surface as "+100%" (indistinguishable
// from a real doubling) or "0%" (indistinguishable from a flat month).
// Its only caller wrote into the `MonthlyComparison` shape's
// `expenseChange`/`incomeChange` fields, which had zero consumers across
// the repo; both the fields and the helper are gone. Any future "percent
// change" call-site should compose `computeBaselineDelta(current, previous)`
// and branch on `.status` ('comparable' | 'new' | 'no-data') so the UI
// can render an honest "New" / "—" instead of a fabricated percent.

// ==========================================
// DETAILED YEAR ANALYSIS
// ==========================================

/**
 * Get detailed monthly breakdown for a year
 * FIXED: Aggregates from monthly cache for O(M) performance
 */
export function getDetailedYearStats(year: string): Record<string, DetailedMonthData> {
  const monthlyData: Record<string, DetailedMonthData> = {};
  
  for (let m = 1; m <= 12; m++) {
    const mk = `${year}-${String(m).padStart(2, '0')}`;
    const totals = monthlyTotalsCache.calculate(mk);
    
    monthlyData[mk] = {
      income: totals.income,
      expenses: totals.expenses,
      net: totals.income - totals.expenses,
      categories: { ...(totals.categoryTotals || {}) }
    };
  }
  
  return monthlyData;
}

/**
 * Compare two years month by month
 */
export function compareYearsMonthly(year1: string, year2: string): MonthlyComparison[] {
  const data1 = getDetailedYearStats(year1);
  const data2 = getDetailedYearStats(year2);
  const comparison: MonthlyComparison[] = [];
  // Phase 6 Slice 1i (rev 12 L6): `data1[mk]`/`data2[mk]` are now
  // `DetailedMonthData | undefined` under `noUncheckedIndexedAccess`.
  // `getDetailedYearStats` always populates all 12 months, but the
  // compiler can't see that — pull each month into a local and fall
  // back to a zero-bucket so the published shape stays stable.
  const zeroMonth: DetailedMonthData = { income: 0, expenses: 0, net: 0, categories: {} };
  for (let m = 1; m <= 12; m++) {
    const mk1 = `${year1}-${String(m).padStart(2, '0')}`;
    const mk2 = `${year2}-${String(m).padStart(2, '0')}`;
    const d1 = data1[mk1] ?? zeroMonth;
    const d2 = data2[mk2] ?? zeroMonth;
    comparison.push({
      month: m,
      // Route through locale-service so year-over-year comparison month
      // labels respect the app's configured locale (was hardcoded 'en-US').
      monthLabel: formatMonthShort(new Date(2000, m - 1, 1)),
      year1: d1,
      year2: d2,
      // 7a (Inline-Behavior-Review, Period/scope coherence + baseline
      // helper): per-month `expenseChange`/`incomeChange`/`netChange`
      // fields were removed from `MonthlyComparison` alongside the retired
      // `calcPercentChange`. Zero consumers read these fields (verified
      // via repo-wide grep). Any future per-month YoY-percent UI should
      // compose `computeBaselineDelta(d1.expenses, d2.expenses)` at the
      // consumer site so a zero-prior baseline surfaces as "New" instead
      // of the old "+100%" fabrication.
    });
  }
  return comparison;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize calculations module and register feature event listeners
 */
export function initCalculations(): void {
  cleanupCalculations();
  calculationsListenerGroupId = createListenerGroup('calculations');

  // Phase 6 cleanup (no-explicit-any sweep): the request/response
  // event-bus pattern carries `{ payload, responseEvent }`; model both
  // the request envelope and the month-payload shape locally so each
  // handler is fully typed instead of leaning on `(data: any)`.
  type MonthRequest = { payload?: { month?: string }; responseEvent?: string };
  type TxRequest = { payload?: { transactions?: Transaction[] }; responseEvent?: string };

  // Request: Month Transactions
  on(FeatureEvents.REQUEST_MONTH_TX, (data: MonthRequest) => {
    const month = data.payload?.month;
    const responseEvent = data.responseEvent;
    if (responseEvent && month) {
      const result = getMonthTx(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_MONTH_TX, result });
    }
  }, { groupId: calculationsListenerGroupId });

  // Request: Month Expenses
  on(FeatureEvents.REQUEST_MONTH_EXPENSES, (data: MonthRequest) => {
    const month = data.payload?.month;
    const responseEvent = data.responseEvent;
    if (responseEvent && month) {
      const result = getMonthExpenses(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_MONTH_EXPENSES, result });
    }
  }, { groupId: calculationsListenerGroupId });

  // Request: Effective Income
  on(FeatureEvents.REQUEST_EFFECTIVE_INCOME, (data: MonthRequest) => {
    const month = data.payload?.month;
    const responseEvent = data.responseEvent;
    if (responseEvent && month) {
      const result = getEffectiveIncome(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_EFFECTIVE_INCOME, result });
    }
  }, { groupId: calculationsListenerGroupId });

  // Request: Totals
  on(FeatureEvents.REQUEST_TOTALS, (data: TxRequest) => {
    const transactions = data.payload?.transactions;
    const responseEvent = data.responseEvent;
    if (responseEvent && transactions) {
      const result = calcTotals(transactions);
      emit(responseEvent, { type: FeatureEvents.REQUEST_TOTALS, result });
    }
  }, { groupId: calculationsListenerGroupId });
}

// ==========================================
// PURE FUNCTION EXPORTS FOR TESTING
// These accept transactions as parameters for testability
// ==========================================

/**
 * Pure velocity data type for testing
 */
export interface VelocityDataPure {
  dailyRate: number;
  projected: number;
  actual: number;
}

/**
 * Pure year stats type for testing (simpler than full YearStats)
 */
export interface YearStatsPure {
  income: number;
  expenses: number;
  net: number;
  savingsRate: number;
  topCategories: Array<{ id: string; amount: number }>;
  transactionCount: number;
}

/**
 * Pure all-time stats type for testing
 */
export interface AllTimeStatsPure {
  firstDate: string;
  lastDate: string;
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  transactionCount: number;
}

/**
 * Pure version of calcVelocity for testing
 * @param transactions - Array of transactions
 * @param currentMonth - Month key (YYYY-MM)
 * @param referenceDate - Reference date for calculations (default: new Date())
 */
export function calcVelocityPure(
  transactions: Transaction[],
  currentMonth: string,
  referenceDate: Date = new Date()
): VelocityDataPure {
  const viewDate = parseMonthKey(currentMonth);
  const isCurrentMonth = getMonthKey(referenceDate) === currentMonth;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const daysElapsed = isCurrentMonth ? Math.max(1, referenceDate.getDate()) : daysInMonth;
  const monthTx = transactions.filter(tx => tx.date && getMonthKey(tx.date) === currentMonth);
  const monthExp = toDollars(
    monthTx.reduce((sum: number, tx: Transaction) => (
      isTrackedExpenseTransaction(tx) ? sum + toCents(tx.amount) : sum
    ), 0)
  );
  const dailyRate = daysElapsed > 0 ? monthExp / daysElapsed : 0;
  return { dailyRate, projected: dailyRate * daysInMonth, actual: monthExp };
}

/**
 * Pure version of getYearStats for testing
 * @param transactions - Array of transactions
 * @param year - Year string (YYYY)
 */
export function getYearStatsPure(transactions: Transaction[], year: string): YearStatsPure {
  const yearTx = transactions.filter(tx => tx.date && tx.date.startsWith(year));

  // Use integer math (cents) to avoid floating-point precision errors
  const incomeCents = yearTx
    .filter(t => t.type === 'income')
    .reduce((s, t) => s + toCents(t.amount), 0);
  const expensesCents = yearTx
    .filter((t: Transaction) => isTrackedExpenseTransaction(t))
    .reduce((s, t) => s + toCents(t.amount), 0);

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  const net = toDollars(incomeCents - expensesCents);
  const savingsRate = income > 0 ? ((income - expenses) / income * 100) : 0;

  // Category breakdown for expenses (also using cents)
  const catTotalsCents: Record<string, number> = {};
  yearTx.filter((t: Transaction) => isTrackedExpenseTransaction(t)).forEach((t: Transaction) => {
    catTotalsCents[t.category] = (catTotalsCents[t.category] || 0) + toCents(t.amount);
  });
  const topCategories = Object.entries(catTotalsCents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([catId, amountCents]) => ({ id: catId, amount: toDollars(amountCents) }));

  return {
    income,
    expenses,
    net,
    savingsRate,
    topCategories,
    transactionCount: yearTx.length
  };
}

/**
 * Pure version of getAllTimeStats for testing
 * @param transactions - Array of transactions
 */
export function getAllTimeStatsPure(transactions: Transaction[]): AllTimeStatsPure | null {
  const allTx = transactions.filter(tx => tx.date);
  if (!allTx.length) return null;

  const sorted = [...allTx].sort((a, b) => a.date.localeCompare(b.date));
  // Phase 6 Slice 1i (rev 12 L6): `sorted[i]` is now `T | undefined`
  // under `noUncheckedIndexedAccess` — read both ends via guarded
  // locals. The `!allTx.length` guard above guarantees presence;
  // the `?? ''` fallback keeps the result shape stable if that ever
  // changes.
  const firstDate = sorted[0]?.date ?? '';
  const lastDate = sorted[sorted.length - 1]?.date ?? '';

  // Use integer math (cents) to avoid floating-point precision errors
  const totalIncomeCents = allTx
    .filter(t => t.type === 'income')
    .reduce((s, t) => s + toCents(t.amount), 0);
  const totalExpensesCents = allTx
    .filter((t: Transaction) => isTrackedExpenseTransaction(t))
    .reduce((s, t) => s + toCents(t.amount), 0);

  const totalIncome = toDollars(totalIncomeCents);
  const totalExpenses = toDollars(totalExpensesCents);
  const netSavings = toDollars(totalIncomeCents - totalExpensesCents);
  const savingsRate = totalIncome > 0 ? (netSavings / totalIncome * 100) : 0;

  return {
    firstDate,
    lastDate,
    totalIncome,
    totalExpenses,
    netSavings,
    savingsRate,
    transactionCount: allTx.length
  };
}
