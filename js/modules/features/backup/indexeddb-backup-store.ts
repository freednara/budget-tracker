/**
 * IndexedDB Backup Store Module
 * 
 * FIXED: Moves backup storage from localStorage to IndexedDB
 * to prevent quota competition and QuotaExceededError.
 * IndexedDB has much larger storage limits (often gigabytes).
 * 
 * @module features/backup/indexeddb-backup-store
 */
'use strict';

import { trackError } from '../../core/error-tracker.js';
import type { BackupData } from './auto-backup.js';

// ==========================================
// CONSTANTS
// ==========================================

const DB_NAME = 'BudgetTrackerBackups';
const DB_VERSION = 1;
const STORE_NAME = 'backups';
const INDEX_TIMESTAMP = 'timestamp';

// ==========================================
// DATABASE MANAGEMENT
// ==========================================

/**
 * Open the IndexedDB database
 */
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
      reject(new Error(`Failed to open database: ${request.error?.message}`));
    };
    
    request.onsuccess = () => {
      resolve(request.result);
    };
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create backup store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'metadata.id' });
        
        // Create index on timestamp for sorting
        store.createIndex(INDEX_TIMESTAMP, 'metadata.timestamp', { unique: false });
      }
    };
  });
}

// ==========================================
// BACKUP OPERATIONS
// ==========================================

/**
 * Store a backup in IndexedDB
 * FIXED: Replaces localStorage storage to avoid quota issues
 *
 * @param backup - The backup payload to persist.
 * @param retainCount - Maximum number of backups to keep after this write.
 *   Callers should pass the user-configured `backupSchedule.retainCount`
 *   so retention follows the settings UI. Defaults to 10 if omitted.
 *   Fixes M16 (Inline-Behavior-Review rev 12) \u2014 previously the caller's
 *   configured retention was ignored in favor of the hardcoded default.
 */
export async function storeBackup(backup: BackupData, retainCount?: number): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Prior-batch P3: upsert rather than add-only. `store.add()` throws
    // `ConstraintError` when a record with the same `metadata.id` key
    // already exists — importing the same backup twice, or re-running a
    // sync that reuses IDs, surfaced a spurious "IndexedDB backup failed"
    // error even though the payload was byte-identical. `store.put()` is
    // an upsert: it writes if the key is new and overwrites if it exists.
    // Safe here because backup IDs are generated with `generateId()` at
    // createBackup time (unique per device), so a same-id collision only
    // happens when the caller genuinely means "replace this specific
    // backup".
    await promisifyRequest(store.put(backup));

    // Clean up old backups using the user-configured retention when provided.
    await trimOldBackups(db, retainCount);

    db.close();
  } catch (error) {
    if (import.meta.env.DEV) console.warn('IndexedDB backup failed:', error);
    throw error;
  }
}

/**
 * Get all backups from IndexedDB
 */
export async function getAllBackups(): Promise<BackupData[]> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index(INDEX_TIMESTAMP);
    
    // Get all backups sorted by timestamp (newest first)
    const backups: BackupData[] = [];
    const request = index.openCursor(null, 'prev');
    
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          backups.push(cursor.value);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
    
    db.close();
    return backups;
  } catch (error) {
    // Fixes H2 (Inline-Behavior-Review rev 12): previously only DEV-logged
    // and returned []. In production the Backups UI showed "no backups"
    // identically for "IDB empty" and "IDB broken" — masking real
    // failures (corruption, quota, permissions). We now trackError in
    // production so the failure is visible to observability while
    // preserving the [] fallback so the UI doesn't explode.
    if (import.meta.env.DEV) console.warn('Failed to get backups from IndexedDB:', error);
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'indexeddb-backup-store',
      action: 'getAllBackups'
    });
    return [];
  }
}

/**
 * Get a specific backup by ID
 */
export async function getBackup(backupId: string): Promise<BackupData | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const backup = await promisifyRequest<BackupData>(store.get(backupId));

    db.close();
    return backup || null;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to get backup from IndexedDB:', error);
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'indexeddb-backup-store',
      action: `getBackup:${backupId}`
    });
    return null;
  }
}

/**
 * Delete a specific backup
 */
export async function deleteBackup(backupId: string): Promise<boolean> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await promisifyRequest(store.delete(backupId));

    db.close();
    return true;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to delete backup from IndexedDB:', error);
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'indexeddb-backup-store',
      action: `deleteBackup:${backupId}`
    });
    return false;
  }
}

/**
 * Clear all backups (use with caution)
 */
export async function clearAllBackups(): Promise<boolean> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await promisifyRequest(store.clear());

    db.close();
    return true;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to clear backups from IndexedDB:', error);
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'indexeddb-backup-store',
      action: 'clearAllBackups'
    });
    return false;
  }
}

// ==========================================
// MAINTENANCE
// ==========================================

/**
 * Trim old backups to maintain storage limits
 * Keeps only the most recent MAX_BACKUPS
 */
