/**
 * Budget Domain Service
 * Pure business logic for budget/envelope calculations. No side effects.
 *
 * All functions are pure: they take data as parameters and return results.
 * No signal access, no event emission, no DOM, no storage.
 *
 * @module domain/budget-service
 */
'use strict';

import { toCents, toDollars } from '../core/utils-pure.js';

// ==========================================
// TYPES
// ==========================================

export interface EnvelopeStatus {
  categoryId: string;
  allocated: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  isOverBudget: boolean;
  rollover: number;
  effectiveBudget: number;
}

export interface RolloverInput {
  enabled: boolean;
  mode: 'all' | 'selected';
  categories: string[];
  maxRollover: number | null;
  negativeHandling: 'zero' | 'carry' | 'ignore';
}

export interface MonthAllocations {
  [categoryId: string]: number;
}

export interface CategoryExpenses {
  [categoryId: string]: number;
}

// ==========================================
// ENVELOPE STATUS
// ==========================================

/**
 * Calculate per-category envelope status.
 * Pure function — takes allocations and actual spending, returns status per category.
 */
export function calculateEnvelopeStatus(
  allocations: MonthAllocations,
  categoryExpenses: CategoryExpenses,
  rollovers: Record<string, number> = {}
): EnvelopeStatus[] {
  const result: EnvelopeStatus[] = [];

  for (const [categoryId, allocated] of Object.entries(allocations)) {
    const allocatedCents = toCents(allocated);
    const spentCents = toCents(categoryExpenses[categoryId] || 0);
    const rolloverCents = toCents(rollovers[categoryId] || 0);
    const effectiveBudgetCents = allocatedCents + rolloverCents;
    const remainingCents = effectiveBudgetCents - spentCents;

    result.push({
      categoryId,
      allocated,
      spent: toDollars(spentCents),
      remaining: toDollars(remainingCents),
      percentUsed: effectiveBudgetCents > 0
        ? Math.min(100, (spentCents / effectiveBudgetCents) * 100)
        : (spentCents > 0 ? 100 : 0),
      isOverBudget: remainingCents < 0,
      rollover: toDollars(rolloverCents),
      effectiveBudget: toDollars(effectiveBudgetCents)
    });
  }

  return result;
}

// ==========================================
// UNASSIGNED BUDGET
// ==========================================

/**
 * Calculate unassigned budget amount for a given month.
 * Pure function — takes income and total allocations, returns unassigned amount.
 */
export function calculateUnassigned(
  income: number,
  allocations: MonthAllocations
): number {
  const incomeCents = toCents(income);
  let allocatedCents = 0;

  for (const amt of Object.values(allocations)) {
    allocatedCents += toCents(amt);
  }

  return toDollars(incomeCents - allocatedCents);
}

/**
 * Calculate cumulative unassigned across multiple months.
 * Each month contributes (income - totalAllocated) to the running total.
 * Pure function — no signals.
 *
 * @param monthlyData Array of { income, allocations } per month, in chronological order up to target month
 */
export function calculateCumulativeUnassigned(
  monthlyData: ReadonlyArray<{ income: number; allocations: MonthAllocations }>
): number {
  let cumulativeCents = 0;

  for (const { income, allocations } of monthlyData) {
    const incomeCents = toCents(income);
    let allocCents = 0;
    for (const amt of Object.values(allocations)) {
      allocCents += toCents(amt);
    }
    cumulativeCents += (incomeCents - allocCents);
  }

  return toDollars(cumulativeCents);
}

// ==========================================
// ROLLOVER CALCULATIONS
// ==========================================

/**
 * Calculate rollover amount for a single category from a previous month.
 * Pure function — takes budget, spending, and settings as input.
 *
 * @param prevAllocated Budget allocated to the category in the previous month
 * @param prevSpent Actual spending in the category in the previous month
 * @param settings Rollover settings
 * @param categoryId The category ID (for mode='selected' filtering)
 * @returns Rollover amount in dollars (positive = surplus, negative = overspent)
 */
