/**
 * Trend Analysis Module
 * 
 * Handles trend calculations and velocity analysis
 */

import * as signals from '../../core/signals.js';
import { parseLocalDate, getMonthKey, getPrevMonthKey, toCents, toDollars, linearTrend } from '../../core/utils.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthTx, getMonthExpByCat } from '../financial/calculations.js';
import type {
  Transaction,
  CategoryTrendData,
  CategoryTrendsResult,
  TrendingCategoriesResult,
  CategoryTrendChange
} from '../../../types/index.js';

/**
 * Calculate category trends over time
 * FIXED: Optimized with monthly totals cache to avoid scanning all transactions repeatedly
 */
export function calculateCategoryTrends(months: number = 6, periodYear?: string): CategoryTrendsResult {
  const currentDate = new Date();
  const trends: CategoryTrendData[] = [];
  
  // 1. Get all months we need data for
  const monthKeys: string[] = [];
  if (periodYear && /^\d{4}$/.test(periodYear)) {
    for (let month = 1; month <= 12; month++) {
      monthKeys.push(`${periodYear}-${String(month).padStart(2, '0')}`);
    }
  } else {
    for (let i = 0; i < months; i++) {
      const targetDate = new Date(currentDate);
      targetDate.setMonth(targetDate.getMonth() - i);
      monthKeys.unshift(getMonthKey(targetDate));
    }
  }

  // 2. Pre-fetch totals for all months
  const monthlyTotals = monthKeys.map(mk => calculateMonthlyTotalsWithCacheSync(mk));
  
  // 3. Get unique categories across these months
  const categories = new Set<string>();
  monthlyTotals.forEach(totals => {
    Object.keys(totals.categoryTotals || {}).forEach(catId => categories.add(catId));
  });

  // 4. Calculate trends for each category
  for (const categoryId of Array.from(categories)) {
    const monthlyData = monthKeys.map((month, idx) => ({
      month,
      amount: (monthlyTotals[idx].categoryTotals || {})[categoryId] || 0
    }));

    // Calculate trend stats (simple linear regression)
    const trend = linearTrend(monthlyData.map(d => d.amount));
    const average = monthlyData.reduce((sum, d) => sum + d.amount, 0) / monthlyData.length;
    const recent = monthlyData.slice(-3).reduce((sum, d) => sum + d.amount, 0) / 3;
    const previous = monthlyData.slice(0, 3).reduce((sum, d) => sum + d.amount, 0) / 3;
    const totalSpend = monthlyData.reduce((sum, d) => sum + d.amount, 0);
    
    const category = getCatInfo('expense', categoryId);
    
    trends.push({
      category,
      monthlyData,
      totalSpend,
      trend: {
        direction: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable',
        slope: trend,
        strength: Math.abs(trend) / (average || 1) // Normalize by average
      },
      averageMonthly: average,
      recentAverage: recent,
      percentageChange: previous > 0 ? ((recent - previous) / previous) * 100 : 0
    });
  }

  // Sort by trend strength
  trends.sort((a, b) => Math.abs(b.trend.slope) - Math.abs(a.trend.slope));

  return { trends, periodMonths: months };
}

/**
 * Get trending categories (up or down)
 */
export function getTrendingCategories(months: number = 3, periodYear?: string): TrendingCategoriesResult {
  const trends = calculateCategoryTrends(periodYear && /^\d{4}$/.test(periodYear) ? 12 : months, periodYear);
  
  const increasing = trends.trends
    .filter(t => t.trend.direction === 'increasing' && t.percentageChange > 20)
    .sort((a, b) => b.percentageChange - a.percentageChange)
    .slice(0, 3);
    
  const decreasing = trends.trends
    .filter(t => t.trend.direction === 'decreasing' && t.percentageChange < -20)
    .sort((a, b) => a.percentageChange - b.percentageChange)
    .slice(0, 3);

  return { increasing, decreasing };
}

/**
 * Analyze spending velocity (rate of change)
 * FIXED: Optimized with single-pass aggregation
 */
export function analyzeSpendingVelocity(): {
  currentVelocity: number;
  previousVelocity: number;
  acceleration: number;
  interpretation: string;
} {
  const transactions = signals.transactions.value;
  const currentDate = new Date();
  
  // Calculate boundaries
  const weekStartDates = [7, 14, 21, 28].map(days => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - days);
    return d;
  });

  const weekExpensesCents = [0, 0, 0, 0]; // [week1, week2, week3, week4]

  // Single pass over transactions
  for (const tx of transactions) {
    if (!isTrackedExpenseTransaction(tx) || !tx.date) continue;
    
    const txDate = parseLocalDate(tx.date);
    const msDiff = currentDate.getTime() - txDate.getTime();
    const daysDiff = msDiff / 86400000;

    if (daysDiff <= 7) weekExpensesCents[0] += toCents(tx.amount);
    else if (daysDiff <= 14) weekExpensesCents[1] += toCents(tx.amount);
    else if (daysDiff <= 21) weekExpensesCents[2] += toCents(tx.amount);
    else if (daysDiff <= 28) weekExpensesCents[3] += toCents(tx.amount);
  }

  const weeks = weekExpensesCents.reverse().map(c => toDollars(c));

  // Calculate velocity (week-over-week change)
  const velocities: number[] = [];
  for (let i = 1; i < weeks.length; i++) {
    velocities.push(weeks[i] - weeks[i - 1]);
  }

  const currentVelocity = velocities[velocities.length - 1] || 0;
  const previousVelocity = velocities[velocities.length - 2] || 0;
  const acceleration = currentVelocity - previousVelocity;

  let interpretation = 'stable';
  if (Math.abs(acceleration) > 50) {
    interpretation = acceleration > 0 ? 'accelerating spending increase' : 'decelerating spending growth';
  } else if (Math.abs(currentVelocity) > 100) {
    interpretation = currentVelocity > 0 ? 'steady spending increase' : 'steady spending decrease';
  }

  return { currentVelocity, previousVelocity, acceleration, interpretation };
}

// linearTrend imported from utils (shared math utility)
