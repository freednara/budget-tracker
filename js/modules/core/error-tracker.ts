/**
 * Error Tracking Module
 * 
 * Comprehensive error tracking and reporting system with
 * automatic error aggregation, stack trace parsing, and user feedback.
 */

import { emit, Events } from './event-bus.js';
import { lsGet, lsSet } from './state.js';
import { generateId } from './utils-dom.js';

// ==========================================
// TYPES
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — callers pass `Partial<ErrorContext>`
// with `module: errorInfo.source` where source is typed as
// `string | undefined` (optional on ErrorInfo).
interface ErrorContext {
  module?: string | undefined;
  action?: string | undefined;
  userId?: string | undefined;
  sessionId?: string | undefined;
  timestamp: number;
  url: string;
  userAgent: string;
}

// Phase 6 Slice 1j (rev 12 L6): `stack` widened for
// `exactOptionalPropertyTypes` — constructed from `err.stack` which is
// `string | undefined` on native `Error` per lib.dom.
export interface TrackedError {
  id: string;
  message: string;
  stack?: string | undefined;
  type: 'error' | 'unhandledRejection' | 'networkError' | 'validationError';
  context: ErrorContext;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolved: boolean;
  fingerprint: string;
  // Fixes M28: surfaces the "silenced burst" count so dashboards can
  // distinguish a single failure from a 60-per-minute storm even when the
  // sampler dropped the intermediate calls.
  droppedSinceLastEmit?: number;
}

interface ErrorReport {
  errors: TrackedError[];
  totalErrors: number;
  uniqueErrors: number;
  topErrors: Array<{ error: TrackedError; percentage: number }>;
  errorRate: number;
  sessionId: string;
  reportTime: number;
}

// ==========================================
// MODULE STATE
// ==========================================

const SESSION_ID = generateId();
const SESSION_START_TIME = Date.now();
const MAX_ERRORS_STORED = 100;
const ERROR_STORAGE_KEY = 'harbor_error_log';
const ERROR_REPORT_KEY = 'harbor_error_reports';
const ERROR_WINDOW = 60000; // 1 minute for rate calculation

let errorQueue: TrackedError[] = [];
// O(1) fingerprint lookup map (mirrors errorQueue for deduplication)
const fingerprintIndex = new Map<string, TrackedError>();
let isInitialized = false;
let errorListeners: Array<(error: TrackedError) => void> = [];

// Fixes M28 (Inline-Behavior-Review rev 12): per-fingerprint burst sampling.
// Previous implementation dropped every console.error after the first one
// inside a rolling 1-second window, which meant a 60-error storm reported
// as a single event. The new scheme tracks the first occurrence of every
// unique fingerprint immediately, then samples subsequent occurrences at
// exponentially-decaying intervals (1, 2, 4, 8, ...) so bursts are visible
// without the tracker flooding its own pipeline. The `dropped` field on
// the emit makes the storm visible even through the sample.
interface FingerprintSampler {
  count: number;            // Total occurrences observed
  dropped: number;           // Occurrences since last emit
  lastEmitCount: number;     // `count` value at the last emit
  nextEmitThreshold: number; // `count` must reach this to trigger next emit
}
const fingerprintSamplers = new Map<string, FingerprintSampler>();
const CONSOLE_ERROR_SAMPLER_MAX = 500;

// Cleanup handles for global listeners installed by initialize().
// These let tests (and app-reset, in the future) tear down the tracker
// without leaving dangling listeners attached to window.
let installedWindowErrorHandler: ((event: ErrorEvent) => void) | null = null;
let installedRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let originalConsoleError: typeof console.error | null = null;

// MERGED: Circuit breaker tracking from error-boundary.ts
// ERR-03: Rolling window — store individual timestamps instead of a single
// count, so getErrorRate() only considers errors within the window.
const circuitBreakerState = new Map<string, {
  timestamps: number[];  // ERR-03: individual error timestamps for rolling window
  lastError: Error;
  isOpen: boolean;
}>();