async function trimOldBackups(db: IDBDatabase, maxBackups: number = 10): Promise<void> {
  // Perform all IDB operations within a single promise to avoid transaction
  // auto-commit between `await` boundaries (IDB transactions auto-commit
  // when control returns to the event loop with no pending requests).
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index(INDEX_TIMESTAMP);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Trim transaction aborted'));

    // Count total backups
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count <= maxBackups) return; // transaction will auto-complete

      // Open cursor on oldest-first index and delete excess entries
      const toDelete = count - maxBackups;
      let deleted = 0;
      const cursorReq = index.openCursor(null, 'next');

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < toDelete) {
          store.delete(cursor.primaryKey);
          deleted++;
          cursor.continue();
        }
        // When cursor is exhausted or we've deleted enough, transaction auto-completes
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/**
 * Get storage usage estimate
 *
 * Prior-batch P3: when navigator.storage.estimate is unavailable or fails,
 * the fallback path now probes IndexedDB directly so a broken store is
 * reported as "unknown" (`available: false`) rather than silently
 * synthesizing `0 / 50MB / 0%`. Previously the fallback called
 * `getAllBackups()` which catches its own IDB errors and returns `[]`,
 * so a broken store looked identical to "empty store with plenty of
 * room" — the Backups UI couldn't surface the real problem to the user.
 */
export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
  percentUsed: number;
  available: boolean;
}> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage || 0,
        quota: estimate.quota || 0,
        percentUsed: ((estimate.usage || 0) / (estimate.quota || 1)) * 100,
        available: true
      };
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to get storage estimate:', error);
      trackError(error instanceof Error ? error : new Error(String(error)), {
        module: 'indexeddb-backup-store',
        action: 'getStorageEstimate'
      });
    }
  }

  // Fallback: probe IDB directly so a broken store surfaces as
  // `available: false` instead of pretending to be an empty one.
  try {
    const db = await openDatabase();
    try {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index(INDEX_TIMESTAMP);
      const backups: BackupData[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            backups.push(cursor.value as BackupData);
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      const totalSize = backups.reduce((sum, b) => sum + (b.metadata.size || 0), 0);
      return {
        usage: totalSize,
        quota: 50 * 1024 * 1024, // Assumed 50MB when navigator.storage is absent
        percentUsed: (totalSize / (50 * 1024 * 1024)) * 100,
        available: true
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Fallback storage estimate failed (broken IDB):', error);
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'indexeddb-backup-store',
      action: 'getStorageEstimate.fallback'
    });
    return {
      usage: 0,
      quota: 0,
      percentUsed: 0,
      available: false
    };
  }
}

// ==========================================
// MIGRATION
// ==========================================

/**
 * Migrate existing backups from localStorage to IndexedDB
 */
export async function migrateFromLocalStorage(): Promise<number> {
  try {
    const STORAGE_KEY = 'harbor_auto_backups';
    const stored = localStorage.getItem(STORAGE_KEY);
    
    if (!stored) return 0;
    
    const backups = JSON.parse(stored) as BackupData[];
    if (!Array.isArray(backups) || backups.length === 0) return 0;
    
    // Store each backup in IndexedDB
    let migrated = 0;
    for (const backup of backups) {
      try {
        await storeBackup(backup);
        migrated++;
      } catch (error) {
        if (import.meta.env.DEV) console.warn('Failed to migrate backup:', error);
      }
    }
    
    // Remove from localStorage after successful migration
    if (migrated > 0) {
      localStorage.removeItem(STORAGE_KEY);
      if (import.meta.env.DEV) console.log(`Migrated ${migrated} backups from localStorage to IndexedDB`);
    }
    
    return migrated;
  } catch (error) {
    if (import.meta.env.DEV) console.error('Backup migration failed:', error);
    return 0;
  }
}

// ==========================================
// UTILITIES
// ==========================================

/**
 * Convert IDB request to Promise
 */
function promisifyRequest<T = unknown>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize the IndexedDB backup store
 * Performs migration if needed.
 *
 * Prior-batch P2: the prior signature was `Promise<void>` and swallowed
 * init failures into `trackError` — callers (and the module-load
 * auto-init at the bottom of this file) had no way to tell whether the
 * backup store was actually available. Consumers like the Backups UI
 * then rendered as if everything was healthy while IDB was broken.
 * Now returns `Promise<boolean>`: `true` if init succeeded, `false` if
 * any step failed. `trackError` is still invoked for observability on
 * the failure path.
 */
export async function initializeBackupStore(): Promise<boolean> {
  try {
    // Test database access
    const db = await openDatabase();
    db.close();

    // Perform migration if needed
    await migrateFromLocalStorage();

    // Check storage usage
    const estimate = await getStorageEstimate();
    if (estimate.percentUsed > 80) {
      if (import.meta.env.DEV) console.warn(`Backup storage usage high: ${estimate.percentUsed.toFixed(1)}%`);
    }
    return true;
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'initialize_store'
    });
    return false;
  }
}

// Auto-initialize on module load. The return value is logged only in
// DEV so production quietly records failure via trackError inside
// initializeBackupStore but doesn't warn-spam the console.
void initializeBackupStore().then(ok => {
  if (!ok && import.meta.env.DEV) {
    console.warn('initializeBackupStore: backup store is unavailable');
  }
}).catch(err => { if (import.meta.env.DEV) console.error(err); });