import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStorageManager,
  mockLsGet
} = vi.hoisted(() => ({
  mockStorageManager: {
    exportAll: vi.fn(async () => ({ _meta: { storageType: 'indexeddb' } } as Record<string, unknown>)),
    importAll: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    createBatch: vi.fn(async () => true),
    set: vi.fn(async () => true),
    getAll: vi.fn(async () => []),
    get: vi.fn(async () => undefined)
  },
  mockLsGet: vi.fn((_key: string, fallback: unknown) => fallback)
}));

vi.mock('../js/modules/data/storage-manager.js', () => ({
  storageManager: mockStorageManager,
  STORES: {
    TRANSACTIONS: 'transactions',
    SETTINGS: 'settings',
    SAVINGS_GOALS: 'savingsGoals',
    SAVINGS_CONTRIBUTIONS: 'savingsContributions',
    MONTHLY_ALLOCATIONS: 'monthlyAllocations',
    ACHIEVEMENTS: 'achievements',
    STREAK: 'streak',
    CUSTOM_CATEGORIES: 'customCategories',
    DEBTS: 'debts',
    FILTER_PRESETS: 'filterPresets',
    TX_TEMPLATES: 'txTemplates'
  }
}));

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
    FILTER_PRESETS: 'budget_tracker_filter_presets',
    TX_TEMPLATES: 'budget_tracker_tx_templates',
    ROLLOVER_SETTINGS: 'budget_tracker_rollover_settings',
    CURRENCY: 'budget_tracker_currency',
    THEME: 'budget_tracker_theme',
    PIN: 'budget_tracker_pin',
    SECTIONS: 'budget_tracker_sections',
    INSIGHT_PERS: 'budget_tracker_insight_pers',
    ALERTS: 'budget_tracker_alerts'
  },
  lsGet: mockLsGet
}));

vi.mock('../js/modules/core/utils.js', () => ({
  generateId: vi.fn(() => 'generated-id')
}));

import { MigrationManager } from '../js/modules/data/migration.js';

const localData = {
  transactions: [{
    __backendId: 'tx_1',
    type: 'expense' as const,
    amount: 42,
    category: 'food',
    description: 'Lunch',
    date: '2026-03-01',
    currency: 'USD',
    recurring: false
  }],
  savingsGoals: { goal_1: { name: 'Emergency', target_amount: 1000, saved_amount: 100 } },
  savingsContribs: [{ id: 1, goalId: 'goal_1', amount: 50, date: '2026-03-01' }],
  monthlyAlloc: { '2026-03': { food: 200 } },
  achievements: { starter: { unlocked: true } },
  streak: { current: 3, longest: 5, lastDate: '2026-03-01' },
  customCats: [{ id: 'cat_1', name: 'Custom', type: 'expense' as const, emoji: '🍔', color: '#fff000' }],
  debts: [{
    id: 'debt_1',
    name: 'Card',
    type: 'credit_card',
    balance: 500,
    originalBalance: 500,
    minimumPayment: 25,
    interestRate: 0.2,
    dueDay: 1,
    createdAt: '2026-03-01T00:00:00.000Z',
    payments: [],
    isActive: true
  }],
  filterPresets: [{ id: 'preset_1', name: 'Test', filters: {} }],
  txTemplates: [{ id: 'tpl_1', name: 'Template', type: 'expense' as const, amount: 10, category: 'food', description: 'Template' }],
  rolloverSettings: { enabled: true, mode: 'all' as const, categories: [], maxRollover: null, negativeHandling: 'zero' as const },
  currency: { home: 'USD', symbol: '$' },
  theme: 'dark',
  pin: '1234',
  sections: { envelope: true },
  insightPers: 'serious',
  alerts: { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] }
};

