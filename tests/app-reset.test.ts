import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { SK } from '../js/modules/core/state.js';

const {
  clearAllStorageMock,
  clearAllBackupsMock,
  resetRuntimeStateMock,
  mockedUserCategoryConfig
} = vi.hoisted(() => ({
  clearAllStorageMock: vi.fn(async () => true),
  clearAllBackupsMock: vi.fn(async () => true),
  resetRuntimeStateMock: vi.fn(),
  mockedUserCategoryConfig: {
    value: { presetId: 'personal', version: 1, expense: [] as unknown[], income: [] as unknown[] } as unknown
  }
}));

vi.mock('../js/modules/data/storage-manager.js', () => ({
  storageManager: {
    clearAll: clearAllStorageMock
  }
}));

vi.mock('../js/modules/features/backup/indexeddb-backup-store.js', () => ({
  clearAllBackups: clearAllBackupsMock
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    resetRuntimeState: resetRuntimeStateMock
  }
}));

vi.mock('../js/modules/core/category-store.js', () => ({
  userCategoryConfig: mockedUserCategoryConfig,
  expenseCategories: { value: [] },
  incomeCategories: { value: [] },
  indexedUserCategories: { value: new Map() },
  initCategoryStore: vi.fn(() => false)
}));

import { resetAppData } from '../js/modules/orchestration/app-reset.js';

