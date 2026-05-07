'use strict';

import { clearAllBackups } from './indexeddb-backup-store.js';

export interface ClearBackupStorageOptions {
  clearPayloads: boolean;
  clearMetadata: boolean;
}

const LOCAL_BACKUP_PAYLOAD_KEY = 'harbor_auto_backups';
const BACKUP_SCHEDULE_KEY = 'harbor_backup_schedule';
const BACKUP_STATUS_KEY = 'harbor_backup_status';
const LEGACY_BACKUP_PREFIX = 'harbor_backup_';

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
    if (options.clearPayloads) {
      // Prior-batch P2: the earlier ordering deleted localStorage
      // payloads FIRST and then attempted `clearAllBackups()`. If the
      // IndexedDB clear failed, we returned `false` but the LS payloads
      // were already gone — a partial wipe that the caller could not
      // distinguish from "nothing happened" and that the user saw as
      // half their recoverable backup history vanishing on a reported
      // failure. Fix: attempt the IDB clear first; only drop the LS
      // payloads once IDB has confirmed the wipe. On IDB failure the
      // LS fallback stays intact and the user can retry without losing
      // state.
      const cleared = await clearAllBackups();
      if (!cleared) {
        return false;
      }
      localStorage.removeItem(LOCAL_BACKUP_PAYLOAD_KEY);
      removeLegacyBackupKeys();
    }

    if (options.clearMetadata) {
      localStorage.removeItem(BACKUP_SCHEDULE_KEY);
      localStorage.removeItem(BACKUP_STATUS_KEY);
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
