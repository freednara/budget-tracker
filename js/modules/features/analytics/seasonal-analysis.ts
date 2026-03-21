/**
 * Seasonal Analysis Module
 * 
 * Handles seasonal spending pattern analysis and insights
 */

import * as signals from '../../core/signals.js';
import { parseLocalDate, toCents, toDollars, getSeason } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import type {
  SeasonalPattern,
  SeasonalInsight,
  SeasonalPatternData
} from '../../../types/index.js';

// Module-level cache for category info lookups (persists across calls)
const catInfoCache = new Map<string, ReturnType<typeof getCatInfo>>();

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
  const transactions = signals.transactions.value;
  
  // Group transactions by season (accumulate in cents to avoid floating-point drift)
  const seasonalCents: { [season: string]: { totalCents: number; count: number; categoryCents: { [cat: string]: number } } } = {
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

    const season = getSeason(date);
    const amtCents = toCents(tx.amount);

    seasonalCents[season].totalCents += amtCents;
    seasonalCents[season].count += 1;

    if (!seasonalCents[season].categoryCents[tx.category]) {
      seasonalCents[season].categoryCents[tx.category] = 0;
    }
    seasonalCents[season].categoryCents[tx.category] += amtCents;
  }

  // Convert cents to dollars for the display structure
  const seasonalData: { [season: string]: { total: number; count: number; categories: { [cat: string]: number } } } = {};
  for (const [season, data] of Object.entries(seasonalCents)) {
    const categories: { [cat: string]: number } = {};
    for (const [cat, cents] of Object.entries(data.categoryCents)) {
      categories[cat] = toDollars(cents);
    }
    seasonalData[season] = { total: toDollars(data.totalCents), count: data.count, categories };
  }

  // Calculate patterns (uses module-level catInfoCache for cross-call persistence)
  const patterns: SeasonalPattern[] = [];
  const seasons = ['winter', 'spring', 'summer', 'autumn'];

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
      season: season as 'winter' | 'spring' | 'summer' | 'autumn',
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
    const highest = sortedBySpending[0];
    const lowest = sortedBySpending[sortedBySpending.length - 1];
    
    if (highest.totalSpent > lowest.totalSpent * 1.2) {
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
      if (topCategory.percentage > 40) {
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
