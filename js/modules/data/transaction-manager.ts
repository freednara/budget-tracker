/**
 * Transaction Manager Module
 * Implements atomic transaction pattern with rollback capability
 * for multi-step operations that must succeed or fail as a unit
 */

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
  name?: string;
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
  private operations: Operation<any>[] = [];
  private executed: ExecutedOperation<any>[] = [];
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
    const results: any[] = [];
    
    try {
      // Execute all operations in sequence
      for (const operation of this.operations) {
        const startTime = performance.now();
        const result = await operation.execute();
        
        this.executed.push({
          operation,
          result,
          timestamp: Date.now()
        });
        
        results.push(result);
        
        // Log operation success
        if (operation.name) {
          // Transaction operation completed with timing metrics
        }
      }
      
      return {
        success: true,
        results
      };
    } catch (error) {
      if (import.meta.env.DEV) console.error('Transaction failed, initiating rollback:', error);
      
      // Rollback all executed operations
      const rollbackResult = await this.rollbackAll();
      
      return {
        success: false,
        error: error as Error,
        rolledBack: rollbackResult.success,
        results: this.executed.map(e => e.result)
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
        
        if (operation.name) {
          // Rollback operation completed
        }
      } catch (error) {
        if (import.meta.env.DEV) console.error(`Rollback failed for operation ${operation.name}:`, error);
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
  operations: Operation<any>[],
  handler: (results: any[]) => T
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