/**
 * Storage Registry — single source of truth for every app-owned
 * localStorage key and prefix, annotated with its cleanup behavior
 * during `resetAppData()` in `orchestration/app-reset.ts`.
 *
 * Why this exists (rev 12 #13b M35, Inline-Behavior-Review).
 * Before this module, `app-reset.ts` hardcoded two arrays —
 * `APP_LOCAL_STORAGE_KEYS` and `APP_LOCAL_STORAGE_PREFIXES` — with no
 * consistency contract tying them to the rest of the codebase. Two
 * failure modes resulted, both silently:
 *
 *   1. Dead entries accumulated. The `monthly_totals_cache` prefix
 *      sat in the wipe list for multiple releases after the totals
 *      cache moved to an in-memory Map (see `monthly-totals-cache.ts`
 *      line 65, where `memoryCache` is a JS Map and no localStorage
 *      write ever happens under that prefix).
 *   2. New storage keys added elsewhere in the codebase quietly
 *      stopped being included in reset (error-tracker telemetry
 *      logs, locale settings, key-migration markers, state-revision
 *      Lamport clocks) with no review signal — because the reset
 *      file never had to be touched when those keys were introduced.
 *
 * The registry collapses both failure modes into a single question:
 * "is every `harbor_*` literal in the codebase listed here, with the
 * right cleanup action?". `tests/architecture-contract.test.ts` now
 * answers that question automatically on every CI run.
 *
 * Categories.
 *   - `wipe-in-reset`            Keys/prefixes that app-reset.ts wipes
 *                                 directly via `localStorage.removeItem`.
 *   - `wipe-via-backup-subsystem` Cleared by `clearBackupStorage()` which
 *                                 runs inside `resetAppData()` — registry
 *                                 documents them but app-reset does NOT
 *                                 list them in its direct wipe arrays.
 *   - `preserve-migration`        Intentionally preserved through reset
 *                                 because `migration.ts` reads them to
 *                                 decide whether the IDB migration has
 *                                 already happened. Re-asserted, not
 *                                 wiped, by `restoreMigrationMarkers()`.
 *   - `not-localstorage`          Same `harbor_` prefix but NOT a
 *                                 localStorage key — used for
 *                                 BroadcastChannel names or IDB object
 *                                 stores. Registered so the contract
 *                                 test can whitelist the literal
 *                                 without forcing it into the wipe list.
 *   - `legacy-backup-prefix`      Legacy key prefix that
 *                                 `reset-backup-storage.ts` sweeps and
 *                                 is otherwise unused by live code.
 *
 * Adding a new storage key.
 *   1. Pick a cleanup category.
 *   2. Add an entry below with `{ pattern, type, cleanup, owner }`.
 *   3. If `cleanup === 'wipe-in-reset'`, `app-reset.ts` will pick it
 *      up automatically via `APP_LOCAL_STORAGE_KEYS` /
 *      `APP_LOCAL_STORAGE_PREFIXES` derivations at the bottom of this
 *      file. No edit to `app-reset.ts` is required.
 *   4. The `architecture-contract` literal-coverage test will FAIL
 *      until the new key is listed here.
 *
 * @module core/storage-registry
 */
import { SK } from './state.js';

/**
 * A single storage-key registry entry.
 *
 * `pattern` — the localStorage key or key prefix.
 *   - For `type: 'key'` the pattern is the exact key.
 *   - For `type: 'prefix'` the pattern is a prefix and
 *     `localStorage.key(i).startsWith(pattern)` selects matches.
 *
 * `owner` — a short module path the key originates from, so a
 * future reviewer can trace it back without grepping.
 */
export interface StorageRegistryEntry {
  pattern: string;
  type: 'key' | 'prefix';
  cleanup:
    | 'wipe-in-reset'
    | 'wipe-via-backup-subsystem'
    | 'preserve-migration'
    | 'not-localstorage'
    | 'legacy-backup-prefix';
  owner: string;
  /** Short reason the cleanup category is correct. Optional but encouraged. */
  notes?: string;
}

// ==========================================
// REGISTRY — keep entries grouped by owning subsystem
// ==========================================

