import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { insightBudgetAdherence } from '../js/modules/features/personalization/insights.js';
import { invalidateAllCache } from '../js/modules/core/monthly-totals-cache.js';
import { invalidateRolloverCache as invalidateCalcRolloverCache } from '../js/modules/features/financial/calculations.js';
import { invalidateRolloverCache as invalidateRolloverRolloverCache } from '../js/modules/features/financial/rollover.js';
import type { InsightContext, Transaction } from '../js/types/index.js';

/**
 * CR-Apr22-D slice 4 coverage — `insightBudgetAdherence` must honor rollover
 * (finding 67 [P2]).
 *
 * Before this slice, the generator compared `spent > alloc[c]` category by
 * category, ignoring any rolled-over surplus from the prior month. Users
 * who under-spent in month N-1 (creating a rollover credit) could spend
 * more than the raw month-N allocation while still comfortably within the
 * effective budget — but the insight would count them as "over budget"
 * and surface a contradictory warning while the Budget Planner painted
 * green bars for the same categories.
 *
 * The fix mirrors the rollover-aware effective-budget math used by
 * `getDailyAllowance` and `getSpendingPace`: resolve rollovers once per
 * call via `calculateMonthRollovers(mk)`, then compare the per-category
 * `spent` (in cents) against `alloc + rollover` (in cents). Cents-math
 * is deliberate — a $100.01 spend against a $100.00 effective budget
 * must still classify as over, and float compare is flaky on that seam.
 *
 * These tests drive the helper in isolation via three personality
 * modes (`roast`, `friendly`, `serious`) and assert both the
 * over/under counts encoded in the copy and the `action.label` switch
 * that depends on whether any category is over. `serious` routes through
 * the generator's default branch, which renders the "Budget check: X on
 * track, Y over budget" copy.
 */

const emptyCtx: InsightContext = { income: 0, expenses: 0, balance: 0 };

function tx(overrides: {
  type: 'expense' | 'income';
  amount: number;
  date: string;
  category: string;
  description?: string;
}): Transaction {
  return {
    __backendId: `test_${Math.random().toString(36).slice(2)}`,
    description: overrides.description ?? 'Test',
    currency: 'USD',
    recurring: false,
    ...overrides
  };
}

/**
 * Reset the rollover settings to their disabled default so one test's
 * override does not leak into the next. Also invalidate the shared caches
 * (`monthlyTotals` + the private rolloverCache inside calculations.ts) so
 * a prior test's tx ledger cannot taint the next test's rollover resolve.
 */
function resetRolloverState(): void {
  signals.rolloverSettings.value = {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero'
  };
  invalidateAllCache();
  invalidateCalcRolloverCache();
  invalidateRolloverRolloverCache();
}