/**
 * Error Context for wrapping operations
 */
export interface OperationContext {
  module: string;
  action: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  silent?: boolean;
  userMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrap a synchronous operation with error tracking
 */
export function wrap<T>(
  operation: () => T,
  context: OperationContext
): T | undefined {
  try {
    return operation();
  } catch (error) {
    handleOpError(error, context);
    return context.metadata?.fallback as T | undefined;
  }
}

/**
 * Wrap an async operation with error tracking
 */
export async function wrapAsync<T>(
  operation: () => Promise<T>,
  context: OperationContext
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    handleOpError(error, context);
    return context.metadata?.fallback as T | undefined;
  }
}

/**
 * Internal error handler for wrapped operations
 */
function handleOpError(error: unknown, context: OperationContext): void {
  const err = error instanceof Error ? error : new Error(String(error));
  
  // Track the error
  trackError(err, {
    module: context.module,
    action: context.action
  });
  
  // Update circuit breaker
  updateCircuitBreaker(`${context.module}:${context.action}`, err);
  
  // Show toast if not silent
  if (!context.silent) {
    const message = context.userMessage || `Error in ${context.module}: ${err.message}`;
    const type = (context.severity === 'high' || context.severity === 'critical') ? 'error' : 'info';
    emit(Events.SHOW_TOAST, { message, type });
  }
}

// ==========================================
// ERROR FINGERPRINTING
// ==========================================

/**
 * Generate a fingerprint for error deduplication
 */
function generateErrorFingerprint(error: Error | string, context?: Partial<ErrorContext>): string {
  const message = typeof error === 'string' ? error : error.message;
  const stack = typeof error === 'object' ? error.stack : '';
  
  // Extract the first meaningful line from stack trace
  const stackLine = stack?.split('\n')[1]?.trim() || '';
  
  // Combine message, module, and stack location for fingerprint
  const parts = [
    message.substring(0, 100),
    context?.module || 'unknown',
    context?.action || 'unknown',
    stackLine.substring(0, 100)
  ];
  
  return parts.join('|').toLowerCase();
}

// ==========================================
// ERROR TRACKING
// ==========================================

/**
 * Track an error with context
 */
// Round 7 fix: recursion guard prevents infinite loop when trackError →
// saveErrors → lsSet → QuotaExceeded → errorHandler → trackError.
let _isTrackingError = false;

export function trackError(
  error: Error | string,
  context?: Partial<ErrorContext>,
  type: TrackedError['type'] = 'error'
): void {
  // Guard against recursive calls from storage failure handlers
  if (_isTrackingError) {
    if (import.meta.env.DEV) console.warn('[ErrorTracker] Recursive call blocked:', error);
    return;
  }
  _isTrackingError = true;
  try {
    _trackErrorInner(error, context, type);
  } finally {
    _isTrackingError = false;
  }
}