export const APP_STORAGE_REGISTRY: readonly StorageRegistryEntry[] = [
  // ---- State signals (SK enum, core/state.ts) -----------------------------
  // All 28 SK.* values are wiped on reset. Listing each SK value instead of
  // `{ pattern: 'harbor_', type: 'prefix', cleanup: 'wipe-in-reset' }` keeps
  // the contract tight — a typo'd key would get caught rather than swept.
  // Phase 6 cleanup (no-explicit-any sweep): SK is typed `StorageKeys`
  // (Record-shape interface), so `Object.values(SK)` falls through to
  // the loose `any[]` overload. Cast the result to `string[]` explicitly
  // so the registry entries below remain fully typed.
  ...(Object.values(SK) as string[]).map((pattern): StorageRegistryEntry => ({
    pattern,
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/state.ts (SK enum)'
  })),

  // ---- localStorage-adapter backing store ---------------------------------
  {
    pattern: 'harbor_metadata',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'data/localstorage-adapter.ts',
    notes: 'Metadata blob that persists the adapter\'s STORES.METADATA table.'
  },
  {
    pattern: 'harbor_lock_',
    type: 'prefix',
    cleanup: 'wipe-in-reset',
    owner: 'data/localstorage-adapter.ts',
    notes: 'Per-key exclusive-lock markers. Wiped so a crashed reset '
      + 'doesn\'t leave stale locks blocking the next write.'
  },
  {
    pattern: 'harbor_web_lock_',
    type: 'prefix',
    cleanup: 'wipe-in-reset',
    owner: 'data/localstorage-adapter.ts',
    notes: 'Web Locks API fallback markers — same rationale as harbor_lock_.'
  },

  // ---- storage-manager rollback & multi-tab sync --------------------------
  {
    pattern: 'harbor_storage_rollback',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'data/storage-manager.ts',
    notes: 'Most recent atomic-write rollback record. Safe to wipe on reset.'
  },
  {
    pattern: 'harbor_storage_rollback_failed',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'data/storage-manager.ts',
    notes: 'Diagnostic log when rollback itself failed. Wiped with reset.'
  },
  {
    pattern: 'harbor_sync_',
    type: 'prefix',
    cleanup: 'wipe-in-reset',
    owner: 'data/storage-manager.ts',
    notes: 'Multi-tab sync message fallback via localStorage events. '
      + 'Ephemeral; cleared on reset to avoid stale cross-tab gossip.'
  },
  {
    pattern: 'harbor_sync',
    type: 'key',
    cleanup: 'not-localstorage',
    owner: 'data/storage-manager.ts / core/multi-tab-sync-broadcast.ts',
    notes: 'BroadcastChannel name, not a localStorage key. Registered so '
      + 'the architecture-contract literal-coverage test recognizes it.'
  },

  // ---- tab identity (sessionStorage, not localStorage) --------------------
  {
    pattern: 'harbor_tab_id',
    type: 'key',
    cleanup: 'not-localstorage',
    owner: 'core/tab-id.ts',
    notes: 'sessionStorage key — persists tab identity across reloads within '
      + 'the same tab session. Not a localStorage key, so listed as '
      + 'not-localstorage for architecture-contract literal coverage.'
  },

  // ---- state-revision (sync/Lamport clock metadata) -----------------------
  {
    pattern: 'harbor_state_revision',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/state-revision.ts',
    notes: 'Revision manifest for cross-device sync. Wiped on reset so the '
      + 'next device comparison starts from a known-fresh baseline.'
  },
  {
    pattern: 'harbor_tx_delta_log',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/state-revision.ts',
    notes: 'Transaction delta buffer (bounded to 64 entries). Wiped on reset.'
  },

  // ---- error-tracker telemetry --------------------------------------------
  {
    pattern: 'harbor_error_log',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/error-tracker.ts',
    notes: 'Persisted error log. Reset is a user-initiated fresh start — '
      + 'prior error breadcrumbs should not carry into the new session.'
  },
  {
    pattern: 'harbor_error_reports',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/error-tracker.ts',
    notes: 'Aggregated error report payloads. Wiped alongside the log.'
  },

  // ---- locale & UI ephemera -----------------------------------------------
  {
    pattern: 'harbor_locale_settings',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'core/locale-service.ts',
    notes: 'Locale overrides the user configured inside the app. Wiped so '
      + 'reset truly restores the first-boot experience.'
  },
  {
    pattern: 'harbor_active_tab',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'ui/core/ui-navigation.ts',
    notes: 'Last-active main tab. Wiped so reset lands on the default tab.'
  },

  // ---- import/export lock -------------------------------------------------
  {
    pattern: 'harbor_import_lock',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'features/import-export/import-export.ts',
    notes: 'In-flight import guard. Wiped so a reset clears any orphaned lock.'
  },

  // ---- key-migration marker -----------------------------------------------
  // NOTE: conceptually a migration marker, but the harbor_key_migration_done
  // key only protects the budget_tracker_* -> harbor_* rename. Once that
  // rename has run, the key set will already be harbor_* — so wiping this
  // marker on reset is safe; the rename will simply no-op on the next boot
  // because there are no budget_tracker_* keys to find.
  {
    pattern: 'harbor_key_migration_done',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'data/key-migration.ts',
    notes: 'Marks the v3.0 rebrand key-rename as complete. Safe to wipe on '
      + 'reset: after v3.0 there are no budget_tracker_* keys to rename, '
      + 'so the next boot\'s migrateStorageKeyNames() is a cheap no-op.'
  },

  // ---- auto-backup (config + payload) -------------------------------------
  {
    pattern: 'harbor_backup_schedule',
    type: 'key',
    cleanup: 'wipe-via-backup-subsystem',
    owner: 'features/backup/auto-backup.ts',
    notes: 'Cleared by clearBackupStorage() which runs inside resetAppData. '
      + 'Not listed in app-reset\'s direct wipe arrays to avoid duplicate work.'
  },
  {
    pattern: 'harbor_backup_status',
    type: 'key',
    cleanup: 'wipe-via-backup-subsystem',
    owner: 'features/backup/auto-backup.ts',
    notes: 'Same as harbor_backup_schedule — owned by the backup subsystem.'
  },
  {
    pattern: 'harbor_auto_backups',
    type: 'key',
    cleanup: 'wipe-via-backup-subsystem',
    owner: 'features/backup/indexeddb-backup-store.ts / reset-backup-storage.ts',
    notes: 'Legacy localStorage fallback for backup payloads. Cleared by '
      + 'clearBackupStorage() when clearPayloads === true.'
  },
  {
    pattern: 'harbor_device_id',
    type: 'key',
    cleanup: 'wipe-via-backup-subsystem',
    owner: 'features/backup/auto-backup.ts',
    notes: 'Stable device identifier for backup metadata. Regenerated after '
      + 'reset clears it; the value itself is non-sensitive.'
  },
  {
    pattern: 'harbor_backup_',
    type: 'prefix',
    cleanup: 'legacy-backup-prefix',
    owner: 'features/backup/reset-backup-storage.ts (LEGACY_BACKUP_PREFIX)',
    notes: 'Swept by reset-backup-storage as a legacy cleanup pass.'
  },

  // ---- IDB object-store names (not localStorage) --------------------------
  {
    pattern: 'harbor_split_tx',
    type: 'key',
    cleanup: 'not-localstorage',
    owner: 'data/indexeddb-adapter.ts',
    notes: 'IndexedDB object-store name, not a localStorage key.'
  },

  // ---- App-owned non-harbor_* entries -------------------------------------
  {
    pattern: 'backup_reminder_last_tx_count',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'orchestration/backup-reminder.ts',
    notes: 'Counter for "you\'ve added N tx since last backup" nag. Reset-wiped.'
  },
  {
    pattern: 'backup_reminder_snooze',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'orchestration/backup-reminder.ts',
    notes: 'User "remind me later" timestamp. Consistent with its sibling '
      + 'backup_reminder_last_tx_count — this pairing was previously missing '
      + 'from the hardcoded wipe list, so a reset left the user still snoozed.'
  },
  {
    pattern: 'backup_reminder_snooze_count',
    type: 'key',
    cleanup: 'wipe-in-reset',
    owner: 'orchestration/backup-reminder.ts',
    notes: 'Snooze counter (max 3 per DEFAULT_CONFIG). Wiped with the snooze '
      + 'timestamp so the fresh session starts with a clean reminder budget.'
  },
  {
    pattern: 'budget_tracker_backup_',
    type: 'prefix',
    cleanup: 'legacy-backup-prefix',
    owner: 'data/migration.ts',
    notes: 'Legacy safety-backup keys written before the IDB migration. '
      + 'Cleared by migration.ts itself during the one-time rollout; this '
      + 'entry registers the literal for the contract test.'
  },

  // ---- Preserved across reset (migration markers) -------------------------
  {
    pattern: 'budget_tracker_idb_migration',
    type: 'key',
    cleanup: 'preserve-migration',
    owner: 'data/migration.ts',
    notes: 'Read by migration.ts to decide whether the LocalStorage → IDB '
      + 'migration has already run. Re-asserted by restoreMigrationMarkers() '
      + 'on every reset — never wiped, else reset would trigger re-migration '
      + 'on the next boot against a hollowed-out store (ADR-001 §9.4).'
  },
  {
    pattern: 'budget_tracker_migrated_to_idb',
    type: 'key',
    cleanup: 'preserve-migration',
    owner: 'data/migration.ts',
    notes: 'Timestamp companion to budget_tracker_idb_migration. Same '
      + 'preservation contract.'
  },
  // ---- Mutex (Web Locks API name prefix) -----------------------------------
  {
    pattern: 'harbor_mutex_',
    type: 'prefix',
    cleanup: 'not-localstorage',
    owner: 'core/mutex.ts',
    notes: 'Web Locks API lock name prefix, not a localStorage key. Registered '
      + 'so the architecture-contract literal-coverage test recognizes it.'
  },

  // INFRA-01 note: harbor_runtime_version and budget_tracker_runtime_version
  // are managed by app.ts (outside js/modules/) and are not registered here.
  // The architecture-contract test scans js/modules/ only, so entries for
  // keys owned by app.ts would appear as "dead" entries.

  // Removed: 'budget_tracker_storage_rollback_failed'. After the harbor_*
  // rename the runtime reader (storage-manager) only looked at
  // `harbor_storage_rollback_failed`, so the legacy name was a dead
  // letter. We unified on the harbor_* name and dropped it from the
  // PRESERVE set so legacy markers get renamed on next boot like any
  // other user-data key. See migration.ts ROLLBACK_FAILURE_KEY comment.
] as const;

