/**
 * Performance Monitor Module
 * Tracks and reports performance metrics for the application
 */

const DEV = import.meta.env.DEV;

function isPerfDebugEnabled(): boolean {
  return DEV && typeof window !== 'undefined' && (window as any).__APP_DEBUG_PERF__ === true;
}

// ==========================================
// TYPES AND INTERFACES
// ==========================================

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count' | 'percent';
  timestamp: number;
  tags?: Record<string, string>;
}

export interface PerformanceReport {
  metrics: {
    [key: string]: {
      avg: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
      count: number;
      unit: string;
    };
  };
  memory?: {
    used: number;
    total: number;
    limit: number;
    percentUsed: number;
  };
  timing?: {
    navigationStart: number;
    domContentLoaded: number;
    loadComplete: number;
  };
  vitals?: {
    FCP?: number; // First Contentful Paint
    LCP?: number; // Largest Contentful Paint
    FID?: number; // First Input Delay
    CLS?: number; // Cumulative Layout Shift
    TTFB?: number; // Time to First Byte
  };
}

// ==========================================
// PERFORMANCE MONITOR CLASS
// ==========================================

export class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private marks = new Map<string, number>();
  private measures = new Map<string, number[]>();
  private maxMetrics = 1000;
  private observers: Array<(metric: PerformanceMetric) => void> = [];
  private memoryIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.initWebVitals();
  }
  
  /**
   * Mark a point in time for later measurement
   */
  mark(name: string): void {
    this.marks.set(name, performance.now());
    performance.mark(`pm-${name}`);
  }
  
  /**
   * Measure time between two marks
   */
  measure(name: string, startMark: string, endMark?: string): number {
    const start = this.marks.get(startMark);
    if (!start) {
      if (DEV) console.warn(`Mark ${startMark} not found`);
      return 0;
    }
    
    const end = endMark ? this.marks.get(endMark) : performance.now();
    if (endMark && !this.marks.has(endMark)) {
      if (DEV) console.warn(`Mark ${endMark} not found`);
      return 0;
    }
    
    const duration = end! - start;
    
    // Record the measurement
    this.recordMetric(name, duration, 'ms');
    
    // Store for percentile calculations
    if (!this.measures.has(name)) {
      this.measures.set(name, []);
    }
    const arr = this.measures.get(name)!;
    arr.push(duration);
    // Keep only last 100 measurements per metric to prevent unbounded growth
    if (arr.length > 100) {
      arr.splice(0, arr.length - 100);
    }
    
    // Use Performance API for detailed timing
    try {
      performance.measure(`pm-${name}`, `pm-${startMark}`, endMark ? `pm-${endMark}` : undefined);
    } catch (e) {
      // Marks might not exist in Performance API
    }
    
    return duration;
  }
  
  /**
   * Record a custom metric
   */
  recordMetric(
    name: string, 
    value: number, 
    unit: PerformanceMetric['unit'],
    tags?: Record<string, string>
  ): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags
    };
    
    this.metrics.push(metric);
    
    // Notify observers
    this.observers.forEach(observer => observer(metric));
    
    // Trim old metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
    
    // Keep metrics recorded in dev, but only emit noisy slow-operation warnings
    // when performance debugging is explicitly enabled.
    if (unit === 'ms' && value > 1000) {
      if (isPerfDebugEnabled()) console.warn(`Slow operation detected: ${name} took ${value.toFixed(2)}ms`);
    }
  }
  
  /**
   * Measure an async operation
   */
  async measureAsync<T>(
    name: string, 
    fn: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    const start = performance.now();
    let error: Error | undefined;
    
    try {
      return await fn();
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = performance.now() - start;
      this.recordMetric(name, duration, 'ms', {
        ...tags,
        ...(error ? { error: error.message } : {})
      });
    }
  }
  
  /**
   * Measure a sync operation
   */
  measureSync<T>(
    name: string,
    fn: () => T,
    tags?: Record<string, string>
  ): T {
    const start = performance.now();
    let error: Error | undefined;
    
    try {
      return fn();
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = performance.now() - start;
      this.recordMetric(name, duration, 'ms', {
        ...tags,
        ...(error ? { error: error.message } : {})
      });
    }
  }
  
  /**
   * Check memory usage
   */
  checkMemory(): void {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      this.recordMetric('heap.used', memory.usedJSHeapSize, 'bytes');
      this.recordMetric('heap.total', memory.totalJSHeapSize, 'bytes');
      this.recordMetric('heap.limit', memory.jsHeapSizeLimit, 'bytes');
      
      const percentUsed = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;
      this.recordMetric('heap.percent', percentUsed, 'percent');
      
      // Warn if memory usage is high
      if (percentUsed > 90) {
        if (DEV) console.warn(`High memory usage: ${percentUsed.toFixed(1)}%`);
      }
    }
  }
  
  /**
   * Initialize Web Vitals monitoring
   */
  private initWebVitals(): void {
    // First Contentful Paint
    this.observePaint('first-contentful-paint', 'FCP');
    
    // Largest Contentful Paint
    this.observeLCP();
    
    // First Input Delay
    this.observeFID();
    
    // Cumulative Layout Shift
    this.observeCLS();
    
    // Time to First Byte
    this.measureTTFB();
  }
  
  private observePaint(entryType: string, metricName: string): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'paint' && entry.name === entryType) {
            this.recordMetric(`vitals.${metricName}`, entry.startTime, 'ms');
          }
        }
      });
      observer.observe({ entryTypes: ['paint'] });
    } catch (e) {
      // PerformanceObserver might not be available
    }
  }
  
  private observeLCP(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          this.recordMetric('vitals.LCP', lastEntry.startTime, 'ms');
        }
      });
      observer.observe({ entryTypes: ['largest-contentful-paint'] });
    } catch (e) {
      // Not available
    }
  }
  
  private observeFID(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'first-input') {
            const delay = (entry as any).processingStart - entry.startTime;
            this.recordMetric('vitals.FID', delay, 'ms');
          }
        }
      });
      observer.observe({ entryTypes: ['first-input'] });
    } catch (e) {
      // Not available
    }
  }
  
  private observeCLS(): void {
    let clsValue = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
            this.recordMetric('vitals.CLS', clsValue, 'count');
          }
        }
      });
      observer.observe({ entryTypes: ['layout-shift'] });
    } catch (e) {
      // Not available
    }
  }
  
  private measureTTFB(): void {
    if (window.performance && performance.timing) {
      const ttfb = performance.timing.responseStart - performance.timing.navigationStart;
      if (ttfb > 0) {
        this.recordMetric('vitals.TTFB', ttfb, 'ms');
      }
    }
  }
  
  /**
   * Calculate percentile
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
  
  /**
   * Calculate percentile asynchronously during idle time
   */
  private async calculatePercentileAsync(values: number[], percentile: number): Promise<number> {
    if (values.length === 0) return 0;
    
    return new Promise((resolve) => {
      const idleCallback = (deadline: IdleDeadline) => {
        // If we have enough idle time, do the calculation
        if (deadline.timeRemaining() > 5 || deadline.didTimeout) {
          const sorted = [...values].sort((a, b) => a - b);
          const index = Math.ceil((percentile / 100) * sorted.length) - 1;
          resolve(sorted[Math.max(0, index)]);
        } else {
          // Not enough time, request another idle callback
          requestIdleCallback(idleCallback, { timeout: 100 });
        }
      };
      
      if ('requestIdleCallback' in window) {
        requestIdleCallback(idleCallback, { timeout: 100 });
      } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => {
          const sorted = [...values].sort((a, b) => a - b);
          const index = Math.ceil((percentile / 100) * sorted.length) - 1;
          resolve(sorted[Math.max(0, index)]);
        }, 0);
      }
    });
  }
  
  /**
   * Generate performance report (synchronous for immediate use)
   */
  getReport(): PerformanceReport {
    // For immediate use, still synchronous but with optimization
    return this.getReportSync();
  }
  
  /**
   * Generate performance report asynchronously during idle time
   */
  async getReportAsync(): Promise<PerformanceReport> {
    const grouped = new Map<string, PerformanceMetric[]>();
    
    // Group metrics by name
    for (const metric of this.metrics) {
      const existing = grouped.get(metric.name) || [];
      existing.push(metric);
      grouped.set(metric.name, existing);
    }
    
    const report: PerformanceReport = {
      metrics: {}
    };
    
    // Calculate statistics for each metric asynchronously
    const calculations = [];
    for (const [name, metrics] of grouped) {
      const values = metrics.map(m => m.value);
      const unit = metrics[0].unit;
      
      // Start async calculations
      const calculation = Promise.all([
        this.calculatePercentileAsync(values, 50),
        this.calculatePercentileAsync(values, 95),
        this.calculatePercentileAsync(values, 99)
      ]).then(([p50, p95, p99]) => {
        report.metrics[name] = {
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          min: Math.min(...values),
          max: Math.max(...values),
          p50,
          p95,
          p99,
          count: values.length,
          unit
        };
      });
      
      calculations.push(calculation);
    }
    
    // Wait for all calculations to complete
    await Promise.all(calculations);
    
    // Add memory info
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      report.memory = {
        used: memory.usedJSHeapSize,
        total: memory.totalJSHeapSize,
        limit: memory.jsHeapSizeLimit,
        percentUsed: (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100
      };
    }
    
    // Add timing info
    if (window.performance && performance.timing) {
      const timing = performance.timing;
      report.timing = {
        navigationStart: timing.navigationStart,
        domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
        loadComplete: timing.loadEventEnd - timing.navigationStart
      };
    }
    
    // Add Web Vitals
    const vitals: any = {};
    for (const [key, value] of Object.entries(report.metrics)) {
      if (key.startsWith('vitals.')) {
        const vitalName = key.replace('vitals.', '');
        vitals[vitalName] = value.avg;
      }
    }
    if (Object.keys(vitals).length > 0) {
      report.vitals = vitals;
    }
    
    return report;
  }
  
  /**
   * Generate performance report synchronously (original implementation)
   */
  private getReportSync(): PerformanceReport {
    const grouped = new Map<string, PerformanceMetric[]>();
    
    // Group metrics by name
    for (const metric of this.metrics) {
      const existing = grouped.get(metric.name) || [];
      existing.push(metric);
      grouped.set(metric.name, existing);
    }
    
    const report: PerformanceReport = {
      metrics: {}
    };
    
    // Calculate statistics for each metric
    for (const [name, metrics] of grouped) {
      const values = metrics.map(m => m.value);
      const unit = metrics[0].unit;
      
      report.metrics[name] = {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        p50: this.calculatePercentile(values, 50),
        p95: this.calculatePercentile(values, 95),
        p99: this.calculatePercentile(values, 99),
        count: values.length,
        unit
      };
    }
    
    // Add memory info
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      report.memory = {
        used: memory.usedJSHeapSize,
        total: memory.totalJSHeapSize,
        limit: memory.jsHeapSizeLimit,
        percentUsed: (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100
      };
    }
    
    // Add timing info
    if (window.performance && performance.timing) {
      const timing = performance.timing;
      report.timing = {
        navigationStart: timing.navigationStart,
        domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
        loadComplete: timing.loadEventEnd - timing.navigationStart
      };
    }
    
    // Add Web Vitals
    const vitals: any = {};
    for (const [key, value] of Object.entries(report.metrics)) {
      if (key.startsWith('vitals.')) {
        const vitalName = key.replace('vitals.', '');
        vitals[vitalName] = value.avg;
      }
    }
    if (Object.keys(vitals).length > 0) {
      report.vitals = vitals;
    }
    
    return report;
  }
  
  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.marks.clear();
    this.measures.clear();
  }

  /**
   * Start periodic memory checking
   */
  startMemoryMonitoring(intervalMs: number = 30000): void {
    this.stopMemoryMonitoring();
    this.memoryIntervalId = setInterval(() => this.checkMemory(), intervalMs);
  }

  /**
   * Stop periodic memory checking and clean up the interval
   */
  stopMemoryMonitoring(): void {
    if (this.memoryIntervalId !== null) {
      clearInterval(this.memoryIntervalId);
      this.memoryIntervalId = null;
    }
  }
  
  /**
   * Add observer for real-time metrics
   */
  observe(callback: (metric: PerformanceMetric) => void): () => void {
    this.observers.push(callback);
    return () => {
      const index = this.observers.indexOf(callback);
      if (index > -1) {
        this.observers.splice(index, 1);
      }
    };
  }
  
  /**
   * Log performance report to console
   */
  logReport(): void {
    if (!DEV) return;
    const report = this.getReport();

    console.group('Performance Report');

    // Log metrics table
    const metricsTable = Object.entries(report.metrics).map(([name, stats]) => ({
      Metric: name,
      Avg: `${stats.avg.toFixed(2)} ${stats.unit}`,
      Min: `${stats.min.toFixed(2)} ${stats.unit}`,
      Max: `${stats.max.toFixed(2)} ${stats.unit}`,
      P95: `${stats.p95.toFixed(2)} ${stats.unit}`,
      Count: stats.count
    }));
    console.table(metricsTable);

    // Log memory if available
    if (report.memory) {
      console.log('Memory Usage:', {
        Used: `${(report.memory.used / 1024 / 1024).toFixed(2)} MB`,
        Total: `${(report.memory.total / 1024 / 1024).toFixed(2)} MB`,
        Percent: `${report.memory.percentUsed.toFixed(1)}%`
      });
    }

    // Log Web Vitals if available
    if (report.vitals) {
      console.log('Web Vitals:', report.vitals);
    }

    console.groupEnd();
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const perfMonitor = new PerformanceMonitor();

// Auto-check memory every 30 seconds
if (typeof window !== 'undefined') {
  perfMonitor.startMemoryMonitoring(30000);
}

// ==========================================
// DECORATORS
// ==========================================

/**
 * Decorator to automatically measure method performance
 */
export function measurePerformance(target: any, propertyName: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = function(...args: any[]) {
    const className = target.constructor.name;
    const metricName = `${className}.${propertyName}`;
    const result = originalMethod.apply(this, args);

    // Preserve sync/async behavior of the original method
    if (result instanceof Promise) {
      return perfMonitor.measureAsync(metricName, () => result);
    }
    return result;
  };

  return descriptor;
}

/**
 * Create a performance-monitored version of a function
 */
export function monitored<T extends (...args: any[]) => any>(
  fn: T,
  name: string
): T {
  return ((...args: Parameters<T>) => {
    // Detect async by checking return value (survives minification, unlike constructor.name)
    const result = fn(...args);
    if (result instanceof Promise) {
      return perfMonitor.measureAsync(name, () => result);
    }
    return result;
  }) as T;
}
