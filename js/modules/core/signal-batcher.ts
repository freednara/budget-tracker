/**
 * Signal Effect Batcher
 * 
 * Optimizes localStorage writes by batching multiple signal effects
 * into a single write operation, preventing performance degradation.
 */
'use strict';

import { effect, Signal } from '@preact/signals-core';
import { lsSet } from './state.js';
import { trackError } from './error-tracker.js';
import { logError } from './utils-pure.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface BatchedWrite {
  key: string;
  value: unknown;
  timestamp: number;
}

interface BatchConfig {
  maxBatchSize?: number;
  debounceMs?: number;
  flushOnVisibilityChange?: boolean;
  // Phase 5g-3 Slice 7 (Inline-Behavior-Review rev 12, M21): the
  // `compression?: boolean` option was removed. Pre-edit grep across
  // js/ + tests/ + e2e/ found zero callers passing `compression: true`
  // and zero read sites for the `__batch_v2__` bundle key the branch
  // wrote to. The branch used `btoa(JSON.stringify(...))` which is
  // base64 encoding (not compression — output is ~33% larger than
  // input). Re-scoped from the review's "delete branch OR wire
  // CompressionStream" binary to full deletion: unused flags that
  // advertise a contract are strictly worse than no flag. Same
  // direction-reversal family as M31, Slice 4 L53, Slice 5 L57-L59,
  // and Slice 6's planned cascading deletion. If real compression is
  // ever wanted, wire `CompressionStream` with a paired read path on
  // rehydration first, then add the option back with an actual caller.
  onWrite?: (key: string, value: unknown) => Promise<void> | void;
}

type SignalMap = Record<string, Signal<unknown>>;

// ==========================================
// SIGNAL BATCHER CLASS
// ==========================================

export class SignalBatcher {
  private pendingWrites: Map<string, BatchedWrite> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Required<BatchConfig>;
  private isWriting = false;
  private needsReflush = false;
  private writeQueue: BatchedWrite[] = [];
  private disposers: Array<() => void> = [];
  
  constructor(config: BatchConfig = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize || 50,
      debounceMs: config.debounceMs || 100,
      flushOnVisibilityChange: config.flushOnVisibilityChange ?? true,
      onWrite: config.onWrite || (async () => {})
    };
    
