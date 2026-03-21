/**
 * Enhanced Streak Tracker Module
 *
 * Tracks daily logging streaks for gamification with:
 * - Timezone-safe date calculations  
 * - Grace period for catch-up logging
 * - Automatic streak decay
 * - Backfill support for historical transactions
 *
 * @module streak-tracker
 */
'use strict';

import { SK, persist, lsGet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getTodayStr, parseLocalDate } from '../../core/utils.js';
import DOM from '../../core/dom-cache.js';
import { on } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import type { StreakData, Transaction } from '../../../types/index.js';

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Streak configuration options
 */
interface StreakConfig {
  gracePeriodDays: number;     // Days to allow backfill
  maxBackfillDays: number;     // Maximum days to look back for backfill
  enableBackfill: boolean;     // Allow streak repair via historical transactions
}

const DEFAULT_CONFIG: StreakConfig = {
  gracePeriodDays: 2,          // Allow 2-day grace period
  maxBackfillDays: 7,          // Look back up to 1 week
  enableBackfill: true         // Enable backfill by default
};

let streakConfig = DEFAULT_CONFIG;

// Module-level cache for deduplicated transaction dates
// Invalidated when transactions change (different length or different last date)
let txDatesCache: {
  txRef: Transaction[];
  sortedAsc: string[];
  sortedDesc: string[];
  dateSet: Set<string>;
} | null = null;

function getTransactionDates(transactions: Transaction[]): { sortedAsc: string[]; sortedDesc: string[]; dateSet: Set<string> } {
  // Cache by reference identity — signals return new array on change
  if (txDatesCache && txDatesCache.txRef === transactions) {
    return txDatesCache;
  }
  const dateSet = new Set(transactions.map(tx => tx.date));
  const sortedAsc = [...dateSet].sort();
  const sortedDesc = [...sortedAsc].reverse();
  txDatesCache = { txRef: transactions, sortedAsc, sortedDesc, dateSet };
  return txDatesCache;
}

/**
 * Invalidate the transaction dates cache (call when transactions change)
 */
export function invalidateTxDatesCache(): void {
  txDatesCache = null;
}

/**
 * Configure streak settings
 */
export function setStreakConfig(config: Partial<StreakConfig>): void {
  streakConfig = { ...DEFAULT_CONFIG, ...config };
}

// ==========================================
// TIMEZONE-SAFE DATE UTILITIES
// ==========================================

/**
 * Calculate days between two date strings using timezone-safe logic
 * Uses noon-to-noon comparison to avoid DST issues
 */
