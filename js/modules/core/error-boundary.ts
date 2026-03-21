/**
 * Standardized Error Boundary System
 * 
 * Provides consistent error handling patterns across the application,
 * eliminating silent failures and empty catch blocks.
 */
'use strict';

import { showToast } from '../ui/core/ui.js';
import { logError } from './utils.js';
// FIXED: Using centralized error tracker to eliminate duplication
import { 
  trackError,
  updateCircuitBreaker,
  resetCircuitBreaker,
  isCircuitOpen as isCircuitOpenFromTracker,
  getErrorRate as getErrorRateFromTracker
} from './error-tracker.js';
import { 
  ErrorState,
  createErrorState,
  createSuccessState,
  CriticalPath 
} from './error-state.js';

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
  metadata?: Record<string, any>;
}

export interface ErrorResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  retries?: number;
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
        lastError = error as Error;
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
    
    if (parallel) {
      // Parallel execution
      const results = await Promise.allSettled(
        items.map(item => operation(item))
      );
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          succeeded.push(result.value);
        } else {
          failed.push({ item: items[i], error: result.reason });
          if (stopOnError) break; // Stop collecting results but don't throw from inside iteration
        }
      }
    } else {
      // Sequential execution
      for (const item of items) {
        try {
          succeeded.push(await operation(item));
        } catch (error) {
          failed.push({ item, error: error as Error });
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
      showToast(message, 'info');
    }
    
    return { succeeded, failed };
  }
  
  /**
   * Central error handler
   * FIXED: Now returns ErrorState instead of undefined to prevent ghost data
   */
  private static handleError<T>(
    error: any,
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
          showToast(`⚠️ Critical: ${message}`, 'error');
          // Re-throw critical errors to prevent silent failures
          if (isCritical && !context.metadata?.fallback) {
            throw err;
          }
          break;
        case 'high':
          showToast(`❌ ${message}`, 'error');
          break;
        case 'medium':
          showToast(`⚠️ ${message}`, 'info');
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
      return 'Storage full - please clear some data';
    }
    
    if (error.message.includes('network')) {
      return 'Connection issue - please check your internet';
    }
    
    if (error.message.includes('permission')) {
      return 'Permission denied - please check your settings';
    }
    
    // Category-based messages
    switch (context.category) {
      case 'validation':
        return 'Invalid input - please check your data';
      case 'storage':
        return 'Failed to save data';
      case 'calculation':
        return 'Calculation error - please verify numbers';
      case 'network':
        return 'Network error - please try again';
      default:
        return `Operation failed: ${context.operation}`;
    }
  }
  
  /**
   * Report error to analytics
   */
  private static reportError(error: Error, context: ErrorContext, severity: ErrorSeverity): void {
    // Integration point for error reporting service
    if (typeof window !== 'undefined' && (window as any).errorReporter) {
      (window as any).errorReporter.report({
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
  return ErrorBoundary.wrapAsync(operation, {
    operation: operationName,
    category: 'network',
    retry: true,
    maxRetries: 3
  });
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
export function withCalculation<T>(
  operation: () => T,
  operationName: string,
  fallbackValue?: T
): T {
  const result = ErrorBoundary.wrap(operation, {
    operation: operationName,
    category: 'calculation',
    severity: 'high'
  });
  
  return result !== undefined ? result : fallbackValue!;
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

/**
 * Set up global error handlers
 */
export function setupGlobalErrorHandlers(): void {
  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    ErrorBoundary.wrap(() => {
      throw event.reason;
    }, {
      operation: 'Unhandled Promise Rejection',
      severity: 'high',
      metadata: { promise: event.promise }
    });
    
    // Prevent default browser behavior
    event.preventDefault();
  });
  
  // Handle global errors
  window.addEventListener('error', (event) => {
    ErrorBoundary.wrap(() => {
      throw event.error;
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
    
    // Prevent default browser behavior
    event.preventDefault();
  });
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