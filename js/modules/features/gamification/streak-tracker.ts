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

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getTodayStr, parseLocalDate, formatDateForInput } from '../../core/utils-pure.js';
import DOM from '../../core/dom-cache.js';
import { on, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
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

let streakListenerGroupId: string | null = null;

export function cleanupStreakTracker(): void {
  if (streakListenerGroupId) {
    destroyListenerGroup(streakListenerGroupId);
    streakListenerGroupId = null;
  }
}

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

// Phase 5g-1 (Inline-Behavior-Review rev 12, L22 part 1): removed the
// exported `invalidateTxDatesCache()` function. Grep across js/ confirms
// zero callers — the cache-invalidation invariant is already satisfied by
// the codebase-wide immutable-update discipline (`signals.transactions.value`
// is always assigned a *new* array on mutation; the existing
// `txRef === transactions` identity check in the cache sees the new
// reference and rebuilds). Exposing the function without a caller was an
// affordance trap: it advertised an API contract the rest of the codebase
// silently doesn't honor, and a future contributor dutifully wiring it up
// in an in-place-mutation code path would be a regression vector.
//
// Phase 5g-3 Slice 3 (Inline-Behavior-Review rev 12, L22 part 2): the
// three inline `${y}-${MM}-${DD}` compositions at getYesterday(),
// getDateSequence(), and calculateCurrentStreak()'s streak-walk loop
// were converged onto `formatDateForInput(date)` in utils-pure.ts —
// which already had the exact same body (direction reversal from the
// review's recommended `formatLocalDateStr` name; helper already
// existed under a different name, grep-verified in 15 existing call
// sites). Padding can no longer drift across call sites, and a single
// fix lands if timezone handling ever needs to change.

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
 * Calculate days between two date strings using timezone-safe logic.
 * Round 7 fix: Use YYYY-MM-DD string comparison to avoid DST boundary issues
 * that can occur with Math.round() on millisecond differences.
 */
function daysBetween(dateStr1: string, dateStr2: string): number {
  // Parse YYYY-MM-DD strings directly into [YYYY, MM, DD] components
  const parts1 = dateStr1.split('-').map(Number);
  const parts2 = dateStr2.split('-').map(Number);
  const y1 = parts1[0] ?? 0, m1 = parts1[1] ?? 1, d1 = parts1[2] ?? 1;
  const y2 = parts2[0] ?? 0, m2 = parts2[1] ?? 1, d2 = parts2[2] ?? 1;

  // Calculate difference in days using UTC to avoid DST boundary issues
  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);

  return Math.abs(Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24)));
}

/**
 * Get yesterday's date string using timezone-safe logic
 */
function getYesterday(): string {
  const today = parseLocalDate(getTodayStr());
  today.setDate(today.getDate() - 1);
  return formatDateForInput(today);
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
  const transactions = signals.transactions.value;

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
  // Phase 6 Slice 1i (rev 12 L6): `transactionDates[0]` is now
  // `string | undefined` under `noUncheckedIndexedAccess`. The
  // length check above guarantees presence, but narrow through a
  // `?? ''` default so downstream helpers see a concrete string.
  const mostRecentTxDate = transactionDates[0] ?? '';
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
    const prevDateStr = formatDateForInput(previousDate);

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
    // Phase 6 Slice 1i (rev 12 L6): loop bound guarantees both
    // indexes, but `transactionDates[n]` is `string | undefined` under
    // `noUncheckedIndexedAccess`. Skip any gap defensively.
    const prev = transactionDates[i - 1];
    const curr = transactionDates[i];
    if (prev === undefined || curr === undefined) continue;
    const daysDiff = daysBetween(prev, curr);
    
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
export function checkStreak(_txDate: string): void {
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
  const previousStreak = signals.streak.value;
  
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

  const streak = signals.streak.value;
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
  const transactions = signals.transactions.value;
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
    // Phase 6 Slice 1i (rev 12 L6): guard both ends; see the
    // matching loop in `getLongestStreak` for the rationale.
    const prev = sortedDates[i - 1];
    const curr = sortedDates[i];
    if (prev === undefined || curr === undefined) continue;
    const daysDiff = daysBetween(prev, curr);

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
  const transactions = signals.transactions.value;
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
  if (import.meta.env.DEV) {
    console.group('Streak Debug Information');
    console.log('Config:', streakConfig);
    console.log('Current Streak:', getStreakInfo());
    console.log('Statistics:', getStreakStats());
    console.log('Repair Info:', getStreakRepairInfo());

    const transactions = signals.transactions.value;
    const transactionDates = [...new Set(transactions.map(tx => tx.date))].sort();
    console.log('Transaction Dates:', transactionDates);
    console.groupEnd();
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize streak tracker module and register feature event listeners
 */
export function initStreakTracker(): void {
  cleanupStreakTracker();
  streakListenerGroupId = createListenerGroup('streak-tracker');

  // Action: Check streak
  on(FeatureEvents.CHECK_STREAK, () => {
    checkStreak(getTodayStr());
  }, { groupId: streakListenerGroupId });
}
