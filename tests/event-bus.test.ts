import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeatureEvents } from '../js/modules/core/feature-event-interface.js';
import {
  checkOrphanedListeners,
  clearAll,
  createListenerGroup,
  destroyListenerGroup,
  getListenerGroupStats,
  on,
  emit
} from '../js/modules/core/event-bus.js';
import * as signals from '../js/modules/core/signals.js';
import { initTheme } from '../js/modules/features/personalization/theme.js';

describe('event bus lifecycle cleanup', () => {
  beforeEach(() => {
    clearAll();
    document.body.innerHTML = '';
    signals.theme.value = 'dark';

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })
    });
  });

  afterEach(() => {
    clearAll();
  });

  it('removes grouped listeners from both listener maps and group stats', () => {
    const groupId = createListenerGroup('BudgetPanel');
    const unsubscribe = on(
      'budget:test',
      () => undefined,
      { groupId, componentName: 'BudgetPanel' }
    );

    expect(getListenerGroupStats()).toEqual([
      expect.objectContaining({ componentName: 'BudgetPanel', listenerCount: 1 })
    ]);
    expect(checkOrphanedListeners()).toEqual([
      expect.objectContaining({ event: 'budget:test', count: 1 })
    ]);

    destroyListenerGroup(groupId);

    expect(getListenerGroupStats()).toEqual([]);
    expect(checkOrphanedListeners()).toEqual([]);

    unsubscribe();
    expect(checkOrphanedListeners()).toEqual([]);
  });

  it('cleans up the theme feature listener when the theme module unmounts', () => {
    const cleanup = initTheme();

    expect(checkOrphanedListeners()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: FeatureEvents.SET_THEME, count: 1 })
      ])
    );

    emit(FeatureEvents.SET_THEME, { theme: 'light' });
    expect(signals.theme.value).toBe('light');

    cleanup();

    expect(checkOrphanedListeners().some((entry) => entry.event === FeatureEvents.SET_THEME)).toBe(false);
  });

  it('removes the system theme listener from the same media query instance', () => {
    signals.theme.value = 'system';

    const queries: Array<{
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
      matches: boolean;
    }> = [];

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => {
        const query = {
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        };
        queries.push(query);
        return query;
      })
    });

    const cleanup = initTheme();
    cleanup();

    expect(queries[0]?.addEventListener).toHaveBeenCalledTimes(1);
    expect(queries[0]?.removeEventListener).toHaveBeenCalledTimes(1);
    expect(queries[1]?.removeEventListener).toBeUndefined();
  });
});
