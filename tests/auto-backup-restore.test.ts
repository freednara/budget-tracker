import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as signals from '../js/modules/core/signals.js';

const {
  emitMock,
  showToastMock,
  hydrateFromImportMock,
  tryAtomicWriteMock,
  buildImportStateMock,
  replaceAllTransactionsMock,
  getIndexedDbBackupMock,
  storeBackupMock,
  setThemeMock,
  safeStorageMock
} = vi.hoisted(() => ({
  emitMock: vi.fn(),
  showToastMock: vi.fn(),
  hydrateFromImportMock: vi.fn(),
  tryAtomicWriteMock: vi.fn(async () => true),
  buildImportStateMock: vi.fn(() => ({ newS: {}, writes: [], theme: null })),
  replaceAllTransactionsMock: vi.fn(async () => ({ isOk: true, data: [] })),
  getIndexedDbBackupMock: vi.fn(),
  storeBackupMock: vi.fn(async () => undefined),
  setThemeMock: vi.fn(),
  safeStorageMock: {
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
    getJSON: vi.fn((_: string, fallback: unknown) => fallback),
    setJSON: vi.fn()
  }
}));

vi.mock('../js/modules/core/event-bus.js', async () => {
  const actual = await vi.importActual('../js/modules/core/event-bus.js');
  return {
    ...actual,
    emit: emitMock
  };
});

vi.mock('../js/modules/ui/core/ui.js', () => ({
  showToast: showToastMock
}));

vi.mock('../js/modules/core/state-hydration.js', () => ({
  hydrateFromImport: hydrateFromImportMock
}));

vi.mock('../js/modules/features/import-export/import-export.js', () => ({
  buildImportState: buildImportStateMock,
  tryAtomicWrite: tryAtomicWriteMock
}));

vi.mock('../js/modules/features/personalization/theme.js', () => ({
  setTheme: setThemeMock
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    replaceAllTransactions: replaceAllTransactionsMock
  }
}));

vi.mock('../js/modules/features/backup/indexeddb-backup-store.js', () => ({
  storeBackup: storeBackupMock,
  getAllBackups: vi.fn(),
  getBackup: getIndexedDbBackupMock,
  deleteBackup: vi.fn()
}));

vi.mock('../js/modules/core/safe-storage.js', () => ({
  safeStorage: safeStorageMock
}));

import { Events } from '../js/modules/core/event-bus.js';
import { restoreBackup } from '../js/modules/features/backup/auto-backup.js';

describe('restoreBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    signals.replaceTransactionLedger([]);
    signals.savingsGoals.value = {};
    signals.monthlyAlloc.value = {};
    signals.customCats.value = [];
    signals.debts.value = [];
    signals.currency.value = { home: 'USD', symbol: '$' };
    signals.rolloverSettings.value = { enabled: false, mode: 'all', categories: [], maxRollover: 0, negativeHandling: 'carry' };
    signals.achievements.value = {} as any;
    signals.streak.value = { current: 0, longest: 0, lastDate: '' } as any;
    signals.sections.value = {} as any;
    signals.insightPers.value = 'balanced' as any;
    signals.lastBackup.value = 0;
    signals.lastBackupTxCount.value = 0;

    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer)
      }
    });

    getIndexedDbBackupMock.mockResolvedValue({
      metadata: {
        id: 'backup-1',
        timestamp: Date.now(),
        version: '2.0',
        deviceId: 'device-1',
        transactionCount: 1,
        compressed: false,
        size: 128
      },
      data: {
        transactions: [{
          __backendId: 'tx_restore',
          type: 'expense',
          amount: 12,
          description: 'Restored',
          date: '2026-03-20',
          category: 'food',
          currency: 'USD',
          recurring: false
        }],
        savingsGoals: {},
        monthlyAllocations: {},
        customCategories: [],
        debts: [],
        settings: {
          lastBackupTxCount: 1
        }
      }
    });
  });

  it('emits DATA_IMPORTED after a successful restore', async () => {
    const result = await restoreBackup('backup-1');

    expect(result).toBe(true);
    expect(replaceAllTransactionsMock).toHaveBeenCalledTimes(1);
    expect(hydrateFromImportMock).toHaveBeenCalledTimes(1);
    expect(hydrateFromImportMock).toHaveBeenCalledWith(
      buildImportStateMock.mock.results[0]?.value?.newS ?? {},
      expect.arrayContaining([
        expect.objectContaining({ __backendId: 'tx_restore' })
      ])
    );
    expect(emitMock).toHaveBeenCalledWith(Events.DATA_IMPORTED);
    expect(showToastMock).toHaveBeenCalledWith('Backup restored successfully', 'success');
  });

  it('aborts restore when the safety backup cannot be created', async () => {
    storeBackupMock.mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await restoreBackup('backup-1');

    expect(result).toBe(false);
    expect(replaceAllTransactionsMock).not.toHaveBeenCalled();
    expect(hydrateFromImportMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(
      'Restore failed: Failed to create safety backup before restore',
      'error'
    );
  });
});