function installLocalDataMocks(): void {
  mockLsGet.mockImplementation((key: string, fallback: unknown) => {
    const mapping: Record<string, unknown> = {
      budget_tracker_transactions: localData.transactions,
      budget_tracker_savings: localData.savingsGoals,
      budget_tracker_savings_contrib: localData.savingsContribs,
      budget_tracker_alloc: localData.monthlyAlloc,
      budget_tracker_achieve: localData.achievements,
      budget_tracker_streak: localData.streak,
      budget_tracker_custom_cat: localData.customCats,
      budget_tracker_debts: localData.debts,
      budget_tracker_filter_presets: localData.filterPresets,
      budget_tracker_tx_templates: localData.txTemplates,
      budget_tracker_rollover_settings: localData.rolloverSettings,
      budget_tracker_currency: localData.currency,
      budget_tracker_theme: localData.theme,
      budget_tracker_pin: localData.pin,
      budget_tracker_sections: localData.sections,
      budget_tracker_insight_pers: localData.insightPers,
      budget_tracker_alerts: localData.alerts
    };
    return key in mapping ? mapping[key] : fallback;
  });
}

describe('MigrationManager public migration safety', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    installLocalDataMocks();
    mockStorageManager.exportAll.mockResolvedValue({ _meta: { storageType: 'indexeddb' } });
    mockStorageManager.importAll.mockResolvedValue(true);
    mockStorageManager.clear.mockResolvedValue(true);
    mockStorageManager.createBatch.mockResolvedValue(true);
    mockStorageManager.set.mockResolvedValue(true);
    mockStorageManager.getAll.mockResolvedValue([]);
    mockStorageManager.get.mockResolvedValue(undefined);
  });

  it('restores the IndexedDB snapshot when migration fails after destructive work begins', async () => {
    const snapshot = {
      transactions: [{ __backendId: 'existing_tx', amount: 1 }],
      settings: [{ key: 'theme', value: 'dark' }],
      _meta: { storageType: 'indexeddb' }
    };

    mockStorageManager.exportAll.mockResolvedValue(snapshot);
    (mockStorageManager.createBatch as any).mockImplementation(async (store: string) => {
      if (store === 'transactions') {
        throw new Error('transactions batch failed');
      }
      return true;
    });

    const manager = new MigrationManager();
    const result = await manager.migrate();

    expect(result.isOk).toBe(false);
    expect(mockStorageManager.importAll).toHaveBeenCalledWith(
      {
        transactions: snapshot.transactions,
        settings: snapshot.settings
      },
      true
    );
  });

  it('fails through the public migrate API when verification detects mismatched migrated data', async () => {
    mockStorageManager.exportAll.mockResolvedValue({ _meta: { storageType: 'indexeddb' } });
    (mockStorageManager.getAll as any).mockImplementation(async (store: string) => {
      if (store === 'transactions') return localData.transactions;
      if (store === 'savingsGoals') return [];
      return [];
    });
    mockStorageManager.get.mockResolvedValue(undefined);

    const manager = new MigrationManager();
    const result = await manager.migrate();

    expect(result.isOk).toBe(false);
    expect(result.error).toBe('Migration verification failed');
  });

  it('records a rollback failure marker when IndexedDB snapshot restore fails and localStorage recovery is used', async () => {
  mockStorageManager.exportAll.mockResolvedValue({
      ...({} as Record<string, unknown>),
      transactions: [{ __backendId: 'existing_tx', amount: 1 }],
      _meta: { storageType: 'indexeddb' }
    });
    mockStorageManager.importAll.mockResolvedValue(false);
    (mockStorageManager.createBatch as any).mockImplementation(async (store: string) => {
      if (store === 'transactions') {
        throw new Error('transactions batch failed');
      }
      return true;
    });

    const manager = new MigrationManager();
    const result = await manager.migrate();

    expect(result.isOk).toBe(false);
    const marker = JSON.parse(localStorage.getItem('budget_tracker_storage_rollback_failed') || '{}') as {
      reason?: string;
    };
    expect(marker.reason).toBe('migration_indexeddb_restore_failed');
  });

  it('does not persist the PIN bundle inside durable migration backup snapshots', async () => {
    const manager = new MigrationManager();
    const result = await manager.migrate();

    expect(result.isOk).toBe(false);

    const backupKey = Object.keys(localStorage).find((key) => key.startsWith('budget_tracker_backup_'));
    expect(backupKey).toBeTruthy();

    const backupSnapshot = JSON.parse(localStorage.getItem(backupKey!) || '{}') as Record<string, unknown>;
    expect(backupSnapshot.pin).toBeUndefined();
  });
});
