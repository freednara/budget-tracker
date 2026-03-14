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
 * Uses signals for reactive state access
 */
export function getMonthTx(mk: string = signals.currentMonth.value): Transaction[] {
  return signals.transactions.value.filter((t: Transaction) => t.date && getMonthKey(t.date) === mk);
}

/**
 * Get expense transactions for a specific month
 */
export function getMonthExpenses(mk: string = signals.currentMonth.value): Transaction[] {
  return getMonthTx(mk).filter((t: Transaction) => t.type === 'expense');
}

// ==========================================
// TOTALS CALCULATIONS
// ==========================================

/**
 * Calculate totals from a transaction list
 * Single-pass algorithm for optimal performance
 */
export function calcTotals(txList: Transaction[]): Totals {
  // Single pass: accumulate both income and expenses at once
  const result = txList.reduce((acc: TotalsAccumulator, tx: Transaction) => {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') acc.incomeCents += amtCents;
    else if (tx.type === 'expense') acc.expensesCents += amtCents;
    return acc;
  }, { incomeCents: 0, expensesCents: 0 });

  const income = toDollars(result.incomeCents);
  const expenses = toDollars(result.expensesCents);
  return { income, expenses, balance: income - expenses };
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
  return sumByType(getMonthTx(mk).filter((t: Transaction) => t.category === catId), 'expense');
}

/**
 * Calculate unallocated income (uses integer math)
 */
export function getUnassigned(mk: string): number {
  const income = getEffectiveIncome(mk);
  const alloc = signals.monthlyAlloc.value[mk] || {};
  const totalAllocCents = Object.values(alloc as Record<string, number>).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );
  const totalAlloc = toDollars(totalAllocCents);
  return income - totalAlloc;
}

// ==========================================
// VELOCITY & PACE CALCULATIONS
// ==========================================

/**
 * Calculate spending velocity
 */
export function calcVelocity(): VelocityData {
  const currentMk = signals.currentMonth.value;
  const viewDate = parseMonthKey(currentMk);
  const now = new Date();
  const isCurrentMonth = getMonthKey(now) === currentMk;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const daysElapsed = isCurrentMonth ? Math.max(1, now.getDate()) : daysInMonth;
  const monthExp = sumByType(getMonthTx(currentMk), 'expense');
  const dailyRate = daysElapsed > 0 ? monthExp / daysElapsed : 0;
  return { dailyRate, projected: dailyRate * daysInMonth, actual: monthExp };
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

  // Get total allocated budget for the month
  const alloc = signals.monthlyAlloc.value[mk] || {};
  const totalBudgetCents = Object.values(alloc as Record<string, number>).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );
  const totalBudget = toDollars(totalBudgetCents);

  // Get total spent
  const spentCents = toCents(sumByType(getMonthTx(mk), 'expense'));
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

  // Get total budget and spent
  const alloc = signals.monthlyAlloc.value[mk] || {};
  const totalBudgetCents = Object.values(alloc as Record<string, number>).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );

  if (totalBudgetCents === 0) {
    return { status: 'no-budget', percentOfBudget: 0, expectedPercent, difference: 0 };
  }

  const spentCents = toCents(sumByType(getMonthTx(mk), 'expense'));
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
 * Get top spending category (uses integer math)
 * Single-pass algorithm for optimal performance
 */
export function getTopCat(): TopCategoryResult | null {
  // Single pass: filter and accumulate category totals together
  const catsCents = getMonthTx().reduce((acc: Record<string, number>, t: Transaction) => {
    if (t.type === 'expense') {
      const amtCents = toCents(t.amount);
      acc[t.category] = (acc[t.category] || 0) + amtCents;
    }
    return acc;
  }, {});

  const sorted = Object.entries(catsCents).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? { ...getCatInfo('expense', sorted[0][0]), amount: toDollars(sorted[0][1]) } : null;
}

// ==========================================
// YEAR STATISTICS
// ==========================================

/**
 * Get comprehensive year statistics (uses integer math)
 * Single-pass algorithm for optimal performance
 */
