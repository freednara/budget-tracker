import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as eventBus from '../js/modules/core/event-bus.js';
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Force the localStorage fallback path
    (storageManager as any).syncChannel = null;
    // Reset counter to known state so we get predictable keys
    (storageManager as any)._syncMessageCounter = 0;

    // Clear any pre-existing harbor_sync_ keys
    const preKeys = Object.keys(localStorage).filter(k => k.startsWith('harbor_sync_'));
    preKeys.forEach(k => localStorage.removeItem(k));

    storageManager.broadcastChange('update', 'all', { key: 'first' });
    storageManager.broadcastChange('update', 'all', { key: 'second' });

    // Read localStorage directly for sync keys
    const syncKeys = Object.keys(localStorage).filter(k => k.startsWith('harbor_sync_'));

    expect(syncKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(syncKeys).size).toBe(syncKeys.length); // all unique
  });

  it('ignores malformed sync payloads before they reach the event bus', () => {
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1712000000000);

    (storageManager as any)._handleSyncMessage({
      type: 'update',
      store: '__proto__',
      tabId: 'other-tab',
      timestamp: Date.now(),
      data: { key: 'theme' }
    });

    (storageManager as any)._handleSyncMessage({
      type: 'update',
      store: 'all',
      tabId: 'other-tab',
      timestamp: Date.now() - (6 * 60 * 1000),
      data: { key: 'theme' }
    });

    expect(emitSpy).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('emits validated sync payloads from other tabs', () => {
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1712000000000);

    (storageManager as any)._handleSyncMessage({
      type: 'update',
      store: 'transactions',
      tabId: 'other-tab',
      timestamp: Date.now(),
      data: { key: 'tx_1' }
    });

    expect(emitSpy).toHaveBeenCalledWith(eventBus.Events.STORAGE_SYNC, {
      type: 'update',
      store: 'transactions',
      data: { key: 'tx_1' },
      timestamp: 1712000000000
    });

    nowSpy.mockRestore();
  });
});
