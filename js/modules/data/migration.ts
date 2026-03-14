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
      console.warn('Failed to save migration status:', err);
    }
  }

  /**
   * Perform the migration from localStorage to IndexedDB
   */
  async migrate(progressCallback: MigrationProgressCallback = () => {}): Promise<MigrationResult> {
    try {
      progressCallback({ phase: 'reading', progress: 0 });

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

      progressCallback({ phase: 'migrating', progress: 5 });

      // Migrate transactions in batches
      let migratedCount = 0;
      const transactions = localData.transactions || [];

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

      progressCallback({ phase: 'complete', progress: 100 });

      return { isOk: true, migrated: totalItems };

    } catch (err) {
      const error = err as Error;
      console.error('Migration failed:', error);
      progressCallback({ phase: 'error', progress: 0, error: error.message });
      return { isOk: false, error: error.message };
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
        console.error(`Transaction count mismatch: ${txCount} vs ${origTxCount}`);
        return false;
      }

      // Spot check a random transaction
      const origTx = originalData.transactions;
      if (origTx && origTx.length > 0) {
        const sampleIdx = Math.floor(Math.random() * origTx.length);
        const sample = origTx[sampleIdx];
        const retrieved = await storageManager.get(STORES.TRANSACTIONS, sample.__backendId) as Transaction | undefined;

        if (!retrieved || retrieved.amount !== sample.amount) {
          console.error('Transaction spot check failed');
          return false;
        }
      }

      return true;
    } catch (err) {
      console.error('Verification error:', err);
      return false;
    }
  }

  /**
   * Rollback migration (restore localStorage as primary)
   */
  async rollback(): Promise<boolean> {
    try {
      // Clear migration status
      localStorage.removeItem(MIGRATION_KEY);
      localStorage.removeItem('budget_tracker_migrated_to_idb');

      // Storage manager will use localStorage on next init
      storageManager.reset();

      return true;
    } catch (err) {
      console.error('Rollback failed:', err);
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
