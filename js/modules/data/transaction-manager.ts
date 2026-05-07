/**
 * Transaction Manager Module
 * Implements atomic transaction pattern with rollback capability
 * for multi-step operations that must succeed or fail as a unit
 */

import { trackError } from '../core/error-tracker.js';

// ==========================================
// TYPES AND INTERFACES
// ==========================================

/**
 * Operation interface for atomic operations
 */
export interface Operation<T> {
  /**
   * Execute the operation
   */
  execute(): Promise<T>;

  /**
   * Rollback the operation if it was executed
   */
  rollback(): Promise<void>;

  /**
   * Optional operation name for debugging
   */
  // Phase 6 Slice 1j (rev 12 L6): widened for `exactOptionalPropertyTypes`
  // — `createAtomicOperation(execute, rollback, name?)` forwards the
  // optional `name` parameter straight into the payload.
  name?: string | undefined;
}

/**
 * Result of a transaction execution
 */
export interface TransactionResult<T = unknown> {
  success: boolean;
  results?: T[];
  error?: Error;
  rolledBack?: boolean;
}

/**
 * Operation execution record
 */
interface ExecutedOperation<T> {
  operation: Operation<T>;
  result: T;
  timestamp: number;
}

// ==========================================
// TRANSACTION MANAGER CLASS
// ==========================================

/**
 * Manages atomic transactions with rollback capability
 */
export class TransactionManager {
  // Phase 6 cleanup (no-explicit-any sweep): the operations queue is
  // heterogeneous — each entry is an `Operation<T>` for a different T.
  // `Operation<unknown>` works as the storage shape because T appears
  // only in covariant position (`execute(): Promise<T>`), so any
  // `Operation<T>` is assignable to `Operation<unknown>`.
  private operations: Operation<unknown>[] = [];
  private executed: ExecutedOperation<unknown>[] = [];
  private committed = false;
  
  /**
   * Add an operation to the transaction
   */
  add<T>(operation: Operation<T>): this {
    if (this.committed) {
      throw new Error('Cannot add operations to a committed transaction');
    }
    this.operations.push(operation);
    return this;
  }
  
  /**
   * Commit all operations atomically
   * If any operation fails, all successful operations are rolled back
   */
  async commit(): Promise<TransactionResult> {
    if (this.committed) {
      throw new Error('Transaction already committed');
    }
    
    this.committed = true;
    const results: unknown[] = [];
    
    try {
      // Execute all operations in sequence.
      //
      // Phase 5g-1 (Inline-Behavior-Review rev 12, L48 part 1): removed
      // an unused `const startTime = performance.now();` local and its
      // paired empty `if (operation.name) { /* timing metrics */ }`
      // block. The per-op timing telemetry was never wired up — if
      // instrumentation gets added back, reintroduce both deliberately.
      for (const operation of this.operations) {
        const result = await operation.execute();

        this.executed.push({
          operation,
          result,
          timestamp: Date.now()
        });

        results.push(result);
      }
      
      return {
        success: true,
        results
      };
    } catch (error) {
      // rev 12 L48-partial (#32 observability): transaction failure and
      // subsequent rollback were DEV-only-logged; surface via trackError so
      // prod partial-failure isn't silent.
      trackError(error instanceof Error ? error : new Error(String(error)), {
        module: 'TransactionManager',
        action: 'commit_failed_initiating_rollback',
      });

      // Snapshot already-executed results BEFORE rollback — rollbackAll()
      // clears `this.executed` on exit, so the current post-rollback
      // `this.executed.map(e => e.result)` always returned []. Capturing
      // here preserves observability into what succeeded pre-failure.
      const executedResults = this.executed.map(e => e.result);

      // Rollback all executed operations
      const rollbackResult = await this.rollbackAll();

      return {
        success: false,
        error: error as Error,
        rolledBack: rollbackResult.success,
        results: executedResults
      };
    }
  }
  
