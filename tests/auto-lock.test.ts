import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initAutoLock, pauseAutoLock, resetAutoLockTimer, resumeAutoLock } from '../js/modules/features/security/auto-lock.js';

describe('auto-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('locks immediately when the document becomes hidden', () => {
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    });

    document.dispatchEvent(new Event('visibilitychange'));

    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('respects pause and resume across visibility changes', () => {
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000);

    pauseAutoLock();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onLock).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    });
    resumeAutoLock();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('still supports timer-based locking after manual reset', () => {
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 5_000);

    resetAutoLockTimer();
    vi.advanceTimersByTime(4_999);
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
