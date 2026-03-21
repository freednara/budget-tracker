/**
 * Error Tracking Module
 * 
 * Comprehensive error tracking and reporting system with
 * automatic error aggregation, stack trace parsing, and user feedback.
 */

import { showToast } from '../ui/core/ui.js';
import { lsGet, lsSet } from './state.js';
import { generateId } from './utils-dom.js';

// ==========================================
// TYPES
// ==========================================

interface ErrorContext {
  module?: string;
  action?: string;
  userId?: string;
  sessionId?: string;
  timestamp: number;
  url: string;
  userAgent: string;
}

interface TrackedError {
  id: string;
  message: string;
  stack?: string;
  type: 'error' | 'unhandledRejection' | 'networkError' | 'validationError';
  context: ErrorContext;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolved: boolean;
  fingerprint: string;
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
const ERROR_STORAGE_KEY = 'budget_tracker_error_log';
const ERROR_REPORT_KEY = 'budget_tracker_error_reports';
const ERROR_WINDOW = 60000; // 1 minute for rate calculation

let errorQueue: TrackedError[] = [];
// O(1) fingerprint lookup map (mirrors errorQueue for deduplication)
const fingerprintIndex = new Map<string, TrackedError>();
let isInitialized = false;
let errorListeners: Array<(error: TrackedError) => void> = [];

// MERGED: Circuit breaker tracking from error-boundary.ts
const circuitBreakerState = new Map<string, {
  count: number;
  lastError: Error;
  timestamp: Date;
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
  metadata?: Record<string, any>;
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
function handleOpError(error: any, context: OperationContext): void {
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
    showToast(message, type);
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
export function trackError(
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
  
  const age = Date.now() - state.timestamp.getTime();
  if (age > ERROR_WINDOW) {
    // Reset old entries
    circuitBreakerState.delete(operation);
    return 0;
  }
  
  return state.count / (age / 1000); // errors per second
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
  
  if (existing) {
    existing.count++;
    existing.lastError = error;
    // Don't reset timestamp — it tracks the start of the error window for rate calculation
  } else {
    circuitBreakerState.set(operation, {
      count: 1,
      lastError: error,
      timestamp: new Date(),
      isOpen: false
    });
  }
  
  // Clean up old entries
  if (circuitBreakerState.size > MAX_ERRORS_STORED) {
    const oldest = Array.from(circuitBreakerState.entries())
      .sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime())[0];
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
    errorCount: state.count,
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
export function displayError(
  error: Error | string,
  options?: {
    recoverable?: boolean;
    context?: Partial<ErrorContext>;
    userMessage?: string;
  }
): void {
  const { recoverable = false, context, userMessage } = options || {};
  
  // Track the error
  trackError(error, context);
  
  // Show user-friendly message
  const message = userMessage || 'An error occurred. Please try again.';
  showToast(message, 'error');
  
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
  saveErrors();
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize error tracking
 */
export function initialize(): void {
  if (isInitialized) return;
  
  // Load existing errors
  errorQueue = loadErrors();
  
  // Setup global error handlers
  window.addEventListener('error', (event) => {
    trackError(event.error || event.message, {
      module: 'global',
      action: 'uncaught_error'
    });
  });
  
  window.addEventListener('unhandledrejection', (event) => {
    trackError(event.reason, {
      module: 'global',
      action: 'unhandled_promise'
    }, 'unhandledRejection');
  });
  
  // Track console errors (rate-limited to avoid performance degradation from frequent logging)
  const originalError = console.error;
  let isTrackingConsoleError = false;
  let lastConsoleErrorTrackTime = 0;
  const CONSOLE_ERROR_TRACK_INTERVAL = 1000; // Max one track per second

  console.error = function(...args) {
    const now = Date.now();
    if (!isTrackingConsoleError && args[0] && typeof args[0] === 'string'
        && now - lastConsoleErrorTrackTime > CONSOLE_ERROR_TRACK_INTERVAL) {
      isTrackingConsoleError = true;
      lastConsoleErrorTrackTime = now;
      try {
        trackError(args[0], {
          module: 'console',
          action: 'console_error'
        });
      } finally {
        isTrackingConsoleError = false;
      }
    }
    originalError.apply(console, args);
  };
  
  isInitialized = true;
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

// Auto-initialize on import
if (typeof window !== 'undefined') {
  initialize();
}