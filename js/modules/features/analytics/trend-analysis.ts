/**
 * Trend Analysis Module
 * 
 * Handles trend calculations and velocity analysis
 */

// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// `signals`, `parseLocalDate`, `isTrackedExpenseTransaction` imports
// dropped alongside the `analyzeSpendingVelocity` retirement — all three
// were exclusive callers of that retired function. Remaining surface
// uses `getMonthKey` / `getPrevMonthKey` / `toCents` / `toDollars` /
// `linearTrend` via `calculateCategoryTrends` and its helpers.
import { getMonthKey, getPrevMonthKey, toCents, toDollars, linearTrend } from '../../core/utils-pure.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only
// after the dead SHA-256 checksum machinery was removed.
import { calculateMonthlyTotalsWithCache } from '../../core/monthly-totals-cache.js';
import { getCatInfo } from '../../core/categories.js';
import { computeBaselineDelta } from '../../core/baseline.js';
import type {
  CategoryTrendData,
  CategoryTrendsResult,
  TrendingCategoriesResult
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
    // Fixes H11 (Inline-Behavior-Review rev 12): previous pattern used
    // `new Date()` → setMonth(getMonth() - i), which on a 31-day date
    // silently double-counts the current month and drops the prior one
    // (e.g. on May 31, walking back duplicates May and skips April).
    // getPrevMonthKey operates on YYYY-MM strings so month arithmetic is
    // always well-defined regardless of today's day-of-month.
    let mk = getMonthKey(currentDate);
    for (let i = 0; i < months; i++) {
      monthKeys.unshift(mk);
      mk = getPrevMonthKey(mk);
    }
  }

  // 2. Pre-fetch totals for all months
  const monthlyTotals = monthKeys.map(mk => calculateMonthlyTotalsWithCache(mk));
  
  // 3. Get unique categories across these months
  const categories = new Set<string>();
  monthlyTotals.forEach(totals => {
    Object.keys(totals.categoryTotals || {}).forEach(catId => categories.add(catId));
  });

  // 4. Calculate trends for each category
  for (const categoryId of Array.from(categories)) {
    const monthlyData = monthKeys.map((month, idx) => ({
      month,
      // Phase 6 Slice 1i (rev 12 L6): `monthlyTotals[idx]` is now
      // `MonthTotals | undefined` under `noUncheckedIndexedAccess`.
      // monthKeys and monthlyTotals are index-aligned by construction
      // — fall back to 0 for a missing month rather than crash.
      amount: (monthlyTotals[idx]?.categoryTotals || {})[categoryId] || 0
    }));

    // Calculate trend stats (simple linear regression)
    // rev 12 #16 (cents-math migration): accumulate in integer cents so the
    // `(recent - previous) / previous` percentageChange doesn't drift by a
    // trailing cent across 3-month windows. The published trend feeds the
    // trending-categories surface where a 0.01% false positive on a flat
    // month could flip a "Stable → Increasing" badge — sum-in-cents keeps
    // the comparison byte-accurate.
    //
    // 7a (Inline-Behavior-Review, Period/scope coherence): the recent-vs-
    // previous window is now **adaptive half-window** rather than a hard
    // `slice(-3)` / `slice(0, 3)` pair. On a 6-month view this is unchanged
    // (halfWindow = 3 → last 3 vs first 3). On a 12-month year-scoped view
    // the pre-fix `slice(-3)` / `slice(0, 3)` compared Q4 to Q1 and called
    // the Q4/Q1 seasonality a trend — the 10 months in between were
    // sum-ignored. Adaptive half-window collapses to H2 vs H1 for the
    // year view and generalizes cleanly for arbitrary window sizes.
    // `Math.max(1, ...)` guards the degenerate 1-month window (halfWindow
    // would otherwise be 0, which would zero-divide the averages below).
    const trend = linearTrend(monthlyData.map(d => d.amount));
    const sumAll = toDollars(monthlyData.reduce((sum, d) => sum + toCents(d.amount), 0));
    const halfWindow = Math.max(1, Math.floor(monthlyData.length / 2));
    const sumRecent = toDollars(monthlyData.slice(-halfWindow).reduce((sum, d) => sum + toCents(d.amount), 0));
    const sumPrevious = toDollars(monthlyData.slice(0, halfWindow).reduce((sum, d) => sum + toCents(d.amount), 0));
    const average = sumAll / monthlyData.length;
    const recent = sumRecent / halfWindow;
    const previous = sumPrevious / halfWindow;
    const totalSpend = sumAll;
    
    const category = getCatInfo('expense', categoryId);

    // Design-Review-Apr21 batch 7 (7a): route the recent-vs-previous
    // comparison through `computeBaselineDelta` so brand-new categories
    // (previous window empty) and truly flat categories don't both collapse
    // into `percentageChange: 0`. `baseline` carries the classification
    // ('comparable' | 'new' | 'no-data') for renderers that need it;
    // `percentageChange` is kept as a raw number so existing consumers
    // (`getTrendingCategories` filters `> 20` / `< -20`) stay unchanged.
    const baseline = computeBaselineDelta(recent, previous);

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
      percentageChange: baseline.percent ?? 0,
      baseline
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

// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// `analyzeSpendingVelocity` was retired via direction-reversal. The
// function computed a fixed "last 4 weeks from today" week-over-week
// velocity and previously carried the L21 paperwork-close — `periodLabel:
// 'Last 4 weeks'` was appended to its return shape so that any future
// caller could surface the fixed-scope label next to the analytics-modal
// year-scoped widgets. Pre-deletion grep (analytics-ui.ts + orchestration
// tree + chart-renderers.ts + tests) confirmed ZERO consumers — no UI
// render site ever called it, so the `periodLabel` contract advertised a
// shape the module never exercised. Same "unused API advertising a
// footgun contract" pattern that Phase 5 retired seven times (SAFE_MOCK,
// addRealtimeValidation, virtual-scroller trio, transaction-row-template
// trio, M21 compression branch, Phase 5g-4 Slice 2 inline-alert hosts,
// `sanitize()` + `validator.sanitizeText`): deletion is strictly better
// than maintenance because an unused API encourages future callers to
// adopt the semantics before they realize the rest of the analytics
// modal's period/scope story has moved on (adaptive half-window, scoped
// re-renders, trend-chart anchor, period persistence, months-tracked
// alignment all landed in this 7a arc). If a real recent-trend surface
// is later scoped, the callers-first path is: wire the analytics modal
// to the period selector first, then pick an anchor (end-of-period vs
// always-now) consciously, rather than reviving the retired skeleton.
// L20 (dead `weekStartDates` const) is now moot — the whole function
// retired, not just the residual. L21 (period-scope label contract) is
// also moot — no consumer, no label to surface.

// linearTrend imported from utils (shared math utility)
