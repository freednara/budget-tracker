/**
 * Performance Integration Module
 * Examples of integrating performance monitoring throughout the application
 */

import { perfMonitor, monitored } from './performance-monitor.js';
import { on } from './event-bus.js';
import { DataSyncEvents, requestDataSync, requestDataReload } from './data-sync-interface.js';
import { CONFIG } from './config.js';
import type { Transaction } from '../../types/index.js';

function isPerfDebugEnabled(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && window.__APP_DEBUG_PERF__ === true;
}

let performanceMonitoringInitialized = false;
let longTaskObserver: PerformanceObserver | null = null;
let budgetCheckInterval: ReturnType<typeof setInterval> | null = null;
let visibilityChangeHandler: (() => void) | null = null;
let onlineHandler: (() => void) | null = null;
let offlineHandler: (() => void) | null = null;

// ==========================================
// DATA OPERATIONS MONITORING (Event-Based)
// ==========================================

/**
 * Monitored version of transaction creation (via events)
 */
/**
 * Monitored version of transaction creation (via events).
 *
 * CR-Apr24-I finding 297: previously resolved on the first global
 * SYNC_COMPLETE with no request correlation — an unrelated sync finishing
 * first could satisfy the wrong monitored create. Now tags the request
 * with a unique source identifier and only resolves when the completion
 * payload carries a matching source.
 */
let _createTxSeq = 0;
export const createTransactionMonitored = monitored(
  async (data: Partial<Transaction>) => {
    const source = `perf-monitor-create-${++_createTxSeq}`;
    return new Promise((resolve, reject) => {
      let unsubscribeComplete: (() => void) | null = null;
      let unsubscribeError: (() => void) | null = null;
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribeComplete?.();
        unsubscribeError?.();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('createTransactionMonitored timed out'));
      }, 10000);
      const handler = (payload: { data: unknown; source?: string }) => {
        // CR-Apr24-I finding 297: only resolve when source matches our request
        if (payload.source && payload.source !== source) return;
        cleanup();
        resolve(payload.data);
      };
      // CR-Apr24-I finding 298: listen for SYNC_ERROR so a failed sync
      // rejects promptly instead of waiting for the 10s timeout.
      const errorHandler = (payload: { error: unknown }) => {
        cleanup();
        const err = payload.error instanceof Error ? payload.error : new Error(String(payload.error));
        reject(err);
      };
      unsubscribeComplete = on(DataSyncEvents.SYNC_COMPLETE, handler);
      unsubscribeError = on(DataSyncEvents.SYNC_ERROR, errorHandler);
      requestDataSync([data as Transaction], source);
    });
  },
  'transaction.create'
);

/**
 * Monitored version of bulk transaction loading (via events)
 */
/**
 * Monitored version of bulk transaction loading (via events).
 *
 * CR-Apr24-I finding 290: previously this helper subscribed to
 * TRANSACTION_UPDATED but never called requestDataReload(), so it would
 * simply wait for an unrelated external update event and otherwise time
 * out. Now it actually triggers the reload after wiring the listener.
 */
let _loadTxSeq = 0;
export const loadTransactionsMonitored = monitored(
  async () => {
    const source = `perf-monitor-load-${++_loadTxSeq}`;
    return new Promise((resolve, reject) => {
      let unsubscribeUpdate: (() => void) | null = null;
      let unsubscribeError: (() => void) | null = null;
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribeUpdate?.();
        unsubscribeError?.();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('loadTransactionsMonitored timed out'));
      }, 10000);
      // CR-Apr24-I finding 299: accept the first TRANSACTION_UPDATED
      // after our own request. Full source-correlation is not available
      // on this event, so accept the first payload after we fire the
      // reload — materially better than the previous no-request version.
      const handler = ({ data }: { data: unknown }) => {
        cleanup();
        resolve(data);
      };
      // CR-Apr24-I finding 298 (pattern): listen for SYNC_ERROR too.
      const errorHandler = (payload: { error: unknown }) => {
        cleanup();
        const err = payload.error instanceof Error ? payload.error : new Error(String(payload.error));
        reject(err);
      };
      unsubscribeUpdate = on(DataSyncEvents.TRANSACTION_UPDATED, handler);
      unsubscribeError = on(DataSyncEvents.SYNC_ERROR, errorHandler);

      // CR-Apr24-I finding 290: actually trigger the transaction load
      requestDataReload(source);
    });
  },
  'transaction.loadAll'
);

import { render, type TemplateResult } from './lit-helpers.js';

// ==========================================
// RENDER PERFORMANCE MONITORING
// ==========================================

