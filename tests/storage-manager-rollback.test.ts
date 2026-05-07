import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockIdbIsAvailable,
  mockIdbInit,
  mockLocalIsAvailable,
  mockLocalInit,
  mockLocalImportAll
} = vi.hoisted(() => ({
  mockIdbIsAvailable: vi.fn(() => true),
  mockIdbInit: vi.fn(async () => ({ isOk: true })),
  mockLocalIsAvailable: vi.fn(() => true),
  mockLocalInit: vi.fn(async () => ({ isOk: true })),
  mockLocalImportAll: vi.fn(async (_data?: Record<string, unknown>, _overwrite?: boolean) => true)
}));

vi.mock('../js/modules/data/indexeddb-adapter.js', () => ({
  IndexedDBAdapter: class {
    isAvailable(): boolean {
      return mockIdbIsAvailable();
    }

    async init(): Promise<{ isOk: boolean }> {
      return mockIdbInit();
    }
  }
}));

vi.mock('../js/modules/data/localstorage-adapter.js', () => ({
  LocalStorageAdapter: class {
    isAvailable(): boolean {
      return mockLocalIsAvailable();
    }

    async init(): Promise<{ isOk: boolean }> {
      return mockLocalInit();
    }

    async importAll(data: Record<string, unknown>, overwrite?: boolean): Promise<boolean> {
      return mockLocalImportAll(data, overwrite);
    }
  }
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  Events: { STORAGE_SYNC: 'storage:sync' }
}));

vi.mock('../js/modules/core/utils-dom.js', () => ({
  generateSecureId: vi.fn(() => 'secure-id'),
  // Phase 4a H1: storage-manager now imports trackError, which transitively
  // requires generateId at module init via error-tracker's SESSION_ID.
  generateId: vi.fn(() => 'test-id'),
  esc: vi.fn((s: string) => s)
}));

import {
  storageManager,
  STORES,
  // CR-Apr22 (slice 1 — finding #2): the settings-shape normalizer is
  // exported so the unit-level assertions below can exercise it without
  // spinning up a full rollback harness (also covered indirectly through
  // the integration tests in this file).
  normalizeIdbExportForLocalStorage
} from '../js/modules/data/storage-manager.js';

