import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storageManager } from '../js/modules/data/storage-manager.js';

describe('storage-manager localStorage sync fallback', () => {
  beforeEach(() => {
    storageManager.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    storageManager.reset();
    vi.restoreAllMocks();
  });

  it('uses unique fallback sync keys when broadcasts happen in the same millisecond', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1712000000000);

    storageManager.broadcastChange('update', 'all', { key: 'first' });
    storageManager.broadcastChange('update', 'all', { key: 'second' });

    const syncKeys = setItemSpy.mock.calls
      .map(([key]) => key)
      .filter((key): key is string => typeof key === 'string' && key.startsWith('budget_tracker_sync_'));

    expect(syncKeys).toHaveLength(2);
    expect(new Set(syncKeys).size).toBe(2);

    nowSpy.mockRestore();
    removeItemSpy.mockRestore();
  });
});