function _trackErrorInner(
  error: Error | string,
  context?: Partial<ErrorContext>,
  type: TrackedError['type'] = 'error'
): void {
  if (!isInitialized) initialize();
  
  const errorContext: ErrorContext = {
    ...context,
    timestamp: Date.now(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    sessionId: SESSION_ID
  };
  
  const fingerprint = generateErrorFingerprint(error, context);

  // O(1) lookup via fingerprint index map
  const existingError = fingerprintIndex.get(fingerprint);

  if (existingError) {
    // Update existing error
    existingError.count++;
    existingError.lastSeen = Date.now();
    existingError.context = errorContext;
  } else {
    // Add new error
    const trackedError: TrackedError = {
      id: generateId(),
      message: typeof error === 'string' ? error : error.message,
      stack: typeof error === 'object' ? error.stack : undefined,
      type,
      context: errorContext,
      count: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      resolved: false,
      fingerprint
    };

    errorQueue.push(trackedError);
    fingerprintIndex.set(fingerprint, trackedError);

    // Notify listeners (each wrapped in try-catch so one failure doesn't block others)
    for (const listener of errorListeners) {
      try {
        listener(trackedError);
      } catch (listenerErr) {
        if (import.meta.env.DEV) console.warn('[ErrorTracker] Listener threw:', listenerErr);
      }
    }

    // Trim queue if needed
    if (errorQueue.length > MAX_ERRORS_STORED) {
      const removed = errorQueue.splice(0, errorQueue.length - MAX_ERRORS_STORED);
      for (const r of removed) fingerprintIndex.delete(r.fingerprint);
    }
  }
  
  // Persist errors
  saveErrors();
  
  // Log to console in development
  if (import.meta.env.DEV) {
    console.error('[Error Tracked]', error, context);
  }
}

/**
 * Track a network error
 */
export function trackNetworkError(
  url: string,
  status: number,
  statusText: string,
  context?: Partial<ErrorContext>
): void {
  const message = `Network error: ${status} ${statusText} for ${url}`;
  trackError(message, { ...context, action: 'network_request' }, 'networkError');
}

/**
 * Track a validation error
 */
export function trackValidationError(
  field: string,
  value: unknown,
  reason: string,
  context?: Partial<ErrorContext>
): void {
  const message = `Validation failed for ${field}: ${reason}`;
  trackError(message, { ...context, action: 'validation' }, 'validationError');
}

/**
 * Load a module dynamically and invoke a callback with it, routing any
 * loader failure through `trackError` (M6, Inline-Behavior-Review rev 12).
 *
 * The DI wiring in `app-init-di.ts` and one lazy-chart branch in
 * `chart-renderers.ts` used to drop the promise returned by
 * `import().then(fn)`. A network blip, a broken chunk after a mid-session
 * deploy, or a parse error in the lazy module produced an unhandled
 * rejection — the triggering button click did nothing and the user saw
 * no error. The legacy inconsistency where some call sites had `void`
 * and some didn't made the failure-mode silent either way (unhandled
 * rejection with `void`, unhandled rejection without — neither surfaced
 * to telemetry).
 *
 * `loadAndCall` restores observability: the loader error is captured by
 * `trackError` with module + action context, and the call site stays
 * fire-and-forget by design (the function returns `void`). Callers that
 * need the promise handle should use `await import()` directly instead.
 *
 * The callback is *not* wrapped — if it throws synchronously or returns
 * a rejected promise, that is still the caller's responsibility. This
 * helper owns the loader boundary only, matching the lint rule
 * `@typescript-eslint/no-floating-promises` that motivated the fix.
 *
 * @param loader The dynamic-import factory, e.g. `() => import('./foo.js')`.
 * @param fn Callback invoked with the resolved module.
 * @param context Optional telemetry context forwarded to `trackError` on
 *   loader failure. The `action` key defaults to `'dynamic_import_failed'`
 *   and is overridable via the context parameter.
 */
export function loadAndCall<T>(
  loader: () => Promise<T>,
  fn: (module: T) => void | Promise<void>,
  context?: Partial<ErrorContext>
): void {
  // CR-Apr24-I finding 357: separate import failures from callback
  // failures so they land in different telemetry buckets.
  void loader()
    .then((mod) => {
      try {
        const result = fn(mod);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- thenable duck-typing
        if (result != null && typeof (result as any).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            trackError(
              err instanceof Error ? err : new Error(String(err)),
              { action: 'callback_failed', ...context }
            );
          });
        }
      } catch (err: unknown) {
        trackError(
          err instanceof Error ? err : new Error(String(err)),
          { action: 'callback_failed', ...context }
        );
      }
    })
    .catch((err: unknown) => {
      trackError(
        err instanceof Error ? err : new Error(String(err)),
        { action: 'dynamic_import_failed', ...context }
      );
    });
}

// ==========================================
// ERROR RECOVERY
// ==========================================

/**
 * Attempt to recover from an error
 */
// recoverFromError removed - dispatched custom events (retry-sync, reset-transaction-form,
// reload-module) that no module listened for. Recovery should be handled at the call site
// where context-specific recovery is possible.

