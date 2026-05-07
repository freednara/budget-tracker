/**
 * One-Time Storage Key Migration
 *
 * Renames all `budget_tracker_*` localStorage keys to `harbor_*` on the
 * first app boot after the v3.0 rebrand. This MUST run before state
 * hydration — otherwise the hydration layer reads from `harbor_*` keys
 * that don't exist yet and the user's data appears to vanish.
 *
 * Three keys are explicitly preserved under their old names because
 * `migration.ts` still reads them to decide whether the LocalStorage →
 * IndexedDB migration has already run. See ADR-001 §9.4.
 *
 * @module key-migration
 */
'use strict';

const DONE_KEY = 'harbor_key_migration_done';
const OLD_PREFIX = 'budget_tracker_';
const NEW_PREFIX = 'harbor_';

/**
 * Keys that must NOT be renamed — they are read by migration.ts under
 * their legacy names to determine whether the IDB migration already ran.
 *
 * `budget_tracker_storage_rollback_failed` used to live here, but the
 * harbor_* rename left it with no production reader (storage-manager
 * reads `harbor_storage_rollback_failed`, migration.ts now writes the
 * same name). Removing it from PRESERVE means any legacy marker still
 * in a returning user's localStorage gets automatically renamed to the
 * unified key on next boot and is finally readable again.
 */
const PRESERVE = new Set([
  'budget_tracker_idb_migration',
  'budget_tracker_migrated_to_idb',
]);

/**
 * Run the one-time key migration. Safe to call on every boot — it no-ops
 * after the first successful run.
 */
export function migrateStorageKeyNames(): void {
  // Already done?
  if (localStorage.getItem(DONE_KEY)) return;

  // Collect keys first to avoid mutating during iteration
  const keysToMigrate: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(OLD_PREFIX) && !PRESERVE.has(key)) {
      keysToMigrate.push(key);
    }
  }

  // Nothing to migrate? Still mark done so we don't re-scan every boot.
  if (keysToMigrate.length === 0) {
    try { localStorage.setItem(DONE_KEY, Date.now().toString()); } catch { /* quota — will re-scan next boot, harmless */ }
    return;
  }

  // Copy-then-delete rather than rename (localStorage has no rename API).
  // If the new key already exists (e.g. a partial prior migration or manual
  // edit), keep the new key's value — it is more recent — and just remove
  // the stale old key.
  //
  // Wrapped in try/catch because localStorage.setItem can throw
  // QuotaExceededError. If that happens mid-migration, the DONE_KEY marker
  // is NOT set, so the next boot will re-attempt. The collision guard above
  // ensures re-runs are safe — already-migrated keys won't be overwritten.
  try {
    for (const oldKey of keysToMigrate) {
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
      if (localStorage.getItem(newKey) !== null) {
        // New key already present — discard the old one, don't overwrite.
        localStorage.removeItem(oldKey);
      } else {
        const value = localStorage.getItem(oldKey);
        if (value !== null) {
          localStorage.setItem(newKey, value);
          localStorage.removeItem(oldKey);
        }
      }
    }

    localStorage.setItem(DONE_KEY, Date.now().toString());

    if (import.meta.env.DEV) {
      console.log(`[key-migration] Migrated ${keysToMigrate.length} keys from budget_tracker_* → harbor_*`);
    }
  } catch (err) {
    // Quota exceeded or storage disabled. The migration is incomplete but
    // safe to retry: the collision guard prevents data loss on re-run, and
    // the missing DONE_KEY ensures we try again on the next boot.
    console.warn('[key-migration] Migration interrupted — will retry on next boot:', err);
  }
}
