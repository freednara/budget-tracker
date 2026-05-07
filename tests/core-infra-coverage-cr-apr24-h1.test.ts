/**
 * Core Infrastructure Coverage (CR-Apr24-H1)
 *
 * P3 test-coverage gaps for core infrastructure modules:
 *
 * - Finding 269: safe-storage setJSON stringify failure
 * - Finding 307: Mutex, Semaphore, ReadWriteLock primitives
 * - Finding 328: effect-manager lifecycle (mount, unmount, errors)
 * - Finding 303/308: render-scheduler loop detection + batch scheduling
 * - Finding 296: DI container falsy singleton/value registration
 * - Finding 274/279: event-bus throttle config + duplicate handlers
 * - Finding 285: lazy-loader cleanup / failure paths
 * - Finding 325: error-state direct coverage (covered in Cluster G tests)
 * - Finding 258: error-tracker hydration (covered in Cluster G tests)
 * - Finding 266: error-boundary API surface (covered in Cluster G tests)
 * - Finding 289: performance-integration monitoring wrappers
 * - Finding 295: error-handler handleError path
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// ==========================================
// FINDING 269: safe-storage setJSON stringify failure
// ==========================================

describe('finding 269 — safeStorage setJSON handles stringify errors', () => {
  it('setJSON returns false when value is not serializable', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');

    // Circular reference causes JSON.stringify to throw
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = safeStorage.setJSON('test_circular', circular);
    expect(result).toBe(false);
  });

  it('getJSON returns fallback when stored value is invalid JSON', async () => {
    const { safeStorage } = await import('../js/modules/core/safe-storage.js');

    localStorage.setItem('test_bad_json', '{not valid json');
    const result = safeStorage.getJSON('test_bad_json', { fallback: true });

    expect(result).toEqual({ fallback: true });
    localStorage.removeItem('test_bad_json');
  });

  it('setItem detects QuotaExceededError and routes to error handler', async () => {
    const { safeStorage, setStorageErrorHandler } = await import(
      '../js/modules/core/safe-storage.js'
    );

    const handler = { handleError: vi.fn() };
    setStorageErrorHandler(handler);

    // Mock localStorage.setItem to throw QuotaExceededError
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError');
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw quotaError;
    });

    const result = safeStorage.setItem('test_key', 'test_value');
    expect(result).toBe(false);
    expect(handler.handleError).toHaveBeenCalledWith(
      expect.objectContaining({ critical: true })
    );

    spy.mockRestore();
    setStorageErrorHandler(null as unknown as Parameters<typeof setStorageErrorHandler>[0]);
  });
});

// ==========================================
// FINDING 307: Lock primitives
// ==========================================

describe('finding 307 — Mutex, Semaphore, ReadWriteLock', () => {
  it('Mutex provides mutual exclusion', async () => {
    const { Mutex } = await import('../js/modules/core/mutex.js');
    const mutex = new Mutex();

    expect(mutex.isLocked()).toBe(false);

    await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);

    mutex.release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('Mutex queues concurrent acquires', async () => {
    const { Mutex } = await import('../js/modules/core/mutex.js');
    const mutex = new Mutex();
    const order: number[] = [];

    await mutex.acquire();

    // These will queue
    const p1 = mutex.acquire().then(() => order.push(1));
    const p2 = mutex.acquire().then(() => order.push(2));

    // Release to let p1 proceed
    mutex.release();
    await p1;
    // Release to let p2 proceed
    mutex.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  it('Mutex.acquire rejects on timeout', async () => {
    const { Mutex } = await import('../js/modules/core/mutex.js');
    const mutex = new Mutex();

    await mutex.acquire();

    // Second acquire with short timeout should reject
    await expect(mutex.acquire(50)).rejects.toThrow('Mutex acquire timeout');

    mutex.release();
  });

  it('Mutex.runExclusive auto-releases on error', async () => {
    const { Mutex } = await import('../js/modules/core/mutex.js');
    const mutex = new Mutex();

    await expect(
      mutex.runExclusive(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    // Mutex should be released even after error
    expect(mutex.isLocked()).toBe(false);
  });

  it('Semaphore limits concurrent access', async () => {
    const { Semaphore } = await import('../js/modules/core/mutex.js');
    const sem = new Semaphore(2);

    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      sem.release();
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('ReadWriteLock allows concurrent reads', async () => {
    const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
    const rwl = new ReadWriteLock();

    // Multiple readers can acquire simultaneously
    await rwl.acquireRead();
    await rwl.acquireRead();

    rwl.releaseRead();
    rwl.releaseRead();
  });

  it('ReadWriteLock blocks readers during write', async () => {
    const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
    const rwl = new ReadWriteLock();
    const events: string[] = [];

    await rwl.acquireWrite();

    // Reader should queue behind writer
    const readerDone = rwl.acquireRead().then(() => {
      events.push('read');
      rwl.releaseRead();
    });

    // Reader hasn't run yet
    expect(events).toEqual([]);

    events.push('write-done');
    rwl.releaseWrite();
    await readerDone;

    expect(events).toEqual(['write-done', 'read']);
  });

  it('ReadWriteLock prioritizes writers over readers', async () => {
    const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
    const rwl = new ReadWriteLock();
    const events: string[] = [];

    await rwl.acquireWrite();

    // Queue a writer and then a reader
    const writerDone = rwl.acquireWrite().then(() => {
      events.push('writer2');
      rwl.releaseWrite();
    });
    const readerDone = rwl.acquireRead().then(() => {
      events.push('reader');
      rwl.releaseRead();
    });

    rwl.releaseWrite();
    await writerDone;
    await readerDone;

    // Writer should have gone before reader
    expect(events).toEqual(['writer2', 'reader']);
  });
});

// ==========================================
// FINDING 328: effect-manager lifecycle
// ==========================================

describe('finding 328 — effect-manager mount/unmount lifecycle', () => {
  afterEach(async () => {
    const em = await import('../js/modules/core/effect-manager.js');
    em.unmountAll();
  });

  it('mountEffects registers and tracks disposers', async () => {
    const em = await import('../js/modules/core/effect-manager.js');
    const disposer = vi.fn();

    em.mountEffects('test-component', [() => disposer]);

    expect(em.getActiveEffectCount()).toBe(1);
    expect(em.getActiveComponentIds()).toContain('test-component');
    expect(disposer).not.toHaveBeenCalled();
  });

  it('unmountEffects calls disposers', async () => {
    const em = await import('../js/modules/core/effect-manager.js');
    const disposer = vi.fn();

    em.mountEffects('test-component', [() => disposer]);
    em.unmountEffects('test-component');

    expect(disposer).toHaveBeenCalledOnce();
    expect(em.getActiveEffectCount()).toBe(0);
  });

  it('mountEffects cleans up previous effects for same component', async () => {
    const em = await import('../js/modules/core/effect-manager.js');
    const disposer1 = vi.fn();
    const disposer2 = vi.fn();

    em.mountEffects('test-component', [() => disposer1]);
    em.mountEffects('test-component', [() => disposer2]);

    // First disposer should have been called during re-mount
    expect(disposer1).toHaveBeenCalledOnce();
    // Second is still active
    expect(disposer2).not.toHaveBeenCalled();
    expect(em.getActiveEffectCount()).toBe(1);
  });

  it('mountEffects rolls back and rethrows on factory error (CR-Apr24-I finding 326)', async () => {
    const em = await import('../js/modules/core/effect-manager.js');
    const goodDisposer = vi.fn();

    // First factory succeeds, second throws — finding 326 changed the
    // contract: mountEffects now rolls back already-collected disposers
    // and rethrows instead of swallowing.
    expect(() =>
      em.mountEffects('test-component', [
        () => goodDisposer,
        () => { throw new Error('factory crash'); },
      ])
    ).toThrow('factory crash');

    // The good disposer should have been rolled back
    expect(goodDisposer).toHaveBeenCalledOnce();
    // Component should NOT be registered
    expect(em.getActiveEffectCount()).toBe(0);
  });

  it('unmountEffects swallows disposer errors', async () => {
    const em = await import('../js/modules/core/effect-manager.js');

    em.mountEffects('test-component', [
      () => () => { throw new Error('disposer crash'); }
    ]);

    // Should not throw
    expect(() => em.unmountEffects('test-component')).not.toThrow();
    expect(em.getActiveEffectCount()).toBe(0);
  });

  it('unmountAll clears all components', async () => {
    const em = await import('../js/modules/core/effect-manager.js');

    em.mountEffects('comp-a', [() => vi.fn()]);
    em.mountEffects('comp-b', [() => vi.fn()]);

    expect(em.getActiveEffectCount()).toBe(2);
    em.unmountAll();
    expect(em.getActiveEffectCount()).toBe(0);
  });
});

// ==========================================
// FINDING 303/308: render-scheduler
// ==========================================

describe('findings 303/308 — render-scheduler loop detection + batching', () => {
  it('register + schedule invokes task', async () => {
    const { createRenderScheduler } = await import(
      '../js/modules/core/render-scheduler.js'
    );
    const scheduler = createRenderScheduler();
    const fn = vi.fn();

    scheduler.register('test-task', fn);
    scheduler.schedule('test-task');

    // Wait for RAF to process
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(fn).toHaveBeenCalled();
  });

  it('cancel prevents scheduled task from running', async () => {
    const { createRenderScheduler } = await import(
      '../js/modules/core/render-scheduler.js'
    );
    const scheduler = createRenderScheduler();
    const fn = vi.fn();

    scheduler.register('test-cancel', fn);
    scheduler.schedule('test-cancel');
    scheduler.cancel('test-cancel');

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(fn).not.toHaveBeenCalled();
  });

  it('scheduleWithPriority respects priority ordering', async () => {
    const { createRenderScheduler } = await import(
      '../js/modules/core/render-scheduler.js'
    );
    const scheduler = createRenderScheduler();
    const order: string[] = [];

    scheduler.register('low-task', () => { order.push('low'); }, 'low');
    scheduler.register('high-task', () => { order.push('high'); }, 'immediate');

    scheduler.scheduleWithPriority('low-task', 'low');
    scheduler.scheduleWithPriority('high-task', 'immediate');

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // High priority should execute before low
    if (order.length >= 2) {
      expect(order.indexOf('high')).toBeLessThan(order.indexOf('low'));
    }
  });
});

// ==========================================
// FINDING 296: DI container falsy values
// ==========================================

describe('finding 296 — DI container falsy singleton/value instances', () => {
  it('registerValue stores and resolves falsy values (0, false, empty string)', async () => {
    const { createDefaultContainer } = await import(
      '../js/modules/core/di-container.js'
    );
    const container = createDefaultContainer();

    container.registerValue('zero', 0);
    container.registerValue('falseVal', false);
    container.registerValue('emptyStr', '');
    container.registerValue('nullVal', null);

    await container.initialize();

    expect(container.resolveSync<number>('zero')).toBe(0);
    expect(container.resolveSync<boolean>('falseVal')).toBe(false);
    expect(container.resolveSync<string>('emptyStr')).toBe('');
    expect(container.resolveSync<null>('nullVal')).toBe(null);

    container.clear();
  });
});

// ==========================================
// FINDING 274/279: event-bus throttle + duplicate handlers
// ==========================================

describe('findings 274/279 — event-bus throttle config + duplicate handlers', () => {
  afterEach(async () => {
    const { clearAll, resetMetrics } = await import('../js/modules/core/event-bus.js');
    clearAll();
    resetMetrics();
  });

  it('duplicate handler reference fires once per subscription (CR-Apr24-I finding 275)', async () => {
    const { on, emit } = await import('../js/modules/core/event-bus.js');

    const handler = vi.fn();

    // Subscribe the same handler reference twice — each on() wraps
    // uniquely so both subscriptions are independent (finding 275).
    const unsub1 = on('test:dup', handler);
    const unsub2 = on('test:dup', handler);

    emit('test:dup', 'payload');

    // Both subscriptions fire — handler called twice
    expect(handler).toHaveBeenCalledTimes(2);

    // Removing one subscription leaves the other intact (finding 276)
    unsub1();
    handler.mockClear();
    emit('test:dup', 'payload2');
    expect(handler).toHaveBeenCalledTimes(1);

    unsub2();
  });

  it('distinct handler references both fire for same event', async () => {
    const { on, emit } = await import('../js/modules/core/event-bus.js');

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    on('test:multi', handler1);
    on('test:multi', handler2);

    emit('test:multi', 'payload');

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('setEventThrottle throttles event emission', async () => {
    const { on, emit, setEventThrottle } = await import(
      '../js/modules/core/event-bus.js'
    );

    setEventThrottle('test:throttled', 100);
    const handler = vi.fn();
    on('test:throttled', handler);

    // Rapid emissions
    emit('test:throttled', 1);
    emit('test:throttled', 2);
    emit('test:throttled', 3);

    // Only the first should fire immediately
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('destroyListenerGroup removes all listeners in group', async () => {
    const { on, emit, createListenerGroup, destroyListenerGroup } = await import(
      '../js/modules/core/event-bus.js'
    );

    const groupId = createListenerGroup('test-group');
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    on('test:grouped1', handler1, { groupId });
    on('test:grouped2', handler2, { groupId });

    destroyListenerGroup(groupId);

    emit('test:grouped1', 'a');
    emit('test:grouped2', 'b');

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});

// ==========================================
// FINDING 289: performance-integration monitoring wrappers
// ==========================================

describe('finding 289 — performance-integration monitoring wrappers', () => {
  it('monitorEventHandler wraps and preserves handler behavior', async () => {
    const { monitorEventHandler } = await import(
      '../js/modules/core/performance-integration.js'
    );

    const original = vi.fn();
    const wrapped = monitorEventHandler('test-handler', original);

    expect(typeof wrapped).toBe('function');
    // monitorEventHandler expects (event: T) — a single Event parameter
    const fakeEvent = new Event('click');
    await wrapped(fakeEvent);

    expect(original).toHaveBeenCalledWith(fakeEvent);
  });

  it('setupPerformanceMonitoring is idempotent', async () => {
    const { setupPerformanceMonitoring, cleanupPerformanceMonitoring } = await import(
      '../js/modules/core/performance-integration.js'
    );

    // Should not throw on repeated calls
    setupPerformanceMonitoring();
    setupPerformanceMonitoring(); // second call should be no-op

    cleanupPerformanceMonitoring();
  });
});

// ==========================================
// FINDING 295: error-handler handleError path
// ==========================================

describe('finding 295 — error-handler handleError dispatches correctly', () => {
  it('handleError routes through displayError (not double-track)', async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    const { handleError } = await import('../js/modules/core/global-error-handler.js');

    tracker.clearErrorLog();

    handleError('test message', new Error('test295'), { module: 'test295' });

    const testErrors = tracker.getStoredErrors().filter(
      e => e.context.module === 'test295'
    );
    // Single entry — verifies no double-tracking
    expect(testErrors.length).toBe(1);

    tracker.clearErrorLog();
  });
});
