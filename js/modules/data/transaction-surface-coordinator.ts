/**
 * Transaction Surface Coordinator
 *
 * Centralizes transaction list refresh policy so callers mutate filters/state
 * through actions and ask one module to decide when the ledger rerenders.
 */
'use strict';

import { on, Events, type UnsubscribeFn } from '../core/event-bus.js';
import { DataSyncEvents } from '../core/data-sync-interface.js';
import { effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { filters, pagination } from '../core/state-actions.js';
import { renderTransactionsList } from './transaction-renderer.js';

let coordinatorUnsubscribers: UnsubscribeFn[] = [];

export async function refreshTransactionsSurface(options: { resetPage?: boolean } = {}): Promise<void> {
  if (options.resetPage) {
    pagination.resetPage();
  }
  await renderTransactionsList(false);
}

export async function applyTransactionFilters(
  updates: Partial<signals.FilterState>,
  options: { resetPage?: boolean } = { resetPage: true }
): Promise<void> {
  filters.updateFilters(updates);
  await refreshTransactionsSurface(options);
}

export async function replaceTransactionFilters(
  nextFilters: signals.FilterState,
  options: { resetPage?: boolean } = { resetPage: true }
): Promise<void> {
  filters.setFilters(nextFilters);
  await refreshTransactionsSurface(options);
}

export async function clearTransactionFilters(
  options: { resetPage?: boolean } = { resetPage: true }
): Promise<void> {
  filters.clearFilters();
  await refreshTransactionsSurface(options);
}

export function initTransactionSurfaceCoordinator(): () => void {
  coordinatorUnsubscribers.forEach((unsubscribe) => unsubscribe());
  coordinatorUnsubscribers = [
    on(Events.DATA_IMPORTED, () => {
      void refreshTransactionsSurface({ resetPage: true });
    }),
    on(Events.TRANSACTIONS_REPLACED, () => {
      void refreshTransactionsSurface({ resetPage: true });
    }),
    on(DataSyncEvents.TRANSACTION_UPDATED, () => {
      void refreshTransactionsSurface();
    }),
    on(DataSyncEvents.TRANSACTION_DELTA_APPLIED, () => {
      void refreshTransactionsSurface();
    })
  ];

  // Re-render transaction rows when currency changes so amounts show the new symbol/format.
  // Skip the first run (initial mount) — the list is already rendered with the current currency.
  let isFirstRun = true;
  const disposeCurrencyEffect = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    if (isFirstRun) { isFirstRun = false; return; }
    void refreshTransactionsSurface();
  });

  return () => {
    coordinatorUnsubscribers.forEach((unsubscribe) => unsubscribe());
    coordinatorUnsubscribers = [];
    disposeCurrencyEffect();
  };
}
