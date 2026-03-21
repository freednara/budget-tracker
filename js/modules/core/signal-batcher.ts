/**
 * Signal Effect Batcher
 * 
 * Optimizes localStorage writes by batching multiple signal effects
 * into a single write operation, preventing performance degradation.
 */
'use strict';

import { effect, Signal, batch } from '@preact/signals-core';
import { lsSet, SK } from './state.js';
import { trackError } from './error-tracker.js';
import { logError } from './utils.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface BatchedWrite {
  key: string;
  value: any;
  timestamp: number;
}

interface BatchConfig {
  maxBatchSize?: number;
  debounceMs?: number;
  flushOnVisibilityChange?: boolean;
  compression?: boolean;
  onWrite?: (key: string, value: any) => Promise<void> | void;
}

type SignalMap = Record<string, Signal<any>>;

// ==========================================
// SIGNAL BATCHER CLASS
// ==========================================

export class SignalBatcher {
  private pendingWrites: Map<string, BatchedWrite> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Required<BatchConfig>;
  private isWriting = false;
  private writeQueue: BatchedWrite[] = [];
  private disposers: Array<() => void> = [];
  
  constructor(config: BatchConfig = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize || 50,
      debounceMs: config.debounceMs || 100,
      flushOnVisibilityChange: config.flushOnVisibilityChange ?? true,
      compression: config.compression ?? false,
      onWrite: config.onWrite || (async () => {})
    };
    