describe('StorageManager rollback safety', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    storageManager.reset();
    mockIdbIsAvailable.mockReturnValue(true);
    mockIdbInit.mockResolvedValue({ isOk: true });
    mockLocalIsAvailable.mockReturnValue(true);
    mockLocalInit.mockResolvedValue({ isOk: true });
  });

  it('fails closed when public write failures trigger rollback with a partial export snapshot', async () => {
    const manager = storageManager as unknown as {
      adapter: {
        set: (store: string, key: string, value: unknown) => Promise<boolean>;
        exportAll: () => Promise<Record<string, unknown>>;
      };
      type: string | null;
      _initialized: boolean;
      _rollbackInProgress: boolean;
      _errorCount: number;
      ERROR_THRESHOLD: number;
    };

    const exportErrors = { transactions: 'transactions export failed' };

    manager.adapter = {
      set: vi.fn(async () => {
        throw new Error('IndexedDB write failed');
      }),
      exportAll: vi.fn(async () => ({
        _meta: { storageType: 'indexeddb' },
        _exportErrors: exportErrors
      }))
    };
    manager.type = 'indexeddb';
    manager._initialized = true;
    manager._rollbackInProgress = false;
    manager._errorCount = manager.ERROR_THRESHOLD - 1;

    await expect(storageManager.set(STORES.TRANSACTIONS, 'tx_1', { __backendId: 'tx_1' })).rejects.toThrow(
      'IndexedDB write failed'
    );

    await vi.waitFor(() => {
      const marker = localStorage.getItem('harbor_storage_rollback_failed');
      expect(marker).not.toBeNull();
    });

    expect(manager.type).toBe('indexeddb');
    expect(mockLocalInit).not.toHaveBeenCalled();
    expect(mockLocalImportAll).not.toHaveBeenCalled();

    const marker = JSON.parse(localStorage.getItem('harbor_storage_rollback_failed') || '{}') as {
      reason?: string;
      exportErrors?: Record<string, string>;
    };
    expect(marker.reason).toBe('partial_export');
    expect(marker.exportErrors).toEqual(exportErrors);
  });

  it('falls back to localStorage on init when a rollback failure marker is present', async () => {
    localStorage.setItem('harbor_storage_rollback_failed', JSON.stringify({
      reason: 'migration_indexeddb_restore_failed',
      timestamp: Date.now()
    }));

    const result = await storageManager.init();

    expect(result).toEqual({ isOk: true, type: 'localstorage' });
    expect(mockLocalInit).toHaveBeenCalledTimes(1);
    expect(mockIdbInit).not.toHaveBeenCalled();
    expect(storageManager.getType()).toBe('localstorage');
  });

  /**
   * CR-Apr22 (slice 1 — finding #1): partial_export used to leave the
   * session pinned to failing IDB with `_errorCount` above threshold.
   * Every subsequent write re-incremented and re-entered `_triggerRollback`,
   * producing a hot loop of re-exports on a known-failing adapter. The
   * latched `_rollbackAttempted` flag short-circuits the re-entry; the
   * error count is reset so nothing else observes the threshold state.
   */
  it('does not re-trigger rollback after a partial_export failure in the same session', async () => {
    const manager = storageManager as unknown as {
      adapter: {
        set: (store: string, key: string, value: unknown) => Promise<boolean>;
        exportAll: () => Promise<Record<string, unknown>>;
      };
      type: string | null;
      _initialized: boolean;
      _rollbackInProgress: boolean;
      _rollbackAttempted: boolean;
      _errorCount: number;
      ERROR_THRESHOLD: number;
    };

    const exportCalls = vi.fn(async () => ({
      _meta: { storageType: 'indexeddb' },
      _exportErrors: { transactions: 'export failed' }
    }));

    manager.adapter = {
      set: vi.fn(async () => {
        throw new Error('IndexedDB write failed');
      }),
      exportAll: exportCalls
    };
    manager.type = 'indexeddb';
    manager._initialized = true;
    manager._rollbackInProgress = false;
    manager._rollbackAttempted = false;
    manager._errorCount = manager.ERROR_THRESHOLD - 1;

    // First failure crosses the threshold → rollback attempt →
    // partial_export bail → marker written.
    await expect(storageManager.set(STORES.TRANSACTIONS, 'tx_1', { __backendId: 'tx_1' })).rejects.toThrow();
    await vi.waitFor(() => {
      expect(localStorage.getItem('harbor_storage_rollback_failed')).not.toBeNull();
    });
    expect(exportCalls).toHaveBeenCalledTimes(1);
    expect(manager._rollbackAttempted).toBe(true);
    expect(manager._errorCount).toBe(0);

    // A flurry of subsequent failing writes must NOT kick off additional
    // export+rollback attempts — the latch short-circuits the threshold.
    for (let i = 0; i < 20; i++) {
      await expect(storageManager.set(STORES.TRANSACTIONS, `tx_${i}`, { __backendId: `tx_${i}` })).rejects.toThrow();
    }
    expect(exportCalls).toHaveBeenCalledTimes(1);
    expect(manager.type).toBe('indexeddb');
  });

  /**
   * CR-Apr22 (slice 1 — finding #2): IDB `exportAll()` returns
   * `data.settings` as an **array** of `{key, value}` rows. Feeding that
   * raw array to `LocalStorageAdapter.importAll()` would send each entry
   * through the numeric-index branch and write `harbor_0`, `harbor_1`, ...
   * — silently dropping every real setting on rollback. The normalizer
   * translates the array into the keyed object shape that the LS adapter
   * consumes.
   */
  it('happy-path rollback translates IDB settings-array into the LS keyed-object shape before importAll', async () => {
    const manager = storageManager as unknown as {
      adapter: {
        set: (store: string, key: string, value: unknown) => Promise<boolean>;
        exportAll: () => Promise<Record<string, unknown>>;
      };
      type: string | null;
      _initialized: boolean;
      _rollbackInProgress: boolean;
      _rollbackAttempted: boolean;
      _errorCount: number;
      ERROR_THRESHOLD: number;
    };

    // A representative IDB export: transactions as an array (unchanged by
    // normalization) and settings as the row-per-key array that IDB
    // `getAll()` returns on the SETTINGS store.
    const idbExport = {
      _meta: { storageType: 'indexeddb' },
      transactions: [{ id: 'tx_1', amount: 42 }],
      settings: [
        { key: 'theme', value: 'dark' },
        { key: 'currency', value: { home: 'USD', symbol: '$' } },
        { key: 'onboarding', value: { active: false, completed: true, step: 3 } }
      ]
    };

    manager.adapter = {
      set: vi.fn(async () => {
        throw new Error('IndexedDB write failed');
      }),
      exportAll: vi.fn(async () => idbExport)
    };
    manager.type = 'indexeddb';
    manager._initialized = true;
    manager._rollbackInProgress = false;
    manager._rollbackAttempted = false;
    manager._errorCount = manager.ERROR_THRESHOLD - 1;

    await expect(
      storageManager.set(STORES.TRANSACTIONS, 'tx_1', { __backendId: 'tx_1' })
    ).rejects.toThrow();

    await vi.waitFor(() => {
      expect(mockLocalImportAll).toHaveBeenCalled();
    });

    // Adapter MUST have been switched to localStorage on the success path.
    expect(manager.type).toBe('localstorage');

    // The payload handed to LS.importAll must carry settings as a keyed
    // object, NOT the raw IDB array.
    const firstCall = mockLocalImportAll.mock.calls[0];
    if (!firstCall) throw new Error('LocalStorageAdapter.importAll was not invoked');
    const [importedData, overwriteFlag] = firstCall;
    expect(overwriteFlag).toBe(true);
    expect(importedData).toBeDefined();
    expect(Array.isArray(importedData!.settings)).toBe(false);
    expect(importedData!.settings).toEqual({
      theme: 'dark',
      currency: { home: 'USD', symbol: '$' },
      onboarding: { active: false, completed: true, step: 3 }
    });
    // Non-settings stores pass through untouched.
    expect(importedData!.transactions).toEqual([{ id: 'tx_1', amount: 42 }]);
    // Meta/errors stripped before handoff.
    expect(importedData!._meta).toBeUndefined();
    expect(importedData!._exportErrors).toBeUndefined();
  });
});

