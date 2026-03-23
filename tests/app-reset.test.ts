import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { SK } from '../js/modules/core/state.js';

const { clearAllStorageMock, clearAllBackupsMock } = vi.hoisted(() => ({
  clearAllStorageMock: vi.fn(async () => true),
  clearAllBackupsMock: vi.fn(async () => true)
}));

vi.mock('../js/modules/data/storage-manager.js', () => ({
  storageManager: {
    clearAll: clearAllStorageMock
  }
}));

vi.mock('../js/modules/features/backup/indexeddb-backup-store.js', () => ({
  clearAllBackups: clearAllBackupsMock
}));

import { resetAppData } from '../js/modules/orchestration/app-reset.js';

describe('resetAppData', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllStorageMock.mockClear();
    clearAllBackupsMock.mockClear();

    signals.transactions.value = [{
      __backendId: 'tx_1',
      type: 'expense',
      amount: 42,
      description: 'Existing',
      date: '2026-03-20',
      category: 'food',
      currency: 'USD',
      recurring: false
    }];
    signals.savingsGoals.value = { goal1: { id: 'goal1', name: 'Goal', target_amount: 1000, current_amount: 100 } as any };
    signals.savingsContribs.value = [{ id: 'contrib1', goalId: 'goal1', amount: 50, date: '2026-03-20' } as any];
    signals.monthlyAlloc.value = { '2026-03': { food: 300 } as any };
    signals.debts.value = [{ id: 'debt1', name: 'Debt', balance: 400, interestRate: 9.9, minimumPayment: 25 } as any];
    signals.customCats.value = [{ id: 'custom', name: 'Custom', emoji: '✨', color: '#fff', type: 'expense' } as any];
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
    signals.pendingEditTx.value = signals.transactions.value[0];
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
    localStorage.setItem('budget_tracker_auto_backups', JSON.stringify([{ id: 'backup-1' }]));
    localStorage.setItem('budget_tracker_backup_schedule', JSON.stringify({ enabled: true }));
    localStorage.setItem('budget_tracker_backup_status', JSON.stringify({ totalBackups: 1 }));
    localStorage.setItem('budget_tracker_backup_legacy_1', JSON.stringify({ id: 'legacy' }));
    localStorage.setItem(SK.THEME, JSON.stringify('light'));
    localStorage.setItem(SK.PIN, JSON.stringify('hashed-pin'));
    localStorage.setItem('backup_reminder_last_tx_count', JSON.stringify(9));
    localStorage.setItem('monthly_totals_cache_2026-03', JSON.stringify({ expenses: 42 }));
    localStorage.setItem('budget_tracker_sync_123', JSON.stringify({ type: 'update' }));
  });

  it('resets the app to first-use defaults while preserving backup payloads', async () => {
    const result = await resetAppData({ clearBackups: false });

    expect(result).toEqual({ ok: true, clearBackups: false });
    expect(clearAllStorageMock).toHaveBeenCalledTimes(1);
    expect(clearAllBackupsMock).not.toHaveBeenCalled();

    expect(signals.transactions.value).toEqual([]);
    expect(signals.savingsGoals.value).toEqual({});
    expect(signals.monthlyAlloc.value).toEqual({});
    expect(signals.debts.value).toEqual([]);
    expect(signals.customCats.value).toEqual([]);
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
    expect(localStorage.getItem('budget_tracker_auto_backups')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_legacy_1')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_schedule')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_status')).toBeNull();
    expect(localStorage.getItem('monthly_totals_cache_2026-03')).toBeNull();
    expect(localStorage.getItem('budget_tracker_sync_123')).toBeNull();
    expect(localStorage.getItem('budget_tracker_idb_migration')).not.toBeNull();
    expect(localStorage.getItem('budget_tracker_migrated_to_idb')).not.toBeNull();
  });

  it('removes backup payloads when the full local wipe option is chosen', async () => {
    const result = await resetAppData({ clearBackups: true });

    expect(result).toEqual({ ok: true, clearBackups: true });
    expect(clearAllBackupsMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('budget_tracker_auto_backups')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_legacy_1')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_schedule')).toBeNull();
    expect(localStorage.getItem('budget_tracker_backup_status')).toBeNull();
  });
});
