/**
 * Performance Integration Module
 * Examples of integrating performance monitoring throughout the application
 */

import { perfMonitor, monitored } from './performance-monitor.js';
import { on } from './event-bus.js';
import { DataSyncEvents, requestDataSync } from './data-sync-interface.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// DATA OPERATIONS MONITORING (Event-Based)
// ==========================================

/**
 * Monitored version of transaction creation (via events)
 */
export const createTransactionMonitored = monitored(
  async (data: Partial<Transaction>) => {
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      const timeout = setTimeout(() => {
        unsubscribe?.();
        reject(new Error('createTransactionMonitored timed out'));
      }, 10000);
      const handler = ({ success, data: result }: any) => {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(result);
      };
      unsubscribe = on(DataSyncEvents.SYNC_COMPLETE, handler);
      requestDataSync([data as Transaction], 'performance-monitor');
    });
  },
  'transaction.create'
);

/**
 * Monitored version of bulk transaction loading (via events)
 */
export const loadTransactionsMonitored = monitored(
  async () => {
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      const timeout = setTimeout(() => {
        unsubscribe?.();
        reject(new Error('loadTransactionsMonitored timed out'));
      }, 10000);
      const handler = ({ data }: any) => {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(data);
      };
      unsubscribe = on(DataSyncEvents.TRANSACTION_UPDATED, handler);
    });
  },
  'transaction.loadAll'
);

import { html, render, type TemplateResult } from './lit-helpers.js';

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

/**
 * Monitor React/Preact component renders
 */
export function withRenderMonitoring<P extends object>(
  Component: React.ComponentType<P>,
  componentName: string
): React.ComponentType<P> {
  return (props: P) => {
    perfMonitor.mark(`component.${componentName}.render`);
    
    // Schedule measurement after render
    requestAnimationFrame(() => {
      perfMonitor.measure(
        `component.${componentName}`,
        `component.${componentName}.render`
      );
    });
    
    // For function components
    if (typeof Component === 'function') {
      return (Component as any)(props);
    }
    // For class components (shouldn't happen but handle it)
    return null as any;
  };
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
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method || 'GET';
  
  return perfMonitor.measureAsync(
    'api.fetch',
    () => fetch(input, init),
    { url, method }
  );
}

// ==========================================
// EVENT HANDLER MONITORING
// ==========================================

/**
 * Monitor event handler performance
 */
export function monitorEventHandler<T extends Event>(
  handlerName: string,
  handler: (event: T) => void | Promise<void>
): (event: T) => void | Promise<void> {
  return async (event: T) => {
    const eventType = event.type;
    
    const result = handler(event);
    if (result instanceof Promise) {
      return perfMonitor.measureAsync(
        `event.${handlerName}`,
        () => result,
        { eventType }
      );
    } else {
      return result;
    }
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
 * Set up automatic performance monitoring for the app
 */
export function setupPerformanceMonitoring(): void {
  // Monitor long tasks
  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          perfMonitor.recordMetric(
            'longtask',
            entry.duration,
            'ms',
            { name: entry.name }
          );
          
          if (entry.duration > 50) {
            if (import.meta.env.DEV) console.warn(`Long task detected: ${entry.duration.toFixed(2)}ms`);
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {
      // Long task monitoring not available
    }
  }
  
  // Monitor page visibility changes
  document.addEventListener('visibilitychange', () => {
    perfMonitor.recordMetric(
      'visibility.change',
      document.hidden ? 0 : 1,
      'count',
      { hidden: document.hidden.toString() }
    );
  });
  
  // Monitor online/offline status
  window.addEventListener('online', () => {
    perfMonitor.recordMetric('network.online', 1, 'count');
  });
  
  window.addEventListener('offline', () => {
    perfMonitor.recordMetric('network.offline', 1, 'count');
  });
  
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
  setInterval(() => budgetEnforcer.check(), 60000);
  
  // Note: perfMonitor.logReport() on beforeunload is handled in app.ts

  // Expose performance monitor globally for debugging
  if (import.meta.env.DEV) {
    (window as any).perfMonitor = perfMonitor;
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
  withRenderMonitoring,
  InitializationMonitor,
  setupPerformanceMonitoring
};