// ==========================================
// ERROR REPORTING
// ==========================================

/**
 * Generate an error report
 */
export function generateErrorReport(): ErrorReport {
  const errors = getStoredErrors();
  const uniqueFingerprints = new Set(errors.map(e => e.fingerprint));
  
  // Calculate top errors
  const errorCounts = new Map<string, number>();
  errors.forEach(error => {
    errorCounts.set(error.fingerprint, error.count);
  });
  
  const sortedErrors = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  const totalCount = errors.reduce((sum, e) => sum + e.count, 0);
  
  const topErrors = sortedErrors.map(([fingerprint, count]) => {
    const error = errors.find(e => e.fingerprint === fingerprint)!;
    return {
      error,
      percentage: (count / totalCount) * 100
    };
  });
  
  // Calculate error rate (errors per hour)
  const sessionDuration = Date.now() - SESSION_START_TIME;
  const hoursElapsed = sessionDuration / (1000 * 60 * 60);
  const errorRate = totalCount / Math.max(hoursElapsed, 0.1);
  
  const report: ErrorReport = {
    errors: errors.slice(0, 10), // Include first 10 errors
    totalErrors: totalCount,
    uniqueErrors: uniqueFingerprints.size,
    topErrors,
    errorRate,
    sessionId: SESSION_ID,
    reportTime: Date.now()
  };
  
  // Save report
  const reports = lsGet<ErrorReport[]>(ERROR_REPORT_KEY, []);
  reports.push(report);
  
  // Keep only last 10 reports
  if (reports.length > 10) {
    reports.shift();
  }
  
  lsSet(ERROR_REPORT_KEY, reports);
  
  return report;
}

/**
 * Export error report as JSON
 */
export function exportErrorReport(): Blob {
  const report = generateErrorReport();
  const json = JSON.stringify(report, null, 2);
  return new Blob([json], { type: 'application/json' });
}

// ==========================================
// CIRCUIT BREAKER (MERGED FROM error-boundary.ts)
// ==========================================

/**
 * Get error rate for a specific operation
 * MERGED: From ErrorTracker in error-boundary.ts
 */
export function getErrorRate(operation: string): number {
  const state = circuitBreakerState.get(operation);
  if (!state) return 0;

  // ERR-03: Rolling window — prune timestamps older than ERROR_WINDOW,
  // then compute errors-per-second from the remaining count.
  const now = Date.now();
  const cutoff = now - ERROR_WINDOW;
  state.timestamps = state.timestamps.filter(t => t > cutoff);

  if (state.timestamps.length === 0) {
    circuitBreakerState.delete(operation);
    return 0;
  }

  // Rate = errors within the window / window duration in seconds
  return state.timestamps.length / (ERROR_WINDOW / 1000);
}

/**
 * Check if circuit breaker is open for an operation
 * MERGED: Prevents cascading failures
 */
export function isCircuitOpen(operation: string, threshold: number = 0.5): boolean {
  const state = circuitBreakerState.get(operation);
  if (!state) return false;
  
  // Check if manually opened
  if (state.isOpen) return true;
  
  // Check error rate
  const rate = getErrorRate(operation);
  if (rate > threshold) {
    state.isOpen = true;
    return true;
  }
  
  return false;
}

/**
 * Update circuit breaker state for an operation
 * MERGED: Track failures for circuit breaking
 */
export function updateCircuitBreaker(operation: string, error: Error): void {
  const existing = circuitBreakerState.get(operation);
  const now = Date.now();

  if (existing) {
    // ERR-03: Push timestamp into rolling window array
    existing.timestamps.push(now);
    existing.lastError = error;
    // Cap array to prevent unbounded growth (keep last 100 timestamps)
    if (existing.timestamps.length > 100) {
      existing.timestamps = existing.timestamps.slice(-100);
    }
  } else {
    circuitBreakerState.set(operation, {
      timestamps: [now],
      lastError: error,
      isOpen: false
    });
  }

  // Clean up old entries by staleness
  if (circuitBreakerState.size > MAX_ERRORS_STORED) {
    const oldest = Array.from(circuitBreakerState.entries())
      .sort((a, b) => {
        const aLast = a[1].timestamps[a[1].timestamps.length - 1] ?? 0;
        const bLast = b[1].timestamps[b[1].timestamps.length - 1] ?? 0;
        return aLast - bLast;
      })[0];
    if (oldest) circuitBreakerState.delete(oldest[0]);
  }
}

