/**
 * Data Sync Interface
 * 
 * Provides an event-based interface between core and data layers
 * to eliminate circular dependencies.
 * 
 * @module data-sync-interface
 */

import { emit } from './event-bus.js';
import type { Transaction, TransactionDataChange } from '../../types/index.js';

// ==========================================
// DATA SYNC EVENTS
// ==========================================

export const DataSyncEvents = {
  REQUEST_RELOAD: 'data:request:reload',
  REQUEST_APPLY_DELTA: 'data:request:apply_delta',
  REQUEST_SYNC: 'data:request:sync',
  SYNC_COMPLETE: 'data:sync:complete',
  SYNC_ERROR: 'data:sync:error',
  TRANSACTION_UPDATED: 'data:transaction:updated',
  TRANSACTION_DELTA_APPLIED: 'data:transaction:delta_applied',
  BULK_UPDATE: 'data:bulk:update'
} as const;

// ==========================================
// DATA SYNC INTERFACE
// ==========================================

export interface DataSyncRequest {
  type: 'reload' | 'sync' | 'update';
  data?: unknown;
  source?: string;
}

export type TransactionDataDelta = TransactionDataChange;

export interface DataSyncResponse {
  success: boolean;
  data?: unknown;
  error?: Error;
  timestamp: number;
}

/**
 * Sync-request metadata envelope.
 *
 * Every field widened to `field?: T | undefined` so callers can pass
 * explicit `undefined` values (propagated from
 * `BroadcastMessage.revision` / `.tabId` / `.timestamp`, which are
 * frequently absent in a valid payload) without tripping
 * `exactOptionalPropertyTypes`. Shipped Phase 6 Slice 1j (rev 12 L6).
 */
export interface DataSyncMetadata {
  revision?: number | undefined;
  tabId?: string | undefined;
  timestamp?: number | undefined;
}

/**
 * Request data layer to reload transactions
 */
export function requestDataReload(
  source: string = 'unknown',
  metadata: DataSyncMetadata = {}
): void {
  emit(DataSyncEvents.REQUEST_RELOAD, { source, ...metadata });
}

/**
 * Request data layer to apply an already-persisted remote delta.
 */
export function requestDataApplyDelta(
  change: TransactionDataDelta,
  source: string = 'unknown',
  metadata: DataSyncMetadata = {}
): void {
  emit(DataSyncEvents.REQUEST_APPLY_DELTA, { change, source, ...metadata });
}

/**
 * Request data layer to sync changes
 */
export function requestDataSync(changes: Partial<Transaction>[], source: string = 'unknown'): void {
  emit(DataSyncEvents.REQUEST_SYNC, { changes, source });
}

/**
 * Notify that data sync is complete
 */
export function notifyDataSyncComplete(data: unknown): void {
  emit(DataSyncEvents.SYNC_COMPLETE, { data, timestamp: Date.now() });
}

/**
 * Notify about sync error
 */
export function notifyDataSyncError(error: Error): void {
  emit(DataSyncEvents.SYNC_ERROR, { error, timestamp: Date.now() });
}
