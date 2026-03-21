/**
 * Global Error Handler (Legacy Wrapper)
 * 
 * Provides consistent error tracking, reporting, and recovery.
 * Now delegates to the more comprehensive ErrorTracker.ts.
 * 
 * @module global-error-handler
 */

import { 
  trackError, 
  displayError, 
  initialize as installGlobalHandlers,
  onError as onTrackerError,
  clearErrorLog as clearTrackerLog
} from './error-tracker.js';

// ==========================================
// TYPE DEFINITIONS (Backward Compatibility)
// ==========================================

export type ErrorLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';
export type ErrorCategory = 'network' | 'storage' | 'validation' | 'rendering' | 'business' | 'unknown';

export interface ErrorContext {
  category?: ErrorCategory;
  level?: ErrorLevel;
  module?: string;
  operation?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  stackTrace?: string;
  timestamp?: number;
}

export interface ErrorReport {
  message: string;
  context: ErrorContext;
  error?: Error;
  id: string;
}

// ==========================================
// ERROR HANDLING FUNCTIONS
// ==========================================

/**
 * Main error handler - delegates to ErrorTracker
 */
export function handleError(
  message: string,
  error?: Error | unknown,
  context?: ErrorContext
): void {
  const err = error instanceof Error ? error : new Error(message);
  
  // Track error centrally
  trackError(err, {
    module: context?.module || 'GlobalErrorHandler',
    action: context?.operation || 'error'
  });

  // Display error to user if appropriate (level >= error and not validation)
  const level = context?.level || 'error';
  const category = context?.category || 'unknown';

  if ((level === 'error' || level === 'critical') && category !== 'validation') {
    displayError(err, {
      userMessage: message,
      context: { module: context?.module }
    });
  }
}

/**
 * Log error (shorthand)
 */
export function logError(error: Error | unknown, context?: ErrorContext): void {
  const message = error instanceof Error ? error.message : String(error);
  handleError(message, error, context);
}

/**
 * Log warning
 */
export function logWarning(message: string, context?: ErrorContext): void {
  handleError(message, undefined, { ...context, level: 'warning' });
}

/**
 * Log info
 */
export function logInfo(message: string, context?: ErrorContext): void {
  handleError(message, undefined, { ...context, level: 'info' });
}

/**
 * Log debug
 */
export function logDebug(message: string, context?: ErrorContext): void {
  handleError(message, undefined, { ...context, level: 'debug' });
}

/**
 * Create module-specific logger
 */
export function createLogger(module: string): {
  error: (message: string, error?: unknown) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  debug: (message: string) => void;
} {
  return {
    error: (message: string, error?: unknown) => 
      handleError(message, error, { module }),
    warn: (message: string) => 
      logWarning(message, { module }),
    info: (message: string) => 
      logInfo(message, { module }),
    debug: (message: string) => 
      logDebug(message, { module })
  };
}

// ==========================================
// ERROR RECOVERY
// ==========================================

/**
 * Try operation with error handling
 */
export async function tryOperation<T>(
  operation: () => T | Promise<T>,
  context: ErrorContext & { fallback?: T }
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    handleError('Operation failed', error, context);
    return context.fallback;
  }
}

// ==========================================
// EXPORTS & INITIALIZATION
// ==========================================

export { installGlobalHandlers };

// Re-export tracker-like methods for backward compatibility
export const errorTracker = {
  clear: clearTrackerLog,
  onError: onTrackerError
};

// Automatic initialization is already handled in ErrorTracker.ts