/**
 * Reset circuit breaker for an operation
 * MERGED: Called on successful operation
 */
export function resetCircuitBreaker(operation?: string): void {
  if (operation) {
    circuitBreakerState.delete(operation);
  } else {
    circuitBreakerState.clear();
  }
}

/**
 * Get circuit breaker status for all operations
 */
export function getCircuitBreakerStatus(): Array<{
  operation: string;
  isOpen: boolean;
  errorCount: number;
  errorRate: number;
  lastError: string;
}> {
  return Array.from(circuitBreakerState.entries()).map(([operation, state]) => ({
    operation,
    isOpen: state.isOpen || isCircuitOpen(operation),
    errorCount: state.timestamps.length,
    errorRate: getErrorRate(operation),
    lastError: state.lastError.message
  }));
}

// ==========================================
// ERROR DISPLAY
// ==========================================

/**
 * Display error to user with recovery options
 */
// Phase 6 Slice 1j (rev 12 L6): option fields widened for
// `exactOptionalPropertyTypes` — error-handler.ts forwards
// `userMessage: errorInfo.userMessage` and `context: { module: errorInfo.source }`
// with both sources typed `T | undefined` (optional on ErrorInfo).
export function displayError(
  error: Error | string,
  options?: {
    recoverable?: boolean | undefined;
    context?: Partial<ErrorContext> | undefined;
    userMessage?: string | undefined;
  }
): void {
  const { context, userMessage } = options || {};
  
  // Track the error
  trackError(error, context);
  
  // Show user-friendly message
  const message = userMessage || 'An error occurred. Please try again.';
  emit(Events.SHOW_TOAST, { message, type: 'error' });
  
  // Recovery is handled at call sites where context-specific actions are possible
}

// ==========================================
// STORAGE
// ==========================================

/**
 * Save errors to localStorage
 */
function saveErrors(): void {
  try {
    lsSet(ERROR_STORAGE_KEY, errorQueue);
  } catch (e) {
    if (import.meta.env.DEV) console.error('Failed to save error log:', e);
  }
}

/**
 * Load errors from localStorage
 */
function loadErrors(): TrackedError[] {
  try {
    return lsGet<TrackedError[]>(ERROR_STORAGE_KEY, []);
  } catch (e) {
    if (import.meta.env.DEV) console.error('Failed to load error log:', e);
    return [];
  }
}

/**
 * Get stored errors
 */
export function getStoredErrors(): TrackedError[] {
  return [...errorQueue];
}

/**
 * Clear error log
 */
