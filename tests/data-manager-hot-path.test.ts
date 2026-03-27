import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStorageManager, mockStateRevision, mockBroadcastManager, mockInvalidateMonthCache, mockInvalidateAllCache } = vi.hoisted(() => {
  return {
    mockStorageManager: {
      init: vi.fn(async () => ({ isOk: true })),
      isUsingIndexedDB: vi.fn(() => true),
      getAll: vi.fn<() => Promise<unknown[]>>(async () => []),
      set: vi.fn(async () => true),
      delete: vi.fn(async () => true),
      updateBatch: vi.fn(async () => true),
      deleteBatch: vi.fn(async () => true),
      replaceTransactionWithSplits: vi.fn(async () => true),
      importAll: vi.fn(async () => true),
      get: vi.fn(async () => undefined)
    },
    mockStateRevision: {
      recordStateChange: vi.fn(async () => ({ revision: 1 })),
      recordTransactionDelta: vi.fn()
    },
    mockBroadcastManager: {
      sendStateUpdate: vi.fn()
    },
    mockInvalidateMonthCache: vi.fn(),
    mockInvalidateAllCache: vi.fn()
  };
});

vi.mock('../js/modules/core/state.js', () => ({
  SK: {
    TX: 'budget_tracker_transactions',
    SAVINGS: 'budget_tracker_savings',
    SAVINGS_CONTRIB: 'budget_tracker_savings_contrib',
    ALLOC: 'budget_tracker_alloc',
    ACHIEVE: 'budget_tracker_achieve',
    STREAK: 'budget_tracker_streak',
    CUSTOM_CAT: 'budget_tracker_custom_cat',
    DEBTS: 'budget_tracker_debts',
    CURRENCY: 'budget_tracker_currency',
    SECTIONS: 'budget_tracker_sections',
    PIN: 'budget_tracker_pin',
    INSIGHT_PERS: 'budget_tracker_insight_pers',
    ALERTS: 'budget_tracker_alerts',
    THEME: 'budget_tracker_theme',
    ROLLOVER_SETTINGS: 'budget_tracker_rollover_settings',
    FILTER_PRESETS: 'budget_tracker_filter_presets',
    TX_TEMPLATES: 'budget_tracker_tx_templates',
    ONBOARD: 'budget_tracker_onboard',
    LAST_BACKUP: 'budget_tracker_last_backup',
    FILTER_EXPANDED: 'budget_tracker_filter_expanded'
  },
  lsGet: vi.fn((_key: string, fallback: unknown) => fallback),
  lsSet: vi.fn(() => true),
  getStored: vi.fn((_key: string, fallback?: unknown) => fallback),
  normalizeAlertPrefs: vi.fn((value: unknown) => value ?? { budgetThreshold: null, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] })
}));

vi.mock('../js/modules/data/storage-manager.js', () => ({
  storageManager: mockStorageManager,
  STORES: { TRANSACTIONS: 'transactions' }
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
  Events: {
    TRANSACTION_ADDED: 'tx:added',
    TRANSACTION_UPDATED: 'tx:updated',
    TRANSACTION_DELETED: 'tx:deleted',
    TRANSACTIONS_BATCH_ADDED: 'tx:batch:added'
  }
}));

vi.mock('../js/modules/core/data-sync-interface.js', () => ({
  DataSyncEvents: {
    REQUEST_RELOAD: 'data:request:reload',
    REQUEST_APPLY_DELTA: 'data:request:apply_delta',
    REQUEST_SYNC: 'data:request:sync',
    TRANSACTION_UPDATED: 'data:transaction:updated',
    TRANSACTION_DELTA_APPLIED: 'data:transaction:delta_applied'
  },
  notifyDataSyncComplete: vi.fn(),
  notifyDataSyncError: vi.fn()
}));

vi.mock('../js/modules/core/state-revision.js', () => ({
  default: mockStateRevision
}));

vi.mock('../js/modules/core/tab-id.js', () => ({
  getTabId: vi.fn(() => 'test-tab')
}));

vi.mock('../js/modules/core/multi-tab-sync-broadcast.js', () => ({
  broadcastManager: mockBroadcastManager
}));

vi.mock('../js/modules/core/monthly-totals-cache.js', () => ({
  invalidateMonthCache: mockInvalidateMonthCache,
  invalidateAllCache: mockInvalidateAllCache
}));

import { DataManager } from '../js/modules/data/data-manager.js';
import type { DataHandler, Transaction } from '../js/types/index.js';

function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 50,
    category: 'food',
    description: 'Test transaction',
    date: '2026-03-15',
    currency: 'USD',
    recurring: false,
    reconciled: true,
    splits: false,
    ...overrides
  };
}

function createHandler(): DataHandler {
  return { onDataChanged: vi.fn() };
}

describe('DataManager hot mutation paths', () => {
  let dataManager: DataManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    dataManager = new DataManager();
  });

  it('updates transactions without re-reading the full ledger after init', async () => {
    const original = createTransaction();
    mockStorageManager.getAll.mockImplementationOnce(async () => [original]);

    await dataManager.init(createHandler());
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);

    const result = await dataManager.update({ ...original, amount: 75 });

    expect(result.isOk).toBe(true);
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);
    expect(mockStorageManager.set).toHaveBeenCalledTimes(1);
  });

  it('deletes transactions from the cached ledger without a second full read', async () => {
    const original = createTransaction();
    mockStorageManager.getAll.mockImplementationOnce(async () => [original]);

    await dataManager.init(createHandler());
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);

    const result = await dataManager.delete(original);

    expect(result.isOk).toBe(true);
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);
    expect(mockStorageManager.delete).toHaveBeenCalledWith('transactions', original.__backendId);
  });

  it('splits transactions from cache and uses atomic replacement persistence', async () => {
    const original = createTransaction({ amount: 100 });
    mockStorageManager.getAll.mockImplementationOnce(async () => [original]);

    await dataManager.init(createHandler());
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);

    const result = await dataManager.splitTransaction(original, [
      { category: 'food', amount: 40, description: 'Food split' },
      { category: 'transport', amount: 60, description: 'Transport split' }
    ]);

    expect(result.isOk).toBe(true);
    expect(mockStorageManager.getAll).toHaveBeenCalledTimes(1);
    expect(mockStorageManager.replaceTransactionWithSplits).toHaveBeenCalledTimes(1);
    expect(mockStorageManager.replaceTransactionWithSplits).toHaveBeenCalledWith(
      original.__backendId,
      expect.arrayContaining([
        expect.objectContaining({ category: 'food', amount: 40 }),
        expect.objectContaining({ category: 'transport', amount: 60 })
      ])
    );
  });

  it('replaces the full ledger through the durable import path', async () => {
    const original = createTransaction();
    const replacement = createTransaction({ __backendId: 'tx_replaced', amount: 125, date: '2026-04-01' });
    mockStorageManager.getAll.mockImplementationOnce(async () => [original]);

    await dataManager.init(createHandler());

    const result = await dataManager.replaceAllTransactions([replacement]);

    expect(result.isOk).toBe(true);
    expect(mockStorageManager.importAll).toHaveBeenCalledWith({ transactions: [replacement] }, true);
    expect(mockBroadcastManager.sendStateUpdate).toHaveBeenCalledWith(
      'budget_tracker_transactions',
      undefined,
      expect.objectContaining({ changeType: 'reload' })
    );
    expect(mockInvalidateAllCache).toHaveBeenCalled();
  });
});
