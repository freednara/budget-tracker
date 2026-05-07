import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClose } = vi.hoisted(() => ({
  mockClose: vi.fn()
}));

vi.mock('../js/modules/data/indexeddb-adapter.js', () => ({
  IndexedDBAdapter: class {
    close(): void {
      mockClose();
    }
  }
}));

vi.mock('../js/modules/data/localstorage-adapter.js', () => ({
  LocalStorageAdapter: class {}
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

import { storageManager } from '../js/modules/data/storage-manager.js';
import { IndexedDBAdapter } from '../js/modules/data/indexeddb-adapter.js';

describe('storageManager.reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageManager.reset();
  });

  it('closes an active IndexedDB adapter before clearing manager state', () => {
    const manager = storageManager as unknown as { adapter: InstanceType<typeof IndexedDBAdapter> | null };
    manager.adapter = new IndexedDBAdapter();

    storageManager.reset();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(manager.adapter).toBeNull();
  });
});
