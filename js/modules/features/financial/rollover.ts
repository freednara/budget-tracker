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
import { getMonthAlloc } from '../../core/month-alloc.js';
import { settings } from '../../core/state-actions.js';
import { getPrevMonthKey, toCents, toDollars } from '../../core/utils-pure.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from '../../core/monthly-totals-cache.js';
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
  // Invalidate cache when rollover enabling status changes
  invalidateRolloverCache();
}

/**
 * Set rollover mode
 */
export function setRolloverMode(mode: RolloverMode): void {
  if (mode !== 'all' && mode !== 'selected') return;
  settings.setRolloverSettings({ mode });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
  // Invalidate cache when rollover mode changes
  invalidateRolloverCache();
}

/**
 * Set which categories should rollover (when mode='selected')
 */
export function setRolloverCategories(categoryIds: string[]): void {
  settings.setRolloverSettings({
    categories: Array.isArray(categoryIds) ? categoryIds : []
  });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
  // Invalidate cache when selected categories change
  invalidateRolloverCache();
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
  // Invalidate cache when category rollover settings change
  invalidateRolloverCache();
}

/**
 * Set maximum rollover amount per category.
 *
 * Phase 5g-3 Slice 3 (Inline-Behavior-Review rev 12, L23): explicit
 * non-finite rejection replaced the prior `parseFloat(String(max)) || 0`
 * pattern. The old form masked every unparseable input (NaN,
 * whitespace-only strings, `undefined` coerced via `String()`) to
 * `0` — and in the rollover domain `maxRollover = 0` means "no
 * surplus ever carries forward," functionally identical to
 * disabling rollover without the user realizing. A user typing a
 * typo'd cap would see no error, then months later notice their
 * underspend never rolled over.
 *
 * Behavior:
 *   - `null` / `undefined`             → clear the cap (unlimited rollover).
 *   - finite number                    → clamped at `>= 0`.
 *   - NaN / Infinity / non-number type → DEV warn and **return without
 *     mutating state**, preserving the prior cap. The caller / UI
 *     layer owns the user-visible validation toast — silently
 *     accepting then coercing is the failure mode L23 flagged.
 *
 * Same family as M15 (`localeService.parseNumber`) and M9
 * (`template-manager.saveAsTemplate`); the broader masking-default
 * sweep (including `debt-planner.ts:153,182` for interest rate and
 * `dueDay`) is tracked under action-plan item #37.
 */
export function setMaxRollover(max: number | null | undefined): void {
  let normalized: number | null;
  if (max === null || max === undefined) {
    normalized = null;
  } else if (typeof max !== 'number' || !isFinite(max)) {
    if (import.meta.env.DEV) {
      console.warn('setMaxRollover: non-finite value rejected, preserving prior cap', max);
    }
    return;
  } else {
    normalized = Math.max(0, max);
  }
  settings.setRolloverSettings({ maxRollover: normalized });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
  // Invalidate cache when max rollover cap changes
  invalidateRolloverCache();
}

/**
 * Set how negative balances are handled
 */
