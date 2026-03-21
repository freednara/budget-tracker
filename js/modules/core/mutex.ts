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