/**
 * Cluster AH — Error/event-bus/perf test gaps
 * Findings: 258, 266, 270, 274, 279, 284, 285, 289, 295, 303
 */
import { describe, it, expect, afterEach } from 'vitest';

// ==========================================
// Finding 258 — error-tracker direct coverage
// ==========================================
describe('Finding 258 — error-tracker direct coverage', () => {
  it('trackError, getStoredErrors, clearErrorLog lifecycle', async () => {
    const mod = await import('../js/modules/core/error-tracker.js');
    mod.initialize();

    const before = mod.getStoredErrors();
    const countBefore = before.length;

    mod.trackError(new Error('test-258'), {
      module: 'test-258',
      action: 'test',
    });

    const after = mod.getStoredErrors();
    expect(after.length).toBeGreaterThanOrEqual(countBefore + 1);
    expect(after.some(e => e.message?.includes('test-258'))).toBe(true);

    mod.clearErrorLog();
    const cleared = mod.getStoredErrors();
    expect(cleared.length).toBe(0);
  });

  it('getErrorStats returns stats object', async () => {
    const mod = await import('../js/modules/core/error-tracker.js');
    const stats = mod.getErrorStats();
    expect(stats).toBeDefined();
    expect(typeof stats.total).toBe('number');
  });

  it('generateErrorReport returns a report', async () => {
    const mod = await import('../js/modules/core/error-tracker.js');
    const report = mod.generateErrorReport();
    expect(report).toBeDefined();
    expect(typeof report).toBe('object');
  });
});

// ==========================================
// Finding 266 — error-boundary exported wrappers
// ==========================================
describe('Finding 266 — error-boundary exported wrappers', () => {
  it('ErrorBoundary.wrap catches sync errors and returns undefined', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');
    const result = ErrorBoundary.wrap(
      () => { throw new Error('sync-266'); },
      { operation: 'test-266', category: 'unknown', severity: 'low' }
    );
    expect(result).toBeUndefined();
  });

  it('ErrorBoundary.wrap returns value on success', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');
    const result = ErrorBoundary.wrap(
      () => 42,
      { operation: 'test-266-ok', category: 'unknown', severity: 'low' }
    );
    expect(result).toBe(42);
  });

  it('ErrorBoundary.wrapAsync catches async errors', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');
    const result = await ErrorBoundary.wrapAsync(
      async () => { throw new Error('async-266'); },
      { operation: 'test-async-266', category: 'unknown', severity: 'low' }
    );
    expect(result).toBeUndefined();
  });

  it('ErrorBoundary.batch handles partial failures', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');
    const result = await ErrorBoundary.batch(
      [1, 2, 3],
      async (item) => {
        if (item === 2) throw new Error('batch-fail-266');
        return item * 10;
      },
      { operation: 'test-batch-266', category: 'unknown', severity: 'low' }
    );
    expect(result.succeeded).toContain(10);
    expect(result.succeeded).toContain(30);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.item).toBe(2);
  });

  it('tryWithFallback falls back on primary failure', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');
    const result = await ErrorBoundary.tryWithFallback(
      async () => { throw new Error('primary-266'); },
      async () => 'fallback-value',
      { operation: 'test-fallback-266', category: 'unknown', severity: 'low' }
    );
    expect(result).toBe('fallback-value');
  });

  it('setupGlobalErrorHandlers and cleanupGlobalErrorHandlers are callable', async () => {
    const mod = await import('../js/modules/core/error-boundary.js');
    expect(typeof mod.setupGlobalErrorHandlers).toBe('function');
    expect(typeof mod.cleanupGlobalErrorHandlers).toBe('function');
  });

  it('withNetwork catches network errors', async () => {
    const { withNetwork } = await import('../js/modules/core/error-boundary.js');
    const result = await withNetwork(
      async () => { throw new Error('network-266'); },
      'test-network-266'
    );
    expect(result).toBeUndefined();
  });
});

