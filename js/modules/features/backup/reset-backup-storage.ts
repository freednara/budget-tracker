'use strict';

import { clearAllBackups } from './indexeddb-backup-store.js';

export interface ClearBackupStorageOptions {
  clearPayloads: boolean;
  clearMetadata: boolean;
}

const LOCAL_BACKUP_PAYLOAD_KEY = 'budget_tracker_auto_backups';
const BACKUP_SCHEDULE_KEY = 'budget_tracker_backup_schedule';
const BACKUP_STATUS_KEY = 'budget_tracker_backup_status';
const LEGACY_BACKUP_PREFIX = 'budget_tracker_backup_';

function removeLegacyBackupKeys(): void {
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(LEGACY_BACKUP_PREFIX)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

/**
 * Clear stored backup data and/or backup metadata across all supported storage paths.
 * This is intentionally separate from the main app reset so the caller can choose
 * whether to keep recoverable payloads while still resetting backup scheduling state.
 */
export async function clearBackupStorage(options: ClearBackupStorageOptions): Promise<boolean> {
  try {
    if (options.clearMetadata) {
      localStorage.removeItem(BACKUP_SCHEDULE_KEY);
      localStorage.removeItem(BACKUP_STATUS_KEY);
    }

    if (options.clearPayloads) {
      localStorage.removeItem(LOCAL_BACKUP_PAYLOAD_KEY);
      removeLegacyBackupKeys();

      const cleared = await clearAllBackups();
      if (!cleared) {
        return false;
      }
    }

    return true;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to clear backup storage:', error);
    return false;
  }
}

export default {
  clearBackupStorage
};
