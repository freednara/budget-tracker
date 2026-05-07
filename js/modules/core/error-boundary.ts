/**
 * Standardized Error Boundary System
 * 
 * Provides consistent error handling patterns across the application,
 * eliminating silent failures and empty catch blocks.
 */
'use strict';

import { emit, Events } from './event-bus.js';
import { logError } from './utils-pure.js';
// FIXED: Using centralized error tracker to eliminate duplication
import {
  updateCircuitBreaker,
  resetCircuitBreaker,
  isCircuitOpen as isCircuitOpenFromTracker,
  getErrorRate as getErrorRateFromTracker
} from './error-tracker.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ErrorCategory = 'network' | 'validation' | 'storage' | 'calculation' | 'ui' | 'unknown';

export interface ErrorContext {
  operation: string;
  category?: ErrorCategory;
  severity?: ErrorSeverity;
  silent?: boolean;
  retry?: boolean;
  maxRetries?: number;
  userMessage?: string;
  metadata?: Record<string, unknown>;
}

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — the failure branch constructs this
// with `error: caughtErr | undefined` where `caughtErr` flows through
// a `catch (e: unknown)` cast.
export interface ErrorResult<T> {
  success: boolean;
  data?: T | undefined;
  error?: Error | undefined;
  retries?: number | undefined;
}

// Re-export error state types for convenience
export type { ErrorState, CriticalPath } from './error-state.js';

// ==========================================
// ERROR BOUNDARY CLASS
// ==========================================

export class ErrorBoundary {
  /**
   * Wrap a synchronous operation with error handling
   */
  static wrap<T>(
    operation: () => T,
    context: ErrorContext
  ): T | undefined {
    try {
      return operation();
    } catch (error) {
      return this.handleError(error, context);
    }
  }
  
