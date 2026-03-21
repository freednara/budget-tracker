/**
 * Transaction Operations Module
 * Concrete operation implementations for the transaction manager
 * Used by DataManager for atomic multi-step operations
 */

import type { Transaction, OperationResult } from '../../types/index.js';
import type { Operation } from './transaction-manager.js';
import { DataManager } from './data-manager.js';
import { emit, Events } from '../core/event-bus.js';
import { toCents, toDollars } from '../core/utils.js';

// ==========================================
// TRANSACTION OPERATIONS
// ==========================================

/**
 * Operation to create a transaction with automatic rollback
 */
export class CreateTransactionOperation implements Operation<Transaction> {
  name = 'CreateTransaction';
  private createdTransaction?: Transaction;
  
  constructor(
    private dataManager: DataManager,
    private transactionData: Partial<Transaction>
  ) {}
  
  async execute(): Promise<Transaction> {
    const result = await this.dataManager.create(this.transactionData);
    if (!result.isOk || !result.data) {
      throw new Error(result.error || 'Failed to create transaction');
    }
    this.createdTransaction = result.data;
    return this.createdTransaction;
  }
  
  async rollback(): Promise<void> {
    if (this.createdTransaction) {
      await this.dataManager.delete(this.createdTransaction);
      // Emit rollback event for UI updates
      emit(Events.TRANSACTION_DELETED, this.createdTransaction);
    }
  }
}

/**
 * Operation to update a transaction with automatic rollback
 */
export class UpdateTransactionOperation implements Operation<Transaction> {
  name = 'UpdateTransaction';
  private originalTransaction?: Transaction;
  private updatedTransaction?: Transaction;
  
  constructor(
    private dataManager: DataManager,
    private transactionId: string,
    private updates: Partial<Transaction>
  ) {}
  
  async execute(): Promise<Transaction> {
    // Get original state for rollback using optimized lookup
    this.originalTransaction = await this.dataManager.get(this.transactionId);
    
    if (!this.originalTransaction) {
      throw new Error(`Transaction ${this.transactionId} not found`);
    }
    
    const result = await this.dataManager.update({
      ...this.originalTransaction,
      ...this.updates
    });
    
    if (!result.isOk || !result.data) {
      throw new Error(result.error || 'Failed to update transaction');
    }
    
    this.updatedTransaction = result.data;
    return this.updatedTransaction;
  }
  
  async rollback(): Promise<void> {
    if (this.originalTransaction) {
      // dataManager.update() already emits TRANSACTION_UPDATED — don't emit twice
      await this.dataManager.update(this.originalTransaction);
    }
  }
}

/**
 * Operation to delete a transaction with automatic restore
 */
export class DeleteTransactionOperation implements Operation<void> {
  name = 'DeleteTransaction';
  private deletedTransaction?: Transaction;
  
  constructor(
    private dataManager: DataManager,
    private transactionId: string
  ) {}
  
  async execute(): Promise<void> {
    // Save transaction before deletion using optimized lookup
    this.deletedTransaction = await this.dataManager.get(this.transactionId);
    
    if (!this.deletedTransaction) {
      throw new Error(`Transaction ${this.transactionId} not found`);
    }
    
    const result = await this.dataManager.delete(this.deletedTransaction);
    if (!result.isOk) {
      throw new Error(result.error || 'Failed to delete transaction');
    }
  }
  
  async rollback(): Promise<void> {
    if (this.deletedTransaction) {
      // Restore the deleted transaction — dataManager.create() already emits TRANSACTION_ADDED
      await this.dataManager.create(this.deletedTransaction);
    }
  }
}

// ==========================================
// BULK OPERATIONS
// ==========================================

/**
 * Operation to bulk create transactions
 */
export class BulkCreateTransactionsOperation implements Operation<Transaction[]> {
  name = 'BulkCreateTransactions';
  private createdTransactions: Transaction[] = [];
  
  constructor(
    private dataManager: DataManager,
    private transactions: Partial<Transaction>[]
  ) {}
  
  async execute(): Promise<Transaction[]> {
    const result = await this.dataManager.createBatch(this.transactions);
    if (!result.isOk || !result.data) {
      throw new Error(`Bulk create failed: ${result.error}`);
    }
    this.createdTransactions = result.data;
    return this.createdTransactions;
  }
  
  async rollback(): Promise<void> {
    // Delete all created transactions in reverse order
    for (const tx of [...this.createdTransactions].reverse()) {
      if (tx.__backendId) {
        await this.dataManager.delete(tx);
      }
    }
    
    // Emit batch rollback event using consistent naming
    if (this.createdTransactions.length > 0) {
      emit(Events.TRANSACTION_ROLLBACK_BATCH, this.createdTransactions);
    }
  }
}

/**
 * Operation to bulk update transactions
 */
export class BulkUpdateTransactionsOperation implements Operation<Transaction[]> {
  name = 'BulkUpdateTransactions';
  private originalTransactions: Map<string, Transaction> = new Map();
  private updatedTransactions: Transaction[] = [];
  
  constructor(
    private dataManager: DataManager,
    private updates: Array<{ id: string; changes: Partial<Transaction> }>
  ) {}
  
  async execute(): Promise<Transaction[]> {
    // Get all current transactions once for rollback lookup (avoids repeated getAll calls)
    const allTransactions = await this.dataManager.getAll();
    const txMap = new Map(allTransactions.map(t => [t.__backendId, t]));

    // Collect all updates first, then apply them in batch to reduce I/O round-trips
    const pendingUpdates: Transaction[] = [];

    for (const { id, changes } of this.updates) {
      const original = txMap.get(id);
      if (!original) {
        throw new Error(`Transaction ${id} not found`);
      }

      this.originalTransactions.set(id, original);
      pendingUpdates.push({ ...original, ...changes });
    }

    // Apply updates sequentially (dataManager.update persists + emits events per call)
    // TODO: Add a DataManager.updateBatch() method for true batched persistence
    for (const updated of pendingUpdates) {
      const result = await this.dataManager.update(updated);

      if (!result.isOk || !result.data) {
        throw new Error(`Failed to update transaction ${updated.__backendId}: ${result.error}`);
      }

      this.updatedTransactions.push(result.data);
    }

    return this.updatedTransactions;
  }
  
  async rollback(): Promise<void> {
    // Restore all original transactions
    for (const [id, original] of this.originalTransactions) {
      await this.dataManager.update(original);
    }
  }
}

// Note: Split and merge operations use DataManager.splitTransaction() directly
// for atomic swap semantics. See data-manager.ts.