import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('setupPerformanceMonitoring', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('registers global listeners and intervals only once', async () => {
    const documentSpy = vi.spyOn(document, 'addEventListener');
    const windowSpy = vi.spyOn(window, 'addEventListener');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);

    class MockPerformanceObserver {
      constructor(_callback: PerformanceObserverCallback) {}
      observe(): void {}
      disconnect(): void {}
    }

    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver as unknown as typeof PerformanceObserver);

    const { setupPerformanceMonitoring } = await import('../js/modules/core/performance-integration.js');

    setupPerformanceMonitoring();
    const intervalCallsAfterFirstSetup = intervalSpy.mock.calls.length;
    setupPerformanceMonitoring();

    expect(documentSpy.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
    expect(windowSpy.mock.calls.filter(([type]) => type === 'online')).toHaveLength(1);
    expect(windowSpy.mock.calls.filter(([type]) => type === 'offline')).toHaveLength(1);
    expect(intervalSpy.mock.calls.length).toBe(intervalCallsAfterFirstSetup);
  });

  it('blocks monitored fetch requests to external origins', async () => {
    const { monitoredFetch } = await import('../js/modules/core/performance-integration.js');

    await expect(monitoredFetch('https://example.com/export')).rejects.toThrow(
      'Blocked external monitored fetch'
    );
  });

  // Phase 6 Slice 1c (Inline-Behavior-Review rev 12, L4): verify the
  // cleanupPerformanceMonitoring() pair tears down every handle
  // setupPerformanceMonitoring() installs, and re-init after cleanup
  // re-arms the pipeline (no stacked intervals / duplicate listeners).
  it('cleanupPerformanceMonitoring releases every handle so re-init is clean', async () => {
    const addDocSpy = vi.spyOn(document, 'addEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    const addWinSpy = vi.spyOn(window, 'addEventListener');
    const removeWinSpy = vi.spyOn(window, 'removeEventListener');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      42 as unknown as ReturnType<typeof setInterval>
    );
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    // Share disconnect/observe across every instance so the test doesn't
    // have to track instances through the module boundary.
    const disconnectSpy = vi.fn();
    const observeSpy = vi.fn();
    class MockPerformanceObserver {
      disconnect = disconnectSpy;
      observe = observeSpy;
      constructor(_callback: PerformanceObserverCallback) {}
    }

    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver as unknown as typeof PerformanceObserver);

    const { setupPerformanceMonitoring, cleanupPerformanceMonitoring } = await import(
      '../js/modules/core/performance-integration.js'
    );

    setupPerformanceMonitoring();
    const visCountBefore = addDocSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length;
    const onlineCountBefore = addWinSpy.mock.calls.filter(([t]) => t === 'online').length;
    const offlineCountBefore = addWinSpy.mock.calls.filter(([t]) => t === 'offline').length;
    const intervalCountBefore = setIntervalSpy.mock.calls.length;

    cleanupPerformanceMonitoring();

    // Every handle released exactly once.
    expect(removeDocSpy.mock.calls.filter(([t]) => t === 'visibilitychange')).toHaveLength(1);
    expect(removeWinSpy.mock.calls.filter(([t]) => t === 'online')).toHaveLength(1);
    expect(removeWinSpy.mock.calls.filter(([t]) => t === 'offline')).toHaveLength(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(42);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    // Re-init after cleanup re-arms the pipeline (no stacked intervals).
    setupPerformanceMonitoring();
    expect(addDocSpy.mock.calls.filter(([t]) => t === 'visibilitychange')).toHaveLength(visCountBefore + 1);
    expect(addWinSpy.mock.calls.filter(([t]) => t === 'online')).toHaveLength(onlineCountBefore + 1);
    expect(addWinSpy.mock.calls.filter(([t]) => t === 'offline')).toHaveLength(offlineCountBefore + 1);
    expect(setIntervalSpy.mock.calls.length).toBe(intervalCountBefore + 1);

    // Cleanup is idempotent — a second call with nothing installed is a no-op.
    cleanupPerformanceMonitoring();
    cleanupPerformanceMonitoring();
    expect(removeDocSpy.mock.calls.filter(([t]) => t === 'visibilitychange')).toHaveLength(2);
  });
});