    this.setupEventHandlers();
  }
  
  /**
   * Register a signal for batched persistence
   */
  registerSignal<T>(key: string, signal: Signal<T>): () => void {
    const dispose = effect(() => {
      this.queueWrite(key, signal.value);
    });
    
    this.disposers.push(dispose);
    return dispose;
  }
  
  /**
   * Register multiple signals at once
   */
  registerSignals(signals: SignalMap): () => void {
    const disposers = Object.entries(signals).map(([key, signal]) => 
      this.registerSignal(key, signal)
    );
    
    return () => disposers.forEach(dispose => dispose());
  }
  
  /**
   * Queue a write operation
   */
  private queueWrite(key: string, value: any): void {
    this.pendingWrites.set(key, {
      key,
      value,
      timestamp: Date.now()
    });
    
    // Check batch size limit
    if (this.pendingWrites.size >= this.config.maxBatchSize) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }
  
  /**
   * Schedule a flush operation
   */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.config.debounceMs);
  }
  
  /**
   * Flush all pending writes to localStorage
   */
  async flush(): Promise<void> {
    if (this.isWriting || this.pendingWrites.size === 0) {
      return;
    }
    
    // Clear the timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Move pending writes to queue
    const writes = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    
    // Perform batched write
    this.isWriting = true;
    
    try {
      await this.performBatchWrite(writes);
    } catch (error) {
      logError('SignalBatcher.flush', error as Error);
      // Re-queue failed writes
      writes.forEach(write => {
        this.pendingWrites.set(write.key, write);
      });
      this.scheduleFlush();
    } finally {
      this.isWriting = false;
    }
  }
  
  /**
   * Perform the actual batch write with improved atomicity
   */
  private async performBatchWrite(writes: BatchedWrite[]): Promise<void> {
    try {
      if (this.config.compression) {
        const batchObj = writes.reduce((acc, write) => {
          acc[write.key] = write.value;
          return acc;
        }, {} as Record<string, any>);
        
        const compressed = btoa(JSON.stringify(batchObj)); // Basic base64 compression
        lsSet('__batch_v2__', compressed);
      } else {
        // IMPROVED: Use a single loop for the entire batch to ensure 
        // that if any write fails, we can handle the whole batch as a failure.
        for (const write of writes) {
          lsSet(write.key, write.value);
          if (this.config.onWrite) {
            await this.config.onWrite(write.key, write.value);
          }
        }
      }
      
      this.emitBatchComplete(writes);
    } catch (error) {
      trackError(error as Error, {
        module: 'SignalBatcher',
        action: `performBatchWrite[${writes.map(w => w.key).join(',')}]`
      });
      throw error; // Re-throw to trigger re-queue logic in flush()
    }
  }
  
  /**
   * Simple compression using LZ-string algorithm concept
   */
  private compress(data: string): string {
    // For production, you'd want to use a real compression library
    // This is a placeholder that demonstrates the concept
    try {
      // Simple RLE-like compression for demo
      return btoa(data);
    } catch {
      return data;
    }
  }
  
  /**
   * Decompress data
   */
  private decompress(data: string): string {
    try {
      return atob(data);
    } catch {
      return data;
    }
  }
  
  /**
   * Set up event handlers
   */
  private periodicFlushInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private unloadHandler: (() => void) | null = null;

  private setupEventHandlers(): void {
    if (this.config.flushOnVisibilityChange) {
      this.visibilityHandler = () => {
        if (document.hidden) {
          this.flush();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    // Synchronously flush pending writes on page unload
    this.unloadHandler = () => {
      // Cancel any pending debounced flush to prevent double-writes
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      // Use synchronous localStorage writes since async won't complete before unload
      for (const write of this.pendingWrites.values()) {
        try {
          localStorage.setItem(write.key, JSON.stringify(write.value));
        } catch { /* best effort */ }
      }
      this.pendingWrites.clear();

      // Mark as writing to prevent any in-flight async flush from re-queuing
      this.isWriting = true;
    };
    window.addEventListener('beforeunload', this.unloadHandler);

    // Periodic flush as safety net
    this.periodicFlushInterval = setInterval(() => {
      if (this.pendingWrites.size > 0) {
        const oldestWrite = Math.min(...Array.from(this.pendingWrites.values()).map(w => w.timestamp));
        if (Date.now() - oldestWrite > 5000) { // 5 seconds
          this.flush();
        }
      }
    }, 1000);
  }
  
  /**
   * Emit batch complete event
   */
  private emitBatchComplete(writes: BatchedWrite[]): void {
    const event = new CustomEvent('signalBatchComplete', {
      detail: {
        count: writes.length,
        keys: writes.map(w => w.key),
        timestamp: Date.now()
      }
    });
    window.dispatchEvent(event);
  }
  
  /**
   * Get pending write count
   */
  getPendingCount(): number {
    return this.pendingWrites.size;
  }
  
  /**
   * Force immediate flush
   */
  forceFlush(): Promise<void> {
    return this.flush();
  }
  
  /**
   * Destroy the batcher
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    if (this.periodicFlushInterval) {
      clearInterval(this.periodicFlushInterval);
      this.periodicFlushInterval = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    // Synchronously write any pending data before clearing (flush() is async and won't complete in time)
    for (const write of this.pendingWrites.values()) {
      try {
        localStorage.setItem(write.key, JSON.stringify(write.value));
      } catch { /* best effort */ }
    }
    this.pendingWrites.clear();
    this.disposers.forEach(dispose => dispose());
    this.disposers = [];
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: SignalBatcher | null = null;

/**
 * Get or create the singleton batcher instance
 */
export function getSignalBatcher(config?: BatchConfig): SignalBatcher {
  if (!instance) {
    instance = new SignalBatcher(config);
  }
  return instance;
}

// ==========================================
// OPTIMIZED SIGNAL REGISTRATION
// ==========================================

/**
 * Register all app signals for batched persistence
 * FIXED: Updated to match current signals.ts definitions and storage keys
 */
export function registerAppSignals(signalsMap: Record<string, Signal<any>>): () => void {
  const batcher = getSignalBatcher({
    debounceMs: 150,
    maxBatchSize: 20,
    flushOnVisibilityChange: true
  });
  
  return batcher.registerSignals(signalsMap);
}

// ==========================================
// PERFORMANCE MONITORING
// ==========================================

/**
 * Monitor batching performance
 */
export function monitorBatchingPerformance(): {
  getStats: () => {
    totalWrites: number;
    batchedWrites: number;
    averageBatchSize: number;
    compressionRatio: number;
  };
  reset: () => void;
} {
  let stats = {
    totalWrites: 0,
    batchedWrites: 0,
    totalBatches: 0,
    totalBytes: 0,
    compressedBytes: 0
  };
  
  window.addEventListener('signalBatchComplete', ((e: CustomEvent) => {
    stats.totalWrites += e.detail.count;
    stats.batchedWrites++;
    stats.totalBatches++;
  }) as EventListener);
  
  return {
    getStats: () => ({
      totalWrites: stats.totalWrites,
      batchedWrites: stats.batchedWrites,
      averageBatchSize: stats.totalBatches > 0 ? stats.totalWrites / stats.totalBatches : 0,
      compressionRatio: stats.totalBytes > 0 ? stats.compressedBytes / stats.totalBytes : 1
    }),
    reset: () => {
      stats = {
        totalWrites: 0,
        batchedWrites: 0,
        totalBatches: 0,
        totalBytes: 0,
        compressedBytes: 0
      };
    }
  };
}

// ==========================================
// MIGRATION HELPER
// ==========================================

/**
 * Migrate from individual effects to batched persistence
 */
export function migrateToBatchedPersistence(
  signals: Record<string, Signal<any>>,
  oldDisposers: Array<() => void>
): () => void {
  // Dispose old effects
  oldDisposers.forEach(dispose => dispose());
  
  // Set up new batched persistence
  const batcher = getSignalBatcher();
  return batcher.registerSignals(signals);
}