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
});
