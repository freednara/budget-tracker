/**
 * Data Sync Interface
 * 
 * Provides an event-based interface between core and data layers
 * to eliminate circular dependencies.
 * 
 * @module data-sync-interface
 */

import { emit, Events } from './event-bus.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// DATA SYNC EVENTS
// ==========================================

export const DataSyncEvents = {
  REQUEST_RELOAD: 'data:request:reload',
  REQUEST_SYNC: 'data:request:sync',
  SYNC_COMPLETE: 'data:sync:complete',
  SYNC_ERROR: 'data:sync:error',
  TRANSACTION_UPDATED: 'data:transaction:updated',
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

export interface DataSyncResponse {
  success: boolean;
  data?: unknown;
  error?: Error;
  timestamp: number;
}

/**
 * Request data layer to reload transactions
 */
export function requestDataReload(source: string = 'unknown'): void {
  emit(DataSyncEvents.REQUEST_RELOAD, { source });
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