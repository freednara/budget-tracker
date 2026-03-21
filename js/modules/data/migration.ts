/**
 * Migration Module
 *
 * Handles one-time migration from localStorage to IndexedDB.
 * Provides progress tracking, verification, and rollback capabilities.
 *
 * @module migration
 */

import { storageManager, STORES } from './storage-manager.js';
import { SK, lsGet } from '../core/state.js';
import { generateId } from '../core/utils.js';
import type {
  MigrationStatus,
  MigrationProgress,
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
}

interface MigrationResult {
  isOk: boolean;
  migrated?: number;
  error?: string;
}

// ==========================================
// MIGRATION STATUS
// ==========================================

const MIGRATION_KEY = 'budget_tracker_idb_migration';

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

    // Check if there's data in localStorage to migrate
    const transactions = lsGet(SK.TX, []) as Transaction[];
    return transactions.length > 0;
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
    
    try {
      progressCallback({ phase: 'reading', progress: 0 });

      // Save backup before proceeding — abort migration if backup fails
      try {
        localStorage.setItem(backupKey, JSON.stringify(migrationBackup));
      } catch (e) {
        if (import.meta.env.DEV) console.error('Could not create migration backup, aborting migration');
        return { isOk: false, error: 'Failed to create backup before migration' };
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
        await storageManager.clear(STORES.SAVINGS_GOALS);
        await storageManager.clear(STORES.SAVINGS_CONTRIBUTIONS);
        await storageManager.clear(STORES.MONTHLY_ALLOCATIONS);
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
        const backupData = localStorage.getItem(backupKey);
        if (backupData) {
          this._restoreFromBackup(JSON.parse(backupData));
          if (import.meta.env.DEV) console.log('Migration rollback: restored from backup');
        }
      } catch (restoreErr) {
        if (import.meta.env.DEV) console.error('Migration rollback also failed:', restoreErr);
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
      alerts: lsGet(SK.ALERTS, null) as AlertPrefs | null
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
      ['alerts', localData.alerts]
    ];

    for (const [key, value] of settings) {
      if (value !== null && value !== undefined) {
        await storageManager.set(STORES.SETTINGS, key, value);
      }
    }
  }

  /**
   * Verify migration was successful
   */
  private async _verifyMigration(originalData: LocalStorageData): Promise<boolean> {
    try {
      // Verify transaction count
      const txCount = await storageManager.countTransactions();
      const origTxCount = (originalData.transactions || []).length;

      if (txCount !== origTxCount) {
        if (import.meta.env.DEV) console.error(`Transaction count mismatch: ${txCount} vs ${origTxCount}`);
        return false;
      }

      // Spot check random transactions across different indices for better corruption detection
      const origTx = originalData.transactions;
      if (origTx && origTx.length > 0) {
        const sampleCount = Math.min(5, origTx.length);
        // Pick evenly-spaced indices to cover different parts of the dataset
        const indices = new Set<number>();
        for (let i = 0; i < sampleCount; i++) {
          const idx = Math.floor((i / sampleCount) * origTx.length + Math.random() * (origTx.length / sampleCount));
          indices.add(Math.min(idx, origTx.length - 1));
        }
        // If we got fewer unique indices than desired, add random ones
        while (indices.size < sampleCount) {
          indices.add(Math.floor(Math.random() * origTx.length));
        }

        for (const sampleIdx of indices) {
          const sample = origTx[sampleIdx];
          const retrieved = await storageManager.get(STORES.TRANSACTIONS, sample.__backendId) as Transaction | undefined;

          if (!retrieved || retrieved.amount !== sample.amount) {
            if (import.meta.env.DEV) console.error(`Transaction spot check failed at index ${sampleIdx} (id: ${sample.__backendId})`);
            return false;
          }
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
  private _createBackupSnapshot(): LocalStorageData {
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
      alerts: lsGet(SK.ALERTS, null) as AlertPrefs | null
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

      // Remove all but the most recent backup
      for (let i = 1; i < backupKeys.length; i++) {
        localStorage.removeItem(backupKeys[i]);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Failed to clean up old backups:', err);
    }
  }

  /**
   * Restore from a backup snapshot
   * FIXED: Added for proper rollback capability
   */
  private _restoreFromBackup(backup: LocalStorageData): boolean {
    try {
      // Restore all localStorage data
      localStorage.setItem(SK.TX, JSON.stringify(backup.transactions));
      localStorage.setItem(SK.SAVINGS, JSON.stringify(backup.savingsGoals));
      localStorage.setItem(SK.SAVINGS_CONTRIB, JSON.stringify(backup.savingsContribs));
      localStorage.setItem(SK.ALLOC, JSON.stringify(backup.monthlyAlloc));
      localStorage.setItem(SK.ACHIEVE, JSON.stringify(backup.achievements));
      if (backup.streak) localStorage.setItem(SK.STREAK, JSON.stringify(backup.streak));
      localStorage.setItem(SK.CUSTOM_CAT, JSON.stringify(backup.customCats));
      localStorage.setItem(SK.DEBTS, JSON.stringify(backup.debts));
      localStorage.setItem(SK.FILTER_PRESETS, JSON.stringify(backup.filterPresets));
      localStorage.setItem(SK.TX_TEMPLATES, JSON.stringify(backup.txTemplates));
      if (backup.rolloverSettings) localStorage.setItem(SK.ROLLOVER_SETTINGS, JSON.stringify(backup.rolloverSettings));
      if (backup.currency) localStorage.setItem(SK.CURRENCY, JSON.stringify(backup.currency));
      if (backup.theme) localStorage.setItem(SK.THEME, JSON.stringify(backup.theme));
      if (backup.pin) localStorage.setItem(SK.PIN, JSON.stringify(backup.pin));
      if (backup.sections) localStorage.setItem(SK.SECTIONS, JSON.stringify(backup.sections));
      if (backup.insightPers) localStorage.setItem(SK.INSIGHT_PERS, JSON.stringify(backup.insightPers));
      if (backup.alerts) localStorage.setItem(SK.ALERTS, JSON.stringify(backup.alerts));
      
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
        
        // Restore from the most recent backup
        const backupData = localStorage.getItem(backupKeys[0]);
        if (backupData) {
          const backup = JSON.parse(backupData) as LocalStorageData;
          this._restoreFromBackup(backup);
          if (import.meta.env.DEV) console.log('Restored from backup:', backupKeys[0]);
        }
      }
      
      // Clear migration status
      localStorage.removeItem(MIGRATION_KEY);
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
