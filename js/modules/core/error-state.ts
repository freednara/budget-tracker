/**
 * Error State Management Module
 * 
 * FIXED: Provides explicit error state objects instead of returning undefined,
 * preventing "ghost data" issues where UI shows 0 or "No Data" on calculation errors.
 * 
 * @module core/error-state
 */
'use strict';

import { signal, computed, Signal } from '@preact/signals-core';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

/**
 * Explicit error state for components
 * Replaces undefined returns with clear error information
 */
export interface ErrorState<T> {
  hasError: boolean;
  error?: Error;
  data?: T;
  fallbackUsed?: boolean;
  retryable?: boolean;
  timestamp: number;
  context?: string;
}

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Critical path indicators
 * Operations marked as critical will re-throw errors instead of swallowing
 */
export enum CriticalPath {
  TRANSACTIONS = 'transactions',
  BALANCE_CALCULATION = 'balance',
  SAVINGS_CALCULATION = 'savings',
  BUDGET_ALLOCATION = 'budget',
  DATA_LOAD = 'data_load',
  DATA_SAVE = 'data_save'
}

// ==========================================
// ERROR STATE FACTORY
// ==========================================

/**
 * Create an error state object
 */
export function createErrorState<T>(
  error: Error,
  context?: string,
  fallback?: T
): ErrorState<T> {
  return {
    hasError: true,
    error,
    data: fallback,
    fallbackUsed: fallback !== undefined,
    retryable: isRetryableError(error),
    timestamp: Date.now(),
    context
  };
}

/**
 * Create a success state object
 */
export function createSuccessState<T>(data: T): ErrorState<T> {
  return {
    hasError: false,
    data,
    fallbackUsed: false,
    retryable: false,
    timestamp: Date.now()
  };
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: Error): boolean {
  const retryablePatterns = [
    'network',
    'timeout',
    'fetch',
    'temporary',
    'ECONNREFUSED',
    'ETIMEDOUT'
  ];
  
  const message = error.message.toLowerCase();
  return retryablePatterns.some(pattern => message.includes(pattern));
}

// ==========================================
// SIGNAL-BASED ERROR STATES
// ==========================================

/**
 * Global error states for critical paths
 * Components can subscribe to these for error awareness
 */
export const errorStates = {
  transactions: signal<ErrorState<any>>(createSuccessState([])),
  balance: signal<ErrorState<number>>(createSuccessState(0)),
  savings: signal<ErrorState<number>>(createSuccessState(0)),
  budget: signal<ErrorState<any>>(createSuccessState({})),
  dataLoad: signal<ErrorState<boolean>>(createSuccessState(true)),
  dataSave: signal<ErrorState<boolean>>(createSuccessState(true))
};

/**
 * Computed signal for any critical errors
 */
export const hasCriticalError = computed(() => {
  return Object.values(errorStates).some(state => 
    state.value.hasError && !state.value.fallbackUsed
  );
});

/**
 * Computed signal for error summary
 */
export const errorSummary = computed(() => {
  const errors = Object.entries(errorStates)
    .filter(([_, state]) => state.value.hasError)
    .map(([path, state]) => ({
      path,
      error: state.value.error?.message || 'Unknown error',
      retryable: state.value.retryable
    }));
  
  return {
    count: errors.length,
    critical: errors.filter(e => !e.retryable).length,
    retryable: errors.filter(e => e.retryable).length,
    errors
  };
});

// ==========================================
// ERROR STATE WRAPPER
// ==========================================

/**
 * Wrap a computation with error state management
 * FIXED: Returns explicit ErrorState instead of undefined
 */
export function withErrorState<T>(
  operation: () => T,
  context: string,
  options?: {
    criticalPath?: CriticalPath;
    fallback?: T;
    silent?: boolean;
  }
): ErrorState<T> {
  try {
    const result = operation();
    const state = createSuccessState(result);
    
    // Update global state if critical path
    if (options?.criticalPath) {
      updateCriticalPathState(options.criticalPath, state);
    }
    
    return state;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const state = createErrorState(err, context, options?.fallback);
    
    // Update global state if critical path
    if (options?.criticalPath) {
      updateCriticalPathState(options.criticalPath, state);
      
      // Re-throw for truly critical paths without fallback
      if (!options.fallback) {
        throw new CriticalPathError(err, options.criticalPath);
      }
    }
    
    return state;
  }
}

/**
 * Async version of withErrorState
 */
export async function withErrorStateAsync<T>(
  operation: () => Promise<T>,
  context: string,
  options?: {
    criticalPath?: CriticalPath;
    fallback?: T;
    silent?: boolean;
  }
): Promise<ErrorState<T>> {
  try {
    const result = await operation();
    const state = createSuccessState(result);
    
    // Update global state if critical path
    if (options?.criticalPath) {
      updateCriticalPathState(options.criticalPath, state);
    }
    
    return state;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const state = createErrorState(err, context, options?.fallback);
    
    // Update global state if critical path
    if (options?.criticalPath) {
      updateCriticalPathState(options.criticalPath, state);
      
      // Re-throw for truly critical paths without fallback
      if (!options.fallback) {
        throw new CriticalPathError(err, options.criticalPath);
      }
    }
    
    return state;
  }
}

// ==========================================
// CRITICAL PATH ERROR
// ==========================================

/**
 * Special error class for critical path failures
 */
export class CriticalPathError extends Error {
  constructor(
    public readonly originalError: Error,
    public readonly criticalPath: CriticalPath
  ) {
    super(`Critical path failure in ${criticalPath}: ${originalError.message}`);
    this.name = 'CriticalPathError';
  }
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Update global error state for critical path
 */
function updateCriticalPathState(path: CriticalPath, state: ErrorState<any>): void {
  switch (path) {
    case CriticalPath.TRANSACTIONS:
      errorStates.transactions.value = state;
      break;
    case CriticalPath.BALANCE_CALCULATION:
      errorStates.balance.value = state;
      break;
    case CriticalPath.SAVINGS_CALCULATION:
      errorStates.savings.value = state;
      break;
    case CriticalPath.BUDGET_ALLOCATION:
      errorStates.budget.value = state;
      break;
    case CriticalPath.DATA_LOAD:
      errorStates.dataLoad.value = state;
      break;
    case CriticalPath.DATA_SAVE:
      errorStates.dataSave.value = state;
      break;
  }
}

/**
 * Clear all error states
 */
export function clearErrorStates(): void {
  Object.values(errorStates).forEach(state => {
    state.value = createSuccessState(state.value.data);
  });
}

/**
 * Retry a failed operation
 */
export async function retryOperation<T>(
  errorState: ErrorState<T>,
  operation: () => Promise<T>
): Promise<ErrorState<T>> {
  if (!errorState.retryable) {
    return errorState;
  }
  
  try {
    const result = await operation();
    return createSuccessState(result);
  } catch (error) {
    return createErrorState(
      error instanceof Error ? error : new Error(String(error)),
      errorState.context
    );
  }
}

// ==========================================
// RESULT TYPE HELPERS
// ==========================================

/**
 * Create a success result
 */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/**
 * Create an error result
 */
export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Check if a result is successful
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/**
 * Check if a result is an error
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/**
 * Unwrap a result or throw
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * Unwrap a result or return default
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}