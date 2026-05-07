/**
 * Shared test fixture builders.
 *
 * Provides `createTx`, `createIncomeTx`, and related helpers so individual
 * test files don't have to hand-roll transaction literals or maintain their
 * own local copies of these factories. Consolidates the previously duplicated
 * `createTx` implementations from `rollover.test.ts` and `data-atomic-chaos.test.ts`.
 *
 * Every helper accepts a `Partial<T>` of overrides so tests can override only
 * the fields that matter for the assertion under test.
 *
 * @module tests/helpers/fixtures
 */

import type { Transaction } from '../../js/types/index.js';

// Deterministic monotonically-increasing counter so fixture IDs are predictable
// within a single test run. Tests that care about cross-run determinism should
// call `resetFixtureCounter()` in a `beforeEach` block.
let txCounter = 0;

/**
 * Generate a deterministic, unique `__backendId` for a fixture transaction.
 * Format matches the production `tx_<ulid>` shape closely enough to satisfy
 * any code that parses the prefix.
 */
function nextTxId(): string {
  txCounter += 1;
  return `tx_fixture_${txCounter.toString().padStart(6, '0')}`;
}

/**
 * Reset the fixture counter. Call in `beforeEach` when a test needs stable
 * IDs across runs, or when asserting exact ID values in snapshots.
 */
export function resetFixtureCounter(): void {
  txCounter = 0;
}

/**
 * Build a plausible expense transaction. Defaults:
 * - `type: 'expense'`
 * - `amount: 50`
 * - `category: 'food'`
 * - `date: '2026-02-15'` (stable, inside a normal month)
 * - `reconciled: false`
 *
 * Override any field via the `overrides` argument.
 *
 * @example
 * const tx = createTx({ amount: 120.50, category: 'transportation' });
 */
export function createTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: nextTxId(),
    type: 'expense',
    amount: 50,
    category: 'food',
    description: 'Test transaction',
    date: '2026-02-15',
    currency: 'USD',
    recurring: false,
    reconciled: false,
    splits: false,
    ...overrides,
  };
}

/**
 * Build a plausible income transaction. Convenience wrapper around `createTx`
 * with `type: 'income'` and sensible defaults (`category: 'salary'`,
 * `amount: 5000`).
 */
export function createIncomeTx(overrides: Partial<Transaction> = {}): Transaction {
  return createTx({
    type: 'income',
    category: 'salary',
    amount: 5000,
    description: 'Test income',
    ...overrides,
  });
}

/**
 * Build a batch of N expense transactions with incrementing descriptions
 * ("Test 1", "Test 2", …). Useful for tests that need a bulk dataset.
 */
export function createTxBatch(count: number, overrides: Partial<Transaction> = {}): Transaction[] {
  return Array.from({ length: count }, (_, i) =>
    createTx({ description: `Test ${i + 1}`, ...overrides })
  );
}