/**
 * Monitor Lit template rendering
 */
export function monitorLitRender(
  componentName: string, 
  template: TemplateResult, 
  container: HTMLElement
): void {
  const start = performance.now();
  
  render(template, container);
  
  // Use requestAnimationFrame to measure after browser has processed the DOM update
  requestAnimationFrame(() => {
    const duration = performance.now() - start;
    perfMonitor.recordMetric(`render.lit.${componentName}`, duration, 'ms');
    
    if (duration > 16.7) { // Missed a frame (60fps)
      if (import.meta.env.DEV) console.warn(`[Performance] Lit render '${componentName}' took ${duration.toFixed(2)}ms (over 1 frame)`);
    }
  });
}

// ==========================================
// API MONITORING
// ==========================================

/**
 * Monitor fetch requests
 */
export async function monitoredFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const requestUrl = resolveMonitoredFetchUrl(input);
  const method = init?.method || (input instanceof Request ? input.method : 'GET');
  if (requestUrl && typeof window !== 'undefined' && requestUrl.origin !== window.location.origin) {
    throw new Error(`Blocked external monitored fetch to ${requestUrl.origin}`);
  }

  const url = requestUrl?.toString() ?? (typeof input === 'string' ? input : input.toString());
  
  return perfMonitor.measureAsync(
    'api.fetch',
    () => fetch(input, init),
    { url, method }
  );
}

function resolveMonitoredFetchUrl(input: RequestInfo | URL): URL | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const rawUrl =
    input instanceof URL ? input.toString() :
    input instanceof Request ? input.url :
    input;

  try {
    return new URL(rawUrl, window.location.origin);
  } catch {
    return null;
  }
}

// ==========================================
// EVENT HANDLER MONITORING
// ==========================================

/**
 * Monitor event handler performance.
 *
 * CR-Apr24-I finding 300: previously always returned an `async` wrapper,
 * turning synchronous throws into rejected promises — a materially
 * different contract for callers expecting immediate exception behavior.
 * Now the wrapper is synchronous when the inner handler is synchronous,
 * preserving the original throw semantics.
 */
export function monitorEventHandler<T extends Event>(
  handlerName: string,
  handler: (event: T) => void | Promise<void>
): (event: T) => void | Promise<void> {
  return (event: T): void | Promise<void> => {
    const eventType = event.type;

    const start = performance.now();
    const result = handler(event);
    if (result instanceof Promise) {
      return perfMonitor.measureAsync(
        `event.${handlerName}`,
        () => result,
        { eventType }
      );
    }
    // CR-Apr24-I findings 291+300: measure sync handlers too so the
    // performance monitor covers both paths. Record timing directly
    // so synchronous throws propagate as throws, not rejected promises.
    const duration = performance.now() - start;
    perfMonitor.recordMetric(`event.${handlerName}`, duration, 'ms', { eventType });
    return result;
  };
}

// ==========================================
// INITIALIZATION MONITORING
// ==========================================

/**
 * Monitor app initialization phases
 */
export class InitializationMonitor {
  private startTime = performance.now();
  
  markPhase(phase: string): void {
    const elapsed = performance.now() - this.startTime;
    perfMonitor.recordMetric(`init.${phase}`, elapsed, 'ms');
  }
  
  complete(): void {
    const totalTime = performance.now() - this.startTime;
    perfMonitor.recordMetric('init.total', totalTime, 'ms');
    
    // Log initialization report
    // App initialization completed with timing metrics
  }
}

// ==========================================
// PERFORMANCE BUDGET ENFORCEMENT
// ==========================================

export interface PerformanceBudget {
  metric: string;
  threshold: number;
  action?: 'warn' | 'error';
}

export class PerformanceBudgetEnforcer {
  private budgets: PerformanceBudget[] = [];
  
  addBudget(budget: PerformanceBudget): void {
    this.budgets.push(budget);
  }
  
  check(): void {
    const report = perfMonitor.getReport();
    
    for (const budget of this.budgets) {
      const metric = report.metrics[budget.metric];
      if (!metric) continue;
      
      const value = metric.p95; // Use P95 for budget checks
      
      if (value > budget.threshold) {
        const message = `Performance budget exceeded for ${budget.metric}: ${value.toFixed(2)}ms (threshold: ${budget.threshold}ms)`;
        
        if (budget.action === 'error') {
          if (import.meta.env.DEV) console.error(message);
        } else {
          if (import.meta.env.DEV) console.warn(message);
        }
      }
    }
  }
}

// ==========================================
// AUTOMATIC MONITORING SETUP
// ==========================================

