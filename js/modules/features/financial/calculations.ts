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
import { sumByType, getMonthKey, parseMonthKey, toCents, toDollars } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { isRolloverEnabled, getEffectiveBudget, calculateMonthRollovers } from './rollover.js';
import monthlyTotalsCache from '../../core/monthly-totals-cache.js';
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

interface TotalsAccumulator {
  incomeCents: number;
  expensesCents: number;
}

interface YearStatsAccumulator {
  incomeCents: number;
  expensesCents: number;
  catTotalsCents: Record<string, number>;
  monthlyDataCents: Record<string, { income: number; expenses: number }>;
  txCount: number;
}

interface AllTimeStatsAccumulator {
  totalIncomeCents: number;
  totalExpensesCents: number;
  monthlyDataCents: Record<string, { income: number; expenses: number }>;
  yearsSet: Set<string>;
  firstDate: string | null;
  lastDate: string | null;
  txCount: number;
}

interface MonthlyDataCentsEntry {
  income: number;
  expenses: number;
  categories: Record<string, number>;
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
 */
export function calcTotals(txList: Transaction[], monthKey?: string): Totals {
  // If we have a month key, use the memoized cache (sync version for compatibility)
  if (monthKey) {
    return monthlyTotalsCache.calculateSync(monthKey);
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
  return monthlyTotalsCache.calculateSync(monthKey);
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
    
    const totals = monthlyTotalsCache.calculateSync(month);
    const monthIncomeCents = toCents(totals.income);
    const monthAlloc = (signals.monthlyAlloc.value[month] || {}) as Record<string, number>;
    let monthAllocCents = 0;
    for (const key in monthAlloc) {
      monthAllocCents += toCents(monthAlloc[key]);
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
  // Use cached calculateMonthRollovers to avoid redundant computation
  const alloc = signals.monthlyAlloc.value[mk] || {};
  const rolloverActive = isRolloverEnabled();
  const rollovers = rolloverActive ? getCachedRollovers(mk) : {};
  let totalBudgetCents = 0;
  for (const [catId, amt] of Object.entries(alloc as Record<string, number>)) {
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
  // Use cached calculateMonthRollovers to avoid redundant computation
  const alloc = signals.monthlyAlloc.value[mk] || {};
  const rolloverActive = isRolloverEnabled();
  const rollovers = rolloverActive ? getCachedRollovers(mk) : {};
  let totalBudgetCents = 0;
  for (const [catId, amt] of Object.entries(alloc as Record<string, number>)) {
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
 * Module-level cache for top category result (invalidated when month changes)
 */
let topCatCache: { month: string; result: TopCategoryResult | null } | null = null;

/**
 * Get top spending category (uses integer math)
 * Single-pass algorithm for optimal performance
 * Cached per month to avoid redundant recalculation
 */
export function getTopCat(): TopCategoryResult | null {
  const currentMonth = signals.currentMonth.value;
  if (topCatCache && topCatCache.month === currentMonth) {
    return topCatCache.result;
  }

  // Single pass: filter and accumulate category totals together
  const catsCents = getMonthTx().reduce((acc: Record<string, number>, t: Transaction) => {
    if (isTrackedExpenseTransaction(t)) {
      const amtCents = toCents(t.amount);
      acc[t.category] = (acc[t.category] || 0) + amtCents;
    }
    return acc;
  }, {});

  const sorted = Object.entries(catsCents).sort((a, b) => b[1] - a[1]);
  const result = sorted.length > 0 ? { ...getCatInfo('expense', sorted[0][0]), amount: toDollars(sorted[0][1]) } : null;

  topCatCache = { month: currentMonth, result };
  return result;
}

/**
 * Invalidate the top category cache (call when transactions change)
 */
export function invalidateTopCatCache(): void {
  topCatCache = null;
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
    const totals = monthlyTotalsCache.calculateSync(mk);
    
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

  const monthCount = Object.keys(monthlyData).length || 1;

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
    const totals = monthlyTotalsCache.calculateSync(mk);
    const income = totals.income;
    const expenses = totals.expenses;
    const net = income - expenses;
    
    totalIncomeCents += toCents(income);
    totalExpensesCents += toCents(expenses);
    yearsSet.add(mk.substring(0, 4));
    
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
  const monthCount = sortedMonths.length || 1;

  return {
    firstDate: sortedMonths[0] + '-01',
    lastDate: sortedMonths[sortedMonths.length - 1] + '-28', // Approximation
    totalIncome,
    totalExpenses,
    netSavings: toDollars(totalIncomeCents - totalExpensesCents),
    savingsRate: totalIncome > 0 ? (toDollars(totalIncomeCents - totalExpensesCents) / totalIncome * 100) : 0,
    txCount: transactions.length,
    avgMonthlySpend: totalExpenses / monthCount,
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
  const [y, m] = mk.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
}

/**
 * Calculate percentage change between two values
 */
export function calcPercentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

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
    const totals = monthlyTotalsCache.calculateSync(mk);
    
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
  for (let m = 1; m <= 12; m++) {
    const mk1 = `${year1}-${String(m).padStart(2, '0')}`;
    const mk2 = `${year2}-${String(m).padStart(2, '0')}`;
    comparison.push({
      month: m,
      monthLabel: new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }),
      year1: data1[mk1],
      year2: data2[mk2],
      expenseChange: calcPercentChange(data1[mk1].expenses, data2[mk2].expenses),
      incomeChange: calcPercentChange(data1[mk1].income, data2[mk2].income),
      netChange: data1[mk1].net - data2[mk2].net
    });
  }
  return comparison;
}

// ==========================================
// INITIALIZATION
// ==========================================

import { on, emit } from '../../core/event-bus.js';
import { FeatureEvents, type FeatureResponse } from '../../core/feature-event-interface.js';

/**
 * Initialize calculations module and register feature event listeners
 */
export function initCalculations(): void {
  // Request: Month Transactions
  on(FeatureEvents.REQUEST_MONTH_TX, (data: any) => {
    const { month } = data.payload || {};
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const result = getMonthTx(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_MONTH_TX, result });
    }
  });

  // Request: Month Expenses
  on(FeatureEvents.REQUEST_MONTH_EXPENSES, (data: any) => {
    const { month } = data.payload || {};
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const result = getMonthExpenses(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_MONTH_EXPENSES, result });
    }
  });

  // Request: Effective Income
  on(FeatureEvents.REQUEST_EFFECTIVE_INCOME, (data: any) => {
    const { month } = data.payload || {};
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const result = getEffectiveIncome(month);
      emit(responseEvent, { type: FeatureEvents.REQUEST_EFFECTIVE_INCOME, result });
    }
  });

  // Request: Totals
  on(FeatureEvents.REQUEST_TOTALS, (data: any) => {
    const { transactions } = data.payload || {};
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const result = calcTotals(transactions);
      emit(responseEvent, { type: FeatureEvents.REQUEST_TOTALS, result });
    }
  });
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
  const firstDate = sorted[0]?.date;
  const lastDate = sorted[sorted.length - 1]?.date;

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
