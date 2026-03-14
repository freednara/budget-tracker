/**
 * Transactions Component
 *
 * Reactive wrapper for the transaction list.
 * Automatically re-renders when transactions or month changes.
 * Filter-based re-renders are handled by filter-events.ts.
 *
 * @module components/transactions
 */
'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { renderTransactions as renderTransactionsImpl } from '../transactions.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive transactions component
 * Watches transactions and currentMonth signals to auto-update the list
 * Returns cleanup function to dispose effects
 */
export function mountTransactions(): () => void {
  const container = DOM.get('transactions-list');

  if (!container) {
    return () => {};
  }

  const cleanup = effect(() => {
    // Read signals to establish dependency tracking
    const _month = signals.currentMonth.value;
    const _txCount = signals.transactions.value.length;

    // Re-render transactions when month or transactions change
    // Note: Filter changes are handled directly by filter-events.ts
    renderTransactionsImpl();
  });

  return cleanup;
}
