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
import { getPrevMonthKey, toCents, toDollars } from '../../core/utils.js';
import { getMonthExpByCat } from './calculations.js';
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
  signals.rolloverSettings.value = {
    ...(signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS),
    enabled: enabled === true
  };
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set rollover mode
 */
export function setRolloverMode(mode: RolloverMode): void {
  if (mode !== 'all' && mode !== 'selected') return;

  signals.rolloverSettings.value = {
    ...(signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS),
    mode
  };
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set which categories should rollover (when mode='selected')
 */
export function setRolloverCategories(categoryIds: string[]): void {
  signals.rolloverSettings.value = {
    ...(signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS),
    categories: Array.isArray(categoryIds) ? categoryIds : []
  };
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Enable rollover for a specific category
 */
export function setCategoryRollover(categoryId: string, enabled: boolean): void {
  const settings = signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS;
  const categories = new Set(settings.categories || []);

  if (enabled) {
    categories.add(categoryId);
  } else {
    categories.delete(categoryId);
  }

  signals.rolloverSettings.value = {
    ...settings,
    categories: Array.from(categories)
  };
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set maximum rollover amount per category
 */
export function setMaxRollover(max: number | null | undefined): void {
  signals.rolloverSettings.value = {
    ...(signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS),
    maxRollover: max === null || max === undefined ? null : Math.max(0, parseFloat(String(max)) || 0)
  };
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
}

/**
 * Set how negative balances are handled
 */
export function setNegativeHandling(handling: NegativeHandling): void {
  if (!['zero', 'carry', 'ignore'].includes(handling)) return;

  signals.rolloverSettings.value = {
    ...(signals.rolloverSettings.value || DEFAULT_ROLLOVER_SETTINGS),
    negativeHandling: handling
  };
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
 *
 * @returns Rollover amount in dollars (positive = surplus, negative = overspent)
 */
export function calculateRollover(categoryId: string, monthKey: string): number {
  if (!isCategoryRolloverEnabled(categoryId)) return 0;

  const prevMonthKey = getPrevMonthKey(monthKey);

  // Get previous month's allocation
  const prevAlloc = signals.monthlyAlloc.value[prevMonthKey]?.[categoryId];
  if (prevAlloc === undefined || prevAlloc === null) return 0;

  // Get previous month's spending (already returns dollars)
  const prevSpent = getMonthExpByCat(categoryId, prevMonthKey);

  // Calculate unspent (using cents to avoid floating-point errors)
  const allocCents = toCents(prevAlloc);
  const spentCents = toCents(prevSpent);
  const unspentCents = allocCents - spentCents;
  const unspent = toDollars(unspentCents);

  const settings = getRolloverSettings();

  // Handle negative balances based on settings
  if (unspent < 0) {
    switch (settings.negativeHandling) {
      case 'zero':
        return 0;  // Forgive overspending
      case 'ignore':
        return 0;  // Don't carry negative
      case 'carry':
        // Carry forward negative (reduces next month's budget)
        break;
    }
  }

  // Apply max rollover cap if set
  if (settings.maxRollover !== null && settings.maxRollover !== undefined) {
    if (unspent > 0 && unspent > settings.maxRollover) {
      return settings.maxRollover;
    }
    if (unspent < 0 && Math.abs(unspent) > settings.maxRollover) {
      return -settings.maxRollover;
    }
  }

  return unspent;
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

/**
 * Initialize rollover module
 * Loads settings from localStorage
 */
export function initRollover(): void {
  // Load settings from localStorage
  const savedSettings = lsGet(SK.ROLLOVER_SETTINGS, null) as RolloverSettings | null;
  signals.rolloverSettings.value = savedSettings || { ...DEFAULT_ROLLOVER_SETTINGS };
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
        return 0;
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
