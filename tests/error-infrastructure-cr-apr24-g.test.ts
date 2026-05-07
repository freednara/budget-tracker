/**
 * Error Infrastructure (CR-Apr24-G, findings 256-257, 259-260, 263, 267, 301, 322-323)
 *
 * Regression tests for error infrastructure correctness:
 *
 * - Finding 256: error-tracker rebuilds fingerprintIndex on initialize
 * - Finding 257: clearErrorLog also clears fingerprintSamplers
 * - Finding 259: withNetwork uses wrapWithRetry (actual retry)
 * - Finding 260: batch parallel+stopOnError uses sequential execution
 * - Finding 263: setupGlobalErrorHandlers is idempotent
 * - Finding 267: global-error-handler.handleError does not double-track
 * - Finding 301: performance-monitor observer isolation
 * - Findings 322-323: falsy fallback in withErrorState / withErrorStateAsync
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ==========================================
// FINDING 256: fingerprintIndex rebuild on initialize
// ==========================================

describe('finding 256 — error-tracker fingerprintIndex rebuild', () => {
  beforeEach(async () => {
    // Fully reset module state — prior tests in the suite may have left
    // isInitialized=true which causes initialize() to early-return.
    const tracker = await import('../js/modules/core/error-tracker.js');
    tracker.cleanup();
    tracker.clearErrorLog();
    localStorage.removeItem('harbor_error_log');
  });

  afterEach(async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    tracker.cleanup();
    tracker.clearErrorLog();
  });

  it('deduplicates errors across initialize() cycles', async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');

    // Helper: filter to only our test's errors (the console.error monkey-patch
    // installed by initialize() creates separate { action: 'console_error' }
    // entries — those are tangential to what we're testing here).
    const testErrors = () =>
      tracker.getStoredErrors().filter(e => e.context.action === 'test256');

    // Reuse the same Error object so the stack-trace line (used in the
    // fingerprint) is identical across both trackError calls.
    const testErr = new Error('duplicate test');

    // First session: track an error
    tracker.initialize();
    tracker.trackError(testErr, { module: 'test', action: 'test256' });

    const errorsAfterFirst = testErrors();
    expect(errorsAfterFirst.length).toBe(1);
    expect(errorsAfterFirst[0]!.count).toBe(1);

    // Simulate session restart: cleanup + re-initialize
    tracker.cleanup();
    tracker.initialize();

    // Track the same error again — should increment count, not add new row
    tracker.trackError(testErr, { module: 'test', action: 'test256' });

    const errorsAfterSecond = testErrors();
    // Should still be 1 error entry, not 2
    expect(errorsAfterSecond.length).toBe(1);
    expect(errorsAfterSecond[0]!.count).toBe(2);
  });
});

// ==========================================
// FINDING 257: clearErrorLog clears samplers
// ==========================================

describe('finding 257 — clearErrorLog resets sampling state', () => {
  afterEach(async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    tracker.cleanup();
    tracker.clearErrorLog();
  });

  it('clearErrorLog allows immediate re-tracking of same fingerprint', async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    tracker.initialize();

    // Helper: filter to only our test's errors (exclude console_error entries
    // created by the console.error monkey-patch that intercepts trackError's
    // DEV-mode console.error call).
    const testErrors = () =>
      tracker.getStoredErrors().filter(e => e.context.action === 'test257');

    // Track an error (first occurrence — always emitted by sampler)
    tracker.trackError(new Error('sampler test'), { module: 'test', action: 'test257' });
    expect(testErrors().length).toBe(1);

    // Clear the log
    tracker.clearErrorLog();
    expect(tracker.getStoredErrors().length).toBe(0);

    // Track the same error again — should be treated as fresh
    tracker.trackError(new Error('sampler test'), { module: 'test', action: 'test257' });
    expect(testErrors().length).toBe(1);
    // Count should be 1, not carried over from before clear
    expect(testErrors()[0]!.count).toBe(1);
  });
});

// ==========================================
// FINDING 259: withNetwork retries
// ==========================================

describe('finding 259 — withNetwork uses wrapWithRetry', () => {
  it('delegates to wrapWithRetry with retry config', async () => {
    const { ErrorBoundary, withNetwork } = await import('../js/modules/core/error-boundary.js');

    const retrySpy = vi.spyOn(ErrorBoundary, 'wrapWithRetry').mockResolvedValue({
      success: true,
      data: 'mocked',
      retries: 0
    });

    const result = await withNetwork(async () => 'test', 'test-retry');

    // Verify wrapWithRetry was called (not wrapAsync)
    expect(retrySpy).toHaveBeenCalledOnce();
    const ctx = retrySpy.mock.calls[0]![1]!;
    expect(ctx).toMatchObject({
      operation: 'test-retry',
      retry: true,
      maxRetries: 3
    });
    expect(result).toBe('mocked');

    retrySpy.mockRestore();
  });

  it('returns undefined when wrapWithRetry reports failure', async () => {
    const { ErrorBoundary, withNetwork } = await import('../js/modules/core/error-boundary.js');

    const retrySpy = vi.spyOn(ErrorBoundary, 'wrapWithRetry').mockResolvedValue({
      success: false,
      error: new Error('permanent failure'),
      retries: 3
    });

    const result = await withNetwork(async () => 'test', 'test-permanent-fail');

    expect(result).toBeUndefined();

    retrySpy.mockRestore();
  });
});

// ==========================================
// FINDING 260: batch parallel+stopOnError
// ==========================================

describe('finding 260 — batch stopOnError uses sequential when parallel requested', () => {
  it('stops processing on first error when stopOnError + parallel', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');

    const executed: number[] = [];
    const items = [1, 2, 3, 4, 5];

    const result = await ErrorBoundary.batch(
      items,
      async (item) => {
        executed.push(item);
        if (item === 2) throw new Error('fail on 2');
        return item * 10;
      },
      { operation: 'test-batch', silent: true },
      { parallel: true, stopOnError: true }
    );

    // With stopOnError, should process sequentially and stop at item 2
    expect(executed).toEqual([1, 2]);
    expect(result.succeeded).toEqual([10]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.item).toBe(2);
  });

  it('processes all items in parallel when stopOnError is false', async () => {
    const { ErrorBoundary } = await import('../js/modules/core/error-boundary.js');

    const items = [1, 2, 3];

    const result = await ErrorBoundary.batch(
      items,
      async (item) => {
        if (item === 2) throw new Error('fail on 2');
        return item * 10;
      },
      { operation: 'test-batch-parallel', silent: true },
      { parallel: true, stopOnError: false }
    );

    // Without stopOnError, all items should be processed (parallel)
    expect(result.succeeded).toEqual([10, 30]);
    expect(result.failed.length).toBe(1);
  });
});

// ==========================================
// FINDING 263: setupGlobalErrorHandlers idempotence
// ==========================================

describe('finding 263 — setupGlobalErrorHandlers is idempotent', () => {
  afterEach(async () => {
    const { cleanupGlobalErrorHandlers } = await import('../js/modules/core/error-boundary.js');
    cleanupGlobalErrorHandlers();
  });

  it('does not register duplicate listeners on repeated calls', async () => {
    const { setupGlobalErrorHandlers } = await import(
      '../js/modules/core/error-boundary.js'
    );

    const addSpy = vi.spyOn(window, 'addEventListener');

    setupGlobalErrorHandlers();
    const firstCallCount = addSpy.mock.calls.filter(
      c => c[0] === 'error' || c[0] === 'unhandledrejection'
    ).length;

    // Second call should be no-op
    setupGlobalErrorHandlers();
    const secondCallCount = addSpy.mock.calls.filter(
      c => c[0] === 'error' || c[0] === 'unhandledrejection'
    ).length;

    // Should have added exactly 2 listeners (error + unhandledrejection)
    // and not added more on second call
    expect(firstCallCount).toBe(2);
    expect(secondCallCount).toBe(2); // same count — no duplicates

    addSpy.mockRestore();
  });

  it('cleanupGlobalErrorHandlers removes listeners', async () => {
    const { setupGlobalErrorHandlers, cleanupGlobalErrorHandlers } = await import(
      '../js/modules/core/error-boundary.js'
    );

    const removeSpy = vi.spyOn(window, 'removeEventListener');

    setupGlobalErrorHandlers();
    cleanupGlobalErrorHandlers();

    const removedCount = removeSpy.mock.calls.filter(
      c => c[0] === 'error' || c[0] === 'unhandledrejection'
    ).length;

    expect(removedCount).toBe(2);
    removeSpy.mockRestore();
  });
});

// ==========================================
// FINDING 267: handleError does not double-track
// ==========================================

describe('finding 267 — global-error-handler does not double-track', () => {
  afterEach(async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    tracker.clearErrorLog();
  });

  it('handleError records error once, not twice', async () => {
    const tracker = await import('../js/modules/core/error-tracker.js');
    const { handleError } = await import('../js/modules/core/global-error-handler.js');

    tracker.clearErrorLog();

    const testErr = new Error('double-track test');
    handleError('Test error occurred', testErr, { module: 'test267' });

    // Filter to errors from our specific module context.
    // The console.error monkey-patch (installed by trackError's auto-init)
    // creates a separate { module: 'console', action: 'console_error' }
    // entry — that's expected behaviour, not double-tracking.
    // The fix for finding 267 ensured handleError calls displayError only
    // (which calls trackError once), instead of calling both displayError
    // AND trackError directly.
    const testErrors = tracker.getStoredErrors().filter(
      e => e.context.module === 'test267' || e.context.module === 'GlobalErrorHandler'
    );
    expect(testErrors.length).toBe(1);
    expect(testErrors[0]!.count).toBe(1);
  });
});

// ==========================================
// FINDING 301: performance-monitor observer isolation
// ==========================================

describe('finding 301 — recordMetric isolates observer failures', () => {
  it('a throwing observer does not break metric recording', async () => {
    const { PerformanceMonitor } = await import('../js/modules/core/performance-monitor.js');

    const monitor = new PerformanceMonitor();
    const goodObserverCalls: string[] = [];

    // Add a throwing observer first (observe returns a cleanup fn)
    monitor.observe(() => {
      throw new Error('observer crash');
    });

    // Add a good observer second
    monitor.observe((metric) => {
      goodObserverCalls.push(metric.name);
    });

    // Recording a metric should NOT throw
    expect(() => {
      monitor.recordMetric('test.metric', 42, 'count');
    }).not.toThrow();

    // The good observer should still have been called
    expect(goodObserverCalls).toContain('test.metric');
  });
});

// ==========================================
// FINDINGS 322-323: falsy fallback in error-state
// ==========================================

describe('findings 322-323 — error-state respects falsy fallbacks', () => {
  it('withErrorState returns fallback of 0 instead of throwing', async () => {
    const { withErrorState, CriticalPath } = await import(
      '../js/modules/core/error-state.js'
    );

    const result = withErrorState(
      () => { throw new Error('test'); },
      'test-falsy',
      { criticalPath: CriticalPath.BALANCE_CALCULATION, fallback: 0 }
    );

    // Should NOT throw — 0 is a valid fallback
    expect(result.hasError).toBe(true);
    expect(result.data).toBe(0);
    expect(result.fallbackUsed).toBe(true);
  });

  it('withErrorState returns fallback of false instead of throwing', async () => {
    const { withErrorState, CriticalPath } = await import(
      '../js/modules/core/error-state.js'
    );

    const result = withErrorState(
      () => { throw new Error('test'); },
      'test-falsy-bool',
      { criticalPath: CriticalPath.DATA_LOAD, fallback: false as unknown as boolean }
    );

    expect(result.hasError).toBe(true);
    expect(result.data).toBe(false);
  });

  it('withErrorState returns fallback of empty string instead of throwing', async () => {
    const { withErrorState, CriticalPath } = await import(
      '../js/modules/core/error-state.js'
    );

    const result = withErrorState(
      () => { throw new Error('test'); },
      'test-falsy-string',
      { criticalPath: CriticalPath.DATA_SAVE, fallback: '' as unknown as string }
    );

    expect(result.hasError).toBe(true);
    expect(result.data).toBe('');
  });

  it('withErrorState still throws CriticalPathError when fallback is undefined', async () => {
    const { withErrorState, CriticalPath, CriticalPathError } = await import(
      '../js/modules/core/error-state.js'
    );

    expect(() => {
      withErrorState(
        () => { throw new Error('test'); },
        'test-no-fallback',
        { criticalPath: CriticalPath.TRANSACTIONS }
      );
    }).toThrow(CriticalPathError);
  });

  it('withErrorStateAsync respects falsy fallback of 0', async () => {
    const { withErrorStateAsync, CriticalPath } = await import(
      '../js/modules/core/error-state.js'
    );

    const result = await withErrorStateAsync(
      async () => { throw new Error('test'); },
      'test-async-falsy',
      { criticalPath: CriticalPath.SAVINGS_CALCULATION, fallback: 0 }
    );

    expect(result.hasError).toBe(true);
    expect(result.data).toBe(0);
    expect(result.fallbackUsed).toBe(true);
  });

  it('withErrorStateAsync throws when fallback is undefined', async () => {
    const { withErrorStateAsync, CriticalPath, CriticalPathError } = await import(
      '../js/modules/core/error-state.js'
    );

    await expect(
      withErrorStateAsync(
        async () => { throw new Error('test'); },
        'test-async-no-fallback',
        { criticalPath: CriticalPath.DATA_LOAD }
      )
    ).rejects.toThrow(CriticalPathError);
  });
});
