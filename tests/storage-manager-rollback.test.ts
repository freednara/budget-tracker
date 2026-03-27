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
  generateSecureId: vi.fn(() => 'secure-id')
}));

import { storageManager, STORES } from '../js/modules/data/storage-manager.js';

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
      const marker = localStorage.getItem('budget_tracker_storage_rollback_failed');
      expect(marker).not.toBeNull();
    });

    expect(manager.type).toBe('indexeddb');
    expect(mockLocalInit).not.toHaveBeenCalled();
    expect(mockLocalImportAll).not.toHaveBeenCalled();

    const marker = JSON.parse(localStorage.getItem('budget_tracker_storage_rollback_failed') || '{}') as {
      reason?: string;
      exportErrors?: Record<string, string>;
    };
    expect(marker.reason).toBe('partial_export');
    expect(marker.exportErrors).toEqual(exportErrors);
  });

  it('falls back to localStorage on init when a rollback failure marker is present', async () => {
    localStorage.setItem('budget_tracker_storage_rollback_failed', JSON.stringify({
      reason: 'migration_indexeddb_restore_failed',
      timestamp: Date.now()
    }));

    const result = await storageManager.init();

    expect(result).toEqual({ isOk: true, type: 'localstorage' });
    expect(mockLocalInit).toHaveBeenCalledTimes(1);
    expect(mockIdbInit).not.toHaveBeenCalled();
    expect(storageManager.getType()).toBe('localstorage');
  });
});