// ==========================================
// DERIVED EXPORTS — consumed by app-reset.ts and tests
// ==========================================

/**
 * Exact localStorage keys that `resetAppData()` wipes directly.
 *
 * Derived from registry entries tagged `wipe-in-reset` with `type: 'key'`.
 * Do NOT edit this list by hand — add a registry entry above instead.
 */
export const APP_LOCAL_STORAGE_KEYS: readonly string[] = APP_STORAGE_REGISTRY
  .filter((entry) => entry.cleanup === 'wipe-in-reset' && entry.type === 'key')
  .map((entry) => entry.pattern);

/**
 * localStorage key prefixes that `resetAppData()` sweeps via
 * `localStorage.key(i).startsWith(prefix)`.
 *
 * Derived from registry entries tagged `wipe-in-reset` with `type: 'prefix'`.
 */
export const APP_LOCAL_STORAGE_PREFIXES: readonly string[] = APP_STORAGE_REGISTRY
  .filter((entry) => entry.cleanup === 'wipe-in-reset' && entry.type === 'prefix')
  .map((entry) => entry.pattern);

/**
 * Keys intentionally preserved across `resetAppData()` (migration markers).
 *
 * Surfaced so the architecture-contract test can distinguish "missing from
 * the wipe list by design" from "forgotten". `restoreMigrationMarkers()` is
 * the authoritative writer for these; this export is read-only.
 */
export const PRESERVED_KEYS: readonly string[] = APP_STORAGE_REGISTRY
  .filter((entry) => entry.cleanup === 'preserve-migration')
  .map((entry) => entry.pattern);

/**
 * All patterns tracked by the registry, regardless of cleanup action.
 * Used by the architecture-contract test to assert that every
 * `harbor_*` / `budget_tracker_*` string literal in `js/modules/` is
 * accounted for here.
 */
export const ALL_REGISTERED_PATTERNS: readonly string[] = APP_STORAGE_REGISTRY
  .map((entry) => entry.pattern);