export function calculateRolloverAmount(
  prevAllocated: number,
  prevSpent: number,
  settings: RolloverInput,
  categoryId: string
): number {
  if (!settings.enabled) return 0;

  // Check if category is eligible
  if (settings.mode === 'selected' && !settings.categories.includes(categoryId)) {
    return 0;
  }

  const allocCents = toCents(prevAllocated);
  const spentCents = toCents(prevSpent);
  let unspentCents = allocCents - spentCents;

  // Handle negative balances
  if (unspentCents < 0) {
    switch (settings.negativeHandling) {
      case 'zero':
        return 0;
      case 'carry':
        // Let negative pass through (reduces next month's budget)
        break;
      case 'ignore':
        // Let negative pass through unchanged
        break;
    }
  }

  // Apply max rollover cap
  if (settings.maxRollover !== null) {
    const maxCents = toCents(settings.maxRollover);
    if (unspentCents > 0) {
      unspentCents = Math.min(unspentCents, maxCents);
    } else if (unspentCents < 0) {
      unspentCents = Math.max(unspentCents, -maxCents);
    }
  }

  return toDollars(unspentCents);
}

/**
 * Calculate accumulated rollover for a category across multiple months.
 * Pure function — takes historical allocations and spending per month.
 *
 * @param monthHistory Chronological array of { allocated, spent } for the category, one per prior month
 * @param settings Rollover settings
 * @param categoryId The category ID
 * @returns Accumulated rollover amount in dollars
 */
export function calculateAccumulatedRollover(
  monthHistory: ReadonlyArray<{ allocated: number; spent: number }>,
  settings: RolloverInput,
  categoryId: string
): number {
  if (!settings.enabled) return 0;

  // Check if category is eligible
  if (settings.mode === 'selected' && !settings.categories.includes(categoryId)) {
    return 0;
  }

  let accumulatedCents = 0;

  for (const { allocated, spent } of monthHistory) {
    const allocCents = toCents(allocated);
    const spentCents = toCents(spent);
    accumulatedCents += (allocCents - spentCents);

    // Handle negative balances per settings
    if (accumulatedCents < 0 && settings.negativeHandling === 'zero') {
      accumulatedCents = 0;
    }
  }

  // Apply max rollover cap
  if (settings.maxRollover !== null) {
    const maxCents = toCents(settings.maxRollover);
    accumulatedCents = Math.max(-maxCents, Math.min(accumulatedCents, maxCents));
  }

  return toDollars(accumulatedCents);
}

/**
 * Calculate rollovers for all categories for a target month.
 * Pure function — takes all historical data as input.
 *
 * @param categoryHistories Map of categoryId -> chronological { allocated, spent } history
 * @param settings Rollover settings
 * @returns Map of categoryId -> rollover amount
 */
export function calculateAllRollovers(
  categoryHistories: Record<string, ReadonlyArray<{ allocated: number; spent: number }>>,
  settings: RolloverInput
): Record<string, number> {
  const rollovers: Record<string, number> = {};

  for (const [categoryId, history] of Object.entries(categoryHistories)) {
    const rollover = calculateAccumulatedRollover(history, settings, categoryId);
    if (rollover !== 0) {
      rollovers[categoryId] = rollover;
    }
  }

  return rollovers;
}

/**
 * Get effective budget for a category (base allocation + rollover).
 * Pure function.
 */
export function getEffectiveBudget(
  baseAllocation: number,
  rolloverAmount: number
): number {
  return toDollars(toCents(baseAllocation) + toCents(rolloverAmount));
}

/**
 * Summarize rollovers: positive (surplus), negative (deficit), net, count.
 * Pure function.
 */
export function summarizeRollovers(
  rollovers: Record<string, number>
): { positive: number; negative: number; net: number; count: number } {
  let positiveCents = 0;
  let negativeCents = 0;

  for (const amt of Object.values(rollovers)) {
    const cents = toCents(amt);
    if (cents > 0) positiveCents += cents;
    else negativeCents += cents;
  }

  return {
    positive: toDollars(positiveCents),
    negative: toDollars(negativeCents),
    net: toDollars(positiveCents + negativeCents),
    count: Object.keys(rollovers).length
  };
}
