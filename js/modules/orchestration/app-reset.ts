'use strict';

import { SK, STORAGE_DEFAULTS, lsSet } from '../core/state.js';
import {
  APP_LOCAL_STORAGE_KEYS,
  APP_LOCAL_STORAGE_PREFIXES
} from '../core/storage-registry.js';
import * as signals from '../core/signals.js';
import { storageManager } from '../data/storage-manager.js';
import { clearRecurringTemplates } from '../data/recurring-templates.js';
import { clearBackupStorage } from '../features/backup/reset-backup-storage.js';
import { getTodayStr } from '../core/utils-pure.js';
import { invalidateAllCache } from '../core/monthly-totals-cache.js';
import { userCategoryConfig, initCategoryStore } from '../core/category-store.js';
import { terminateWorker } from './worker-manager.js';
import { dataSdk } from '../data/data-manager.js';
import { trackError } from '../core/error-tracker.js';
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

// rev 12 #13b (M35): the wipe lists above used to be hardcoded here. They
// now live in `core/storage-registry.ts` as derived exports off a single
// registry that documents every harbor_* localStorage key in the codebase
// with its cleanup action. Two concrete wins:
//   1. Dead `monthly_totals_cache` prefix removed — the totals cache moved
//      to an in-memory Map (see monthly-totals-cache.ts:65), so wiping
//      that prefix on reset has been a no-op for several releases.
//   2. The registry is now grep-validated by tests/architecture-contract
//      (literal-coverage test). Adding a new harbor_* key elsewhere in the
//      codebase without registering it here will fail CI — the previous
//      arrangement let new keys silently miss the reset wipe.

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
  // PRESERVED ACROSS HARBOR LEDGER RENAME (ADR-001 §9.4): migration.ts reads
  // these under their legacy names. Writing to harbor_* here would cause the
  // migration module to conclude "migration hasn't happened" after a reset.
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
    userCategoryConfig.value = cloneDefault(STORAGE_DEFAULTS[SK.USER_CATS] as null);
    signals.savingsGoals.value = cloneDefault(STORAGE_DEFAULTS[SK.SAVINGS] as Record<string, never>);
    signals.savingsContribs.value = cloneDefault(STORAGE_DEFAULTS[SK.SAVINGS_CONTRIB] as []);
    signals.monthlyAlloc.value = cloneDefault(STORAGE_DEFAULTS[SK.ALLOC] as Record<string, never>);
    signals.achievements.value = cloneDefault(STORAGE_DEFAULTS[SK.ACHIEVE] as Record<string, never>);
    signals.streak.value = cloneDefault(STORAGE_DEFAULTS[SK.STREAK] as StreakData);
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
    // CR-Apr22-F slice 3: dismissedAlerts now persists to sessionStorage
    // so the signal survives reload. Clear the sessionStorage entry on
    // app reset so a post-reset reload doesn't re-hydrate the stale set.
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem(signals.DISMISSED_ALERTS_SESSION_KEY);
      } catch {
        // Swallow — a failing removeItem is not fatal; in-memory signal is already cleared.
      }
    }
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

/**
 * Fixes H19 (Inline-Behavior-Review rev 12): capture a pre-destructive
 * snapshot of every localStorage key so a mid-reset crash in step 4
 * (`removeAppLocalStorageKeys`) can be partially rolled back. Main-ledger
 * and backup-IDB rollback is intentionally out of scope — snapshotting
 * those would require cloning hundreds of MB into memory before destroying
 * them. The localStorage tier, however, is cheap to snapshot and is where
 * the user's *configuration* (PIN, currency, theme, alerts, migration
 * markers) lives, so rolling it back on partial failure keeps the user's
 * session logically consistent with whatever the rest of the wipe achieved.
 */
function snapshotLocalStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key);
      if (value !== null) {
        snapshot[key] = value;
      }
    }
  } catch {
    // If we can't even read localStorage we're already in a bad place;
    // the caller will land in the catch below and surface telemetry.
  }
  return snapshot;
}

function restoreLocalStorageSnapshot(snapshot: Record<string, string>): void {
  try {
    for (const [key, value] of Object.entries(snapshot)) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Per-key failure (quota, disabled storage) shouldn't abort the rest.
      }
    }
  } catch {
    // Snapshot restore is best-effort recovery after a destructive crash.
  }
}