  /**
   * Rollback all executed operations in reverse order
   */
  private async rollbackAll(): Promise<{ success: boolean; errors: Error[] }> {
    const errors: Error[] = [];
    
    // Rollback in reverse order (LIFO)
    const toRollback = [...this.executed].reverse();
    
    for (const { operation } of toRollback) {
      try {
        await operation.rollback();
        // Phase 5g-1 (Inline-Behavior-Review rev 12, L48 part 1): removed
        // the symmetric `if (operation.name) { /* rollback success log */ }`
        // empty-body block. Rollback *failures* are already surfaced via
        // the trackError() call below — success path never needed a log.
      } catch (error) {
        // rev 12 L48-partial (#32 observability): individual rollback
        // failures previously DEV-only-logged then disappeared into the
        // local `errors[]` (which the caller never sees — TransactionResult
        // exposes only `rolledBack: boolean`). Route through trackError so
        // every rollback failure is surfaced in prod telemetry.
        trackError(error instanceof Error ? error : new Error(String(error)), {
          module: 'TransactionManager',
          action: `rollback_failed_${operation.name ?? 'unnamed'}`,
        });
        errors.push(error as Error);
      }
    }
    
    // Clear executed operations after rollback
    this.executed = [];
    
    return {
      success: errors.length === 0,
      errors
    };
  }
  
  /**
   * Get the number of operations in the transaction
   */
  get size(): number {
    return this.operations.length;
  }
  
  /**
   * Check if transaction has been committed
   */
  get isCommitted(): boolean {
    return this.committed;
  }
}

// ==========================================
// COMMON OPERATION IMPLEMENTATIONS
// ==========================================

/**
 * Generic create operation with rollback
 */
export class CreateOperation<T extends { id?: string }> implements Operation<T> {
  name = 'Create';
  private createdItem?: T;
  
  constructor(
    private createFn: () => Promise<T>,
    private deleteFn: (id: string) => Promise<void>
  ) {}
  
  async execute(): Promise<T> {
    this.createdItem = await this.createFn();
    return this.createdItem;
  }
  
  async rollback(): Promise<void> {
    if (this.createdItem?.id) {
      await this.deleteFn(this.createdItem.id);
    }
  }
}

/**
 * Generic update operation with rollback
 */
export class UpdateOperation<T> implements Operation<T> {
  name = 'Update';
  private previousState?: T;
  
  constructor(
    private id: string,
    private getFn: (id: string) => Promise<T>,
    private updateFn: (id: string, data: T) => Promise<T>,
    private newData: Partial<T>
  ) {}
  
  async execute(): Promise<T> {
    // Save current state for rollback
    this.previousState = await this.getFn(this.id);
    // Apply update
    return await this.updateFn(this.id, { ...this.previousState, ...this.newData });
  }
  
  async rollback(): Promise<void> {
    if (this.previousState) {
      await this.updateFn(this.id, this.previousState);
    }
  }
}

/**
 * Generic delete operation with rollback
 */
export class DeleteOperation<T> implements Operation<void> {
  name = 'Delete';
  private deletedItem?: T;
  
  constructor(
    private id: string,
    private getFn: (id: string) => Promise<T>,
    private deleteFn: (id: string) => Promise<void>,
    private restoreFn: (item: T) => Promise<void>
  ) {}
  
  async execute(): Promise<void> {
    // Save item before deletion
    this.deletedItem = await this.getFn(this.id);
    await this.deleteFn(this.id);
  }
  
  async rollback(): Promise<void> {
    if (this.deletedItem) {
      await this.restoreFn(this.deletedItem);
    }
  }
}

/**
 * Batch operation that groups multiple operations
 */
export class BatchOperation<T> implements Operation<T[]> {
  name = 'Batch';
  private results: T[] = [];
  
  constructor(
    private operations: Operation<T>[]
  ) {}
  
  async execute(): Promise<T[]> {
    for (const op of this.operations) {
      const result = await op.execute();
      this.results.push(result);
    }
    return this.results;
  }
  
  async rollback(): Promise<void> {
    // Only rollback operations that were actually executed (have results)
    const executedOps = this.operations.slice(0, this.results.length);
    for (const op of [...executedOps].reverse()) {
      await op.rollback();
    }
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Create a simple operation from async functions
 */
export function createOperation<T>(
  executeFn: () => Promise<T>,
  rollbackFn: () => Promise<void>,
  name?: string
): Operation<T> {
  return {
    execute: executeFn,
    rollback: rollbackFn,
    name
  };
}

/**
 * Create a no-op operation (useful for testing)
 */
export function noOpOperation<T>(value: T): Operation<T> {
  return {
    execute: async () => value,
    rollback: async () => {},
    name: 'NoOp'
  };
}

/**
 * Execute operations with automatic rollback on failure
 */
export async function withTransaction<T>(
  operations: Operation<unknown>[],
  handler: (results: unknown[]) => T
): Promise<T> {
  const transaction = new TransactionManager();
  
  for (const op of operations) {
    transaction.add(op);
  }
  
  const result = await transaction.commit();
  
  if (!result.success) {
    throw result.error;
  }
  
  return handler(result.results!);
}