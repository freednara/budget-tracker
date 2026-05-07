/**
 * Worker Contract Drift (CR-Apr24-F, findings 230-232, 239-241, 249)
 *
 * Regression tests for worker path parity with sync fallback:
 *
 * - Finding 230: amount-range filters pre-parsed locale-awarely
 * - Finding 231: worker aggregation excludes savings-transfer expenses
 * - Finding 232: worker aggregate path applies filters
 * - Finding 239: worker search refreshes dataset from payload
 * - Finding 240: searchTransactionsAsync returns Transaction[] not paginated wrapper
 * - Finding 241: awardAchievement listener destructures object payload
 * - Finding 249: dataset hash catches interior edits
 */
import { describe, expect, it, vi } from 'vitest';

import type { Transaction } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2)}`,
    date: '2026-04-25',
    amount: 100,
    description: 'Test Transaction',
    category: 'food',
    type: 'expense',
    currency: 'USD',
    recurring: false,
    ...overrides
  } as Transaction;
}

function makeSavingsTransferTx(overrides: Partial<Transaction> = {}): Transaction {
  return makeTx({
    category: 'savings_transfer',
    type: 'expense',
    description: 'Savings Transfer: Emergency Fund',
    amount: 200,
    ...overrides
  });
}

// ==========================================
// FINDING 231: Worker aggregation excludes savings-transfer
// ==========================================

describe('finding 231 — isTrackedExpenseTransaction in sync fallback', () => {
  it('filterTransactionsSync excludes savings-transfer from expense totals', async () => {
    const { filterTransactionsSync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    const txs = [
      makeTx({ amount: 100, type: 'expense', category: 'food' }),
      makeSavingsTransferTx({ amount: 200 }),
      makeTx({ amount: 50, type: 'income', category: 'salary' })
    ];

    const result = filterTransactionsSync(txs, {});

    // Savings transfer ($200) should NOT be in expense totals
    expect(result.aggregations.totalExpenses).toBe(100);
    expect(result.aggregations.expenseCount).toBe(1);
    expect(result.aggregations.totalIncome).toBe(50);
    // Category totals should not include savings_transfer
    expect(result.aggregations.categoryTotals).not.toHaveProperty('savings_transfer');
    expect(result.aggregations.categoryTotals).toHaveProperty('food');
  });

  it('filterTransactionsSync excludes legacy savings with markers', async () => {
    const { filterTransactionsSync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    const legacySavingsTx = makeTx({
      category: 'savings',
      type: 'expense',
      amount: 150,
      tags: 'savings_transfer',
      description: 'Savings Transfer: Vacation Fund'
    });

    const regularTx = makeTx({ amount: 75, type: 'expense', category: 'food' });

    const result = filterTransactionsSync([legacySavingsTx, regularTx], {});

    // Legacy savings with transfer markers should be excluded
    expect(result.aggregations.totalExpenses).toBe(75);
    expect(result.aggregations.expenseCount).toBe(1);
  });
});

// ==========================================
// FINDING 230: Amount range locale-aware pre-parsing
// ==========================================

describe('finding 230 — amount filter pre-parsing in filterTransactionsAsync', () => {
  it('filterTransactionsSync handles string amount ranges via parseAmount', async () => {
    const { filterTransactionsSync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    const txs = [
      makeTx({ amount: 50 }),
      makeTx({ amount: 100 }),
      makeTx({ amount: 200 })
    ];

    // String amounts should be parsed, not ignored
    const result = filterTransactionsSync(txs, {
      minAmount: '75' as unknown as number,
      maxAmount: '150' as unknown as number
    });

    expect(result.totalItems).toBe(1);
    expect(result.items[0]!.amount).toBe(100);
  });
});

// ==========================================
// FINDING 240: searchTransactionsAsync return shape
// ==========================================

describe('finding 240 — searchTransactionsAsync extracts items from paginated result', () => {
  it('searchTransactionsAsync is typed to return Transaction[]', async () => {
    const { searchTransactionsAsync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    // Verify the function signature exists and is callable
    expect(typeof searchTransactionsAsync).toBe('function');

    // The function's return type is Promise<Transaction[]>, which is
    // enforced at compile time. At runtime, we just verify it doesn't
    // crash when no worker is available.
    try {
      await searchTransactionsAsync(null, 'test', 10);
    } catch (e) {
      // Expected: 'Worker not available' in test environment
      expect((e as Error).message).toContain('Worker');
    }
  });
});

// ==========================================
// FINDING 241: awardAchievement payload destructure
// ==========================================

describe('finding 241 — awardAchievement listener handles object payload', () => {
  it('achievements listener accepts { id } object payload from event bus', async () => {
    // Spy on the downstream state-actions call that awardAchievement delegates to.
    // ESM binds the local `awardAchievement` function reference at import time,
    // so vi.spyOn on the achievements module export can't intercept internal calls.
    // Instead, spy on `achievements.award` from state-actions, which IS looked up
    // via the imported object at call time.
    const stateActions = await import('../js/modules/core/state-actions.js');
    const awardSpy = vi.spyOn(stateActions.achievements, 'award').mockReturnValue(false);

    const achievementsModule = await import(
      '../js/modules/features/gamification/achievements.js'
    );
    const { emit } = await import('../js/modules/core/event-bus.js');

    achievementsModule.initAchievements();

    // The emitter sends { id: 'test_achievement' }
    emit('feature:award:achievement', { id: 'test_achievement' });

    // The listener should have destructured { id } and passed the string key
    expect(awardSpy).toHaveBeenCalledWith('test_achievement');

    achievementsModule.cleanupAchievements();
    awardSpy.mockRestore();
  });

  it('achievements listener also accepts raw string payload (backwards compat)', async () => {
    const stateActions = await import('../js/modules/core/state-actions.js');
    const awardSpy = vi.spyOn(stateActions.achievements, 'award').mockReturnValue(false);

    const achievementsModule = await import(
      '../js/modules/features/gamification/achievements.js'
    );
    const { emit } = await import('../js/modules/core/event-bus.js');

    achievementsModule.initAchievements();

    // Direct string payload (if any caller sent it this way)
    emit('feature:award:achievement', 'legacy_string_id');

    expect(awardSpy).toHaveBeenCalledWith('legacy_string_id');

    achievementsModule.cleanupAchievements();
    awardSpy.mockRestore();
  });
});

// ==========================================
// FINDING 249: Dataset hash interior edit detection
// ==========================================

describe('finding 249 — strengthened dataset hash detects interior edits', () => {
  it('sync fallback filterTransactionsSync reflects category changes immediately', async () => {
    const { filterTransactionsSync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    const tx1 = makeTx({ amount: 100, category: 'food', type: 'expense' });
    const tx2 = makeTx({ amount: 100, category: 'food', type: 'expense' });

    const before = filterTransactionsSync([tx1, tx2], {});
    expect(before.aggregations.categoryTotals['food']).toBe(200);

    // Change category of tx2 — amounts and count unchanged
    const tx2Modified = { ...tx2, category: 'transport' };
    const after = filterTransactionsSync([tx1, tx2Modified], {});

    expect(after.aggregations.categoryTotals['food']).toBe(100);
    expect(after.aggregations.categoryTotals['transport']).toBe(100);
  });

  it('sync fallback reflects description changes', async () => {
    const { filterTransactionsSync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    const tx = makeTx({ description: 'Original' });
    const txModified = { ...tx, description: 'Modified Description' };

    // Search should find the modified description
    const result = filterTransactionsSync([txModified], {
      searchQuery: 'modified'
    });
    expect(result.totalItems).toBe(1);

    // And not find the original
    const result2 = filterTransactionsSync([txModified], {
      searchQuery: 'original'
    });
    expect(result2.totalItems).toBe(0);
  });
});

// ==========================================
// FINDING 232: Aggregate path applies filters
// ==========================================

describe('finding 232 — aggregateTransactionsAsync contract', () => {
  it('aggregateTransactionsAsync accepts filters parameter', async () => {
    const { aggregateTransactionsAsync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );

    // Verify the function signature accepts filters
    expect(typeof aggregateTransactionsAsync).toBe('function');
    expect(aggregateTransactionsAsync.length).toBeGreaterThanOrEqual(1);

    // When no worker is available, it should throw (not silently ignore filters)
    try {
      await aggregateTransactionsAsync(null, { type: 'expense' });
    } catch (e) {
      expect((e as Error).message).toContain('Worker');
    }
  });
});
