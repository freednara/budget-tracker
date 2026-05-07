/**
 * Migration Module
 *
 * Handles one-time migration from localStorage to IndexedDB.
 * Provides progress tracking, verification, and rollback capabilities.
 *
 * @module migration
 */

import { storageManager, STORES } from './storage-manager.js';
import { SK, lsGet, BACKUP_REMINDER_TX_COUNT_KEY } from '../core/state.js';
import { generateId } from '../core/utils-pure.js';
import { trackError } from '../core/error-tracker.js';
import type {
  MigrationStatus,
  MigrationProgressCallback,
  Transaction,
  SavingsGoal,
  SavingsContribution,
  MonthlyAllocation,
  CustomCategory,
  Debt,
  FilterPreset,
  TxTemplate,
  StreakData,
  RolloverSettings,
  CurrencySettings,
  SectionsConfig,
  AlertPrefs,
  InsightPersonality
} from '../../types/index.js';
import type { OnboardingState } from '../core/signals.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface LocalStorageData {
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  savingsContribs: SavingsContribution[];
  monthlyAlloc: Record<string, MonthlyAllocation>;
  achievements: Record<string, unknown>;
  streak: StreakData | null;
  customCats: CustomCategory[];
  debts: Debt[];
  filterPresets: FilterPreset[];
  txTemplates: TxTemplate[];
  rolloverSettings: RolloverSettings | null;
  currency: CurrencySettings | null;
  theme: string | null;
  pin: string | null;
  sections: SectionsConfig | null;
  insightPers: InsightPersonality | null;
  alerts: AlertPrefs | null;
  // CR-Apr24-I finding 170: previously omitted persisted settings
  onboarding: OnboardingState | null;
  filterExpanded: boolean;
  lastBackupTxCount: number;
  recurring: Record<string, unknown>;
  hasOnboarded: boolean;
}

// Fixes H9 (Inline-Behavior-Review rev 12): the snapshot must cover every
// localStorage key that _readLocalStorage migrates out, including PIN. The
// previous Omit<'pin'> made rollback silently lose the user's PIN — the
// only auth credential — on any mid-migration failure. Keep this alias
// equal to LocalStorageData; if a new key is added to one, it MUST appear
// in the other, and the matching _createBackupSnapshot / _restoreFromBackup
// changes below are the other half of the contract.
type LocalStorageBackupSnapshot = LocalStorageData;

interface MigrationResult {
  isOk: boolean;
  migrated?: number;
  error?: string;
}

interface StorageSnapshot extends Record<string, unknown> {
  _meta?: unknown;
  _exportErrors?: Record<string, string>;
}

// ==========================================
// MIGRATION STATUS
// ==========================================

// PRESERVED ACROSS HARBOR LEDGER RENAME (ADR-001 §9.4): renaming this key
// would cause existing users to re-run the IDB migration on their already-
// migrated data. Do NOT include in the budget_tracker_* → harbor_* sweep.
// A contract test in tests/migration-key-preservation.test.ts enforces this.
const MIGRATION_KEY = 'budget_tracker_idb_migration';

// Unified with storage-manager's rollback-failure marker. The runtime path
// (storage-manager._recordRollbackFailure) and the migration-time rollback
// path now both write this single key, and storage-manager.init() reads it
// to force a safe localStorage fallback on the next boot. Previously this
// was the legacy budget_tracker_* variant — which had no production reader
// after the harbor_* rename, so migration-time rollback failures silently
// lost their "force fallback" signal. Legacy markers still in a returning
// user's localStorage get renamed to this key automatically by
// key-migration.ts on next boot (intentionally NOT in its PRESERVE set).
const ROLLBACK_FAILURE_KEY = 'harbor_storage_rollback_failed';

// ==========================================
// MIGRATION MANAGER CLASS
// ==========================================

export class MigrationManager {
  private readonly BATCH_SIZE: number = 100;

  constructor() {
    // BATCH_SIZE is already initialized
  }