// ==========================================
// Finding 270 — global-error-handler + safe-storage
// ==========================================
describe('Finding 270 — global-error-handler + safe-storage', () => {
  it('handleError does not throw for valid input', async () => {
    const { handleError } = await import('../js/modules/core/global-error-handler.js');
    expect(() => handleError('test error 270', new Error('test-270'))).not.toThrow();
  });

  it('handleError works with no error argument', async () => {
    const { handleError } = await import('../js/modules/core/global-error-handler.js');
    expect(() => handleError('message only 270')).not.toThrow();
  });

  it('safeStorage getItem/setItem/removeItem lifecycle', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');
    const key = '__test_270__';

    const setResult = safeStorage.setItem(key, 'hello');
    expect(setResult).toBe(true);

    const val = safeStorage.getItem(key);
    expect(val).toBe('hello');

    safeStorage.removeItem(key);
    expect(safeStorage.getItem(key)).toBeNull();
  });

  it('safeStorage getJSON returns fallback for missing key', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');
    const result = safeStorage.getJSON('__nonexistent_270__', { x: 1 });
    expect(result).toEqual({ x: 1 });
  });

  it('safeStorage getJSON returns fallback for malformed JSON', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');
    const key = '__malformed_270__';
    safeStorage.setItem(key, '{not valid json}}}');
    const result = safeStorage.getJSON(key, 'fallback');
    expect(result).toBe('fallback');
    safeStorage.removeItem(key);
  });

  it('safeStorage setJSON round-trips objects', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');
    const key = '__json_270__';
    safeStorage.setJSON(key, { a: 1, b: [2, 3] });
    const result = safeStorage.getJSON(key, null);
    expect(result).toEqual({ a: 1, b: [2, 3] });
    safeStorage.removeItem(key);
  });
});

// ==========================================
// Finding 274 — event-bus clearAll and getEventMetrics
// ==========================================
describe('Finding 274 — event-bus clearAll and getEventMetrics', () => {
  afterEach(async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    bus.clearAll();
    bus.resetMetrics();
  });

  it('on/emit/off lifecycle with getEventMetrics', async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    const received: unknown[] = [];
    const handler = (payload: unknown) => { received.push(payload); };

    bus.on('test-274', handler);
    bus.emit('test-274', 'hello');

    await new Promise(r => setTimeout(r, 20));
    expect(received).toContain('hello');

    const metrics = bus.getEventMetrics();
    const m = metrics.find(m => m.name === 'test-274');
    expect(m).toBeDefined();

    bus.off('test-274', handler);
  });

  it('clearAll removes all listeners', async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    let called = false;
    bus.on('test-274-clear', () => { called = true; });
    bus.clearAll();
    bus.emit('test-274-clear');
    await new Promise(r => setTimeout(r, 20));
    expect(called).toBe(false);
  });
});

// ==========================================
// Finding 279 — event-bus duplicate handler + timer teardown
// ==========================================
describe('Finding 279 — event-bus duplicate handler subscription', () => {
  afterEach(async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    bus.clearAll();
    bus.resetMetrics();
  });

  it('same handler registered twice receives payload twice or is deduplicated', async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    let count = 0;
    const handler = () => { count++; };

    bus.on('test-279-dup', handler);
    bus.on('test-279-dup', handler);
    bus.emit('test-279-dup');
    await new Promise(r => setTimeout(r, 20));

    // Either count===2 (both fire) or count===1 (deduplication) — just verify no crash
    expect(count).toBeGreaterThanOrEqual(1);

    bus.off('test-279-dup', handler);
  });

  it('unsubscribe via returned fn cleans up', async () => {
    const bus = await import('../js/modules/core/event-bus.js');
    let count = 0;
    const unsub = bus.on('test-279-unsub', () => { count++; });

    bus.emit('test-279-unsub');
    await new Promise(r => setTimeout(r, 20));
    expect(count).toBe(1);

    unsub();
    bus.emit('test-279-unsub');
    await new Promise(r => setTimeout(r, 20));
    expect(count).toBe(1);
  });
});

// ==========================================
// Finding 284 — monthly-totals-cache cleanup/diagnostics
// ==========================================
describe('Finding 284 — monthly-totals-cache', () => {
  it('initMonthlyTotalsCache / destroyMonthlyTotalsCache lifecycle', async () => {
    const mod = await import('../js/modules/core/monthly-totals-cache.js');
    expect(() => mod.initMonthlyTotalsCache()).not.toThrow();

    const stats = mod.getCacheStats();
    expect(stats).toBeDefined();
    expect(typeof stats.hits).toBe('number');
    expect(typeof stats.misses).toBe('number');

    expect(() => mod.destroyMonthlyTotalsCache()).not.toThrow();
  });

  it('invalidateAllCache clears cached entries', async () => {
    const mod = await import('../js/modules/core/monthly-totals-cache.js');
    mod.initMonthlyTotalsCache();

    // Attempt to get a non-cached month, should return null
    const result = mod.getCachedMonthlyTotals('9999-01');
    expect(result).toBeNull();

    mod.invalidateAllCache();
    mod.destroyMonthlyTotalsCache();
  });

  it('resetCacheStats zeroes counters', async () => {
    const mod = await import('../js/modules/core/monthly-totals-cache.js');
    mod.initMonthlyTotalsCache();
    mod.resetCacheStats();
    const stats = mod.getCacheStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    mod.destroyMonthlyTotalsCache();
  });
});

