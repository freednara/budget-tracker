/**
 * Transactions Component
 *
 * Transaction list rendering is now driven explicitly by:
 * - the initial render in app-init-di.ts
 * - filter-events.ts when filters change
 * - app-events.ts on transaction/month events
 *
 * The previous signal-driven auto-mount performed a second immediate render during
 * startup and could wedge the page under Chromium automation. Keep this mount as a
 * no-op so callers can safely import it without reintroducing that duplicate render path.
 *
 * @module components/transactions
 */
'use strict';

export function mountTransactions(): () => void {
  return () => {};
}
