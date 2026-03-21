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
  getTrendingCategories,
  analyzeSpendingVelocity
} from '../features/analytics/trend-analysis.js';

// Re-export main functions for backwards compatibility
export {
  renderAnalyticsModal,
  getAnalyticsCurrentPeriod,
  setAnalyticsCurrentPeriod,
  analyzeSeasonalPatterns,
  calculateCategoryTrends,
  getTrendingCategories,
  analyzeSpendingVelocity
};

