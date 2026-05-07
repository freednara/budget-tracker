import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setThemeMock, syncStateApplyKeyUpdateMock, lsGetMock, shouldShowPinLockMock, showPinLockMock, trackErrorMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
  syncStateApplyKeyUpdateMock: vi.fn(),
  lsGetMock: vi.fn((_key: string, fallback: unknown) => fallback),
  shouldShowPinLockMock: vi.fn(() => false),
  showPinLockMock: vi.fn(),
  trackErrorMock: vi.fn(),
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

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: trackErrorMock,
}));

import { SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
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
    trackErrorMock.mockReset();
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

    // rev 12 L35: SK.THEME now routes through syncState.applyKeyUpdate,
    // which reads the current value via lsGet and propagates via the
    // hydration registry (normalizeTheme validator). The storage handler
    // no longer calls setTheme() directly.
    lsGetMock.mockReturnValue('light');

    initStorageEvents(callbacks);
    initStorageEvents(callbacks);

    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.THEME,
      newValue: '"light"',
    }));

    expect(syncStateApplyKeyUpdateMock).toHaveBeenCalledTimes(1);
    expect(syncStateApplyKeyUpdateMock).toHaveBeenCalledWith(SK.THEME, 'light');

    cleanupStorageEvents();

    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.THEME,
      newValue: '"dark"',
    }));

    // After cleanup, no further dispatches should occur.
    expect(syncStateApplyKeyUpdateMock).toHaveBeenCalledTimes(1);
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

  it('ignores malformed onboarding and filter-expanded payloads from storage events', () => {
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

    signals.onboarding.value = { active: true, step: 2, completed: false };
    signals.filtersExpanded.value = true;

    initStorageEvents(callbacks);

    lsGetMock.mockReturnValueOnce({ active: 'yes', step: '2', completed: false });
    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.ONBOARD,
      newValue: '{"active":"yes","step":"2","completed":false}',
    }));

    lsGetMock.mockReturnValueOnce('open');
    window.dispatchEvent(new StorageEvent('storage', {
      key: SK.FILTER_EXPANDED,
      newValue: '"open"',
    }));

    expect(signals.onboarding.value).toEqual({ active: true, step: 2, completed: false });
    expect(signals.filtersExpanded.value).toBe(true);
    expect(trackErrorMock).toHaveBeenCalledTimes(2);
  });
});