export function setNegativeHandling(handling: NegativeHandling): void {
  if (!['zero', 'carry', 'ignore'].includes(handling)) return;
  settings.setRolloverSettings({ negativeHandling: handling });
  persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
  // Invalidate cache when negative handling behavior changes
  invalidateRolloverCache();
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
 * Module-level cache for rollover calculations
 * Key format: `${categoryId}_${monthKey}`
 * Stores computed rollover amounts in cents for precision
 */
const rolloverCache = new Map<string, number>();

/**
 * Invalidate the entire rollover cache
 * Called when transactions, allocations, or settings change
 */
export function invalidateRolloverCache(): void {
  rolloverCache.clear();
}

/**
 * Calculate rollover amount from previous month for a category
 * Uses cents-based math to avoid floating-point errors
 * OPTIMIZED: Implements two-tier caching strategy:
 *   1. Module-level memoization of (categoryId, monthKey) -> rollover amount
 *   2. Incremental accumulation: if cache has month M-1, start from there instead of month 0
 *
 * @returns Rollover amount in dollars (positive = surplus, negative = overspent)
 */
export function calculateRollover(categoryId: string, monthKey: string): number {
  if (!isCategoryRolloverEnabled(categoryId)) return 0;

  // Check module-level cache first
  const cacheKey = `${categoryId}_${monthKey}`;
  if (rolloverCache.has(cacheKey)) {
    return toDollars(rolloverCache.get(cacheKey)!);
  }

  const settings = getRolloverSettings();

  // Find all relevant months chronologically
  const allMonthsWithAlloc = Object.keys(signals.monthlyAlloc.value).sort();
  const startMonth = allMonthsWithAlloc.find(mk =>
    signals.monthlyAlloc.value[mk]?.[categoryId] !== undefined
  );

  if (!startMonth || startMonth >= monthKey) return 0;

  let accumulatedCents = 0;
  let startAccumFrom = startMonth;

  // Optimization: if we have the value for the previous month cached,
  // start accumulation from the current month instead of scanning from the start
  const prevMonthKey = getPrevMonthKey(monthKey);
  const prevCacheKey = `${categoryId}_${prevMonthKey}`;
  if (rolloverCache.has(prevCacheKey)) {
    accumulatedCents = rolloverCache.get(prevCacheKey)!;
    startAccumFrom = monthKey; // Only accumulate this month's delta
  }

  for (const mk of allMonthsWithAlloc) {
    if (mk < startAccumFrom) continue;
    if (mk >= monthKey) break;

    const monthAlloc = signals.monthlyAlloc.value[mk]?.[categoryId] || 0;
    const allocCents = toCents(monthAlloc);

    // Use cached totals instead of manual calculation
    const totals = calculateMonthlyTotalsWithCache(mk);
    const monthSpentCents = toCents((totals.categoryTotals || {})[categoryId] || 0);

    accumulatedCents += (allocCents - monthSpentCents);

    // Handle negative balances based on settings
    if (accumulatedCents < 0 && settings.negativeHandling === 'zero') {
      accumulatedCents = 0;
    }
  }

  // ROLL-01: Apply max rollover cap to POSITIVE surplus only.
  // Negative balances (overspending) should carry forward in full so
  // `negativeHandling` alone controls their fate. Symmetric clamping
  // silently forgave overspending beyond the cap, which breaks the
  // user's "I overspent $X" mental model.
  if (settings.maxRollover !== null && settings.maxRollover !== undefined && accumulatedCents > 0) {
    const maxCents = toCents(settings.maxRollover);
    accumulatedCents = Math.min(accumulatedCents, maxCents);
  }

  // Store in cache before returning
  rolloverCache.set(cacheKey, accumulatedCents);

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
  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
  // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
  // once-per-session trackError on a genuine miss (map non-empty but the
  // requested month is missing), which is the data-loss signal the review
  // targets. Empty allocMap (new user / pre-hydration / post-reset) stays
  // silent. Shape is identical on the hit path.
  const alloc = getMonthAlloc(monthKey, signals.monthlyAlloc.value);

  // Also check previous month's allocations in case user had budget there.
  // Rev 12 / #39 M4: deliberately keeps the raw `|| {}` pattern here — a
  // missing previous-month allocation is an EXPECTED case (user started
  // budgeting this month and has no historical allocation for the prior
  // month), not a data-loss signal. Routing through getMonthAlloc would
  // generate false-positive trackError fires because the allocMap is
  // non-empty (monthKey IS set), so the helper's empty-map suppression
  // wouldn't catch this site. This comment preserves the rationale for
  // future grep hits so the intent is not lost.
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
 * Loads settings from localStorage and sets up cache invalidation on data changes
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

  // Cache invalidation: when budget allocations change, clear the rollover cache
  // since rollover amounts depend on monthly allocations and spending
  on('budget:updated', () => {
    invalidateRolloverCache();
  }, { groupId: rolloverListenerGroupId });

  // Cache invalidation: when transactions change, clear the rollover cache
  // since rollover amounts depend on spending totals
  on('transactions:changed', () => {
    invalidateRolloverCache();
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

  // ROLL-01: Apply max rollover cap to POSITIVE surplus only.
  // Negative balances (overspending) carry forward in full so
  // `negativeHandling` alone controls their fate.
  if (state.rolloverSettings.maxRollover !== null && state.rolloverSettings.maxRollover !== undefined && unspentCents > 0) {
    const maxCents = toCents(state.rolloverSettings.maxRollover);
    return toDollars(Math.min(unspentCents, maxCents));
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
