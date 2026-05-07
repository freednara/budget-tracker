/**
 * Atomic Write Module
 *
 * Provides transactional storage writes with rollback capability.
 * Uses Web Locks API for cross-tab atomicity during import operations.
 *
 * @module atomic-write
 */
'use strict';

import { safeStorage } from '../../core/safe-storage.js';
import { emit, Events } from '../../core/event-bus.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface AtomicWriteEntry {
  key: string;
  value: unknown;
}

// ==========================================
// ATOMIC WRITE
// ==========================================

/**
 * Atomic write helper: snapshots current bytes for every key, applies each
 * write in sequence, and rolls back all keys on the first failure.
 * FIXED: Now uses Web Locks API to prevent cross-tab interference
 */
export async function tryAtomicWrite(writes: AtomicWriteEntry[]): Promise<boolean> {
  // Use Web Locks API for true cross-tab atomicity during import
  if (typeof navigator.locks?.request === 'function') {
    return await navigator.locks.request(
      'harbor_import_lock',
      { mode: 'exclusive', ifAvailable: false },
      async () => {
        return performAtomicWrite(writes);
      }
    );
  } else {
    // Fallback for browsers without Web Locks
    return performAtomicWrite(writes);
  }
}

/**
 * Internal atomic write implementation
 * FIXED: Uses safeStorage for consistent error handling and rollback
 */
function performAtomicWrite(writes: AtomicWriteEntry[]): boolean {
  const backups = writes.map(({ key }) => ({
    key,
    raw: safeStorage.getItem(key)
  }));

  for (const { key, value } of writes) {
    if (!safeStorage.setJSON(key, value)) {
      // Rollback failed write
      let rollbackFailed = false;
      backups.forEach(({ key: k, raw }) => {
        try {
          if (raw === null) safeStorage.removeItem(k);
          else if (!safeStorage.setItem(k, raw)) rollbackFailed = true;
        } catch (e) {
          if (import.meta.env.DEV) console.error('Rollback failed for key:', k, e);
          rollbackFailed = true;
        }
      });
      if (rollbackFailed) {
        if (import.meta.env.DEV) console.error('CRITICAL: Atomic write rollback failed - data may be in inconsistent state');
        emit(Events.SHOW_TOAST, { message: 'Storage error: data may be corrupted. Please export and refresh.', type: 'error' });
      }
      return false;
    }
  }
  return true;
}
