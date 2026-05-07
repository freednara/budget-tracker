import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStorageAdapter } from '../js/modules/data/localstorage-adapter.js';
import { STORES, SETTINGS_KEYS } from '../js/modules/data/storage-adapter.js';
import { safeStorage } from '../js/modules/core/safe-storage.js';
import { SK } from '../js/modules/core/state.js';

describe('LocalStorageAdapter importAll', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('rolls back overwritten stores and settings when a later write fails', async () => {
    const adapter = new LocalStorageAdapter();

    localStorage.setItem(SK.TX, JSON.stringify([{ __backendId: 'tx_old', amount: 10 }]));
    localStorage.setItem(SK.THEME, JSON.stringify('dark'));

    const setJsonSpy = vi.spyOn(safeStorage, 'setJSON').mockImplementation((key: string, value: unknown) => {
      if (key === SK.THEME) {
        return false;
      }
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    });

    const result = await adapter.importAll(
      {
        [STORES.TRANSACTIONS]: [{ __backendId: 'tx_new', amount: 20 }],
        settings: {
          [SETTINGS_KEYS.THEME]: 'light'
        }
      },
      true
    );

    expect(result).toBe(false);
    expect(setJsonSpy).toHaveBeenCalled();
    expect(localStorage.getItem(SK.TX)).toBe(JSON.stringify([{ __backendId: 'tx_old', amount: 10 }]));
    expect(localStorage.getItem(SK.THEME)).toBe(JSON.stringify('dark'));
  });

  it('preserves object-backed stores when exporting all data', async () => {
    const adapter = new LocalStorageAdapter();

    const allocations = { '2026-04': { food: 200 } };
    const achievements = { streak_7: { unlocked: true } };
    localStorage.setItem(SK.ALLOC, JSON.stringify(allocations));
    localStorage.setItem(SK.ACHIEVE, JSON.stringify(achievements));

    const exported = await adapter.exportAll();

    expect(exported[STORES.MONTHLY_ALLOCATIONS]).toEqual(allocations);
    expect(exported[STORES.ACHIEVEMENTS]).toEqual(achievements);
  });

  it('merges exported object-backed stores without treating them as arrays', async () => {
    const adapter = new LocalStorageAdapter();

    localStorage.setItem(SK.ALLOC, JSON.stringify({ '2026-03': { rent: 900 } }));
    localStorage.setItem(SK.ACHIEVE, JSON.stringify({ streak_7: { unlocked: true } }));

    const result = await adapter.importAll(
      {
        [STORES.MONTHLY_ALLOCATIONS]: { '2026-04': { food: 200 } },
        [STORES.ACHIEVEMENTS]: { streak_30: { unlocked: true } }
      },
      false
    );

    expect(result).toBe(true);
    expect(JSON.parse(localStorage.getItem(SK.ALLOC) || '{}')).toEqual({
      '2026-03': { rent: 900 },
      '2026-04': { food: 200 }
    });
    expect(JSON.parse(localStorage.getItem(SK.ACHIEVE) || '{}')).toEqual({
      streak_7: { unlocked: true },
      streak_30: { unlocked: true }
    });
  });
});