describe('insightBudgetAdherence — rollover-aware over/under classification (CR-Apr22-D slice 4)', () => {
  beforeEach(() => {
    resetRolloverState();
    signals.replaceTransactionLedger([]);
    signals.currentMonth.value = '2026-04';
    signals.monthlyAlloc.value = {};
  });

  afterEach(() => {
    signals.replaceTransactionLedger([]);
    signals.currentMonth.value = '2026-03';
    signals.monthlyAlloc.value = {};
    resetRolloverState();
  });

  it('returns null when the viewed month has no allocation at all', () => {
    // No allocation → no categories to classify → generator bows out so
    // `generateInsights` can fall through to a lower-priority generator.
    expect(insightBudgetAdherence('serious', emptyCtx)).toBeNull();
    expect(insightBudgetAdherence('roast', emptyCtx)).toBeNull();
    expect(insightBudgetAdherence('friendly', emptyCtx)).toBeNull();
  });

  it('classifies purely on raw allocation when rollover is DISABLED', () => {
    signals.monthlyAlloc.value = {
      '2026-04': { food: 200, transport: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 250, date: '2026-04-05', category: 'food' }), // over
      tx({ type: 'expense', amount: 80,  date: '2026-04-06', category: 'transport' }) // under
    ]);

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return; // narrow
    expect(result.text).toBe('Budget check: 1 category on track, 1 over budget');
    expect(result.action?.label).toBe('Reallocate 1 category');
  });

  it('REGRESSION LOCK: a rolled-over surplus rescues a category from "over" (rollover ENABLED)', () => {
    // Previous month: budgeted 300, spent 100 → 200 surplus to roll over.
    // Current month: budgeted 200, spent 350 → raw `spent > alloc` → over;
    // with rollover enabled the effective budget is 200 + 200 = 400, so
    // 350 is UNDER effective and the insight should report "on track".
    signals.monthlyAlloc.value = {
      '2026-03': { food: 300 },
      '2026-04': { food: 200 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100, date: '2026-03-10', category: 'food' }), // prev-month: 100 of 300 spent
      tx({ type: 'expense', amount: 350, date: '2026-04-10', category: 'food' })  // this-month: 350 of raw 200, 350 of effective 400
    ]);
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    invalidateAllCache();
    invalidateCalcRolloverCache();
    invalidateRolloverRolloverCache();

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 1 category on track, 0 over budget');
    expect(result.action?.label).toBe('View budget');
  });

  it('still reports "over" when spend EXCEEDS the effective budget (rollover enabled)', () => {
    // Previous month: budget 150, spent 100 → 50 surplus rolled forward.
    // Current month: budget 100, spent 200 → effective 150, 200 > 150 → over.
    signals.monthlyAlloc.value = {
      '2026-03': { food: 150 },
      '2026-04': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100, date: '2026-03-10', category: 'food' }),
      tx({ type: 'expense', amount: 200, date: '2026-04-10', category: 'food' })
    ]);
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    invalidateAllCache();
    invalidateCalcRolloverCache();
    invalidateRolloverRolloverCache();

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 0 categories on track, 1 over budget');
    expect(result.action?.label).toBe('Reallocate 1 category');
  });

  it('is unchanged when rollover is disabled (same seed as the regression-lock case)', () => {
    // Identical seed to the regression-lock test but with rollover disabled.
    // The `alloc = 200, spent = 350` category should count as OVER because
    // the effective budget is the raw allocation.
    signals.monthlyAlloc.value = {
      '2026-03': { food: 300 },
      '2026-04': { food: 200 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100, date: '2026-03-10', category: 'food' }),
      tx({ type: 'expense', amount: 350, date: '2026-04-10', category: 'food' })
    ]);
    // rollover left DISABLED by beforeEach reset.

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 0 categories on track, 1 over budget');
  });

  it('handles the exact-budget boundary as UNDER (strict > comparator)', () => {
    // Spending exactly equal to effective budget is "on track", not over.
    signals.monthlyAlloc.value = {
      '2026-03': { food: 100 },
      '2026-04': { food: 150 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100, date: '2026-03-10', category: 'food' }), // no rollover surplus
      tx({ type: 'expense', amount: 150, date: '2026-04-10', category: 'food' })  // spent === raw === effective
    ]);
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    invalidateAllCache();
    invalidateCalcRolloverCache();
    invalidateRolloverRolloverCache();

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 1 category on track, 0 over budget');
  });

  it('uses cents-math on the threshold-boundary (catches a $0.01 overage)', () => {
    // Effective budget = 100.00 exactly; spend = 100.01 → must classify as OVER.
    // Before cents-math the `spent > effective` comparator relied on JS float
    // subtraction; 100.01 > 100.0 is actually safe under IEEE 754, but e.g.
    // 0.1 + 0.2 + ... accumulating comparisons can drift. The test here is
    // the contract that the comparator uses toCents for both sides.
    signals.monthlyAlloc.value = {
      '2026-04': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100.01, date: '2026-04-10', category: 'food' })
    ]);
    // rollover disabled → effective = raw = 100.00
    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 0 categories on track, 1 over budget');
  });

  it('honors `mode: selected` — a non-selected category gets NO rollover boost', () => {
    // Rollover is enabled but only for `transport`. A prior-month surplus
    // in `food` must NOT be applied to the food category's effective budget.
    signals.monthlyAlloc.value = {
      '2026-03': { food: 300 },
      '2026-04': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 50,  date: '2026-03-10', category: 'food' }), // prev: 50 of 300 spent → 250 surplus available for rollover
      tx({ type: 'expense', amount: 150, date: '2026-04-10', category: 'food' })  // this: 150 of raw 100 → over; with selected-mode excluding food, stays over
    ]);
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'selected',
      categories: ['transport'], // food intentionally NOT in the selected set
      maxRollover: null,
      negativeHandling: 'zero'
    };
    invalidateAllCache();
    invalidateCalcRolloverCache();
    invalidateRolloverRolloverCache();

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    // Food is over because its rollover is zero per `mode: selected`.
    expect(result.text).toBe('Budget check: 0 categories on track, 1 over budget');
  });

  it('renders correct roast-mode copy when all categories are within effective budget', () => {
    signals.monthlyAlloc.value = {
      '2026-04': { food: 500, transport: 200 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 100, date: '2026-04-05', category: 'food' }),
      tx({ type: 'expense', amount: 50,  date: '2026-04-06', category: 'transport' })
    ]);

    const result = insightBudgetAdherence('roast', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('All 2 categories under budget? Suspicious.');
    expect(result.action?.label).toBe('View budget');
  });

  it('renders correct friendly-mode copy with a mixed over/under result', () => {
    signals.monthlyAlloc.value = {
      '2026-04': { food: 200, transport: 100, entertainment: 50 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 250, date: '2026-04-05', category: 'food' }),      // over
      tx({ type: 'expense', amount: 50,  date: '2026-04-06', category: 'transport' }), // under
      tx({ type: 'expense', amount: 20,  date: '2026-04-07', category: 'entertainment' }) // under
    ]);

    const result = insightBudgetAdherence('friendly', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('2 on track, 1 over — you can do it!');
    expect(result.action?.label).toBe('Reallocate 1 category');
  });

  it('renders correct analytical-mode singular/plural copy', () => {
    // Single over, single under → exercises both `catWord(1)` singular paths.
    signals.monthlyAlloc.value = {
      '2026-04': { food: 100, transport: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 150, date: '2026-04-05', category: 'food' }),
      tx({ type: 'expense', amount: 50,  date: '2026-04-06', category: 'transport' })
    ]);

    const result = insightBudgetAdherence('serious', emptyCtx);
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') return;
    expect(result.text).toBe('Budget check: 1 category on track, 1 over budget');
  });
});
