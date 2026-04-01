import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setThemeMock, syncStateApplyKeyUpdateMock, lsGetMock, shouldShowPinLockMock, showPinLockMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
  syncStateApplyKeyUpdateMock: vi.fn(),
  lsGetMock: vi.fn((_key: string, fallback: unknown) => fallback),
  shouldShowPinLockMock: vi.fn(() => false),
  showPinLockMock: vi.fn(),
}));

vi.mock('../js/modules/core/state-actions.js', () => ({
  syncState: {
    applyKeyUpdate: syncStateApplyKeyUpdateMock,
  },
}));

vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual('../js/modules/core/state.js');
  return {
    ...actual,
    lsGet: lsGetMock,
  };
});

vi.mock('../js/modules/core/feature-event-interface.js', async () => {
  const actual = await vi.importActual('../js/modules/core/feature-event-interface.js');
  return {
    ...actual,
    setTheme: setThemeMock,
  };
});

vi.mock('../js/modules/ui/widgets/pin-ui-handlers.js', () => ({
  shouldShowPinLock: shouldShowPinLockMock,
  showPinLock: showPinLockMock,
}));

import { SK } from '../js/modules/core/state.js';
import { cleanupStorageEvents, initStorageEvents } from '../js/modules/ui/interactions/storage-events.js';

describe('storage-events lifecycle', () => {
  beforeEach(() => {
    setThemeMock.mockReset();
    syncStateApplyKeyUpdateMock.mockReset();
    lsGetMock.mockReset();
    lsGetMock.mockImplementation((_key: string, fallback: unknown) => fallback);
    shouldShowPinLockMock.mockReset();
    shouldShowPinLockMock.mockReturnValue(false);
    showPinLockMock.mockReset();
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

  it('normalizes supported insight personalities from storage events', () => {
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

    lsGetMock.mockReturnValueOnce('friendly');

    initStorageEvents(callbacks);

    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.INSIGHT_PERS,
      newValue: '"friendly"',
    }));

    expect(syncStateApplyKeyUpdateMock).toHaveBeenCalledWith(SK.INSIGHT_PERS, 'friendly');
    expect(callbacks.updateInsights).toHaveBeenCalledTimes(1);
  });
});
