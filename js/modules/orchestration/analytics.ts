/**
 * Analytics Module (Refactored)
 *
 * Main orchestration for analytics functionality.
 * Individual analysis modules are imported from /features/analytics/
 *
 * @module analytics
 */
'use strict';

// Import the new focused analytics modules
import { 
  renderAnalyticsModal,
  getAnalyticsCurrentPeriod,
  setAnalyticsCurrentPeriod
} from '../features/analytics/analytics-ui.js';

import { 
  analyzeSeasonalPatterns 
} from '../features/analytics/seasonal-analysis.js';

import {
  calculateCategoryTrends,
  getTrendingCategories
} from '../features/analytics/trend-analysis.js';

// 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
// `analyzeSpendingVelocity` removed from this re-export list alongside
// its retirement in `features/analytics/trend-analysis.ts`. Zero
// production/test consumers verified at deletion — the function was a
// vestigial public-surface entry that advertised a "recent-4-weeks
// velocity with period-scope label" contract no caller exercised.
// Direction-reversal per the Phase 5 durable pattern: deletion beats
// maintenance for unused-API footgun surfaces.

// Re-export main functions for backwards compatibility
export {
  renderAnalyticsModal,
  getAnalyticsCurrentPeriod,
  setAnalyticsCurrentPeriod,
  analyzeSeasonalPatterns,
  calculateCategoryTrends,
  getTrendingCategories
};

