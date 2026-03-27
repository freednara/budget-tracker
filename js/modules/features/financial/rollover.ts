/**
 * Budget Rollover Module
 * Handles budget rollover calculations between months
 *
 * @module rollover
 * @requires state
 * @requires utils
 * @requires calculations
 */
'use strict';

import { SK, lsGet, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { settings } from '../../core/state-actions.js';
import { getPrevMonthKey, toCents, toDollars, getMonthKey } from '../../core/utils.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { on, emit, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents, type FeatureResponse } from '../../core/feature-event-interface.js';
import type {
  RolloverSettings,
  RolloverSummary,
  RolloverMode,
  NegativeHandling,
  Transaction
} from '../../../types/index.js';

// ==========================================
// DEFAULT SETTINGS
// ==========================================

/**
 * Default rollover settings
 */
export const DEFAULT_ROLLOVER_SETTINGS: RolloverSettings = {
  enabled: false,              // Disabled by default, users opt-in
  mode: 'all',                 // 'all' or 'selected'
  categories: [],              // Category IDs that should rollover (when mode='selected')
  maxRollover: null,           // Maximum rollover per category (null = unlimited)
  negativeHandling: 'zero'     // 'zero' (forgive), 'carry' (reduce next month), 'ignore'
};

// ==========================================
// SETTINGS MANAGEMENT
// ==========================================

/**
 * Check if rollover is enabled globally
 */
export function isRolloverEnabled(): boolean {
  return signals.rolloverSettings.value?.enabled === true;
}

/**
 * Check if rollover is enabled for a specific category
 */
export function isCategoryRolloverEnabled(categoryId: string): boolean {
  if (!isRolloverEnabled()) return false;

  const settings = signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS;

  if (settings.mode === 'all') {
    return true;
  }

  // Mode is 'selected'
  return settings.categories?.includes(categoryId) === true;
}

/**
 * Enable or disable rollover globally
 */
export function setRolloverEnabled(enabled: boolean): void {
  settings.setRolloverSettings({ enabled: enabled === true });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set rollover mode
 */
export function setRolloverMode(mode: RolloverMode): void {
  if (mode !== 'all' && mode !== 'selected') return;
  settings.setRolloverSettings({ mode });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set which categories should rollover (when mode='selected')
 */
export function setRolloverCategories(categoryIds: string[]): void {
  settings.setRolloverSettings({
    categories: Array.isArray(categoryIds) ? categoryIds : []
  });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Enable rollover for a specific category
 */
export function setCategoryRollover(categoryId: string, enabled: boolean): void {
  const currentSettings = signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS;
  const categories = new Set(currentSettings.categories || []);

  if (enabled) {
    categories.add(categoryId);
  } else {
    categories.delete(categoryId);
  }

  settings.setRolloverSettings({ categories: Array.from(categories) });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set maximum rollover amount per category
 */
export function setMaxRollover(max: number | null | undefined): void {
  settings.setRolloverSettings({
    maxRollover: max === null || max === undefined ? null : Math.max(0, parseFloat(String(max)) || 0)
  });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set how negative balances are handled
 */
export function setNegativeHandling(handling: NegativeHandling): void {
  if (!['zero', 'carry', 'ignore'].includes(handling)) return;
  settings.setRolloverSettings({ negativeHandling: handling });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Get current rollover settings
 */
export function getRolloverSettings(): RolloverSettings {
  return { ...DEFAULT_ROLLOVER_SETTINGS, ...(signals.rolloverSettings.value || {}) };
}

// ==========================================
// ROLLOVER CALCULATIONS
// ==========================================

/**
 * Calculate rollover amount from previous month for a category
 * Uses cents-based math to avoid floating-point errors
 * FIXED: Now accumulates across multiple months using cached totals for efficiency
 *
 * @returns Rollover amount in dollars (positive = surplus, negative = overspent)
 */
export function calculateRollover(categoryId: string, monthKey: string): number {
  if (!isCategoryRolloverEnabled(categoryId)) return 0;

  const settings = getRolloverSettings();
  
  // Find all relevant months chronologically
  const allMonthsWithAlloc = Object.keys(signals.monthlyAlloc.value).sort();
  const startMonth = allMonthsWithAlloc.find(mk => 
    signals.monthlyAlloc.value[mk]?.[categoryId] !== undefined
  );
  
  if (!startMonth || startMonth >= monthKey) return 0;

  let accumulatedCents = 0;
  
  for (const mk of allMonthsWithAlloc) {
    if (mk < startMonth) continue;
    if (mk >= monthKey) break;

    const monthAlloc = signals.monthlyAlloc.value[mk]?.[categoryId] || 0;
    const allocCents = toCents(monthAlloc);
    
    // OPTIMIZED: Use cached totals instead of manual calculation
    const totals = calculateMonthlyTotalsWithCacheSync(mk);
    const monthSpentCents = toCents((totals.categoryTotals || {})[categoryId] || 0);
    
    accumulatedCents += (allocCents - monthSpentCents);
    
    // Handle negative balances based on settings  
    if (accumulatedCents < 0 && settings.negativeHandling === 'zero') {
      accumulatedCents = 0;
    }
  }

  // Apply max rollover cap
  if (settings.maxRollover !== null && settings.maxRollover !== undefined) {
    const maxCents = toCents(settings.maxRollover);
    accumulatedCents = Math.max(-maxCents, Math.min(accumulatedCents, maxCents));
  }

  return toDollars(accumulatedCents);
}

/**
 * Get effective budget for a category (base allocation + rollover)
 */
export function getEffectiveBudget(categoryId: string, monthKey: string): number {
  const baseAlloc = signals.monthlyAlloc.value[monthKey]?.[categoryId] || 0;
  const rollover = calculateRollover(categoryId, monthKey);

  // Use cents-based addition for precision
  return toDollars(toCents(baseAlloc) + toCents(rollover));
}

/**
 * Calculate all rollovers for a month
 *
 * @returns Object mapping categoryId -> rollover amount
 */
export function calculateMonthRollovers(monthKey: string): Record<string, number> {
  const rollovers: Record<string, number> = {};
  const alloc = signals.monthlyAlloc.value[monthKey] || {};

  // Also check previous month's allocations in case user had budget there
  const prevMonthKey = getPrevMonthKey(monthKey);
  const prevAlloc = signals.monthlyAlloc.value[prevMonthKey] || {};

  // Get all unique category IDs from both months
  const categoryIds = new Set([
    ...Object.keys(alloc),
    ...Object.keys(prevAlloc)
  ]);

  categoryIds.forEach(catId => {
    const rollover = calculateRollover(catId, monthKey);
    if (rollover !== 0) {
      rollovers[catId] = rollover;
    }
  });

  return rollovers;
}

/**
 * Get total rollover amount for a month (sum of all category rollovers)
 */
export function getTotalRollover(monthKey: string): number {
  const rollovers = calculateMonthRollovers(monthKey);
  const totalCents = Object.values(rollovers).reduce(
    (sum, amt) => sum + toCents(amt),
    0
  );
  return toDollars(totalCents);
}

/**
 * Get rollover summary for display
 */
export function getRolloverSummary(monthKey: string): RolloverSummary {
  const rollovers = calculateMonthRollovers(monthKey);

  let positiveCents = 0;
  let negativeCents = 0;

  Object.values(rollovers).forEach(amt => {
    const cents = toCents(amt);
    if (cents > 0) {
      positiveCents += cents;
    } else {
      negativeCents += cents;
    }
  });

  return {
    positive: toDollars(positiveCents),      // Surplus from underspending
    negative: toDollars(negativeCents),       // Deficit from overspending
    net: toDollars(positiveCents + negativeCents),
    count: Object.keys(rollovers).length
  };
}

// ==========================================
// INITIALIZATION
// ==========================================

let rolloverListenerGroupId: string | null = null;

export function cleanupRollover(): void {
  if (rolloverListenerGroupId) {
    destroyListenerGroup(rolloverListenerGroupId);
    rolloverListenerGroupId = null;
  }
}

/**
 * Initialize rollover module
 * Loads settings from localStorage
 */
export function initRollover(): void {
  cleanupRollover();
  rolloverListenerGroupId = createListenerGroup('rollover');

  // Load settings from localStorage
  const savedSettings = lsGet(SK.ROLLOVER_SETTINGS, null) as RolloverSettings | null;
  settings.setRolloverSettings(savedSettings || { ...DEFAULT_ROLLOVER_SETTINGS });

  // Register Feature Event Listeners
  on(FeatureEvents.REQUEST_ROLLOVER_SETTINGS, (data?: { responseEvent?: string }) => {
    const responseEvent = data?.responseEvent || `${FeatureEvents.REQUEST_ROLLOVER_SETTINGS}:response`;
    const response: FeatureResponse<RolloverSettings> = {
      type: FeatureEvents.REQUEST_ROLLOVER_SETTINGS,
      result: getRolloverSettings()
    };
    emit(responseEvent, response);
  }, { groupId: rolloverListenerGroupId });

  on(FeatureEvents.UPDATE_ROLLOVER_SETTINGS, (settings: RolloverSettings) => {
    if (settings.enabled !== undefined) setRolloverEnabled(settings.enabled);
    if (settings.mode) setRolloverMode(settings.mode);
    if (settings.categories) setRolloverCategories(settings.categories);
    if (settings.maxRollover !== undefined) setMaxRollover(settings.maxRollover);
    if (settings.negativeHandling) setNegativeHandling(settings.negativeHandling);
  }, { groupId: rolloverListenerGroupId });
}

// ==========================================
// PURE FUNCTION EXPORTS FOR TESTING
// These accept state as parameters for testability
// ==========================================

/**
 * Test state interface - matches test mock structure
 */
export interface RolloverTestState {
  transactions: Transaction[];
  monthlyAllocations: Record<string, Record<string, number>>;
  rolloverSettings: RolloverSettings;
}

/**
 * Pure version of calculateRollover for testing
 * @param categoryId - Category to calculate rollover for
 * @param monthKey - Target month (YYYY-MM)
 * @param state - Test state with transactions, allocations, and settings
 */
export function calculateRolloverPure(
  categoryId: string,
  monthKey: string,
  state: RolloverTestState
): number {
  if (!state.rolloverSettings.enabled) return 0;

  // Check mode and category inclusion
  if (state.rolloverSettings.mode === 'selected' &&
      !state.rolloverSettings.categories.includes(categoryId)) {
    return 0;
  }

  // Get previous month
  const prevMonthKey = getPrevMonthKey(monthKey);

  // Get budget for previous month
  const prevAlloc = state.monthlyAllocations[prevMonthKey] || {};
  const budgetCents = toCents(prevAlloc[categoryId] || 0);
  if (budgetCents === 0) return 0;

  // Get spending for previous month (filter transactions)
  const prevTx = state.transactions.filter(tx =>
    tx.date && tx.date.startsWith(prevMonthKey) &&
    tx.type === 'expense' &&
    tx.category === categoryId
  );
  const spentCents = prevTx.reduce((sum, tx) => sum + toCents(tx.amount), 0);

  // Calculate unspent
  const unspentCents = budgetCents - spentCents;

  // Handle negative
  if (unspentCents < 0) {
    switch (state.rolloverSettings.negativeHandling) {
      case 'zero':
        return 0;
      case 'carry':
        // Carry forward negative (reduces next month's budget)
        break;
      case 'ignore':
        // Let the negative amount pass through unchanged (don't interfere)
        break;
    }
  }

  // Apply max cap
  if (state.rolloverSettings.maxRollover !== null && state.rolloverSettings.maxRollover !== undefined) {
    const maxCents = toCents(state.rolloverSettings.maxRollover);
    if (unspentCents > 0) {
      return toDollars(Math.min(unspentCents, maxCents));
    }
    if (unspentCents < 0) {
      return toDollars(Math.max(unspentCents, -maxCents));
    }
  }

  return toDollars(unspentCents);
}

/**
 * Pure version of getEffectiveBudget for testing
 * @param categoryId - Category ID
 * @param monthKey - Target month
 * @param baseBudget - Base budget allocation for the month
 * @param state - Test state
 */
export function getEffectiveBudgetPure(
  categoryId: string,
  monthKey: string,
  baseBudget: number,
  state: RolloverTestState
): number {
  const rollover = calculateRolloverPure(categoryId, monthKey, state);
  return toDollars(toCents(baseBudget) + toCents(rollover));
}

/**
 * Pure version of calculateMonthRollovers for testing
 * @param monthKey - Target month
 * @param categories - List of category IDs to calculate
 * @param state - Test state
 */
export function calculateMonthRolloversPure(
  monthKey: string,
  categories: string[],
  state: RolloverTestState
): { byCategory: Record<string, number>; total: number } {
  const rollovers: Record<string, number> = {};
  let totalCents = 0;

  for (const catId of categories) {
    const rollover = calculateRolloverPure(catId, monthKey, state);
    if (rollover !== 0) {
      rollovers[catId] = rollover;
      totalCents += toCents(rollover);
    }
  }

  return {
    byCategory: rollovers,
    total: toDollars(totalCents)
  };
}