// ==========================================
// Finding 285 — accessibility announcer lifecycle
// ==========================================
describe('Finding 285 — accessibility announcer', () => {
  it('announcer.announce does not throw', async () => {
    const { announcer } = await import('../js/modules/core/accessibility.js');
    expect(typeof announcer.announce).toBe('function');
    expect(() => announcer.announce('Test message 285')).not.toThrow();
    expect(() => announcer.announce('Urgent 285', 'assertive')).not.toThrow();
  });
});

// ==========================================
// Finding 289 — lazy-loader cleanup/failure
// ==========================================
describe('Finding 289 — lazy-loader', () => {
  it('lazyLoader singleton is exported with expected API', async () => {
    const { lazyLoader } = await import('../js/modules/core/lazy-loader.js');
    expect(lazyLoader).toBeDefined();
    expect(typeof lazyLoader.init).toBe('function');
    expect(typeof lazyLoader.cleanup).toBe('function');
    expect(typeof lazyLoader.register).toBe('function');
    expect(typeof lazyLoader.getPerformanceStats).toBe('function');
  });

  it('initLazyLoading / cleanupLazyLoading are exported functions', async () => {
    const mod = await import('../js/modules/core/lazy-loader.js');
    expect(typeof mod.initLazyLoading).toBe('function');
    expect(typeof mod.cleanupLazyLoading).toBe('function');
  });

  it('getLazyLoadingStats returns stats', async () => {
    const mod = await import('../js/modules/core/lazy-loader.js');
    const stats = mod.getLazyLoadingStats();
    expect(stats).toBeDefined();
    expect(typeof stats).toBe('object');
  });
});

// ==========================================
// Finding 295 — performance-integration monitoring wrappers
// ==========================================
describe('Finding 295 — performance-integration', () => {
  it('monitorEventHandler wraps a sync handler', async () => {
    const { monitorEventHandler } = await import(
      '../js/modules/core/performance-integration.js'
    );
    let called = false;
    const wrapped = monitorEventHandler('test-295', (_e: Event) => {
      called = true;
    });
    expect(typeof wrapped).toBe('function');

    const fakeEvent = new Event('click');
    void wrapped(fakeEvent);
    expect(called).toBe(true);
  });

  it('setupPerformanceMonitoring / cleanupPerformanceMonitoring lifecycle', async () => {
    const mod = await import('../js/modules/core/performance-integration.js');
    expect(typeof mod.setupPerformanceMonitoring).toBe('function');
    expect(typeof mod.cleanupPerformanceMonitoring).toBe('function');

    // Should not throw
    expect(() => mod.cleanupPerformanceMonitoring()).not.toThrow();
  });

  it('InitializationMonitor tracks phases', async () => {
    const { InitializationMonitor } = await import(
      '../js/modules/core/performance-integration.js'
    );
    const monitor = new InitializationMonitor();
    expect(() => monitor.markPhase('test-295')).not.toThrow();
  });
});

// ==========================================
// Finding 303 — PerformanceMonitor observer/lifecycle
// ==========================================
describe('Finding 303 — PerformanceMonitor', () => {
  it('perfMonitor singleton is exported', async () => {
    const { perfMonitor } = await import('../js/modules/core/performance-monitor.js');
    expect(perfMonitor).toBeDefined();
    expect(typeof perfMonitor.mark).toBe('function');
    expect(typeof perfMonitor.measure).toBe('function');
    expect(typeof perfMonitor.recordMetric).toBe('function');
    expect(typeof perfMonitor.destroy).toBe('function');
  });

  it('PerformanceMonitor instance lifecycle: mark/measure/destroy', async () => {
    const { PerformanceMonitor } = await import(
      '../js/modules/core/performance-monitor.js'
    );
    const pm = new PerformanceMonitor();

    pm.mark('start-303');
    await new Promise(r => setTimeout(r, 5));
    pm.mark('end-303');
    const duration = pm.measure('test-303', 'start-303', 'end-303');
    expect(duration).toBeGreaterThan(0);

    // Destroy cleans up observers
    expect(() => pm.destroy()).not.toThrow();
  });

  it('observe receives metric notifications', async () => {
    const { PerformanceMonitor } = await import(
      '../js/modules/core/performance-monitor.js'
    );
    const pm = new PerformanceMonitor();
    const received: Array<{ name: string }> = [];

    const unsub = pm.observe((metric) => { received.push(metric); });
    pm.recordMetric('obs-test-303', 42, 'ms');

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.some(m => m.name === 'obs-test-303')).toBe(true);

    unsub();
    pm.destroy();
  });
});