describe('resetAppData', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllStorageMock.mockClear();
    clearAllBackupsMock.mockClear();
    resetRuntimeStateMock.mockClear();
    clearAllBackupsMock.mockResolvedValue(true);
    clearAllStorageMock.mockResolvedValue(true);

    signals.replaceTransactionLedger([{
      __backendId: 'tx_1',
      type: 'expense',
      amount: 42,
      description: 'Existing',
      date: '2026-03-20',
      category: 'food',
      currency: 'USD',
      recurring: false
    }]);
    signals.savingsGoals.value = { goal1: { id: 'goal1', name: 'Goal', target_amount: 1000, current_amount: 100 } as any };
    signals.savingsContribs.value = [{ id: 'contrib1', goalId: 'goal1', amount: 50, date: '2026-03-20' } as any];
    signals.monthlyAlloc.value = { '2026-03': { food: 300 } as any };
    signals.debts.value = [{ id: 'debt1', name: 'Debt', balance: 400, interestRate: 9.9, minimumPayment: 25 } as any];
    mockedUserCategoryConfig.value = {
      presetId: 'custom',
      version: 1,
      expense: [{ id: 'food', name: 'Food', emoji: '🍔', color: '#ef4444', type: 'expense', order: 0 }],
      income: []
    } as any;
    signals.filterPresets.value = [{ id: 'preset1', name: 'Preset', filters: signals.filters.value } as any];
    signals.txTemplates.value = [{ id: 'tpl1', name: 'Tpl', type: 'expense', category: 'food', amount: 10, description: 'Tpl', tags: '', notes: '' } as any];
    signals.currency.value = { home: 'EUR', symbol: '€' };
    signals.pin.value = 'hashed-pin';
    signals.insightPers.value = 'friendly' as any;
    signals.theme.value = 'light' as any;
    signals.rolloverSettings.value = { enabled: true, mode: 'selected', categories: ['food'], maxRollover: 100, negativeHandling: 'carry' };
    signals.alerts.value = { budgetThreshold: 0.5, browserNotificationsEnabled: true, lastNotifiedAlertKeys: ['2026-03:food:budget-threshold'] };
    signals.sections.value = { envelope: false } as any;
    signals.onboarding.value = { active: true, completed: true, step: 5 };
    signals.lastBackup.value = 123456;
    signals.lastBackupTxCount.value = 9;
    signals.activeMainTab.value = 'transactions';
    signals.currentTab.value = 'income';
    signals.currentType.value = 'income';
    signals.selectedCategory.value = 'food';
    signals.editingId.value = 'tx_1';
    signals.deleteTargetId.value = 'tx_1';
    signals.addSavingsGoalId.value = 'goal1';
    signals.splitTxId.value = 'tx_1';
    signals.splitRows.value = [{ id: 'row1', categoryId: 'food', amount: 42 }];
    signals.pendingEditTx.value = signals.transactions.value[0] ?? null;
    signals.isEditing.value = true;
    signals.formTitle.value = 'Edit';
    signals.submitButtonText.value = 'Save';
    signals.editSeriesMode.value = true;
    signals.filtersExpanded.value = true;
    signals.filters.value = {
      searchText: 'Existing',
      type: 'expense',
      category: 'food',
      tags: 'tag',
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      minAmount: '10',
      maxAmount: '50',
      reconciled: 'no',
      recurring: true,
      showAllMonths: true,
      sortBy: 'date-asc'
    };

    localStorage.setItem(SK.RECURRING, JSON.stringify({ recurring1: { id: 'recurring1' } }));
    localStorage.setItem('harbor_auto_backups', JSON.stringify([{ id: 'backup-1' }]));
    localStorage.setItem('harbor_backup_schedule', JSON.stringify({ enabled: true }));
    localStorage.setItem('harbor_backup_status', JSON.stringify({ totalBackups: 1 }));
    localStorage.setItem('harbor_backup_legacy_1', JSON.stringify({ id: 'legacy' }));
    localStorage.setItem(SK.THEME, JSON.stringify('light'));
    localStorage.setItem(SK.PIN, JSON.stringify('hashed-pin'));
    localStorage.setItem('backup_reminder_last_tx_count', JSON.stringify(9));
    localStorage.setItem('harbor_sync_123', JSON.stringify({ type: 'update' }));
  });

  it('resets the app to first-use defaults while preserving backup payloads', async () => {
    const result = await resetAppData({ clearBackups: false });

    expect(result).toEqual({ ok: true, clearBackups: false });
    expect(clearAllStorageMock).toHaveBeenCalledTimes(1);
    expect(clearAllBackupsMock).not.toHaveBeenCalled();
    expect(resetRuntimeStateMock).toHaveBeenCalledTimes(1);

    expect(signals.transactions.value).toEqual([]);
    expect(signals.savingsGoals.value).toEqual({});
    expect(signals.monthlyAlloc.value).toEqual({});
    expect(signals.debts.value).toEqual([]);
    expect(mockedUserCategoryConfig.value).toBeNull();
    expect(signals.filterPresets.value).toEqual([]);
    expect(signals.txTemplates.value).toEqual([]);
    expect(signals.currency.value).toEqual({ home: 'USD', symbol: '$' });
    expect(signals.pin.value).toBe('');
    expect(signals.theme.value).toBe('dark');
    expect(signals.onboarding.value).toEqual({ active: false, completed: false, step: 0 });
    expect(signals.lastBackup.value).toBe(0);
    expect(signals.lastBackupTxCount.value).toBe(0);
    expect(signals.activeMainTab.value).toBe('dashboard');
    expect(signals.currentTab.value).toBe('expense');
    expect(signals.currentType.value).toBe('expense');
    expect(signals.filtersExpanded.value).toBe(false);
    expect(signals.filters.value.searchText).toBe('');
    expect(signals.formTitle.value).toBe('➕ Add Transaction');
    expect(signals.submitButtonText.value).toBe('ADD TRANSACTION');
    expect(localStorage.getItem(SK.RECURRING)).toBeNull();
    expect(localStorage.getItem('harbor_auto_backups')).not.toBeNull();
    expect(localStorage.getItem('harbor_backup_legacy_1')).not.toBeNull();
    expect(localStorage.getItem('harbor_backup_schedule')).toBeNull();
    expect(localStorage.getItem('harbor_backup_status')).toBeNull();
    // rev 12 #13b (M35, Inline-Behavior-Review): the dead `monthly_totals_cache`
    // prefix was dropped from the reset wipe list. The monthly-totals cache
    // lives entirely in `memoryCache` (a JS Map in monthly-totals-cache.ts),
    // so no localStorage key under that prefix is ever written in production
    // — asserting it gets wiped was asserting a no-op against test fixture.
    expect(localStorage.getItem('harbor_sync_123')).toBeNull();
    // restoreMigrationMarkers writes to the PRESERVED legacy key names (ADR-001 §9.4)
    expect(localStorage.getItem('budget_tracker_idb_migration')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_migrated_to_idb')).not.toBeNull();
  });

  it('removes backup payloads when the full local wipe option is chosen', async () => {
    const result = await resetAppData({ clearBackups: true });

    expect(result).toEqual({ ok: true, clearBackups: true });
    expect(clearAllBackupsMock).toHaveBeenCalledTimes(1);
    expect(clearAllStorageMock).toHaveBeenCalledTimes(1);
    expect(resetRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('harbor_auto_backups')).toBeNull();
    expect(localStorage.getItem('harbor_backup_legacy_1')).toBeNull();
    expect(localStorage.getItem('harbor_backup_schedule')).toBeNull();
    expect(localStorage.getItem('harbor_backup_status')).toBeNull();
  });

  it('aborts before touching backups when the main-ledger wipe fails (prior-batch P2)', async () => {
    // Prior-batch P2 (inline review, 7l): resetAppData was reordered so the
    // main ledger is wiped BEFORE backup storage. If `storageManager.clearAll()`
    // fails, `clearBackupStorage` must never run — backups are the user's
    // last recovery path, and destroying them on a failed reset is the
    // specific state transition the reorder prevents.
    clearAllStorageMock.mockResolvedValue(false);

    const result = await resetAppData({ clearBackups: true });

    expect(result).toEqual({ ok: false, clearBackups: true });
    expect(clearAllStorageMock).toHaveBeenCalledTimes(1);
    expect(clearAllBackupsMock).not.toHaveBeenCalled();
    expect(resetRuntimeStateMock).not.toHaveBeenCalled();
    expect(signals.transactions.value).toHaveLength(1);
    expect(localStorage.getItem(SK.RECURRING)).not.toBeNull();
    // Backups are still intact on disk.
    expect(localStorage.getItem('harbor_auto_backups')).not.toBeNull();
    expect(localStorage.getItem('harbor_backup_legacy_1')).not.toBeNull();
    // Snapshot restore keeps user configuration keys aligned with the
    // ledger that wasn't wiped.
    expect(localStorage.getItem('harbor_backup_schedule')).toBe(JSON.stringify({ enabled: true }));
  });

  it('still reports failure when backup cleanup fails AFTER main ledger wipe succeeds', async () => {
    // Second half of the prior-batch P2 contract: if the main-ledger wipe
    // succeeds but backup cleanup later returns false, the reset still
    // reports `{ok: false}` so the caller can surface the partial-success
    // state to the user. Signals haven't been rehydrated to defaults (the
    // steps past `clearBackupStorage` never ran), and localStorage snapshot
    // restore keeps PIN/theme/currency consistent with the ledger.
    clearAllStorageMock.mockResolvedValue(true);
    clearAllBackupsMock.mockResolvedValue(false);

    const result = await resetAppData({ clearBackups: true });

    expect(result).toEqual({ ok: false, clearBackups: true });
    expect(clearAllStorageMock).toHaveBeenCalledTimes(1);
    expect(clearAllBackupsMock).toHaveBeenCalledTimes(1);
    expect(resetRuntimeStateMock).not.toHaveBeenCalled();
    // Snapshot restore salvaged the user's config keys.
    expect(localStorage.getItem(SK.THEME)).toBe(JSON.stringify('light'));
    expect(localStorage.getItem(SK.PIN)).toBe(JSON.stringify('hashed-pin'));
  });

  it('does not leak migration-marker keys when the reset fails before any destructive step', async () => {
    // Rev 13 L70 regression guard: the prior code wrote
    // `budget_tracker_idb_migration` + `budget_tracker_migrated_to_idb`
    // inside `try` but BEFORE `clearBackupStorage`. When the backup-clear
    // step returned false, the rollback path (`restoreLocalStorageSnapshot`)
    // only re-set snapshotted entries — it had no way to remove keys
    // added AFTER the snapshot, so the markers stayed on disk even though
    // the reset reported `{ok: false}` and no destructive work had run.
    // Fix: the pre-wipe `restoreMigrationMarkers()` call moved to
    // immediately before `removeAppLocalStorageKeys`, so it only runs once
    // main-IDB clearing has succeeded.
    clearAllBackupsMock.mockResolvedValue(false);

    const result = await resetAppData({ clearBackups: true });

    expect(result.ok).toBe(false);
    expect(localStorage.getItem('budget_tracker_idb_migration')).toBeNull();
    expect(localStorage.getItem('budget_tracker_migrated_to_idb')).toBeNull();
  });

  it('does not leak migration-marker keys when storageManager.clearAll fails', async () => {
    clearAllStorageMock.mockResolvedValue(false);

    const result = await resetAppData({ clearBackups: true });

    expect(result.ok).toBe(false);
    // Main ledger failed to wipe; no localStorage key wipes have run yet,
    // so markers must NOT have been written on this aborted path.
    expect(localStorage.getItem('budget_tracker_idb_migration')).toBeNull();
    expect(localStorage.getItem('budget_tracker_migrated_to_idb')).toBeNull();
  });
});
