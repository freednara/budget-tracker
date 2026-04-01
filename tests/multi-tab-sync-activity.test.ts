import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupActivityTracking,
  initActivityTracking,
  markUnsavedChanges
} from '../js/modules/core/multi-tab-sync-activity.js';

describe('multi-tab-sync activity tracking cleanup', () => {
  beforeEach(() => {
    cleanupActivityTracking();
    markUnsavedChanges(false);
  });

  afterEach(() => {
    cleanupActivityTracking();
  });

  it('removes document listeners that initActivityTracking registers', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    initActivityTracking();
    cleanupActivityTracking();

    expect(addSpy).toHaveBeenCalledWith('input', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('focus', expect.any(Function), true);
    expect(addSpy).toHaveBeenCalledWith('blur', expect.any(Function), true);
    expect(addSpy).toHaveBeenCalledWith('click', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('change', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('submit', expect.any(Function));

    expect(removeSpy).toHaveBeenCalledWith('input', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('submit', expect.any(Function));
  });
});
