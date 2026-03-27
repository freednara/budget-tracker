import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setThemeMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
}));

vi.mock('../js/modules/core/feature-event-interface.js', async () => {
  const actual = await vi.importActual('../js/modules/core/feature-event-interface.js');
  return {
    ...actual,
    setTheme: setThemeMock,
  };
});

import { SK } from '../js/modules/core/state.js';
import { cleanupStorageEvents, initStorageEvents } from '../js/modules/ui/interactions/storage-events.js';

describe('storage-events lifecycle', () => {
  beforeEach(() => {
    setThemeMock.mockReset();
    cleanupStorageEvents();
  });

  afterEach(() => {
    cleanupStorageEvents();
  });

  it('replaces the storage listener on re-init and removes it on cleanup', () => {
    const callbacks = {
      refreshAll: vi.fn(),
      updateSummary: vi.fn(),
      renderSavingsGoals: vi.fn(),
      checkAlerts: vi.fn(),
      updateInsights: vi.fn(),
      renderBadges: vi.fn(),
      renderStreak: vi.fn(),
      renderFilterPresets: vi.fn(),
      renderTemplates: vi.fn(),
    };

    initStorageEvents(callbacks);
    initStorageEvents(callbacks);

    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.THEME,
      newValue: '"light"',
    }));

    expect(setThemeMock).toHaveBeenCalledTimes(1);
    expect(setThemeMock).toHaveBeenCalledWith('light');

    cleanupStorageEvents();

    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.THEME,
      newValue: '"dark"',
    }));

    expect(setThemeMock).toHaveBeenCalledTimes(1);
  });
});