/**
 * CR-Apr22 (slice 1 — finding #2): exhaustive coverage of the
 * shape-normalizer at the unit level. Each case below catches a subtle
 * edge the raw-pass-through behavior would silently mangle on rollback.
 */
describe('normalizeIdbExportForLocalStorage', () => {
  it('rewrites an IDB settings-array into a keyed object', () => {
    const input = {
      transactions: [{ id: 'a' }],
      settings: [
        { key: 'theme', value: 'dark' },
        { key: 'pin', value: '' }
      ]
    };
    const out = normalizeIdbExportForLocalStorage(input);
    expect(out.settings).toEqual({ theme: 'dark', pin: '' });
    expect(out.transactions).toBe(input.transactions); // non-settings pass-through
  });

  it('preserves a settings object that is already in LS shape (idempotent)', () => {
    const input = {
      settings: { theme: 'light', currency: { home: 'USD', symbol: '$' } }
    };
    const out = normalizeIdbExportForLocalStorage(input);
    expect(out.settings).toEqual({ theme: 'light', currency: { home: 'USD', symbol: '$' } });
  });

  it('drops rows with missing / non-string keys rather than crashing', () => {
    const input = {
      settings: [
        { key: 'theme', value: 'dark' },
        { value: 'orphan-no-key' },
        { key: '', value: 'empty-string-key' },
        { key: 42, value: 'numeric-key' },
        null,
        { key: 'currency', value: { home: 'USD' } }
      ]
    };
    const out = normalizeIdbExportForLocalStorage(input);
    expect(out.settings).toEqual({
      theme: 'dark',
      currency: { home: 'USD' }
    });
  });

  it('does not mutate the input payload', () => {
    const input = {
      settings: [{ key: 'theme', value: 'dark' }]
    };
    const originalSettings = input.settings;
    const out = normalizeIdbExportForLocalStorage(input);
    expect(input.settings).toBe(originalSettings);
    expect(out).not.toBe(input);
  });

  it('leaves payloads without a settings field untouched', () => {
    const input = { transactions: [{ id: 'a' }], debts: [] };
    const out = normalizeIdbExportForLocalStorage(input);
    expect(out).toEqual(input);
  });
});