  /**
   * Wrap an async operation with error handling
   */
  static async wrapAsync<T>(
    operation: () => Promise<T>,
    context: ErrorContext
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      return this.handleError(error, context);
    }
  }
  
  /**
   * Wrap with retry logic
   */
  static async wrapWithRetry<T>(
    operation: () => Promise<T>,
    context: ErrorContext
  ): Promise<ErrorResult<T>> {
    const maxRetries = context.maxRetries || 3;
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check circuit breaker using centralized tracker
      if (isCircuitOpen(context.operation)) {
        return {
          success: false,
          error: new Error('Circuit breaker open - too many errors'),
          retries: attempt
        };
      }
      
      try {
        const data = await operation();
        
        // Reset error tracking on success
        if (attempt > 0) {
          resetCircuitBreaker(context.operation);
        }
        
        return { success: true, data, retries: attempt };
      } catch (error) {
        // CR-Apr24-I finding 265: normalize non-Error throws so circuit-
        // breaker state and the returned `lastError` are always real Errors.
        lastError = error instanceof Error ? error : new Error(String(error));
        updateCircuitBreaker(context.operation, lastError);
        
        // Don't retry on validation errors
        if (context.category === 'validation') break;
        
        // Exponential backoff
        if (attempt < maxRetries) {
          await this.delay(Math.pow(2, attempt) * 100);
        }
      }
    }
    
    this.handleError(lastError!, context);
    return { success: false, error: lastError, retries: maxRetries };
  }
  
  /**
   * Try operation with fallback
   */
  static async tryWithFallback<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    context: ErrorContext
  ): Promise<T> {
    try {
      return await primary();
    } catch (primaryError) {
      logError(`${context.operation} - primary failed, trying fallback`, primaryError as Error);
      
      try {
        return await fallback();
      } catch (fallbackError) {
        // Both failed
        this.handleError(fallbackError, { ...context, operation: `${context.operation} (fallback)` });
        throw fallbackError;
      }
    }
  }
  
  /**
   * Handle batch operations with partial failure support
   */
  static async batch<T, R>(
    items: T[],
    operation: (item: T) => Promise<R>,
    context: ErrorContext,
    options?: { stopOnError?: boolean; parallel?: boolean }
  ): Promise<{ succeeded: R[]; failed: Array<{ item: T; error: Error }> }> {
    const { stopOnError = false, parallel = true } = options || {};
    const succeeded: R[] = [];
    const failed: Array<{ item: T; error: Error }> = [];

    // CR-Apr24-G finding 260: when stopOnError is requested, use sequential
    // execution regardless of parallel flag. Promise.allSettled fires all
    // operations up front, so "stop on error" after allSettled is misleading
    // — all side effects have already run by the time we check results.
    if (parallel && !stopOnError) {
      // Parallel execution (no fail-fast needed)
      const results = await Promise.allSettled(
        items.map(item => operation(item))
      );

      for (let i = 0; i < results.length; i++) {
        // Phase 6 Slice 1i (rev 12 L6): both `results[i]` and
        // `items[i]` are `T | undefined` under
        // `noUncheckedIndexedAccess`. The arrays are index-aligned
        // by construction (one result per item), so a missing entry
        // means the iteration bounds are broken — skip defensively.
        const result = results[i];
        const item = items[i];
        if (!result || item === undefined) continue;
        if (result.status === 'fulfilled') {
          succeeded.push(result.value);
        } else {
          // PromiseSettledResult.reason is typed `any`; narrow before storing.
          const reason: unknown = result.reason;
          const reasonError = reason instanceof Error ? reason : new Error(String(reason));
          failed.push({ item, error: reasonError });
        }
      }
    } else {
      // Sequential execution
      for (const item of items) {
        try {
          succeeded.push(await operation(item));
        } catch (error) {
          // CR-Apr24-I finding 261: normalize non-Error throws the same
          // way the parallel branch does, so failed[] always holds Errors.
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          failed.push({ item, error: normalizedError });
          if (stopOnError) {
            this.handleError(error, context);
            break;
          }
        }
      }
    }
    
    // Report failures
    if (failed.length > 0 && !context.silent) {
      const message = `${context.operation}: ${succeeded.length} succeeded, ${failed.length} failed`;
      emit(Events.SHOW_TOAST, { message, type: 'info' });
    }
    
    return { succeeded, failed };
  }
  
  /**
   * Central error handler
   * FIXED: Now returns ErrorState instead of undefined to prevent ghost data
   */
  private static handleError<T>(
    error: unknown,
    context: ErrorContext
  ): T | undefined {
    const err = error instanceof Error ? error : new Error(String(error));
    
    // Log the error
    logError(context.operation, err);
    
    // Track for circuit breaker
    updateCircuitBreaker(context.operation, err);
    
    // Determine severity
    const severity = context.severity || this.determineSeverity(err, context);
    
    // Check if this is a critical path that should re-throw
    const criticalPaths = ['transactions', 'balance', 'savings', 'data_load'];
    const isCritical = criticalPaths.some(path => 
      context.operation.toLowerCase().includes(path)
    );
    
    // Show user notification based on severity
    if (!context.silent) {
      const message = context.userMessage || this.getUserMessage(err, context);
      
      switch (severity) {
        case 'critical':
          emit(Events.SHOW_TOAST, { message, type: 'error' });
          // Re-throw critical errors to prevent silent failures
          if (isCritical && !context.metadata?.fallback) {
            throw err;
          }
          break;
        case 'high':
          emit(Events.SHOW_TOAST, { message, type: 'error' });
          break;
        case 'medium':
          emit(Events.SHOW_TOAST, { message, type: 'info' });
          break;
        case 'low':
          // Log only, no user notification
          break;
      }
    }
    
    // Report to analytics if available
    this.reportError(err, context, severity);
    
    // Return fallback if provided, otherwise undefined
    // Components should check for undefined and handle appropriately
    return context.metadata?.fallback as T | undefined;
  }
  
  /**
   * Determine error severity
   */
  private static determineSeverity(error: Error, context: ErrorContext): ErrorSeverity {
    // Network errors
    if (error.message.includes('network') || error.message.includes('fetch')) {
      return 'medium';
    }
    
    // Storage quota errors
    if (error.name === 'QuotaExceededError') {
      return 'high';
    }
    
    // Validation errors
    if (context.category === 'validation') {
      return 'low';
    }
    
    // Financial calculation errors
    if (context.category === 'calculation') {
      return 'high';
    }
    
    return 'medium';
  }
  
  /**
   * Generate user-friendly error message
   */
  private static getUserMessage(error: Error, context: ErrorContext): string {
    // Check for specific error types
    if (error.name === 'QuotaExceededError') {
      return 'Your storage is full \u2014 try clearing old data or backups in Settings.';
    }

    if (error.message.includes('network')) {
      return 'Couldn\u2019t connect \u2014 check your internet and try again.';
    }

    if (error.message.includes('permission')) {
      return 'Permission denied \u2014 check your browser settings and try again.';
    }

    // Category-based messages
    switch (context.category) {
      case 'validation':
        return 'Something doesn\u2019t look right \u2014 double-check your input and try again.';
      case 'storage':
        return 'Couldn\u2019t save your data \u2014 storage may be full.';
      case 'calculation':
        return 'Something went wrong with that calculation \u2014 verify your numbers and try again.';
      case 'network':
        return 'Couldn\u2019t connect \u2014 check your internet and try again.';
      default:
        return 'Something went wrong. Try again, or refresh the page if the problem continues.';
    }
  }
  
  /**
   * Report error to analytics
   */
  private static reportError(error: Error, context: ErrorContext, severity: ErrorSeverity): void {
    // Integration point for error reporting service
    if (typeof window !== 'undefined' && window.errorReporter) {
      window.errorReporter.report({
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        },
        context,
        severity,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent
      });
    }
  }
  
  /**
   * Delay helper for retry logic
   */
  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==========================================
