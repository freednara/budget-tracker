/**
 * Regression tests for CR-Apr24-M / N fix clusters.
 *
 * Cluster M — Event-bus contract P2 fixes
 *   271  detachHandler cleans up throttle state on last-listener removal
 *   275  on() wraps each handler for independent subscriptions
 *   276  off() matches on originalHandler and removes only first match
 *
 * Cluster N — Migration fidelity P2 fixes
 *   170  _readLocalStorage / _migrateSettings omit onboarding, filterExpanded,
 *        lastBackupTxCount, recurring, hasOnboarded
 *   171  _verifyMigration can falsely report success for skipped settings
 *   172  _createBackupSnapshot / _restoreFromBackup omit the same settings
 *   173  rollback() ignores _restoreFromBackup failure
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

// ==========================================
// Cluster M — event-bus regression (finding 271)
// ==========================================

describe('Cluster M — event-bus', () => {
  it('271: detachHandler clears throttle state when last listener is removed', async () => {
    const eventBus = await import('../js/modules/core/event-bus.js');
    // Clear any state from prior tests
    eventBus.clearAll();

    const handler = vi.fn();
    eventBus.on('TEST_THROTTLE_271', handler, { throttle: 200 });

    // Emit to create throttle bookkeeping
    eventBus.emit('TEST_THROTTLE_271', 'a');
    expect(handler).toHaveBeenCalledTimes(1);

    // Detach last listener — throttle metadata should be cleaned up
    eventBus.off('TEST_THROTTLE_271', handler);

    // Re-subscribe — if throttle state leaked, the first emit after
    // re-subscribe could be incorrectly suppressed by a stale timer.
    const handler2 = vi.fn();
    eventBus.on('TEST_THROTTLE_271', handler2, { throttle: 200 });
    eventBus.emit('TEST_THROTTLE_271', 'b');
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledWith('b');

    eventBus.off('TEST_THROTTLE_271', handler2);
    eventBus.clearAll();
  });

  it('275+276: duplicate on() calls create independent subscriptions, off() removes one', async () => {
    const eventBus = await import('../js/modules/core/event-bus.js');
    eventBus.clearAll();

    const handler = vi.fn();
    eventBus.on('DUP_TEST_275', handler);
    eventBus.on('DUP_TEST_275', handler); // second independent subscription

    eventBus.emit('DUP_TEST_275', 'x');
    expect(handler).toHaveBeenCalledTimes(2);

    // off() removes only the first matching subscription
    eventBus.off('DUP_TEST_275', handler);
    handler.mockClear();

    eventBus.emit('DUP_TEST_275', 'y');
    expect(handler).toHaveBeenCalledTimes(1);

    // Remove the remaining one
    eventBus.off('DUP_TEST_275', handler);
    handler.mockClear();

    eventBus.emit('DUP_TEST_275', 'z');
    expect(handler).toHaveBeenCalledTimes(0);

    eventBus.clearAll();
  });
});

// ==========================================
// Cluster N — migration fidelity regression
// ==========================================

const {
  mockStorageManager,
  mockLsGet
} = vi.hoisted(() => ({
  mockStorageManager: {
    isUsingIndexedDB: vi.fn(() => true),
    exportAll: vi.fn(async () => ({ _meta: { storageType: 'indexeddb' } } as Record<string, unknown>)),
    importAll: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    createBatch: vi.fn(async () => true),
    set: vi.fn(async () => true),
    getAll: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    reset: vi.fn()
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

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn()
}));

describe('Cluster N — migration fidelity', () => {
  let MigrationManager: typeof import('../js/modules/data/migration.js').MigrationManager;
  let SK: typeof import('../js/modules/core/state.js').SK;
  let BACKUP_REMINDER_TX_COUNT_KEY: string;

  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();

    const stateModule = await import('../js/modules/core/state.js');
    SK = stateModule.SK;
    BACKUP_REMINDER_TX_COUNT_KEY = stateModule.BACKUP_REMINDER_TX_COUNT_KEY;

    const migrationModule = await import('../js/modules/data/migration.js');
    MigrationManager = migrationModule.MigrationManager;

    // Default: all lsGet calls return fallback
    mockLsGet.mockImplementation((_key: string, fallback: unknown) => fallback);
    mockStorageManager.exportAll.mockResolvedValue({ _meta: { storageType: 'indexeddb' } });
    mockStorageManager.importAll.mockResolvedValue(true);
    mockStorageManager.clear.mockResolvedValue(true);
    mockStorageManager.createBatch.mockResolvedValue(true);
    mockStorageManager.set.mockResolvedValue(true);
    mockStorageManager.getAll.mockResolvedValue([]);
    mockStorageManager.get.mockResolvedValue(undefined);
    mockStorageManager.isUsingIndexedDB.mockReturnValue(true);
  });

  it('170: _migrateSettings writes onboarding, filterExpanded, lastBackupTxCount, recurring, hasOnboarded to IDB', async () => {
    const onboarding = { active: false, completed: true, step: 5 };
    const recurring = { tpl_1: { name: 'Rent', amount: 1200 } };

    mockLsGet.mockImplementation((key: string, fallback: unknown) => {
      const data: Record<string, unknown> = {
        [SK.TX]: [{ __backendId: 'tx1', type: 'expense', amount: 10, category: 'food', description: 'x', date: '2026-01-01', currency: 'USD', recurring: false }],
        [SK.ONBOARD]: onboarding,
        [SK.FILTER_EXPANDED]: true,
        [BACKUP_REMINDER_TX_COUNT_KEY]: 42,
        [SK.RECURRING]: recurring,
        [SK.HAS_ONBOARDED]: true
      };
      return key in data ? data[key] : fallback;
    });

    // Make verification pass by returning matching values
    (mockStorageManager.getAll as any).mockImplementation(async (store: string) => {
      if (store === 'transactions') {
        return [{ __backendId: 'tx1', type: 'expense', amount: 10, category: 'food', description: 'x', date: '2026-01-01', currency: 'USD', recurring: false }];
      }
      return [];
    });
    (mockStorageManager.get as any).mockImplementation(async (_store: string, key: string) => {
      const map: Record<string, unknown> = {
        onboarding,
        filterExpanded: true,
        lastBackupTxCount: 42,
        recurring,
        hasOnboarded: true
      };
      return map[key];
    });

    const manager = new MigrationManager();
    await manager.migrate();

    // Verify the new settings were written to SETTINGS store
    const setCalls = (mockStorageManager.set.mock.calls as unknown) as Array<[string, string, unknown]>;
    const settingsWrites = setCalls.filter(([store]) => store === 'settings');
    const writtenKeys = settingsWrites.map(([, key]) => key);

    expect(writtenKeys).toContain('onboarding');
    expect(writtenKeys).toContain('filterExpanded');
    expect(writtenKeys).toContain('lastBackupTxCount');
    expect(writtenKeys).toContain('recurring');
    expect(writtenKeys).toContain('hasOnboarded');

    // Verify actual values written
    const findWrite = (k: string) => settingsWrites.find(([, key]) => key === k)?.[2];
    expect(findWrite('onboarding')).toEqual(onboarding);
    expect(findWrite('filterExpanded')).toBe(true);
    expect(findWrite('lastBackupTxCount')).toBe(42);
    expect(findWrite('recurring')).toEqual(recurring);
    expect(findWrite('hasOnboarded')).toBe(true);
  });

  it('171: _verifyMigration detects mismatch on the newly-added settings', async () => {
    mockLsGet.mockImplementation((key: string, fallback: unknown) => {
      const data: Record<string, unknown> = {
        [SK.TX]: [{ __backendId: 'tx1', type: 'expense', amount: 10, category: 'food', description: 'x', date: '2026-01-01', currency: 'USD', recurring: false }],
        [SK.ONBOARD]: { active: false, completed: true, step: 3 },
        [SK.HAS_ONBOARDED]: true
      };
      return key in data ? data[key] : fallback;
    });

    // Transaction store matches, but onboarding returns wrong value
    (mockStorageManager.getAll as any).mockImplementation(async (store: string) => {
      if (store === 'transactions') {
        return [{ __backendId: 'tx1', type: 'expense', amount: 10, category: 'food', description: 'x', date: '2026-01-01', currency: 'USD', recurring: false }];
      }
      return [];
    });
    (mockStorageManager.get as any).mockImplementation(async (_store: string, key: string) => {
      if (key === 'onboarding') {
        return { active: false, completed: false, step: 0 }; // WRONG — mismatch
      }
      if (key === 'hasOnboarded') return true;
      return undefined;
    });

    const manager = new MigrationManager();
    const result = await manager.migrate();

    // Migration should fail because verification detects the onboarding mismatch
    expect(result.isOk).toBe(false);
    expect(result.error).toBe('Migration verification failed');
  });

  it('172: _createBackupSnapshot includes the new fields and _restoreFromBackup restores them', async () => {
    const onboarding = { active: true, completed: false, step: 2 };
    const recurring = { r1: { name: 'Sub', amount: 15 } };

    mockLsGet.mockImplementation((key: string, fallback: unknown) => {
      const data: Record<string, unknown> = {
        [SK.TX]: [],
        [SK.ONBOARD]: onboarding,
        [SK.FILTER_EXPANDED]: true,
        [BACKUP_REMINDER_TX_COUNT_KEY]: 7,
        [SK.RECURRING]: recurring,
        [SK.HAS_ONBOARDED]: true
      };
      return key in data ? data[key] : fallback;
    });

    // Make migration fail after backup is created to trigger restore path
    mockStorageManager.createBatch.mockRejectedValueOnce(new Error('forced failure'));
    // Make IDB restore fail too so it falls through to localStorage restore
    mockStorageManager.importAll.mockResolvedValueOnce(false);

    const manager = new MigrationManager();
    await manager.migrate();

    // The backup was created and _restoreFromBackup was called.
    // Check that localStorage was written with the new fields.
    const stored = localStorage.getItem(SK.ONBOARD);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(onboarding);

    expect(JSON.parse(localStorage.getItem(SK.FILTER_EXPANDED) || 'null')).toBe(true);
    expect(JSON.parse(localStorage.getItem(BACKUP_REMINDER_TX_COUNT_KEY) || '0')).toBe(7);
    expect(JSON.parse(localStorage.getItem(SK.RECURRING) || '{}')).toEqual(recurring);
    expect(JSON.parse(localStorage.getItem(SK.HAS_ONBOARDED) || 'false')).toBe(true);
  });

  it('173: rollback() returns false when _restoreFromBackup fails', async () => {
    // Seed a backup key in localStorage with data that will trigger a restore
    const backupKey = 'budget_tracker_backup_1700000000000';
    const backupData = {
      transactions: [],
      savingsGoals: {},
      savingsContribs: [],
      monthlyAlloc: {},
      achievements: {},
      streak: null,
      customCats: [],
      debts: [],
      filterPresets: [],
      txTemplates: [],
      rolloverSettings: null,
      currency: null,
      theme: null,
      pin: null,
      sections: null,
      insightPers: null,
      alerts: null,
      onboarding: null,
      filterExpanded: false,
      lastBackupTxCount: 0,
      recurring: {},
      hasOnboarded: false
    };
    localStorage.setItem(backupKey, JSON.stringify(backupData));

    // Mock localStorage.setItem to throw (simulating quota exceeded)
    // after the initial getItem succeeds
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let callCount = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      // Let the backup key write succeed, but fail on the restore writes
      if (key === backupKey) {
        return originalSetItem(key, value);
      }
      callCount++;
      if (callCount <= 1) {
        throw new Error('QuotaExceededError');
      }
      return originalSetItem(key, value);
    });

    const manager = new MigrationManager();
    const result = await manager.rollback();

    expect(result).toBe(false);
  });
});
