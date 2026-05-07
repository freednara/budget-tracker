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

// NOTE: We deliberately do NOT hardcode SK values here. The previous version
// of this mock duplicated the SK object inline with 7 values that had drifted
// away from production (e.g. CUSTOM_CAT='harbor_custom_cat' vs real
// 'harbor_custom_categories'), so the suite was exercising neither the
// previous keys nor the current ones — it couldn't catch custom-category
// rename regressions. Spreading `actual` keeps SK, STORAGE_DEFAULTS, and any
// future exports in lock-step with production; we only override `lsGet` to
// route reads through `mockLsGet`.
vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/state.js')>(
    '../js/modules/core/state.js'
  );
  return {
    ...actual,
    lsGet: mockLsGet
  };
});

vi.mock('../js/modules/core/utils-pure.js', () => ({
  generateId: vi.fn(() => 'generated-id')
}));

import { MigrationManager } from '../js/modules/data/migration.js';
import { SK } from '../js/modules/core/state.js';

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
  alerts: { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] },
  onboarding: { active: false, step: 0, completed: false },
  filterExpanded: false,
  lastBackupTxCount: 0,
  recurring: {},
  hasOnboarded: false
};

function installLocalDataMocks(): void {
  // Keys are sourced from the real SK (via vi.importActual above) so this
  // mapping automatically tracks any future rename in state.ts.
  mockLsGet.mockImplementation((key: string, fallback: unknown) => {
    const mapping: Record<string, unknown> = {
      [SK.TX]: localData.transactions,
      [SK.SAVINGS]: localData.savingsGoals,
      [SK.SAVINGS_CONTRIB]: localData.savingsContribs,
      [SK.ALLOC]: localData.monthlyAlloc,
      [SK.ACHIEVE]: localData.achievements,
      [SK.STREAK]: localData.streak,
      [SK.CUSTOM_CAT]: localData.customCats,
      [SK.DEBTS]: localData.debts,
      [SK.FILTER_PRESETS]: localData.filterPresets,
      [SK.TX_TEMPLATES]: localData.txTemplates,
      [SK.ROLLOVER_SETTINGS]: localData.rolloverSettings,
      [SK.CURRENCY]: localData.currency,
      [SK.THEME]: localData.theme,
      [SK.PIN]: localData.pin,
      [SK.SECTIONS]: localData.sections,
      [SK.INSIGHT_PERS]: localData.insightPers,
      [SK.ALERTS]: localData.alerts,
      [SK.ONBOARD]: localData.onboarding,
      [SK.FILTER_EXPANDED]: localData.filterExpanded,
      backup_reminder_last_tx_count: localData.lastBackupTxCount,
      [SK.RECURRING]: localData.recurring,
      [SK.HAS_ONBOARDED]: localData.hasOnboarded
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
    // migration.ts now writes the unified marker that storage-manager
    // reads on next boot to force a safe localStorage fallback.
    const marker = JSON.parse(localStorage.getItem('harbor_storage_rollback_failed') || '{}') as {
      reason?: string;
    };
    expect(marker.reason).toBe('migration_indexeddb_restore_failed');
  });

  it('persists the PIN inside migration backup snapshots so rollback can restore it', async () => {
    // H9 (Inline-Behavior-Review rev 12): the prior contract omitted PIN
    // from the snapshot on disk-leak grounds, but that left rollback with
    // no way to restore the user's only auth credential after a mid-
    // migration failure — silently wiping it. The PIN already lives in
    // localStorage durably under SK.PIN (duplicating it in the backup
    // keyspace adds no new leak surface), so H9 promotes data-integrity
    // over a no-op security concern.
    const manager = new MigrationManager();
    const result = await manager.migrate();

    expect(result.isOk).toBe(false);

    // migration.ts creates backup keys under the legacy prefix (not renamed)
    const backupKey = Object.keys(localStorage).find((key) => key.startsWith('budget_tracker_backup_'));
    expect(backupKey).toBeTruthy();

    const backupSnapshot = JSON.parse(localStorage.getItem(backupKey!) || '{}') as Record<string, unknown>;
    expect(backupSnapshot.pin).toBe(localData.pin);
  });

  it('restores falsy persisted settings during rollback instead of leaving stale truthy values behind', () => {
    localStorage.setItem(SK.FILTER_EXPANDED, JSON.stringify(true));
    localStorage.setItem('backup_reminder_last_tx_count', JSON.stringify(9));
    localStorage.setItem(SK.HAS_ONBOARDED, JSON.stringify(true));
    localStorage.setItem(SK.RECURRING, JSON.stringify({ stale: true }));

    const manager = new MigrationManager() as unknown as {
      _restoreFromBackup: (backup: Record<string, unknown>) => boolean;
    };

    const restored = manager._restoreFromBackup({
      ...localData,
      filterExpanded: false,
      lastBackupTxCount: 0,
      recurring: {},
      hasOnboarded: false
    });

    expect(restored).toBe(true);
    expect(JSON.parse(localStorage.getItem(SK.FILTER_EXPANDED) || 'null')).toBe(false);
    expect(JSON.parse(localStorage.getItem('backup_reminder_last_tx_count') || 'null')).toBe(0);
    expect(JSON.parse(localStorage.getItem(SK.HAS_ONBOARDED) || 'null')).toBe(false);
    expect(JSON.parse(localStorage.getItem(SK.RECURRING) || 'null')).toEqual({});
  });

  // New-batch P2: `needsMigration()` previously short-circuited on
  // `lsGet(SK.TX, []).length > 0` only, so users with populated
  // settings/debts/goals/etc. but no transactions were reported as
  // "nothing to migrate" and their data never moved to IndexedDB.
  it('reports needsMigration=true when only non-transaction data is present in localStorage', async () => {
    // Override the mock to return data only for non-TX keys.
    mockLsGet.mockImplementation((key: string, fallback: unknown) => {
      const mapping: Record<string, unknown> = {
        [SK.TX]: [], // explicitly empty
        [SK.DEBTS]: localData.debts,
        [SK.CURRENCY]: localData.currency,
        [SK.THEME]: localData.theme,
        [SK.PIN]: localData.pin
      };
      return key in mapping ? mapping[key] : fallback;
    });

    // Force IDB-in-use path; needsMigration short-circuits to false
    // otherwise.
    const { storageManager: sm } = await import('../js/modules/data/storage-manager.js');
    (sm as unknown as { isUsingIndexedDB: () => boolean }).isUsingIndexedDB = () => true;

    const manager = new MigrationManager();
    const needs = await manager.needsMigration();
    expect(needs).toBe(true);
  });

  it('reports needsMigration=false when localStorage is truly empty across all migration slots', async () => {
    mockLsGet.mockImplementation((_key: string, fallback: unknown) => fallback);

    const { storageManager: sm } = await import('../js/modules/data/storage-manager.js');
    (sm as unknown as { isUsingIndexedDB: () => boolean }).isUsingIndexedDB = () => true;

    const manager = new MigrationManager();
    const needs = await manager.needsMigration();
    expect(needs).toBe(false);
  });

  // New-batch P2: `migrate()` with a settings-only localStorage
  // previously hit `totalItems === 0`, marked the migration as
  // complete, and returned without ever calling `_migrateSettings`.
  // Pinned here so the count helper must include settings slots.
  it('runs the real migration path when only settings are present (no empty-complete short-circuit)', async () => {
    mockLsGet.mockImplementation((key: string, fallback: unknown) => {
      const mapping: Record<string, unknown> = {
        [SK.TX]: [],
        [SK.CURRENCY]: localData.currency,
        [SK.THEME]: localData.theme,
        [SK.PIN]: localData.pin
      };
      return key in mapping ? mapping[key] : fallback;
    });

    // Capture settings writes so we can assert at least one happened.
    mockStorageManager.set.mockResolvedValue(true);
    mockStorageManager.getAll.mockResolvedValue([]);

    const manager = new MigrationManager();
    await manager.migrate();

    // The `_migrateSettings()` helper calls `storageManager.set` for
    // each populated settings key. If the short-circuit triggered
    // incorrectly, `set` would never have been invoked.
    expect(mockStorageManager.set).toHaveBeenCalled();
  });
});