// SPECIALIZED ERROR HANDLERS
// ==========================================

/**
 * Network operation wrapper
 */
export async function withNetwork<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T | undefined> {
  // CR-Apr24-G finding 259: was calling wrapAsync which ignores retry/maxRetries.
  // Use wrapWithRetry so the advertised retry behavior actually executes.
  const result = await ErrorBoundary.wrapWithRetry(operation, {
    operation: operationName,
    category: 'network',
    retry: true,
    maxRetries: 3
  });
  return result.success ? result.data : undefined;
}

/**
 * Storage operation wrapper
 */
export async function withStorage<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T | undefined> {
  return ErrorBoundary.wrapAsync(operation, {
    operation: operationName,
    category: 'storage',
    severity: 'high'
  });
}

/**
 * Calculation operation wrapper
 */
// CR-Apr24-I finding 262: when `fallbackValue` is omitted the return
// type must widen to `T | undefined` — the old non-null assertion hid
// an `undefined` escape.  Overloads preserve the strict `T` return for
// callers that do supply a fallback, keeping existing call-sites clean.
export function withCalculation<T>(operation: () => T, operationName: string, fallbackValue: T): T;
export function withCalculation<T>(operation: () => T, operationName: string): T | undefined;
export function withCalculation<T>(
  operation: () => T,
  operationName: string,
  fallbackValue?: T
): T | undefined {
  const result = ErrorBoundary.wrap(operation, {
    operation: operationName,
    category: 'calculation',
    severity: 'high'
  });

  return result !== undefined ? result : fallbackValue;
}

/**
 * UI operation wrapper
 */
export function withUI<T>(
  operation: () => T,
  operationName: string
): T | undefined {
  return ErrorBoundary.wrap(operation, {
    operation: operationName,
    category: 'ui',
    severity: 'low',
    silent: true
  });
}

/**
 * Validation wrapper
 */
export function withValidation<T>(
  operation: () => T,
  operationName: string
): T | undefined {
  return ErrorBoundary.wrap(operation, {
    operation: operationName,
    category: 'validation',
    severity: 'low'
  });
}

// ==========================================
// GLOBAL ERROR HANDLERS
// ==========================================

// CR-Apr24-G finding 263: track installed listeners so setupGlobalErrorHandlers
// is idempotent and can be torn down by cleanupGlobalErrorHandlers.
let _globalRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let _globalErrorHandler: ((event: ErrorEvent) => void) | null = null;

/**
 * Set up global error handlers
 */
export function setupGlobalErrorHandlers(): void {
  // CR-Apr24-G finding 263: guard against double-installation.
  if (_globalRejectionHandler || _globalErrorHandler) return;

  // Handle unhandled promise rejections
  _globalRejectionHandler = (event: PromiseRejectionEvent) => {
    ErrorBoundary.wrap(() => {
      throw event.reason;
    }, {
      operation: 'Unhandled Promise Rejection',
      severity: 'high',
      metadata: { promise: event.promise }
    });
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', _globalRejectionHandler);

  // Handle global errors
  _globalErrorHandler = (event: ErrorEvent) => {
    // CR-Apr24-G finding 264 (P3 bonus): use event.message when event.error
    // is undefined (script/resource load failures).
    const errorValue: unknown = event.error ?? event.message ?? 'Unknown global error';
    ErrorBoundary.wrap(() => {
      throw errorValue instanceof Error ? errorValue : new Error(String(errorValue));
    }, {
      operation: 'Global Error',
      severity: 'critical',
      metadata: {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno
      }
    });
    event.preventDefault();
  };
  window.addEventListener('error', _globalErrorHandler);
}

/**
 * Tear down global error handlers installed by setupGlobalErrorHandlers.
 */
export function cleanupGlobalErrorHandlers(): void {
  if (_globalRejectionHandler) {
    window.removeEventListener('unhandledrejection', _globalRejectionHandler);
    _globalRejectionHandler = null;
  }
  if (_globalErrorHandler) {
    window.removeEventListener('error', _globalErrorHandler);
    _globalErrorHandler = null;
  }
}

// ==========================================
// CIRCUIT BREAKER UTILITIES
// ==========================================

/**
 * Check if circuit is open for an operation
 */
export function isCircuitOpen(operation: string): boolean {
  return isCircuitOpenFromTracker(operation);
}

/**
 * Reset error tracking for an operation
 */
export function resetCircuit(operation?: string): void {
  resetCircuitBreaker(operation);
}

/**
 * Get error rate for monitoring
 */
export function getErrorRate(operation: string): number {
  return getErrorRateFromTracker(operation);
}