  /**
   * Check if migration is needed
   */
  async needsMigration(): Promise<boolean> {
    // Not needed if not using IndexedDB
    if (!storageManager.isUsingIndexedDB()) {
      return false;
    }

    // Check localStorage for migration flag
    const status = this._getMigrationStatus();
    if (status?.completed) {
      return false;
    }

    // New-batch P2: previously this short-circuited on
    // `lsGet(SK.TX, [])` only, so a user with no transactions but
    // populated settings / debts / goals / achievements was reported
    // as "nothing to migrate" and their existing data never moved to
    // IndexedDB. Consult the same read+count helpers `migrate()` uses
    // so the needs-check and the actual migration agree.
    const localData = this._readLocalStorage();
    return this._countItems(localData) > 0;
  }

  /**
   * Get the current migration status
   */
  private _getMigrationStatus(): MigrationStatus | null {
    try {
      const status = localStorage.getItem(MIGRATION_KEY);
      return status ? JSON.parse(status) as MigrationStatus : null;
    } catch {
      return null;
    }
  }

  /**
   * Set the migration status
   */
  private _setMigrationStatus(status: MigrationStatus): void {
    try {
      localStorage.setItem(MIGRATION_KEY, JSON.stringify(status));
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Failed to save migration status:', err);
    }
  }