function daysBetween(dateStr1: string, dateStr2: string): number {
  const date1 = parseLocalDate(dateStr1); // Parse as local date
  const date2 = parseLocalDate(dateStr2);
  
  // Set both to noon to avoid DST issues
  date1.setHours(12, 0, 0, 0);
  date2.setHours(12, 0, 0, 0);
  
  const diffTime = Math.abs(date2.getTime() - date1.getTime());
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Get yesterday's date string using timezone-safe logic
 */
function getYesterday(): string {
  const today = parseLocalDate(getTodayStr());
  today.setDate(today.getDate() - 1);
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

/**
 * Generate consecutive date sequence between two dates
 */
function getDateSequence(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  
  while (current <= end) {
    dates.push(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`);
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

// ==========================================
// STREAK CALCULATION
// ==========================================

/**
 * Calculate current streak based on transaction history
 * Supports backfill and grace periods
 */
export function calculateCurrentStreak(): StreakData {
  const today = getTodayStr();
  const yesterday = getYesterday();
  const transactions = signals.transactions.value as Transaction[];

  // Get cached deduplicated transaction dates
  const { sortedDesc: transactionDates, dateSet: txDateSet } = getTransactionDates(transactions);

  if (transactionDates.length === 0) {
    return {
      current: 0,
      longest: 0,
      lastDate: ''
    };
  }
  
  // Start streak calculation from today or most recent transaction date
  const mostRecentTxDate = transactionDates[0];
  let streakCount = 0;
  let streakEndDate = '';
  
  // Check if user logged today
  if (txDateSet.has(today)) {
    streakCount = 1;
    streakEndDate = today;
  } else if (streakConfig.enableBackfill && txDateSet.has(yesterday)) {
    // Grace period: if they logged yesterday, start streak from yesterday
    streakCount = 1;
    streakEndDate = yesterday;
  } else {
    // No recent activity - check for grace period
    const daysSinceLastTx = daysBetween(mostRecentTxDate, today);
    
    if (daysSinceLastTx <= streakConfig.gracePeriodDays) {
      // Within grace period - start streak from most recent transaction
      streakCount = 1;
      streakEndDate = mostRecentTxDate;
    } else {
      // Outside grace period - no current streak
      return {
        current: 0,
        longest: getLongestStreak(transactions),
        lastDate: mostRecentTxDate
      };
    }
  }
  
  // Build consecutive streak backwards from streak end date
  // Use total unique transaction dates as upper bound (not maxBackfillDays which is for grace periods)
  let currentDate = streakEndDate;
  const maxStreak = transactionDates.length;

  for (let i = 1; i <= maxStreak; i++) {
    const previousDate = parseLocalDate(currentDate);
    previousDate.setDate(previousDate.getDate() - 1);
    const prevDateStr = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, '0')}-${String(previousDate.getDate()).padStart(2, '0')}`;

    if (txDateSet.has(prevDateStr)) {
      streakCount++;
      currentDate = prevDateStr;
    } else {
      break; // Streak broken
    }
  }
  
  return {
    current: streakCount,
    longest: Math.max(streakCount, getLongestStreak(transactions)),
    lastDate: streakEndDate
  };
}

/**
 * Calculate the longest historical streak
 */
function getLongestStreak(transactions: Transaction[]): number {
  const { sortedAsc: transactionDates } = getTransactionDates(transactions);
  
  if (transactionDates.length === 0) return 0;
  
  let longestStreak = 1;
  let currentStreak = 1;
  
  for (let i = 1; i < transactionDates.length; i++) {
    const daysDiff = daysBetween(transactionDates[i - 1], transactionDates[i]);
    
    if (daysDiff === 1) {
      currentStreak++;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }
  
  return longestStreak;
}

/**
 * Update streak when a transaction is added
 * Supports both current-day and backfill scenarios
 */
export function checkStreak(txDate: string): void {
  // Recalculate streak based on current transaction data
  const newStreak = calculateCurrentStreak();
  
  // Update signals and persist
  signals.streak.value = newStreak;
  persist(SK.STREAK, newStreak);
  renderStreak();
  
  // Log streak update for debugging
  if (import.meta.env.DEV) console.log(`Streak updated: ${newStreak.current} days (longest: ${newStreak.longest})`);
}

/**
 * Force recalculate and update streak (called on app start)
 */
export function updateStreakOnStartup(): void {
  const currentStreak = calculateCurrentStreak();
  const previousStreak = signals.streak.value as StreakData;
  
  // Only update if streak has changed (to avoid unnecessary renders)
  if (
    currentStreak.current !== previousStreak.current ||
    currentStreak.longest !== previousStreak.longest ||
    currentStreak.lastDate !== previousStreak.lastDate
  ) {
    signals.streak.value = currentStreak;
    persist(SK.STREAK, currentStreak);
    renderStreak();
    
    if (import.meta.env.DEV) console.log(`Streak recalculated on startup: ${currentStreak.current} days`);
  }
}

/**
 * Render the enhanced streak widget UI
 */
export function renderStreak(): void {
  const widget = DOM.get('streak-widget');
  if (!widget) return;

  const streak = signals.streak.value as StreakData;
  const today = getTodayStr();
  const yesterday = getYesterday();

  if (streak.current > 0) {
    widget.classList.remove('hidden');
    
    // Update streak count
    const countEl = DOM.get('streak-count');
    if (countEl) countEl.textContent = String(streak.current);
    
    // Update streak description with status
    const descEl = DOM.get('streak-description');
    if (descEl) {
      let status = '';
      if (streak.lastDate === today) {
        status = 'Active today';
      } else if (streak.lastDate === yesterday) {
        status = 'Continue today';
      } else {
        const daysSince = daysBetween(streak.lastDate, today);
        status = `${daysSince} day${daysSince === 1 ? '' : 's'} ago`;
      }
      descEl.textContent = `${streak.current} day streak • ${status}`;
    }
    
    // Update longest streak display
    const longestEl = DOM.get('streak-longest');
    if (longestEl) {
      longestEl.textContent = `Best: ${streak.longest} days`;
    }
  } else {
    widget.classList.add('hidden');
  }
}

/**
 * Get current streak info with computed status
 */
export function getStreakInfo(): StreakData & { 
  status: 'active' | 'grace' | 'broken';
  daysUntilExpiry: number;
} {
  const streak = calculateCurrentStreak();
  const today = getTodayStr();
  const yesterday = getYesterday();
  
  let status: 'active' | 'grace' | 'broken' = 'broken';
  let daysUntilExpiry = 0;
  
  if (streak.current > 0) {
    if (streak.lastDate === today) {
      status = 'active';
    } else if (streak.lastDate === yesterday) {
      status = 'grace';
      daysUntilExpiry = streakConfig.gracePeriodDays - 1;
    } else {
      const daysSince = daysBetween(streak.lastDate, today);
      if (daysSince <= streakConfig.gracePeriodDays) {
        status = 'grace';
        daysUntilExpiry = streakConfig.gracePeriodDays - daysSince;
      } else {
        status = 'broken';
      }
    }
  }
  
  return {
    ...streak,
    status,
    daysUntilExpiry
  };
}

/**
 * Get streak statistics for analytics
 */
export function getStreakStats(): {
  current: number;
  longest: number;
  totalDaysWithTransactions: number;
  streakPercentage: number;
  averageStreakLength: number;
} {
  const transactions = signals.transactions.value as Transaction[];
  const transactionDates = [...new Set(transactions.map(tx => tx.date))];
  const totalDays = transactionDates.length;
  
  if (totalDays === 0) {
    return {
      current: 0,
      longest: 0,
      totalDaysWithTransactions: 0,
      streakPercentage: 0,
      averageStreakLength: 0
    };
  }
  
  // Calculate all streaks in history
  const sortedDates = transactionDates.sort();
  const streaks: number[] = [];
  let currentStreak = 1;
  
  for (let i = 1; i < sortedDates.length; i++) {
    const daysDiff = daysBetween(sortedDates[i - 1], sortedDates[i]);
    
    if (daysDiff === 1) {
      currentStreak++;
    } else {
      if (currentStreak > 1) streaks.push(currentStreak);
      currentStreak = 1;
    }
  }
  if (currentStreak > 1) streaks.push(currentStreak);
  
  const streakInfo = getStreakInfo();
  const averageStreakLength = streaks.length > 0 
    ? streaks.reduce((sum, streak) => sum + streak, 0) / streaks.length 
    : 1;
  
  return {
    current: streakInfo.current,
    longest: streakInfo.longest,
    totalDaysWithTransactions: totalDays,
    streakPercentage: streaks.length > 0 
      ? (streaks.reduce((sum, streak) => sum + streak, 0) / totalDays) * 100 
      : 0,
    averageStreakLength: Math.round(averageStreakLength * 10) / 10
  };
}

/**
 * Check if user can repair their streak by logging historical transactions
 */
export function getStreakRepairInfo(): {
  canRepair: boolean;
  missingDates: string[];
  potentialStreak: number;
} {
  if (!streakConfig.enableBackfill) {
    return { canRepair: false, missingDates: [], potentialStreak: 0 };
  }
  
  const today = getTodayStr();
  const transactions = signals.transactions.value as Transaction[];
  const transactionDates = new Set(transactions.map(tx => tx.date));
  
  // Look back from today to find potential streak
  const missingDates: string[] = [];
  let potentialStreak = transactionDates.has(today) ? 1 : 0;
  
  for (let i = 1; i <= streakConfig.maxBackfillDays; i++) {
    const checkDate = parseLocalDate(today);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
    
    if (transactionDates.has(dateStr)) {
      potentialStreak++;
    } else {
      // Found gap - check if it's within grace period
      if (i <= streakConfig.gracePeriodDays) {
        missingDates.push(dateStr);
      } else {
        break; // Too far back
      }
    }
  }
  
  return {
    canRepair: missingDates.length > 0 && potentialStreak > 0,
    missingDates: missingDates.reverse(), // Chronological order
    potentialStreak
  };
}

/**
 * Debug streak calculation (development/testing)
 */
export function debugStreak(): void {
  if (!import.meta.env.DEV) return;
  console.group('Streak Debug Information');
  console.log('Config:', streakConfig);
  console.log('Current Streak:', getStreakInfo());
  console.log('Statistics:', getStreakStats());
  console.log('Repair Info:', getStreakRepairInfo());

  const transactions = signals.transactions.value as Transaction[];
  const transactionDates = [...new Set(transactions.map(tx => tx.date))].sort();
  console.log('Transaction Dates:', transactionDates);
  console.groupEnd();
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize streak tracker module and register feature event listeners
 */
export function initStreakTracker(): void {
  // Action: Check streak
  on(FeatureEvents.CHECK_STREAK, () => {
    checkStreak(getTodayStr());
  });
}