export function getYearStats(year: string): YearStats {
  // Single pass: accumulate all stats at once
  const result = signals.transactions.value.reduce((acc: YearStatsAccumulator, tx: Transaction) => {
    // Skip transactions without dates or from different years
    if (!tx.date || !tx.date.startsWith(year)) return acc;

    acc.txCount++;
    const amtCents = toCents(tx.amount);
    const mk = getMonthKey(tx.date);

    // Initialize month data if needed
    if (!acc.monthlyDataCents[mk]) {
      acc.monthlyDataCents[mk] = { income: 0, expenses: 0 };
    }

    if (tx.type === 'income') {
      acc.incomeCents += amtCents;
      acc.monthlyDataCents[mk].income += amtCents;
    } else if (tx.type === 'expense') {
      acc.expensesCents += amtCents;
      acc.monthlyDataCents[mk].expenses += amtCents;
      // Track category totals
      acc.catTotalsCents[tx.category] = (acc.catTotalsCents[tx.category] || 0) + amtCents;
    }

    return acc;
  }, {
    incomeCents: 0,
    expensesCents: 0,
    catTotalsCents: {},
    monthlyDataCents: {},
    txCount: 0
  });

  // Convert cents to dollars
  const income = toDollars(result.incomeCents);
  const expenses = toDollars(result.expensesCents);
  const net = income - expenses;
  const savingsRate = income > 0 ? ((income - expenses) / income * 100) : 0;

  // Build top categories (convert cents to dollars)
  const topCategories: TopCategoryResult[] = Object.entries(result.catTotalsCents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([catId, cents]) => ({ ...getCatInfo('expense', catId), amount: toDollars(cents) }));

  // Convert monthly data cents to dollars
  const monthlyData: Record<string, { income: number; expenses: number }> = {};
  Object.entries(result.monthlyDataCents).forEach(([mk, data]) => {
    monthlyData[mk] = {
      income: toDollars(data.income),
      expenses: toDollars(data.expenses)
    };
  });

  const monthCount = Object.keys(monthlyData).length || 1;
  const avgMonthlyIncome = income / monthCount;
  const avgMonthlyExpenses = expenses / monthCount;

  return {
    year,
    income,
    expenses,
    net,
    savingsRate,
    topCategories,
    monthlyData,
    avgMonthlyIncome,
    avgMonthlyExpenses,
    txCount: result.txCount
  };
}

// ==========================================
// ALL-TIME STATISTICS
// ==========================================

/**
 * Get lifetime statistics across all transactions (uses integer math)
 * Single-pass algorithm for optimal performance
 */
