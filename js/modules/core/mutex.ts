/**
 * Async Mutex for coordinating concurrent operations
 * Replaces busy-wait pattern with proper queue-based locking
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Check if the mutex is currently locked
   */
  isLocked(): boolean {
    return this.locked;
  }

  async acquire(timeoutMs: number = 10000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            // Remove from queue to prevent stale resolution
            const idx = this.queue.indexOf(wrappedResolve);
            if (idx > -1) this.queue.splice(idx, 1);
            reject(new Error('Mutex acquire timeout'));
          }
        }, timeoutMs);
        const wrappedResolve = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };
        this.queue.push(wrappedResolve);
      }
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ==========================================
// CROSS-TAB MUTEX (Web Locks API)
// ==========================================

/**
 * Round 7 fix: Cross-tab mutex using the Web Locks API.
 *
 * The local `Mutex` class only serializes within a single tab — two tabs
 * can each acquire their own "lock" independently, leading to silent data
 * corruption on concurrent read-modify-write cycles. `CrossTabMutex`
 * wraps `navigator.locks.request()` to provide true cross-tab exclusion.
 * Falls back to a local `Mutex` on browsers without Web Locks support
 * (Safari < 15.4, Firefox < 96), so the same-tab serialization guarantee
 * is always preserved.
 */
export class CrossTabMutex {
  private readonly lockName: string;
  private readonly fallback: Mutex;
  private readonly timeoutMs: number;

  constructor(name: string, timeoutMs: number = 10000) {
    this.lockName = `harbor_mutex_${name}`;
    this.timeoutMs = timeoutMs;
    this.fallback = new Mutex();
  }

  /**
   * Run `fn` under an exclusive cross-tab lock.
   *
   * When the Web Locks API is available, the lock is process-wide (all
   * same-origin tabs contend on the same named resource). An
   * AbortController enforces the timeout to prevent deadlocks if a tab
   * crashes while holding a lock.
   *
   * When Web Locks are unavailable, falls back to the local Mutex which
   * at least prevents same-tab interleaving.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await navigator.locks.request(
          this.lockName,
          { mode: 'exclusive', signal: controller.signal },
          async () => fn()
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`CrossTabMutex "${this.lockName}" timed out after ${this.timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Fallback: local-only mutex (no cross-tab protection)
    return this.fallback.runExclusive(fn);
  }
}

/**
 * Semaphore for limiting concurrent operations
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    // CR-Apr24-I finding 311: guard against underflow from unbalanced
    // release calls — a negative count corrupts all subsequent acquire().
    if (this.current <= 0) {
      throw new Error('Semaphore.release: no matching acquire (count already 0)');
    }
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Read-Write Lock for optimizing read-heavy workloads
 */
export class ReadWriteLock {
  private readers = 0;
  private writeQueue: Array<() => void> = [];
  private readQueue: Array<() => void> = [];
  private writing = false;

  async acquireRead(): Promise<void> {
    return new Promise<void>(resolve => {
      if (!this.writing && this.writeQueue.length === 0) {
        this.readers++;
        resolve();
      } else {
        this.readQueue.push(resolve);
      }
    });
  }

  releaseRead(): void {
    // CR-Apr24-I finding 312: guard against underflow from unbalanced
    // releaseRead calls — negative reader count prevents writers from
    // ever draining.
    if (this.readers <= 0) {
      throw new Error('ReadWriteLock.releaseRead: no matching acquireRead (readers already 0)');
    }
    this.readers--;
    if (this.readers === 0 && this.writeQueue.length > 0) {
      const writer = this.writeQueue.shift();
      if (writer) {
        this.writing = true;
        writer();
      }
    }
  }

  async acquireWrite(): Promise<void> {
    return new Promise<void>(resolve => {
      if (!this.writing && this.readers === 0) {
        this.writing = true;
        resolve();
      } else {
        this.writeQueue.push(resolve);
      }
    });
  }

  releaseWrite(): void {
    // CR-Apr24-I finding 313: guard against releaseWrite when no write
    // lock is held — releasing a phantom write would silently drain the
    // write queue or release readers out of turn.
    if (!this.writing) {
      throw new Error('ReadWriteLock.releaseWrite: no matching acquireWrite (not writing)');
    }
    this.writing = false;
    
    // Prioritize waiting writers
    if (this.writeQueue.length > 0) {
      const writer = this.writeQueue.shift();
      if (writer) {
        this.writing = true;
        writer();
      }
    } else {
      // Release all waiting readers
      const waitingReaders = [...this.readQueue];
      this.readQueue.length = 0;
      // Increment count for each reader we're about to release
      this.readers += waitingReaders.length;
      waitingReaders.forEach(reader => reader());
    }
  }
}