    this.setupEventHandlers();
  }
  
  /**
   * Register a signal for batched persistence.
   *
   * CR-Apr24-I finding 210: the original implementation eagerly queued
   * a write for the signal's current value the moment the `effect()`
   * subscription was created (Preact signals fire effects synchronously
   * on first subscribe). This meant every registered signal generated a
   * no-op localStorage write + cross-tab broadcast on startup, even
   * though nothing had changed. The `isInitial` flag skips the first
   * effect invocation — actual user-driven mutations still queue writes
   * normally because they trigger the effect a second time.
   */
  registerSignal<T>(key: string, signal: Signal<T>): () => void {
    let isInitial = true;
    const dispose = effect(() => {
      const value = signal.value; // subscribe unconditionally
      if (isInitial) {
        isInitial = false;
        return; // skip the eager startup write
      }
      this.queueWrite(key, value);
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
  private queueWrite(key: string, value: unknown): void {
    this.pendingWrites.set(key, {
      key,
      value,
      timestamp: Date.now()
    });
    
    // Check batch size limit
    if (this.pendingWrites.size >= this.config.maxBatchSize) {
      void this.flush();
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
      void this.flush();
    }, this.config.debounceMs);
  }
  
  /**
   * Flush all pending writes to localStorage
   */
  async flush(): Promise<void> {
    // If already writing, mark for re-flush and return
    if (this.isWriting) {
      this.needsReflush = true;
      return;
    }

    // Nothing to flush
    if (this.pendingWrites.size === 0) {
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
    this.needsReflush = false;

    // Perform batched write
    this.isWriting = true;

    try {
      await this.performBatchWrite(writes);
    } catch (error) {
      // Round 7 fix: Handle partial failures gracefully. If the error object
      // has a failedWrites array, only re-queue those. Otherwise re-queue all
      // (backward compatibility for errors not from performBatchWrite).
      const errorObj = error as Record<string, unknown> | null | undefined;
      const failedWrites = (errorObj && Array.isArray((errorObj as Record<string, unknown>).failedWrites))
        ? (errorObj as Record<string, unknown>).failedWrites as BatchedWrite[]
        : writes;

      logError('SignalBatcher.flush', (errorObj as Record<string, unknown>)?.error instanceof Error
        ? (errorObj as Record<string, unknown>).error as Error
        : (error as Error));

      // Round 7 fix: Only re-queue the writes that actually failed, not all.
      // This prevents the write amplification storm on partial batch failures.
      failedWrites.forEach((write: BatchedWrite) => {
        this.pendingWrites.set(write.key, write);
      });

      this.scheduleFlush();
    } finally {
      this.isWriting = false;

      // If new writes were queued during the flush, re-flush them
      if (this.needsReflush && this.pendingWrites.size > 0) {
        this.needsReflush = false;
        // Use scheduleFlush instead of flush() to respect debounce logic
        this.scheduleFlush();
      }
    }
  }
  
  /**
   * Perform the actual batch write with improved atomicity
   *
   * Phase 5g-3 Slice 7 (Inline-Behavior-Review rev 12, M21): removed the
   * `if (this.config.compression) { ... }` branch that wrote a base64-
   * encoded bundle to the singleton `__batch_v2__` localStorage key.
   * Pre-edit grep confirmed: (a) zero callers passed `compression: true`
   * across js/ + tests/ + e2e/; (b) the `__batch_v2__` key had exactly
   * one write site (this branch) and zero read sites anywhere in the
   * codebase — nothing rehydrated signals from it on boot; (c) `btoa` is
   * base64 encoding, not compression — it enlarges input by ~33%. Any
   * caller that had opted in would have made the app strictly *worse*
   * (write amplification + stale per-key reads). Sibling removal: the
   * dead `compress()`/`decompress()` private helpers (~20 LOC) were
   * already deleted in Phase 5g-1 under L41 part 1; Slice 7 closes the
   * last remaining dead compression surface in this module. 5th
   * deletion-over-fix this phase (after M31, Slice 4 L53, Slice 5
   * L57/L58/L59, Slice 6 `transaction-row-template` dead-trio).
   */
  private async performBatchWrite(writes: BatchedWrite[]): Promise<void> {
    const succeededKeys = new Set<string>();

    try {
      // Write each item individually and track successes. Round 7 fix: if
      // a partial failure occurs (e.g., write 1-3 succeed, write 4 fails),
      // only re-queue the failed ones instead of all N items. Without this,
      // on every partial failure the batch retries all succeeded writes,
      // causing a write/broadcast storm that amplifies the original failure.
      for (const write of writes) {
        lsSet(write.key, write.value);
        succeededKeys.add(write.key);

        if (this.config.onWrite) {
          await this.config.onWrite(write.key, write.value);
        }
      }

      this.emitBatchComplete(writes);
    } catch (error) {
      // Round 7 fix: Track which writes succeeded before the error occurred.
      // Partition the batch: re-queue only the items that haven't been
      // written yet (those not in succeededKeys). This prevents the write
      // amplification loop where partial failures cause all succeeded writes
      // to be retried every time.
      const failedWrites = writes.filter(write => !succeededKeys.has(write.key));

      if (failedWrites.length > 0) {
        trackError(error as Error, {
          module: 'SignalBatcher',
          action: `performBatchWrite_partial_failure[${failedWrites.map(w => w.key).join(',')}]_${succeededKeys.size}ok_${failedWrites.length}fail`
        });
      }

      // Re-throw with a wrapped error so the caller knows this was a partial failure
      const err = error as Error;
      err.message = `Partial batch failure: ${succeededKeys.size}/${writes.length} succeeded`;
      throw { error: err, failedWrites };
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
          void this.flush();
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

      // rev 12 M29-beforeunload (#32): route unload-time writes through
      // `lsSet` (which wraps `safeStorage.setJSON`) instead of raw
      // `localStorage.setItem`. Raw setItem bypasses the project's
      // quota-exceeded handling and surfaces DOMExceptions during the
      // beforeunload phase where they can't be acted on. `lsSet` is still
      // synchronous (localStorage itself is synchronous — safeStorage just
      // wraps it), so unload semantics are preserved, but quota failures now
      // flow through the central error-handler path rather than being
      // swallowed by the empty `catch {}`.
      for (const write of this.pendingWrites.values()) {
        lsSet(write.key, write.value);
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
          void this.flush();
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
    // Synchronously write any pending data before clearing (flush() is async and won't complete in time).
    // rev 12 M29-beforeunload (#32): same safeStorage path as the
    // beforeunload handler — quota failures flow through the central
    // error-handler rather than being swallowed.
    for (const write of this.pendingWrites.values()) {
      lsSet(write.key, write.value);
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

/**
 * Tear down the singleton batcher and null the slot so the next caller
 * gets a fresh instance with the new config.
 *
 * Fixes L41-partial (Inline-Behavior-Review rev 12): without this, the
 * singleton's first config wins for the entire process — tests that need
 * to vary `debounceMs` or `maxBatchSize` between scenarios couldn't, and
 * the periodic flush interval kept firing across test boundaries.
 */
export function resetSignalBatcher(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

// ==========================================
// OPTIMIZED SIGNAL REGISTRATION
// ==========================================

/**
 * Register all app signals for batched persistence
 * FIXED: Updated to match current signals.ts definitions and storage keys
 */
export function registerAppSignals(signalsMap: Record<string, Signal<unknown>>): () => void {
  const batcher = getSignalBatcher({
    debounceMs: 150,
    maxBatchSize: 20,
    flushOnVisibilityChange: true
  });
  
  return batcher.registerSignals(signalsMap);
}

// Phase 5g-3 Slice 7 (Inline-Behavior-Review rev 12, M21 cascade):
// removed the entire `PERFORMANCE MONITORING` section + the
// `monitorBatchingPerformance()` export (~55 LOC). Pre-edit grep
// across js/ + tests/ + e2e/ confirmed zero callers. The function
// returned a stats aggregator whose `compressionRatio` field was
// only meaningful if the (now-deleted) compression branch in
// `performBatchWrite` had ever been activated — `totalBytes` and
// `compressedBytes` were never written by the non-compression path,
// so `compressionRatio` perpetually returned 1 for every caller.
// Phase 5a's L40 hardening (task #103) added a `destroy()` handle
// to close a `window.addEventListener` leak; that hardening kept a
// dead API marginally less leaky but no caller ever emerged. With
// M21's compression branch gone, the only reason the stats block
// existed is gone too. If batcher telemetry is ever wanted, wire a
// fresh module against `trackError`-compatible reporting with an
// explicit consumer — don't re-inherit this orphaned shape.

// ==========================================
// MIGRATION HELPER
// ==========================================

/**
 * Migrate from individual effects to batched persistence
 */
export function migrateToBatchedPersistence(
  signals: Record<string, Signal<unknown>>,
  oldDisposers: Array<() => void>
): () => void {
  // Dispose old effects
  oldDisposers.forEach(dispose => dispose());
  
  // Set up new batched persistence
  const batcher = getSignalBatcher();
  return batcher.registerSignals(signals);
}