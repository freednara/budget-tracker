/**
 * Transaction Domain Service
 * Pure business logic for transaction calculations. No side effects.
 *
 * All functions are pure: they take data as parameters and return results.
 * No signal access, no event emission, no DOM, no storage.
 *
 * @module domain/transaction-service
 */
'use strict';

import { toCents, toDollars, sumByType } from '../core/utils-pure.js';
import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';

// ==========================================
// TYPES
// ==========================================

export interface MonthlyTotals {
  income: number;
  expenses: number;
  balance: number;
  categoryTotals: Record<string, number>;
}

export interface DailyAllowanceResult {
  amount: number;
  daysRemaining: number;
  spentToday: number;
  isOverBudget: boolean;
  paceStatus: 'under' | 'on-track' | 'over';
}

export interface VelocityResult {
  dailyRate: number;
  projected: number;
  actual: number;
}

export interface SpendingPaceResult {
  pace: number;
  status: 'under' | 'on-track' | 'over';
  percentUsed: number;
}

export interface YearStatsResult {
  income: number;
  expenses: number;
  net: number;
  savingsRate: number;
  topCategories: Array<{ id: string; amount: number }>;
  transactionCount: number;
}

export interface AllTimeStatsResult {
  firstDate: string;
  lastDate: string;
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  transactionCount: number;
}

/** Minimal transaction shape required by domain functions */
export interface TransactionInput {
  type: string;
  amount: number;
  category: string;
  date: string;
}

// ==========================================
// TOTALS CALCULATIONS
// ==========================================

/**
 * Calculate monthly totals from a filtered set of transactions.
 * Pure function — no side effects.
 */
export function calculateMonthTotals(
  transactions: ReadonlyArray<TransactionInput>,
  month: string
): MonthlyTotals {
  let incomeCents = 0;
  let expensesCents = 0;
  const categoryTotalsCents: Record<string, number> = {};

  for (const tx of transactions) {
    if (tx.date.substring(0, 7) !== month) continue;
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') {
      incomeCents += amtCents;
    } else if (isTrackedExpenseTransaction(tx as TransactionInput & { tags?: string; notes?: string; description?: string })) {
      expensesCents += amtCents;
      categoryTotalsCents[tx.category] = (categoryTotalsCents[tx.category] || 0) + amtCents;
    }
  }

  // Convert category totals back to dollars
  const categoryTotals: Record<string, number> = {};
  for (const [cat, cents] of Object.entries(categoryTotalsCents)) {
    categoryTotals[cat] = toDollars(cents);
  }

  return {
    income: toDollars(incomeCents),
    expenses: toDollars(expensesCents),
    balance: toDollars(incomeCents - expensesCents),
    categoryTotals
  };
}

/**
 * Calculate totals from a transaction list (any month).
 * Uses integer math (cents) to avoid floating-point errors.
 */
export function calculateTotals(
  transactions: ReadonlyArray<TransactionInput>
): { income: number; expenses: number; balance: number } {
  let incomeCents = 0;
  let expensesCents = 0;

  for (const tx of transactions) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') incomeCents += amtCents;
    else if (isTrackedExpenseTransaction(tx as TransactionInput & { tags?: string; notes?: string; description?: string })) expensesCents += amtCents;
  }

  return {
    income: toDollars(incomeCents),
    expenses: toDollars(expensesCents),
    balance: toDollars(incomeCents - expensesCents)
  };
}

// ==========================================
// DAILY ALLOWANCE
// ==========================================

/**
 * Calculate daily spending allowance.
 * Pure function — takes pre-computed budget/expense data as input.
 */
export function calculateDailyAllowance(
  monthlyIncome: number,
  monthlyExpenses: number,
  totalAllocated: number,
  daysRemaining: number,
  rolloverAmount: number = 0
): number {
  if (daysRemaining <= 0) return 0;
  const availableCents = toCents(totalAllocated) + toCents(rolloverAmount) - toCents(monthlyExpenses);
  return toDollars(Math.max(0, Math.floor(availableCents / daysRemaining)));
}

// ==========================================
// SPENDING PACE
// ==========================================

/**
 * Determine spending pace relative to budget.
 * Returns pace ratio, status label, and percentage used.
 */
export function calculateSpendingPace(
  expenses: number,
  budget: number,
  dayOfMonth: number,
  daysInMonth: number
): SpendingPaceResult {
  if (budget <= 0) return { pace: 0, status: 'over', percentUsed: 100 };

  const expectedProportion = dayOfMonth / daysInMonth;
  const actualProportion = expenses / budget;
  const pace = expectedProportion > 0 ? actualProportion / expectedProportion : 0;
  const percentUsed = (expenses / budget) * 100;

  let status: 'under' | 'on-track' | 'over';
  if (pace < 0.9) status = 'under';
  else if (pace <= 1.1) status = 'on-track';
  else status = 'over';

  return { pace, status, percentUsed };
}