export async function resetAppData(options: ResetAppDataOptions = {}): Promise<ResetAppDataResult> {
  const clearBackups = !!options.clearBackups;

  // Round 7 fix: broadcast a "force close" signal to all sibling tabs
  // before executing clearAll(). Other tabs holding active IndexedDB
  // connections will block deleteDatabase(), causing the reset to appear
  // successful while data persists. Sibling tabs should close their IDB
  // connections and reload on receiving this message.
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const resetChannel = new BroadcastChannel('harbor_sync');
      const myTabId = storageManager.getTabId();
      // CR-May01: include senderTabId so this tab's own BroadcastChannel
      // listener can identify and ignore the self-sent message. Without
      // this, the listener closes the IDB connection before clearAll()
      // runs, causing the reset to silently fail every time.
      resetChannel.postMessage({
        type: 'force_close_for_reset',
        senderTabId: myTabId,
      });
      resetChannel.close();
      // Brief delay to give sibling tabs time to process the message
      // and close their IDB connections before we attempt deletion.
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  } catch {
    // Non-fatal: proceed with reset even if broadcast fails.
    // The worst case is the same as before this fix.
  }

  // Fixes H19 (Inline-Behavior-Review rev 12): capture a localStorage
  // snapshot before any destructive step, so a failure between steps can
  // rehydrate configuration state (PIN, currency, theme, alerts). Cheap:
  // localStorage is capped well below the main ledger.
  const localStorageSnapshot = snapshotLocalStorage();

  try {
    // Prior-batch P2 (inline review): wipe the main ledger BEFORE backup
    // storage. The earlier ordering destroyed backups first and then
    // attempted `storageManager.clearAll()` — if the main-ledger wipe
    // failed, the user was left with no backups AND no completed reset.
    // Now the expensive/destructive IDB wipe happens first; on its
    // failure, backups stay intact as a recovery path and the user can
    // retry. The legacy H19 rationale (rev 12 → rev 13 / L70) about
    // `restoreMigrationMarkers()` placement is unaffected — that fix
    // concerned marker-write ordering relative to `removeAppLocalStorageKeys`,
    // not the relative order of ledger-vs-backup destruction.
    const cleared = await storageManager.clearAll();
    if (!cleared) {
      trackError(new Error('App reset: storageManager.clearAll returned false'), {
        module: 'app-reset',
        action: 'resetAppData.clearAll.failed'
      });
      // Nothing destructive has happened: backups, configuration, and
      // ledger are all intact. Snapshot restore keeps the failure path
      // uniform with other aborts below.
      restoreLocalStorageSnapshot(localStorageSnapshot);
      return { ok: false, clearBackups };
    }

    const backupsCleared = await clearBackupStorage({
      clearPayloads: clearBackups,
      clearMetadata: true
    });
    if (!backupsCleared) {
      trackError(new Error('App reset: clearBackupStorage returned false'), {
        module: 'app-reset',
        action: 'resetAppData.clearBackupStorage.failed'
      });
      // Main ledger is already cleared; backups may be partially
      // affected. Restore localStorage so the user's PIN/currency/theme
      // survive the partial failure and the next boot has a coherent
      // configuration. This path is strictly better than the old flow,
      // which could destroy backups BEFORE discovering the ledger wipe
      // would fail.
      restoreLocalStorageSnapshot(localStorageSnapshot);
      return { ok: false, clearBackups };
    }

    clearRecurringTemplates();
    restoreMigrationMarkers();
    removeAppLocalStorageKeys();

    terminateWorker();
    invalidateAllCache();
    dataSdk.resetRuntimeState();
    resetSignalsToFirstUseState();
    restoreMigrationMarkers();

    initCategoryStore();

    return { ok: true, clearBackups };
  } catch (error) {
    // Fixes H19 (Inline-Behavior-Review rev 12): route the single most
    // destructive operation in the app through trackError unconditionally.
    // Previously this was DEV-only console.error, so prod had zero signal
    // when a user's reset failed partway through — the exact scenario
    // where support most needs to reconstruct what happened.
    trackError(error instanceof Error ? error : new Error(String(error)), {
      module: 'app-reset',
      action: 'resetAppData.exception'
    });
    // Partial-rollback best effort: rehydrate localStorage so the user's
    // config keys survive even if the ledger is now half-cleared.
    restoreLocalStorageSnapshot(localStorageSnapshot);
    // Markers must end up set either way, so a crashed reset doesn't
    // trigger re-migration on the next boot.
    try {
      restoreMigrationMarkers();
    } catch {
      // The markers call only writes two keys — if even this fails,
      // trackError above already captured the outer failure and there's
      // nothing further we can do from here.
    }
    return { ok: false, clearBackups };
  }
}

export default {
  resetAppData
};