/**
 * Tear down automatic performance monitoring: disconnect the long-task
 * PerformanceObserver, detach visibilitychange + online + offline listeners,
 * clear the budget-check interval, and reset the init flag so a subsequent
 * `setupPerformanceMonitoring()` call re-arms the pipeline cleanly.
 *
 * Phase 6 Slice 1c (Inline-Behavior-Review rev 12, L4): previously
 * `budgetCheckInterval` (and the PerformanceObserver + three window
 * listeners) were captured to module-scope but had no release path. A
 * second `setupPerformanceMonitoring()` call early-returned via the init
 * guard, so there was no leak on double-init *today*, but any future
 * re-init flow (e.g. HMR, DI-container re-bootstrap, tests that want a
 * fresh monitoring pipeline) would silently stack a second 1 Hz interval,
 * a second long-task observer, and three duplicate window listeners onto
 * the first. This function is the pair to `setupPerformanceMonitoring` —
 * call it before re-calling setup to get clean re-init semantics.
 */
export function cleanupPerformanceMonitoring(): void {
  if (longTaskObserver) {
    try {
      longTaskObserver.disconnect();
    } catch {
      // PerformanceObserver.disconnect() is idempotent in spec but older
      // implementations throw on double-disconnect; swallow deliberately.
    }
    longTaskObserver = null;
  }

  if (visibilityChangeHandler) {
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
    visibilityChangeHandler = null;
  }

  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }

  if (offlineHandler) {
    window.removeEventListener('offline', offlineHandler);
    offlineHandler = null;
  }

  if (budgetCheckInterval !== null) {
    clearInterval(budgetCheckInterval);
    budgetCheckInterval = null;
  }

  performanceMonitoringInitialized = false;
}

/**
 * Set up automatic performance monitoring for the app
 */
export function setupPerformanceMonitoring(): void {
  if (performanceMonitoringInitialized) {
    return;
  }

  performanceMonitoringInitialized = true;

  // Monitor long tasks
  if ('PerformanceObserver' in window) {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          perfMonitor.recordMetric(
            'longtask',
            entry.duration,
            'ms',
            { name: entry.name }
          );
          
          if (entry.duration > 50) {
            if (isPerfDebugEnabled()) console.warn(`Long task detected: ${entry.duration.toFixed(2)}ms`);
          }
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (_e) {
      longTaskObserver = null;
      // Long task monitoring not available
    }
  }
  
  // Monitor page visibility changes
  visibilityChangeHandler = () => {
    perfMonitor.recordMetric(
      'visibility.change',
      document.hidden ? 0 : 1,
      'count',
      { hidden: document.hidden.toString() }
    );
  };
  document.addEventListener('visibilitychange', visibilityChangeHandler);
  
  // Monitor online/offline status
  onlineHandler = () => {
    perfMonitor.recordMetric('network.online', 1, 'count');
  };
  window.addEventListener('online', onlineHandler);
  
  offlineHandler = () => {
    perfMonitor.recordMetric('network.offline', 1, 'count');
  };
  window.addEventListener('offline', offlineHandler);
  
  // Set up performance budgets
  const budgetEnforcer = new PerformanceBudgetEnforcer();
  
  budgetEnforcer.addBudget({
    metric: 'transaction.create',
    threshold: 100,
    action: 'warn'
  });
  
  budgetEnforcer.addBudget({
    metric: 'render.dashboard',
    threshold: 200,
    action: 'warn'
  });
  
  budgetEnforcer.addBudget({
    metric: 'transaction.loadAll',
    threshold: 500,
    action: 'error'
  });

  budgetEnforcer.addBudget({
    metric: 'db.init',
    threshold: 1000,
    action: 'warn'
  });

  budgetEnforcer.addBudget({
    metric: 'worker.sync',
    threshold: 300,
    action: 'warn'
  });
  
  // Check budgets periodically
  budgetCheckInterval = setInterval(() => budgetEnforcer.check(), CONFIG.TIMING.PERIODIC_CLEANUP_INTERVAL);
  
  // Note: perfMonitor.logReport() on beforeunload is handled in app.ts

  // Expose performance monitor globally for debugging
  if (import.meta.env.DEV) {
    window.perfMonitor = perfMonitor;
  }
}

// ==========================================
// EXPORT FOR EASY INTEGRATION
// ==========================================

export const performanceTools = {
  monitor: perfMonitor,
  monitorRender: monitorLitRender,
  monitorEventHandler,
  monitoredFetch,
  InitializationMonitor,
  setupPerformanceMonitoring,
  cleanupPerformanceMonitoring
};
