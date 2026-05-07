/**
 * Seasonal Analysis Module
 * 
 * Handles seasonal spending pattern analysis and insights
 */

import * as signals from '../../core/signals.js';
import { parseLocalDate, toCents, toDollars, getSeason } from '../../core/utils-pure.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { Events, on } from '../../core/event-bus.js';
import type {
  SeasonalPattern,
  SeasonalInsight,
  SeasonalPatternData
} from '../../../types/index.js';

// Module-level cache for category info lookups (persists across calls)
const catInfoCache = new Map<string, ReturnType<typeof getCatInfo>>();

// Round 7 fix: Subscribe to category updates and clear cache on changes
let _isInitialized = false;

function initCacheInvalidation(): void {
  if (_isInitialized) return;
  _isInitialized = true;
  on(Events.CATEGORY_UPDATED, () => {
    catInfoCache.clear();
  });
}

function getCatInfoCached(catId: string): ReturnType<typeof getCatInfo> {
  let info = catInfoCache.get(catId);
  if (!info) {
    info = getCatInfo('expense', catId);
    catInfoCache.set(catId, info);
  }
  return info;
}

/**
 * Analyze seasonal spending patterns
 */
export function analyzeSeasonalPatterns(period: string = 'all-time'): SeasonalPatternData {
  // Round 7 fix: Initialize cache invalidation listener on first call
  initCacheInvalidation();

  const transactions = signals.transactions.value;
  
  // Group transactions by season (accumulate in cents to avoid floating-point drift)
  // Phase 6 Slice 1i (rev 12 L6): typed with a `Record` over the
  // fixed season union so `seasonalCents[season]` returns the bucket
  // directly (not `T | undefined`) under `noUncheckedIndexedAccess`.
  type Season = 'winter' | 'spring' | 'summer' | 'autumn';
  type SeasonBucket = { totalCents: number; count: number; categoryCents: { [cat: string]: number } };
  const seasonalCents: Record<Season, SeasonBucket> = {
    winter: { totalCents: 0, count: 0, categoryCents: {} },
    spring: { totalCents: 0, count: 0, categoryCents: {} },
    summer: { totalCents: 0, count: 0, categoryCents: {} },
    autumn: { totalCents: 0, count: 0, categoryCents: {} }
  };

  // Process transactions
  for (const tx of transactions) {
    if (!isTrackedExpenseTransaction(tx)) continue;

    const date = parseLocalDate(tx.date);
    if (period !== 'all-time' && date.getFullYear() !== parseInt(period, 10)) continue;

    const season = getSeason(date) as Season;
    const amtCents = toCents(tx.amount);

    seasonalCents[season].totalCents += amtCents;
    seasonalCents[season].count += 1;

    if (!seasonalCents[season].categoryCents[tx.category]) {
      seasonalCents[season].categoryCents[tx.category] = 0;
    }
    // `categoryCents` entry guaranteed above
    seasonalCents[season].categoryCents[tx.category] = (seasonalCents[season].categoryCents[tx.category] ?? 0) + amtCents;
  }

  // Convert cents to dollars for the display structure
  type SeasonDisplay = { total: number; count: number; categories: { [cat: string]: number } };
  const seasonalData: Record<Season, SeasonDisplay> = {
    winter: { total: 0, count: 0, categories: {} },
    spring: { total: 0, count: 0, categories: {} },
    summer: { total: 0, count: 0, categories: {} },
    autumn: { total: 0, count: 0, categories: {} }
  };
  for (const season of ['winter', 'spring', 'summer', 'autumn'] as const) {
    const data = seasonalCents[season];
    const categories: { [cat: string]: number } = {};
    for (const [cat, cents] of Object.entries(data.categoryCents)) {
      categories[cat] = toDollars(cents);
    }
    seasonalData[season] = { total: toDollars(data.totalCents), count: data.count, categories };
  }

  // Calculate patterns (uses module-level catInfoCache for cross-call persistence)
  const patterns: SeasonalPattern[] = [];
  const seasons: Season[] = ['winter', 'spring', 'summer', 'autumn'];

  for (const season of seasons) {
    const data = seasonalData[season];
    const avgAmount = data.count > 0 ? data.total / data.count : 0;

    // Find top categories for this season
    const topCategories = Object.entries(data.categories)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([catId, amount]) => ({
        category: getCatInfoCached(catId),
        amount,
        percentage: data.total > 0 ? (amount / data.total) * 100 : 0
      }));

    patterns.push({
      season,
      totalSpent: data.total,
      averageTransaction: avgAmount,
      transactionCount: data.count,
      topCategories
    });
  }

  // Generate insights
  const insights = generateSeasonalInsights(patterns);

  return { patterns, insights };
}

// getSeason imported from utils (shared utility)

/**
 * Generate insights from seasonal patterns
 */
function generateSeasonalInsights(patterns: SeasonalPattern[]): SeasonalInsight[] {
  const insights: SeasonalInsight[] = [];
  
  // Find highest and lowest spending seasons
  const sortedBySpending = [...patterns].sort((a, b) => b.totalSpent - a.totalSpent);
  
  if (sortedBySpending.length >= 2) {
    // Phase 6 Slice 1i (rev 12 L6): length check above guarantees
    // both ends are present — guard anyway so the types narrow.
    const highest = sortedBySpending[0];
    const lowest = sortedBySpending[sortedBySpending.length - 1];

    // Design-Review-Apr21 batch 7 (7a): require at least two seasons with
    // real spend before declaring a "high season". Without this guard a
    // user with only one active season (e.g. just started tracking in
    // winter) saw "Winter is your highest spending season" not because it
    // genuinely was, but because every other season totaled $0 and the
    // `> lowest * 1.2` test was vacuously true against zero. Counting
    // non-zero seasons makes the claim earn its keep.
    const nonZeroSeasonCount = patterns.filter(p => p.totalSpent > 0).length;

    if (
      nonZeroSeasonCount >= 2 &&
      highest && lowest &&
      highest.totalSpent > lowest.totalSpent * 1.2
    ) {
      insights.push({
        type: 'high-season',
        season: highest.season,
        message: `${capitalize(highest.season)} is your highest spending season`,
        amount: highest.totalSpent,
        comparison: highest.totalSpent - lowest.totalSpent
      });
    }
  }

  // Find seasonal category patterns
  for (const pattern of patterns) {
    if (pattern.topCategories.length > 0) {
      const topCategory = pattern.topCategories[0];
      if (topCategory && topCategory.percentage > 40) {
        insights.push({
          type: 'category-dominant',
          season: pattern.season,
          message: `${topCategory.category.name} dominates your ${pattern.season} spending`,
          amount: topCategory.amount,
          category: topCategory.category.id
        });
      }
    }
  }

  return insights;
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
