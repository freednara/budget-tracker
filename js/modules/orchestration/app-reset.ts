'use strict';

import { SK, STORAGE_DEFAULTS, lsSet } from '../core/state.js';
import * as signals from '../core/signals.js';
import { storageManager } from '../data/storage-manager.js';
import { clearRecurringTemplates } from '../data/recurring-templates.js';
import { clearBackupStorage } from '../features/backup/reset-backup-storage.js';
import { getTodayStr } from '../core/utils.js';
import { invalidateAllCache } from '../core/monthly-totals-cache.js';
import { terminateWorker } from './worker-manager.js';
import { dataSdk } from '../data/data-manager.js';
import type {
  AlertPrefs,
  CurrencySettings,
  FilterPreset,
  InsightPersonality,
  RolloverSettings,
  SectionsConfig,
  StreakData,
  Theme,
  TxTemplate
} from '../../types/index.js';

export interface ResetAppDataOptions {
  clearBackups?: boolean;
}

export interface ResetAppDataResult {
  ok: boolean;
  clearBackups: boolean;
}

const APP_LOCAL_STORAGE_KEYS: string[] = [
  ...Object.values(SK),
  'budget_tracker_metadata',
  'budget_tracker_storage_rollback',
  'backup_reminder_last_tx_count'
];

const APP_LOCAL_STORAGE_PREFIXES: string[] = [
  'monthly_totals_cache',
  'budget_tracker_sync_'
];

function cloneDefault<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function removeAppLocalStorageKeys(): void {
  APP_LOCAL_STORAGE_KEYS.forEach((key) => {
    localStorage.removeItem(key);
  });

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (APP_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

function restoreMigrationMarkers(): void {
  lsSet('budget_tracker_idb_migration', {
    completed: true,
    timestamp: Date.now(),
    version: '2.7',
    itemCount: 0
  });
  localStorage.setItem('budget_tracker_migrated_to_idb', Date.now().toString());
}

function resetSignalsToFirstUseState(): void {
  const currentMonth = getTodayStr().slice(0, 7);

  signals.batch(() => {
    signals.replaceTransactionLedger(cloneDefault(STORAGE_DEFAULTS[SK.TX] as []));
    signals.savingsGoals.value = cloneDefault(STORAGE_DEFAULTS[SK.SAVINGS] as Record<string, never>);
    signals.savingsContribs.value = cloneDefault(STORAGE_DEFAULTS[SK.SAVINGS_CONTRIB] as []);
    signals.monthlyAlloc.value = cloneDefault(STORAGE_DEFAULTS[SK.ALLOC] as Record<string, never>);
    signals.achievements.value = cloneDefault(STORAGE_DEFAULTS[SK.ACHIEVE] as Record<string, never>);
    signals.streak.value = cloneDefault(STORAGE_DEFAULTS[SK.STREAK] as StreakData);
    signals.customCats.value = cloneDefault(STORAGE_DEFAULTS[SK.CUSTOM_CAT] as []);
    signals.debts.value = cloneDefault(STORAGE_DEFAULTS[SK.DEBTS] as []);
    signals.currency.value = cloneDefault(STORAGE_DEFAULTS[SK.CURRENCY] as CurrencySettings);
    signals.sections.value = cloneDefault(STORAGE_DEFAULTS[SK.SECTIONS] as SectionsConfig);
    signals.pin.value = cloneDefault(STORAGE_DEFAULTS[SK.PIN] as string);
    signals.insightPers.value = cloneDefault(STORAGE_DEFAULTS[SK.INSIGHT_PERS] as InsightPersonality);
    signals.alerts.value = cloneDefault(STORAGE_DEFAULTS[SK.ALERTS] as AlertPrefs);
    signals.theme.value = cloneDefault(STORAGE_DEFAULTS[SK.THEME] as Theme);
    signals.rolloverSettings.value = cloneDefault(STORAGE_DEFAULTS[SK.ROLLOVER_SETTINGS] as RolloverSettings);
    signals.filterPresets.value = cloneDefault(STORAGE_DEFAULTS[SK.FILTER_PRESETS] as FilterPreset[]);
    signals.txTemplates.value = cloneDefault(STORAGE_DEFAULTS[SK.TX_TEMPLATES] as TxTemplate[]);
    signals.lastBackup.value = cloneDefault(STORAGE_DEFAULTS[SK.LAST_BACKUP] as number);
    signals.lastBackupTxCount.value = 0;
    signals.onboarding.value = cloneDefault(STORAGE_DEFAULTS[SK.ONBOARD] as typeof signals.onboarding.value);

    signals.refreshVersion.value++;
    signals.currentMonth.value = currentMonth;
    signals.currentType.value = 'expense';
    signals.currentTab.value = 'expense';
    signals.selectedCategory.value = '';
    signals.dismissedAlerts.value = new Set();
    signals.editingId.value = null;
    signals.deleteTargetId.value = null;
    signals.addSavingsGoalId.value = null;
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
    signals.pendingEditTx.value = null;
    signals.isEditing.value = false;
    signals.formTitle.value = '➕ Add Transaction';
    signals.submitButtonText.value = 'ADD TRANSACTION';
    signals.editSeriesMode.value = false;
    signals.recurringPreview.value = {
      show: false,
      count: 0,
      startDate: '',
      endDate: '',
      isCapped: false
    };
    signals.selectedCalendarDay.value = null;
    signals.activeMainTab.value = 'dashboard';
    signals.pagination.value = {
      page: 0,
      totalPages: 0,
      totalItems: 0
    };
    signals.filters.value = {
      searchText: '',
      type: 'all',
      category: '',
      tags: '',
      dateFrom: '',
      dateTo: '',
      minAmount: '',
      maxAmount: '',
      reconciled: 'all',
      recurring: false,
      showAllMonths: false,
      sortBy: 'date-desc'
    };
    signals.filtersExpanded.value = false;
  });
}

export async function resetAppData(options: ResetAppDataOptions = {}): Promise<ResetAppDataResult> {
  const clearBackups = !!options.clearBackups;

  try {
    const backupsCleared = await clearBackupStorage({
      clearPayloads: clearBackups,
      clearMetadata: true
    });
    if (!backupsCleared) {
      return { ok: false, clearBackups };
    }

    const cleared = await storageManager.clearAll();
    if (!cleared) {
      return { ok: false, clearBackups };
    }

    clearRecurringTemplates();
    removeAppLocalStorageKeys();

    terminateWorker();
    invalidateAllCache();
    dataSdk.resetRuntimeState();
    resetSignalsToFirstUseState();
    restoreMigrationMarkers();

    return { ok: true, clearBackups };
  } catch (error) {
    if (import.meta.env.DEV) console.error('App reset failed:', error);
    return { ok: false, clearBackups };
  }
}

export default {
  resetAppData
};
