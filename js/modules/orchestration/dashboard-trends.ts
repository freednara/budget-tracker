/**
 * Dashboard Trend Calculations
 * 
 * Trend analysis and comparison functions extracted from dashboard module.
 * 
 * @module dashboard-trends
 */

import * as signals from '../core/signals.js';
import { getMonthTx, calcTotals } from '../features/financial/calculations.js';
import { toCents, toDollars } from '../core/utils.js';
import { getMonthKey, getPrevMonthKey } from '../core/utils.js';
import DOM from '../core/dom-cache.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface TrendData {
  current: number;
  previous: number;
  change: number;
  percentChange: number;
  direction: 'up' | 'down' | 'neutral';
  improved: boolean;
}

export interface MonthComparison {
  income: TrendData;
  expenses: TrendData;
  savings: TrendData;
  netBalance: TrendData;
}

// ==========================================
// TREND CALCULATIONS
// ==========================================

/**
 * Calculate trend data for a metric
 */
export function calculateTrend(current: number, previous: number, lowerIsBetter = false): TrendData {
  const change = current - previous;
  const percentChange = previous !== 0 ? (change / Math.abs(previous)) * 100 : current !== 0 ? 100 : 0;
  
  let direction: TrendData['direction'];
  if (Math.abs(change) < 0.01) {
    direction = 'neutral';
  } else {
    direction = change > 0 ? 'up' : 'down';
  }
  
  const improved = lowerIsBetter ? change <= 0 : change >= 0;
  
  return {
    current,
    previous,
    change,
    percentChange,
    direction,
    improved
  };
}

/**
 * Get month-over-month comparison
 */
export function getMonthComparison(_transactions?: Transaction[]): MonthComparison {
  // Use the user's currently viewed month, not the calendar month
  const currentMonth = signals.currentMonth.value;
  const previousMonth = getPrevMonthKey(currentMonth);
  
  const currentTx = getMonthTx(currentMonth);
  const previousTx = getMonthTx(previousMonth);
  
  const currentTotals = calcTotals(currentTx);
  const previousTotals = calcTotals(previousTx);
  
  return {
    income: calculateTrend(currentTotals.income, previousTotals.income),
    expenses: calculateTrend(currentTotals.expenses, previousTotals.expenses, true),
    savings: calculateTrend(
      currentTotals.income - currentTotals.expenses,
      previousTotals.income - previousTotals.expenses
    ),
    netBalance: calculateTrend(
      currentTotals.income - currentTotals.expenses,
      previousTotals.income - previousTotals.expenses
    )
  };
}

/**
 * Update trend indicator showing % change vs previous month
 */
export function updateTrendIndicator(elId: string, trend: TrendData): void {
  const el = DOM.get(elId);
  if (!el || !(el instanceof HTMLElement)) return;
  
  const { percentChange, direction, improved } = trend;
  
  // Clear previous classes
  el.classList.remove('trend-up', 'trend-down', 'trend-neutral', 'trend-improved', 'trend-worse');
  
  // Add direction class
  el.classList.add(`trend-${direction}`);
  
  // Add improvement class
  el.classList.add(improved ? 'trend-improved' : 'trend-worse');
  
  // Update text
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  const sign = percentChange > 0 ? '+' : '';
  el.textContent = `${arrow} ${sign}${percentChange.toFixed(1)}%`;
  
  // Update ARIA label
  el.setAttribute('aria-label', 
    `${direction === 'neutral' ? 'No change' : `${direction} ${Math.abs(percentChange).toFixed(1)}%`} from last month`
  );
}

/**
 * Update all trend indicators on dashboard
 */
export function updateAllTrends(): void {
  const comparison = getMonthComparison();
  
  updateTrendIndicator('income-trend', comparison.income);
  updateTrendIndicator('expense-trend', comparison.expenses);
  updateTrendIndicator('savings-trend', comparison.savings);
  updateTrendIndicator('balance-trend', comparison.netBalance);
}

/**
 * Get trend summary text
 */
export function getTrendSummary(trend: TrendData, metricName: string): string {
  const { percentChange, direction, improved } = trend;
  
  if (direction === 'neutral') {
    return `${metricName} unchanged from last month`;
  }
  
  const changeText = `${Math.abs(percentChange).toFixed(1)}%`;
  const directionText = direction === 'up' ? 'increased' : 'decreased';
  const improvementText = improved ? 'improvement' : 'decline';
  
  return `${metricName} ${directionText} ${changeText} (${improvementText})`;
}

/**
 * Calculate year-to-date trends
 */
export function getYearToDateTrends(): {
  totalIncome: number;
  totalExpenses: number;
  totalSavings: number;
  averageMonthlyIncome: number;
  averageMonthlyExpenses: number;
  monthsWithProfit: number;
} {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();
  
  let totalIncomeCents = 0;
  let totalExpensesCents = 0;
  let monthsWithProfit = 0;
  let monthsProcessed = 0;

  for (let month = 0; month <= currentMonth; month++) {
    const monthKey = `${currentYear}-${String(month + 1).padStart(2, '0')}`;
    const monthTx = getMonthTx(monthKey);

    if (monthTx.length > 0) {
      const totals = calcTotals(monthTx);
      totalIncomeCents += toCents(totals.income);
      totalExpensesCents += toCents(totals.expenses);

      if (totals.income > totals.expenses) {
        monthsWithProfit++;
      }

      monthsProcessed++;
    }
  }

  const totalIncome = toDollars(totalIncomeCents);
  const totalExpenses = toDollars(totalExpensesCents);
  
  return {
    totalIncome,
    totalExpenses,
    totalSavings: toDollars(totalIncomeCents - totalExpensesCents),
    averageMonthlyIncome: monthsProcessed > 0 ? totalIncome / monthsProcessed : 0,
    averageMonthlyExpenses: monthsProcessed > 0 ? totalExpenses / monthsProcessed : 0,
    monthsWithProfit
  };
}