export function clearErrorLog(): void {
  errorQueue = [];
  fingerprintIndex.clear();
  // CR-Apr24-G finding 257: also clear fingerprintSamplers so console.error
  // burst sampling resets when the user clears the log. Previously samplers
  // survived the clear, causing the next occurrence of the same fingerprint
  // to be throttled as if the old burst history still existed.
  fingerprintSamplers.clear();
  saveErrors();
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Convert any console.error argument shape into an `Error` instance.
 *
 * Fixes M28a: the prior implementation only captured `typeof args[0] === 'string'`.
 * Idiomatic JS code calls `console.error(new Error(...))` or `console.error(errorObj)`,
 * and third-party libraries (Preact, Lit, Firebase SDK) routinely throw through
 * `console.error` with non-string payloads. The string-only filter silently
 * dropped every one of those, leaving production telemetry blind to the
 * largest source of errors. Now every shape is normalized to an Error.
 */
function normalizeConsoleErrorArg(arg: unknown): Error {
  if (arg instanceof Error) return arg;
  if (typeof arg === 'string') return new Error(arg);
  // Capture the whole argument array's first element via String() so the
  // message remains useful even for plain objects ("[object Object]" is
  // still a load-bearing signal that something happened, and the
  // fingerprint will dedupe duplicates anyway).
  try {
    return new Error(String(arg));
  } catch {
    return new Error('console.error: <unrepresentable argument>');
  }
}

/**
 * Per-fingerprint sampler that decides whether the current occurrence
 * should be reported to `trackError` and, if so, how many silent
 * occurrences to attribute to the burst.
 *
 * Fixes M28b: replaces the 1-second module-wide hard rate-limit. Previously
 * a 60-error burst within a minute reported as 1 event and 59 silent drops.
 * Now each unique fingerprint is sampled on its own schedule — first
 * occurrence emits immediately; subsequent occurrences emit at a doubling
 * cadence (count = 2, 4, 8, 16, 32 ...) so a real storm always surfaces
 * within a small constant number of emits. The `droppedSinceLastEmit`
 * field on each emit captures the silenced count for the dashboard.
 */
function sampleFingerprint(fingerprint: string): { emit: boolean; dropped: number } {
  const sampler = fingerprintSamplers.get(fingerprint);
  if (!sampler) {
    fingerprintSamplers.set(fingerprint, {
      count: 1,
      dropped: 0,
      lastEmitCount: 1,
      nextEmitThreshold: 2
    });
    // Bound the sampler map so a very long-running tab with many unique
    // fingerprints doesn't accumulate forever. Drop the oldest if we cross
    // the cap; the next call from that fingerprint will simply re-emit
    // and re-seed (correct, just slightly noisier under prolonged storms).
    if (fingerprintSamplers.size > CONSOLE_ERROR_SAMPLER_MAX) {
      const oldestKey = fingerprintSamplers.keys().next().value;
      if (oldestKey !== undefined) fingerprintSamplers.delete(oldestKey);
    }
    return { emit: true, dropped: 0 };
  }

  sampler.count++;
  if (sampler.count >= sampler.nextEmitThreshold) {
    const dropped = sampler.dropped;
    sampler.dropped = 0;
    sampler.lastEmitCount = sampler.count;
    // Exponential backoff: next emit at 2x current count.
    sampler.nextEmitThreshold = sampler.count * 2;
    return { emit: true, dropped };
  }

  sampler.dropped++;
  return { emit: false, dropped: sampler.dropped };
}

/**
 * Initialize error tracking
 */
export function initialize(): void {
  if (isInitialized) return;

  // Load existing errors
  errorQueue = loadErrors();

  // CR-Apr24-G finding 256: rebuild fingerprintIndex from persisted queue.
  // Previously, loaded errors were not indexed, so the next occurrence of
  // an already-stored fingerprint was treated as a brand-new error instead
  // of incrementing the existing aggregate count.
  //
  // ERR-02: Build into a local map first, then swap — avoids a window where
  // fingerprintIndex is empty if loadErrors() returned a partial/corrupt list.
  const rebuilt = new Map<string, TrackedError>();
  for (const err of errorQueue) {
    if (err.fingerprint) {
      rebuilt.set(err.fingerprint, err);
    }
  }
  fingerprintIndex.clear();
  for (const [fp, err] of rebuilt) {
    fingerprintIndex.set(fp, err);
  }

  // Setup global error handlers (capture handles so cleanup() can detach)
  installedWindowErrorHandler = (event: ErrorEvent) => {
    trackError(event.error || event.message, {
      module: 'global',
      action: 'uncaught_error'
    });
  };
  window.addEventListener('error', installedWindowErrorHandler);

  installedRejectionHandler = (event: PromiseRejectionEvent) => {
    trackError(event.reason, {
      module: 'global',
      action: 'unhandled_promise'
    }, 'unhandledRejection');
  };
  window.addEventListener('unhandledrejection', installedRejectionHandler);

  // Fixes M28 (Inline-Behavior-Review rev 12): widen capture + per-fingerprint
  // burst sampling. See normalizeConsoleErrorArg / sampleFingerprint above.
  originalConsoleError = console.error;
  let isTrackingConsoleError = false;

  console.error = function(...args) {
    if (!isTrackingConsoleError && args.length > 0) {
      isTrackingConsoleError = true;
      try {
        const normalizedError = normalizeConsoleErrorArg(args[0]);
        const context: Partial<ErrorContext> = {
          module: 'console',
          action: 'console_error'
        };
        const fingerprint = generateErrorFingerprint(normalizedError, context);
        const { emit, dropped } = sampleFingerprint(fingerprint);
        if (emit) {
          trackError(normalizedError, context);
          // Attach drop metadata to the just-tracked error for dashboard visibility.
          const tracked = fingerprintIndex.get(fingerprint);
          if (tracked && dropped > 0) {
            tracked.droppedSinceLastEmit = dropped;
          }
        }
      } finally {
        isTrackingConsoleError = false;
      }
    }
    if (originalConsoleError) originalConsoleError.apply(console, args);
  };

  isInitialized = true;
}

/**
 * Tear down all global listeners and reset module state.
 *
 * Fixes L39 / L41-partial (Inline-Behavior-Review rev 12): tests that import
 * the module need a way to detach the global error/rejection handlers and
 * restore the original `console.error` so subsequent test cases run in
 * isolation. Idempotent: safe to call before initialize() or twice in a row.
 */
export function cleanup(): void {
  if (installedWindowErrorHandler) {
    window.removeEventListener('error', installedWindowErrorHandler);
    installedWindowErrorHandler = null;
  }
  if (installedRejectionHandler) {
    window.removeEventListener('unhandledrejection', installedRejectionHandler);
    installedRejectionHandler = null;
  }
  if (originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = null;
  }
  fingerprintSamplers.clear();
  errorListeners = [];
  isInitialized = false;
}

/**
 * Subscribe to error events
 */
export function onError(listener: (error: TrackedError) => void): () => void {
  errorListeners.push(listener);
  
  // Return unsubscribe function
  return () => {
    const index = errorListeners.indexOf(listener);
    if (index > -1) {
      errorListeners.splice(index, 1);
    }
  };
}

// ==========================================
// DEBUGGING UTILITIES
// ==========================================

/**
 * Get error statistics
 */
export function getErrorStats(): {
  total: number;
  unique: number;
  byType: Record<string, number>;
  byModule: Record<string, number>;
  errorRate: number;
} {
  const errors = getStoredErrors();
  const uniqueFingerprints = new Set(errors.map(e => e.fingerprint));
  
  const byType: Record<string, number> = {};
  const byModule: Record<string, number> = {};
  
  errors.forEach(error => {
    // Count by type
    byType[error.type] = (byType[error.type] || 0) + error.count;
    
    // Count by module
    const module = error.context.module || 'unknown';
    byModule[module] = (byModule[module] || 0) + error.count;
  });
  
  const totalCount = errors.reduce((sum, e) => sum + e.count, 0);
  const sessionDuration = Date.now() - SESSION_START_TIME;
  const hoursElapsed = sessionDuration / (1000 * 60 * 60);
  
  return {
    total: totalCount,
    unique: uniqueFingerprints.size,
    byType,
    byModule,
    errorRate: totalCount / Math.max(hoursElapsed, 0.1)
  };
}

// Fixes L39 (Inline-Behavior-Review rev 12): the module no longer auto-initializes
// on import. Boot code is responsible for calling `initialize()` explicitly so
// (a) tests can import the module for `trackError`-only use without inheriting
// the global listeners, and (b) the side-effect timing is observable rather than
// hidden inside module evaluation. As a defense-in-depth, `trackError()` itself
// still calls `initialize()` lazily on first use, so a missed boot wiring degrades
// gracefully into the prior auto-init behavior instead of dropping errors silently.