export function getAllTimeStats(): AllTimeStats | null {
  // Single pass: accumulate all stats at once
  const result = signals.transactions.value.reduce((acc: AllTimeStatsAccumulator, tx: Transaction) => {
    // Skip transactions without dates
    if (!tx.date) return acc;

    acc.txCount++;
    const amtCents = toCents(tx.amount);
    const mk = getMonthKey(tx.date);
    const year = tx.date.substring(0, 4);

    // Track first and last dates
    if (!acc.firstDate || tx.date < acc.firstDate) acc.firstDate = tx.date;
    if (!acc.lastDate || tx.date > acc.lastDate) acc.lastDate = tx.date;

    // Track years
    acc.yearsSet.add(year);

    // Initialize month data if needed
    if (!acc.monthlyDataCents[mk]) {
      acc.monthlyDataCents[mk] = { income: 0, expenses: 0 };
    }

    if (tx.type === 'income') {
      acc.totalIncomeCents += amtCents;
      acc.monthlyDataCents[mk].income += amtCents;
    } else if (tx.type === 'expense') {
      acc.totalExpensesCents += amtCents;
      acc.monthlyDataCents[mk].expenses += amtCents;
    }

    return acc;
  }, {
    totalIncomeCents: 0,
    totalExpensesCents: 0,
    monthlyDataCents: {},
    yearsSet: new Set<string>(),
    firstDate: null,
    lastDate: null,
    txCount: 0
  });

  if (result.txCount === 0) return null;

  // Convert cents to dollars
  const totalIncome = toDollars(result.totalIncomeCents);
  const totalExpenses = toDollars(result.totalExpensesCents);
  const netSavings = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome * 100) : 0;

  // Convert monthly data and find best/worst months
  const monthlyData: Record<string, { income: number; expenses: number; net: number }> = {};
  let bestMonth: MonthBestWorst | null = null;
  let worstMonth: MonthBestWorst | null = null;

  Object.entries(result.monthlyDataCents).forEach(([mk, d]) => {
    const income = toDollars(d.income);
    const expenses = toDollars(d.expenses);
    const net = income - expenses;
    monthlyData[mk] = { income, expenses, net };

    // Track best month (highest net)
    if (!bestMonth || net > bestMonth.net) {
      bestMonth = { month: mk, income, expenses, net };
    }
    // Track worst month (highest expenses)
    if (!worstMonth || expenses > worstMonth.expenses) {
      worstMonth = { month: mk, income, expenses, net };
    }
  });

  const monthCount = Object.keys(monthlyData).length || 1;
  const avgMonthlySpend = totalExpenses / monthCount;

  // Convert years set to sorted array
  const years = [...result.yearsSet].sort().reverse();

  return {
    firstDate: result.firstDate!,
    lastDate: result.lastDate!,
    totalIncome,
    totalExpenses,
    netSavings,
    savingsRate,
    txCount: result.txCount,
    avgMonthlySpend,
    bestMonth,
    worstMonth,
    years
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
 * Single-pass algorithm for optimal performance
 */
export function getDetailedYearStats(year: string): Record<string, DetailedMonthData> {
  // Initialize all 12 months upfront (in cents for precision)
  const monthlyDataCents: Record<string, MonthlyDataCentsEntry> = {};
  for (let m = 1; m <= 12; m++) {
    const mk = `${year}-${String(m).padStart(2, '0')}`;
    monthlyDataCents[mk] = { income: 0, expenses: 0, categories: {} };
  }

  // Single pass: filter and accumulate in one operation
  signals.transactions.value.forEach((tx: Transaction) => {
    // Skip transactions without dates or from different years
    if (!tx.date || !tx.date.startsWith(year)) return;

    const mk = getMonthKey(tx.date);
    if (!monthlyDataCents[mk]) return;

    const amountCents = toCents(tx.amount);
    if (tx.type === 'income') {
      monthlyDataCents[mk].income += amountCents;
    } else if (tx.type === 'expense') {
      monthlyDataCents[mk].expenses += amountCents;
      monthlyDataCents[mk].categories[tx.category] = (monthlyDataCents[mk].categories[tx.category] || 0) + amountCents;
    }
  });

  // Convert cents to dollars for return
  const monthlyData: Record<string, DetailedMonthData> = {};
  Object.entries(monthlyDataCents).forEach(([mk, data]) => {
    const income = toDollars(data.income);
    const expenses = toDollars(data.expenses);
    const categories: Record<string, number> = {};
    Object.entries(data.categories).forEach(([cat, cents]) => {
      categories[cat] = toDollars(cents);
    });
    monthlyData[mk] = {
      income,
      expenses,
      net: income - expenses,
      categories
    };
  });
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
  const monthExp = sumByType(monthTx, 'expense');
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
    .filter(t => t.type === 'expense')
    .reduce((s, t) => s + toCents(t.amount), 0);

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  const net = toDollars(incomeCents - expensesCents);
  const savingsRate = income > 0 ? ((income - expenses) / income * 100) : 0;

  // Category breakdown for expenses (also using cents)
  const catTotalsCents: Record<string, number> = {};
  yearTx.filter(t => t.type === 'expense').forEach(t => {
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
    .filter(t => t.type === 'expense')
    .reduce((s, t) => s + toCents(t.amount), 0);

  const totalIncome = toDollars(totalIncomeCents);
  const totalExpenses = toDollars(totalExpensesCents);
  const netSavings = toDollars(totalIncomeCents - totalExpensesCents);
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome * 100) : 0;

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