// ==========================================
// SPENDING VELOCITY
// ==========================================

/**
 * Calculate spending velocity (daily rate, projected total, actual).
 * Pure function — accepts transactions and reference date.
 */
export function calculateVelocity(
  transactions: ReadonlyArray<TransactionInput>,
  currentMonth: string,
  referenceDate: Date
): VelocityResult {
  const [yearStr, monthStr] = currentMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const isCurrentMonth =
    referenceDate.getFullYear() === year &&
    referenceDate.getMonth() + 1 === month;

  const daysInMonth = new Date(year, month, 0).getDate();
  const daysElapsed = isCurrentMonth ? Math.max(1, referenceDate.getDate()) : daysInMonth;

  // Filter to the target month and sum expenses
  let expenseCents = 0;
  for (const tx of transactions) {
    if (tx.date && tx.date.substring(0, 7) === currentMonth && isTrackedExpenseTransaction(tx as TransactionInput & { tags?: string; notes?: string; description?: string })) {
      expenseCents += toCents(tx.amount);
    }
  }

  const actual = toDollars(expenseCents);
  const dailyRate = daysElapsed > 0 ? actual / daysElapsed : 0;

  return {
    dailyRate,
    projected: dailyRate * daysInMonth,
    actual
  };
}

// ==========================================
// SPLIT TRANSACTION VALIDATION
// ==========================================

/**
 * Validate split transaction amounts sum to original.
 * Uses integer cents to avoid floating-point errors.
 */
export function validateSplitAmounts(
  originalAmount: number,
  splitAmounts: number[]
): { valid: boolean; remainingCents: number } {
  const originalCents = toCents(originalAmount);
  const splitCents = splitAmounts.reduce((sum, amt) => sum + toCents(amt), 0);
  return {
    valid: splitCents === originalCents,
    remainingCents: originalCents - splitCents
  };
}

// ==========================================
// CATEGORY ANALYSIS
// ==========================================

/**
 * Get the top spending category from a category totals map.
 * Pure function — no signal access.
 */
export function getTopCategory(
  categoryTotals: Record<string, number>
): { category: string; amount: number } | null {
  let topCat = '';
  let topAmt = 0;
  for (const [cat, amt] of Object.entries(categoryTotals)) {
    if (amt > topAmt) {
      topCat = cat;
      topAmt = amt;
    }
  }
  return topCat ? { category: topCat, amount: topAmt } : null;
}

/**
 * Get top N spending categories sorted by amount descending.
 */
export function getTopCategories(
  categoryTotals: Record<string, number>,
  limit: number = 5
): Array<{ id: string; amount: number }> {
  return Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, amount]) => ({ id, amount }));
}

// ==========================================
// YEAR STATISTICS
// ==========================================

/**
 * Compute year-level statistics from a list of transactions.
 * Pure function — no cache, no signals.
 */
export function calculateYearStats(
  transactions: ReadonlyArray<TransactionInput>,
  year: string
): YearStatsResult {
  const yearTx = transactions.filter(tx => tx.date && tx.date.startsWith(year));

  let incomeCents = 0;
  let expensesCents = 0;
  const catTotalsCents: Record<string, number> = {};

  for (const tx of yearTx) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') {
      incomeCents += amtCents;
    } else if (tx.type === 'expense') {
      expensesCents += amtCents;
      catTotalsCents[tx.category] = (catTotalsCents[tx.category] || 0) + amtCents;
    }
  }

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  const net = toDollars(incomeCents - expensesCents);
  const savingsRate = income > 0 ? ((income - expenses) / income) * 100 : 0;

  const topCategories = Object.entries(catTotalsCents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, cents]) => ({ id, amount: toDollars(cents) }));

  return {
    income,
    expenses,
    net,
    savingsRate,
    topCategories,
    transactionCount: yearTx.length
  };
}

// ==========================================
// ALL-TIME STATISTICS
// ==========================================

/**
 * Compute all-time statistics across every transaction.
 * Pure function — no cache, no signals.
 */
export function calculateAllTimeStats(
  transactions: ReadonlyArray<TransactionInput>
): AllTimeStatsResult | null {
  const allTx = transactions.filter(tx => tx.date);
  if (!allTx.length) return null;

  const sorted = [...allTx].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = sorted[0].date;
  const lastDate = sorted[sorted.length - 1].date;

  let totalIncomeCents = 0;
  let totalExpensesCents = 0;

  for (const tx of allTx) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') totalIncomeCents += amtCents;
    else if (tx.type === 'expense') totalExpensesCents += amtCents;
  }

  const totalIncome = toDollars(totalIncomeCents);
  const totalExpenses = toDollars(totalExpensesCents);
  const netSavings = toDollars(totalIncomeCents - totalExpensesCents);
  const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;

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

// ==========================================
// PERCENTAGE UTILITIES
// ==========================================

/**
 * Calculate percentage change between two values.
 */
export function calculatePercentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}
