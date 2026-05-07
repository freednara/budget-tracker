'use strict';

/**
 * Defensive accessor for `Transaction.amount`.
 *
 * Rev 12 / #39 M1 (Inline-Behavior-Review): replaces the legacy
 * `(tx.amount || 0)` pattern at Transaction aggregation sites.
 * `Transaction.amount` is typed `number` (required), so `undefined` /
 * `NaN` / `null` can only enter the ledger via data-corruption paths
 * (legacy imports, truncated migrations, crashed writes). The old `|| 0`
 * fallback silently counted those records as free money — hiding the bug
 * from the user AND from the monitoring pipeline. This helper surfaces
 * the corruption via the M28 fingerprint-sampled error tracker while
 * still returning a safe 0 so downstream math doesn't crash.
 *
 * Scope is Transaction-only. Other `{ amount: number }` shapes
 * (`SavingsContribution`, `CategoryMonthData`) have their own semantics
 * (backdating, optional-chain cascades) and are out of scope for #39 M1.
 *
 * @module core/safe-amount
 *
 * IMPORTANT: this helper lives in its own module — not in
 * `transaction-classification.ts` — because the `trackError` import would
 * otherwise close a circular dependency cycle through the shared utils
 * graph:
 *
 *   `utils-dom → utils-pure → transaction-classification → error-tracker → utils-dom`
 *
 * Keeping `safeAmount` downstream of `error-tracker` keeps the cycle
 * broken while still allowing Transaction-shape callers to import it.
 */

import type { Transaction } from '../../types/index.js';
import { trackError } from './error-tracker.js';

/**
 * Returns `tx.amount` when it is a finite number; otherwise logs a
 * `trackError` telemetry event and returns 0.
 *
 * Only `__backendId` and `amount` are read so the helper can accept
 * `Pick<Transaction, ...>` slices from detail panels.
 */
export function safeAmount(tx: Pick<Transaction, '__backendId' | 'amount'>): number {
  if (Number.isFinite(tx.amount)) return tx.amount;
  // Round 7 fix: include transaction summary for better debugging when __backendId is missing
  const txId = tx.__backendId || 'unknown';
  const txSummary = JSON.stringify({ id: txId, amount: tx.amount });
  trackError(
    `safeAmount received non-finite amount: ${txSummary}`,
    { module: 'safe-amount', action: `safeAmount:${txId}` },
    'validationError'
  );
  return 0;
}