  /**
   * Perform the migration from localStorage to IndexedDB
   * FIXED: Added proper backup before migration for safe rollback
   */
  async migrate(progressCallback: MigrationProgressCallback = () => {}): Promise<MigrationResult> {
    // Create backup snapshot before migration
    const backupKey = `budget_tracker_backup_${Date.now()}`;
    const migrationBackup = this._createBackupSnapshot();
    let indexedDbBackup: StorageSnapshot | null = null;
    
    try {
      progressCallback({ phase: 'reading', progress: 0 });

      // Save backup before proceeding — abort migration if backup fails
      try {
        localStorage.setItem(backupKey, JSON.stringify(migrationBackup));
      } catch (_e) {
        if (import.meta.env.DEV) console.error('Could not create migration backup, aborting migration');
        return { isOk: false, error: 'Failed to create backup before migration' };
      }

      // Snapshot IndexedDB before any destructive steps so we can restore it first on failure
      try {
        indexedDbBackup = await storageManager.exportAll() as StorageSnapshot;
        if (indexedDbBackup._exportErrors && Object.keys(indexedDbBackup._exportErrors).length > 0) {
          throw new Error('Failed to capture a complete IndexedDB snapshot before migration');
        }
      } catch (snapshotErr) {
        if (import.meta.env.DEV) console.error('Could not snapshot IndexedDB before migration:', snapshotErr);
        progressCallback({
          phase: 'error',
          progress: 0,
          error: 'Failed to snapshot IndexedDB before migration'
        });
        return { isOk: false, error: 'Failed to snapshot IndexedDB before migration' };
      }

      // Read all localStorage data
      const localData = this._readLocalStorage();
      const totalItems = this._countItems(localData);

      if (totalItems === 0) {
        // No data to migrate, mark as complete
        this._setMigrationStatus({
          completed: true,
          timestamp: Date.now(),
          version: '2.7',
          itemCount: 0
        });
        progressCallback({ phase: 'complete', progress: 100 });
        return { isOk: true, migrated: 0 };
      }

      progressCallback({ phase: 'migrating', progress: 2 });

      // Clear any existing IDB data from previous failed migration attempts
      // to prevent duplicate key errors on objectStore.add()
      try {
        await storageManager.clear(STORES.TRANSACTIONS);
        await storageManager.clear(STORES.SETTINGS);
        await storageManager.clear(STORES.SAVINGS_GOALS);
        await storageManager.clear(STORES.SAVINGS_CONTRIBUTIONS);
        await storageManager.clear(STORES.MONTHLY_ALLOCATIONS);
        await storageManager.clear(STORES.ACHIEVEMENTS);
        await storageManager.clear(STORES.STREAK);
        await storageManager.clear(STORES.CUSTOM_CATEGORIES);
        await storageManager.clear(STORES.DEBTS);
        await storageManager.clear(STORES.FILTER_PRESETS);
        await storageManager.clear(STORES.TX_TEMPLATES);
      } catch {
        // Stores may not exist yet on fresh DB — safe to ignore
      }

      progressCallback({ phase: 'migrating', progress: 5 });

      // Migrate transactions in batches
      let migratedCount = 0;
      const transactions = localData.transactions || [];

      // Ensure every transaction has a valid unique __backendId (required by IDB keyPath)
      const seenIds = new Set<string>();
      for (const tx of transactions) {
        if (!tx.__backendId || seenIds.has(tx.__backendId)) {
          tx.__backendId = generateId();
        }
        seenIds.add(tx.__backendId);
      }

      if (transactions.length > 0) {
        for (let i = 0; i < transactions.length; i += this.BATCH_SIZE) {
          const batch = transactions.slice(i, i + this.BATCH_SIZE);
          await storageManager.createBatch(STORES.TRANSACTIONS, batch);
          migratedCount += batch.length;

          const progress = 5 + (migratedCount / transactions.length) * 50;
          progressCallback({
            phase: 'migrating',
            progress,
            current: migratedCount,
            total: transactions.length
          });
        }
      }

      progressCallback({ phase: 'migrating', progress: 55 });

      // Migrate savings goals
      if (localData.savingsGoals && Object.keys(localData.savingsGoals).length > 0) {
        const goals = Object.entries(localData.savingsGoals).map(([id, goal]) => ({
          ...goal,
          id
        }));
        await storageManager.createBatch(STORES.SAVINGS_GOALS, goals);
      }

      progressCallback({ phase: 'migrating', progress: 60 });

      // Migrate savings contributions
      if (localData.savingsContribs && localData.savingsContribs.length > 0) {
        await storageManager.createBatch(STORES.SAVINGS_CONTRIBUTIONS, localData.savingsContribs);
      }

      progressCallback({ phase: 'migrating', progress: 65 });

      // Migrate monthly allocations
      if (localData.monthlyAlloc && Object.keys(localData.monthlyAlloc).length > 0) {
        const allocations = Object.entries(localData.monthlyAlloc).map(([monthKey, data]) => ({
          monthKey,
          ...data
        }));
        await storageManager.createBatch(STORES.MONTHLY_ALLOCATIONS, allocations);
      }

      progressCallback({ phase: 'migrating', progress: 70 });

      // Migrate achievements
      if (localData.achievements && Object.keys(localData.achievements).length > 0) {
        const achievements = Object.entries(localData.achievements).map(([id, data]) => ({
          id,
          ...(data as Record<string, unknown>)
        }));
        await storageManager.createBatch(STORES.ACHIEVEMENTS, achievements);
      }

      progressCallback({ phase: 'migrating', progress: 75 });

      // Migrate streak
      if (localData.streak) {
        await storageManager.set(STORES.STREAK, 'current', localData.streak);
      }

      // Migrate custom categories
      if (localData.customCats && localData.customCats.length > 0) {
        await storageManager.createBatch(STORES.CUSTOM_CATEGORIES, localData.customCats);
      }

      progressCallback({ phase: 'migrating', progress: 80 });

      // Migrate debts
      if (localData.debts && localData.debts.length > 0) {
        await storageManager.createBatch(STORES.DEBTS, localData.debts);
      }

      // Migrate filter presets
      if (localData.filterPresets && localData.filterPresets.length > 0) {
        await storageManager.createBatch(STORES.FILTER_PRESETS, localData.filterPresets);
      }

      // Migrate transaction templates
      if (localData.txTemplates && localData.txTemplates.length > 0) {
        await storageManager.createBatch(STORES.TX_TEMPLATES, localData.txTemplates);
      }

      progressCallback({ phase: 'migrating', progress: 85 });

      // Migrate settings (individual keys)
      await this._migrateSettings(localData);

      progressCallback({ phase: 'verifying', progress: 90 });

      // Verify migration
      const verified = await this._verifyMigration(localData);

      if (!verified) {
        throw new Error('Migration verification failed');
      }

      progressCallback({ phase: 'verifying', progress: 95 });

      // Mark migration as complete
      this._setMigrationStatus({
        completed: true,
        timestamp: Date.now(),
        version: '2.7',
        itemCount: totalItems
      });

      // Keep localStorage data as backup (don't delete)
      // Just mark that migration happened
      // PRESERVED ACROSS HARBOR LEDGER RENAME (ADR-001 §9.4) — see MIGRATION_KEY comment.
      localStorage.setItem('budget_tracker_migrated_to_idb', Date.now().toString());

      // Clean up old backup keys, keeping only the most recent one
      this._cleanupOldBackups();

      progressCallback({ phase: 'complete', progress: 100 });

      return { isOk: true, migrated: totalItems };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err ?? 'Unknown migration error');
      if (import.meta.env.DEV) console.error('Migration failed:', err);

      // Attempt to restore from backup
      try {
        if (indexedDbBackup) {
          const importableData: Record<string, unknown> = { ...indexedDbBackup };
          delete importableData._meta;
          delete importableData._exportErrors;
          const restoredIndexedDb = await storageManager.importAll(importableData, true);
          if (restoredIndexedDb) {
            if (import.meta.env.DEV) console.log('Migration rollback: restored IndexedDB snapshot');
          } else {
            throw new Error('Failed to restore IndexedDB snapshot during migration rollback');
          }
        }
      } catch (restoreErr) {
        if (import.meta.env.DEV) console.error('IndexedDB rollback failed, restoring localStorage backup:', restoreErr);
        try {
          const backupData = localStorage.getItem(backupKey);
          if (backupData) {
            this._restoreFromBackup(JSON.parse(backupData));
            localStorage.setItem(ROLLBACK_FAILURE_KEY, JSON.stringify({
              reason: 'migration_indexeddb_restore_failed',
              timestamp: Date.now()
            }));
            if (import.meta.env.DEV) console.log('Migration rollback: restored from localStorage backup');
          }
        } catch (localRestoreErr) {
          // Fixes H10 (Inline-Behavior-Review rev 12): this is the single
          // worst failure mode in the data layer — the user has lost data
          // AND we can't restore it. Previously DEV-only, now logged
          // unconditionally AND stamped into ROLLBACK_FAILURE_KEY so the
          // next boot can surface a recovery prompt.
          if (import.meta.env.DEV) console.error('Migration rollback also failed:', localRestoreErr);
          trackError(localRestoreErr instanceof Error ? localRestoreErr : new Error(String(localRestoreErr)), {
            module: 'migration',
            action: 'rollback.localStorageRestore.FAILED'
          });
          try {
            localStorage.setItem(ROLLBACK_FAILURE_KEY, JSON.stringify({
              reason: 'migration_rollback_total_failure',
              timestamp: Date.now(),
              error: localRestoreErr instanceof Error ? localRestoreErr.message : String(localRestoreErr)
            }));
          } catch {
            // localStorage itself is broken — nothing more we can do here.
          }
        }
      }

      progressCallback({ phase: 'error', progress: 0, error: errorMsg });
      return { isOk: false, error: errorMsg };
    }
  }

  /**
   * Read all data from localStorage
   */
  private _readLocalStorage(): LocalStorageData {
    return {
      transactions: lsGet(SK.TX, []) as Transaction[],
      savingsGoals: lsGet(SK.SAVINGS, {}) as Record<string, SavingsGoal>,
      savingsContribs: lsGet(SK.SAVINGS_CONTRIB, []) as SavingsContribution[],
      monthlyAlloc: lsGet(SK.ALLOC, {}) as Record<string, MonthlyAllocation>,
      achievements: lsGet(SK.ACHIEVE, {}) as Record<string, unknown>,
      streak: lsGet(SK.STREAK, null) as StreakData | null,
      customCats: lsGet(SK.CUSTOM_CAT, []) as CustomCategory[],
      debts: lsGet(SK.DEBTS, []) as Debt[],
      filterPresets: lsGet(SK.FILTER_PRESETS, []) as FilterPreset[],
      txTemplates: lsGet(SK.TX_TEMPLATES, []) as TxTemplate[],
      rolloverSettings: lsGet(SK.ROLLOVER_SETTINGS, null) as RolloverSettings | null,
      currency: lsGet(SK.CURRENCY, null) as CurrencySettings | null,
      theme: lsGet(SK.THEME, null) as string | null,
      pin: lsGet(SK.PIN, null) as string | null,
      sections: lsGet(SK.SECTIONS, null) as SectionsConfig | null,
      insightPers: lsGet(SK.INSIGHT_PERS, null) as InsightPersonality | null,
      alerts: lsGet(SK.ALERTS, null) as AlertPrefs | null,
      // CR-Apr24-I finding 170: these persisted settings were previously
      // omitted from the migration pipeline, meaning a user who only had
      // onboarding state, filter prefs, recurring templates, or a backup-
      // reminder tx count would silently lose them on IDB migration.
      onboarding: lsGet(SK.ONBOARD, null) as OnboardingState | null,
      filterExpanded: lsGet(SK.FILTER_EXPANDED, false) as boolean,
      lastBackupTxCount: lsGet(BACKUP_REMINDER_TX_COUNT_KEY, 0) as number,
      recurring: lsGet(SK.RECURRING, {}) as Record<string, unknown>,
      hasOnboarded: lsGet(SK.HAS_ONBOARDED, false) as boolean
    };
  }

  /**
   * Count total items to migrate
   */
  private _countItems(data: LocalStorageData): number {
    let count = 0;

    count += (data.transactions || []).length;
    count += Object.keys(data.savingsGoals || {}).length;
    count += (data.savingsContribs || []).length;
    count += Object.keys(data.monthlyAlloc || {}).length;
    count += Object.keys(data.achievements || {}).length;
    count += data.streak ? 1 : 0;
    count += (data.customCats || []).length;
    count += (data.debts || []).length;
    count += (data.filterPresets || []).length;
    count += (data.txTemplates || []).length;

    // New-batch P2: settings-only cold-starts were previously miscounted
    // as empty, causing `migrate()` to mark the migration complete
    // without ever moving the user's theme, currency, PIN, etc. into
    // IndexedDB. Count each populated settings slot so a settings-only
    // localStorage gets a non-zero count and flows through the real
    // migration path.
    if (data.rolloverSettings) count += 1;
    if (data.currency) count += 1;
    if (data.theme) count += 1;
    if (data.pin) count += 1;
    if (data.sections) count += 1;
    if (data.insightPers) count += 1;
    if (data.alerts) count += 1;
    // CR-Apr24-I finding 170: count the previously omitted settings
    if (data.onboarding) count += 1;
    if (data.filterExpanded) count += 1;
    if (data.lastBackupTxCount > 0) count += 1;
    if (Object.keys(data.recurring || {}).length > 0) count += 1;
    if (data.hasOnboarded) count += 1;

    return count;
  }

  /**
   * Migrate settings to IndexedDB
   */
  private async _migrateSettings(localData: LocalStorageData): Promise<void> {
    const settings: [string, unknown][] = [
      ['rolloverSettings', localData.rolloverSettings],
      ['currency', localData.currency],
      ['theme', localData.theme],
      ['pin', localData.pin],
      ['sections', localData.sections],
      ['insightPersonality', localData.insightPers],
      ['alerts', localData.alerts],
      // CR-Apr24-I finding 170: migrate the previously omitted settings
      ['onboarding', localData.onboarding],
      ['filterExpanded', localData.filterExpanded],
      ['lastBackupTxCount', localData.lastBackupTxCount],
      ['recurring', localData.recurring],
      ['hasOnboarded', localData.hasOnboarded]
    ];

    for (const [key, value] of settings) {
      if (value !== null && value !== undefined) {
        await storageManager.set(STORES.SETTINGS, key, value);
      }
    }
  }

  private _normalizeForComparison(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this._normalizeForComparison(item)).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, itemValue]) => [key, this._normalizeForComparison(itemValue)]);
      return Object.fromEntries(entries);
    }

    return value;
  }

  private _valuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(this._normalizeForComparison(left)) === JSON.stringify(this._normalizeForComparison(right));
  }

  /**
   * Extract the logical value from an IDB settings record.
   * The IndexedDB adapter wraps settings: primitives become { key, value }
   * and objects become { key, ...originalObj }. This strips the keyPath
   * field so verification can compare against the original unwrapped value.
   */
  private _extractSettingValue(idbRecord: unknown): unknown {
    if (idbRecord && typeof idbRecord === 'object' && !Array.isArray(idbRecord)) {
      const record = { ...(idbRecord as Record<string, unknown>) };
      delete record.key; // Remove IDB keyPath field
      const keys = Object.keys(record);
      // If only 'value' remains, this was a wrapped primitive
      if (keys.length === 1 && keys[0] === 'value') {
        return record.value;
      }
      return record;
    }
    return idbRecord;
  }

  /**
   * Verify migration was successful
   */
  private async _verifyMigration(originalData: LocalStorageData): Promise<boolean> {
    try {
      const expectedStoreValues: Array<[typeof STORES[keyof typeof STORES], unknown]> = [
        [STORES.TRANSACTIONS, originalData.transactions || []],
        [STORES.SAVINGS_GOALS, Object.entries(originalData.savingsGoals || {}).map(([id, goal]) => ({ ...goal, id }))],
        [STORES.SAVINGS_CONTRIBUTIONS, originalData.savingsContribs || []],
        [STORES.MONTHLY_ALLOCATIONS, Object.entries(originalData.monthlyAlloc || {}).map(([monthKey, data]) => ({ monthKey, ...data }))],
        [STORES.ACHIEVEMENTS, Object.entries(originalData.achievements || {}).map(([id, data]) => ({ id, ...(data as Record<string, unknown>) }))],
        [STORES.STREAK, originalData.streak ? [{ ...(originalData.streak as unknown as Record<string, unknown>), id: 'current' }] : []],
        [STORES.CUSTOM_CATEGORIES, originalData.customCats || []],
        [STORES.DEBTS, originalData.debts || []],
        [STORES.FILTER_PRESETS, originalData.filterPresets || []],
        [STORES.TX_TEMPLATES, originalData.txTemplates || []]
      ];

      for (const [storeName, expected] of expectedStoreValues) {
        const actual = await storageManager.getAll(storeName);
        if (!this._valuesEqual(actual, expected)) {
          if (import.meta.env.DEV) console.error(`Migration verification mismatch for store ${storeName}`);
          return false;
        }
      }

      const expectedSettings: Array<[string, unknown]> = [
        ['rolloverSettings', originalData.rolloverSettings],
        ['currency', originalData.currency],
        ['theme', originalData.theme],
        ['pin', originalData.pin],
        ['sections', originalData.sections],
        ['insightPersonality', originalData.insightPers],
        ['alerts', originalData.alerts],
        // CR-Apr24-I finding 171: verify the previously omitted settings
        // so verification can't falsely report success after skipping them.
        ['onboarding', originalData.onboarding],
        ['filterExpanded', originalData.filterExpanded],
        ['lastBackupTxCount', originalData.lastBackupTxCount],
        ['recurring', originalData.recurring],
        ['hasOnboarded', originalData.hasOnboarded]
      ];

      for (const [key, expected] of expectedSettings) {
        const raw = await storageManager.get(STORES.SETTINGS, key);
        if (expected === null || expected === undefined) {
          if (raw !== undefined) {
            if (import.meta.env.DEV) console.error(`Migration verification mismatch for setting ${key}`);
            return false;
          }
          continue;
        }

        // The IDB adapter wraps settings with a keyPath field ('key').
        // Strip it so we compare against the original unwrapped value.
        const actual = this._extractSettingValue(raw);
        if (!this._valuesEqual(actual, expected)) {
          if (import.meta.env.DEV) console.error(`Migration verification mismatch for setting ${key}`);
          return false;
        }
      }

      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Verification error:', err);
      return false;
    }
  }

  /**
   * Create a backup snapshot of all localStorage data
   * FIXED: Added for safe rollback capability
   */
  private _createBackupSnapshot(): LocalStorageBackupSnapshot {
    return {
      transactions: lsGet(SK.TX, []) as Transaction[],
      savingsGoals: lsGet(SK.SAVINGS, {}) as Record<string, SavingsGoal>,
      savingsContribs: lsGet(SK.SAVINGS_CONTRIB, []) as SavingsContribution[],
      monthlyAlloc: lsGet(SK.ALLOC, {}) as Record<string, MonthlyAllocation>,
      achievements: lsGet(SK.ACHIEVE, {}) as Record<string, unknown>,
      streak: lsGet(SK.STREAK, null) as StreakData | null,
      customCats: lsGet(SK.CUSTOM_CAT, []) as CustomCategory[],
      debts: lsGet(SK.DEBTS, []) as Debt[],
      filterPresets: lsGet(SK.FILTER_PRESETS, []) as FilterPreset[],
      txTemplates: lsGet(SK.TX_TEMPLATES, []) as TxTemplate[],
      rolloverSettings: lsGet(SK.ROLLOVER_SETTINGS, null) as RolloverSettings | null,
      currency: lsGet(SK.CURRENCY, null) as CurrencySettings | null,
      theme: lsGet(SK.THEME, null) as string | null,
      // Fixes H9 (Inline-Behavior-Review rev 12): snapshot the PIN so rollback
      // can restore it. Omitting it silently erased the user's only auth
      // credential on any mid-migration failure.
      pin: lsGet(SK.PIN, null) as string | null,
      sections: lsGet(SK.SECTIONS, null) as SectionsConfig | null,
      insightPers: lsGet(SK.INSIGHT_PERS, null) as InsightPersonality | null,
      alerts: lsGet(SK.ALERTS, null) as AlertPrefs | null,
      // CR-Apr24-I finding 172: snapshot the previously omitted settings
      // so rollback can restore them. Without these, a mid-migration
      // failure would silently lose onboarding progress, filter state,
      // backup-reminder counters, and recurring templates.
      onboarding: lsGet(SK.ONBOARD, null) as OnboardingState | null,
      filterExpanded: lsGet(SK.FILTER_EXPANDED, false) as boolean,
      lastBackupTxCount: lsGet(BACKUP_REMINDER_TX_COUNT_KEY, 0) as number,
      recurring: lsGet(SK.RECURRING, {}) as Record<string, unknown>,
      hasOnboarded: lsGet(SK.HAS_ONBOARDED, false) as boolean
    };
  }

  /**
   * Clean up old backup keys from localStorage, keeping only the most recent one
   */
  private _cleanupOldBackups(): void {
    try {
      const backupKeys = Object.keys(localStorage).filter(k => k.startsWith('budget_tracker_backup_'));
      if (backupKeys.length <= 1) return;

      // Sort by timestamp (newest first)
      backupKeys.sort((a, b) => {
        const aTime = parseInt(a.split('_').pop() || '0');
        const bTime = parseInt(b.split('_').pop() || '0');
        return bTime - aTime;
      });

      // Remove all but the most recent backup.
      // Phase 6 Slice 1i (rev 12 L6): `backupKeys[i]` is
      // `string | undefined` under `noUncheckedIndexedAccess`; the
      // `i < backupKeys.length` bound guarantees presence, but a local
      // pull keeps `removeItem` argument typed without an assertion.
      for (let i = 1; i < backupKeys.length; i++) {
        const key = backupKeys[i];
        if (key) localStorage.removeItem(key);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Failed to clean up old backups:', err);
    }
  }

  /**
   * Restore from a backup snapshot
   * FIXED: Added for proper rollback capability
   */
  private _restoreFromBackup(backup: LocalStorageBackupSnapshot): boolean {
    try {
      const setOptionalJson = (key: string, value: unknown): void => {
        if (value === null || value === undefined) {
          localStorage.removeItem(key);
          return;
        }
        localStorage.setItem(key, JSON.stringify(value));
      };

      // Restore all localStorage data
      localStorage.setItem(SK.TX, JSON.stringify(backup.transactions));
      localStorage.setItem(SK.SAVINGS, JSON.stringify(backup.savingsGoals));
      localStorage.setItem(SK.SAVINGS_CONTRIB, JSON.stringify(backup.savingsContribs));
      localStorage.setItem(SK.ALLOC, JSON.stringify(backup.monthlyAlloc));
      localStorage.setItem(SK.ACHIEVE, JSON.stringify(backup.achievements));
      setOptionalJson(SK.STREAK, backup.streak);
      localStorage.setItem(SK.CUSTOM_CAT, JSON.stringify(backup.customCats));
      localStorage.setItem(SK.DEBTS, JSON.stringify(backup.debts));
      localStorage.setItem(SK.FILTER_PRESETS, JSON.stringify(backup.filterPresets));
      localStorage.setItem(SK.TX_TEMPLATES, JSON.stringify(backup.txTemplates));
      setOptionalJson(SK.ROLLOVER_SETTINGS, backup.rolloverSettings);
      setOptionalJson(SK.CURRENCY, backup.currency);
      setOptionalJson(SK.THEME, backup.theme);
      // Fixes H9 (Inline-Behavior-Review rev 12): restore the PIN too. The
      // snapshot now captures it (see _createBackupSnapshot); without this
      // line rollback would still silently wipe it.
      setOptionalJson(SK.PIN, backup.pin);
      setOptionalJson(SK.SECTIONS, backup.sections);
      setOptionalJson(SK.INSIGHT_PERS, backup.insightPers);
      setOptionalJson(SK.ALERTS, backup.alerts);
      // CR-Apr24-I finding 172: restore the previously omitted settings
      setOptionalJson(SK.ONBOARD, backup.onboarding);
      localStorage.setItem(SK.FILTER_EXPANDED, JSON.stringify(backup.filterExpanded));
      localStorage.setItem(BACKUP_REMINDER_TX_COUNT_KEY, JSON.stringify(backup.lastBackupTxCount));
      localStorage.setItem(SK.RECURRING, JSON.stringify(backup.recurring));
      localStorage.setItem(SK.HAS_ONBOARDED, JSON.stringify(backup.hasOnboarded));

      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to restore backup:', err);
      return false;
    }
  }

  /**
   * Rollback migration (restore localStorage as primary)
   * FIXED: Now properly restores from backup if available
   */
  async rollback(): Promise<boolean> {
    try {
      // Look for the most recent backup
      const backupKeys = Object.keys(localStorage).filter(k => k.startsWith('budget_tracker_backup_'));
      
      if (backupKeys.length > 0) {
        // Sort by timestamp (newest first)
        backupKeys.sort((a, b) => {
          const aTime = parseInt(a.split('_').pop() || '0');
          const bTime = parseInt(b.split('_').pop() || '0');
          return bTime - aTime;
        });
        
        // Restore from the most recent backup.
        // Phase 6 Slice 1i (rev 12 L6): `backupKeys[0]` is
        // `string | undefined` under `noUncheckedIndexedAccess`; pull
        // into a local and guard before calling `localStorage.getItem`.
        const topKey = backupKeys[0];
        if (topKey) {
          const backupData = localStorage.getItem(topKey);
          if (backupData) {
            const backup = JSON.parse(backupData) as LocalStorageData;
            // CR-Apr24-I finding 173: check the return value instead of
            // ignoring it. A false return means at least one setItem threw
            // (e.g. quota exceeded), so the user's data is only partially
            // restored — propagate as a failed rollback.
            const restored = this._restoreFromBackup(backup);
            if (!restored) {
              if (import.meta.env.DEV) console.error('Rollback: _restoreFromBackup returned false for:', topKey);
              trackError(new Error('Migration rollback: backup restore failed'), {
                module: 'migration',
                action: 'rollback.restoreFromBackup.FAILED'
              });
              return false;
            }
            if (import.meta.env.DEV) console.log('Restored from backup:', topKey);
          }
        }
      }

      // Clear migration status
      localStorage.removeItem(MIGRATION_KEY);
      // PRESERVED ACROSS HARBOR LEDGER RENAME (ADR-001 §9.4) — see MIGRATION_KEY comment.
      localStorage.removeItem('budget_tracker_migrated_to_idb');

      // Storage manager will use localStorage on next init
      storageManager.reset();

      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Rollback failed:', err);
      return false;
    }
  }

  /**
   * Check if migration was completed
   */
  isMigrationCompleted(): boolean {
    const status = this._getMigrationStatus();
    return status?.completed === true;
  }

  /**
   * Get migration info
   */
  getMigrationInfo(): MigrationStatus | null {
    return this._getMigrationStatus();
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const migrationManager = new MigrationManager();
