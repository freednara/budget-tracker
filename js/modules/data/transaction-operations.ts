/**
 * Transaction Operations Module
 * Concrete operation implementations for the transaction manager
 * Used by DataManager for atomic multi-step operations
 */

import type { Transaction } from '../../types/index.js';
import type { Operation } from './transaction-manager.js';
import { DataManager } from './data-manager.js';
import { emit, Events } from '../core/event-bus.js';

// ==========================================
// TRANSACTION OPERATIONS
// ==========================================

/**
 * Operation to create a transaction with automatic rollback
 */
export class CreateTransactionOperation implements Operation<Transaction> {
  name = 'CreateTransaction';
  private createdTransaction?: Transaction;
  // New-batch P2: track whether the create was a real persistence vs an
  // idempotent hit. A hit means the row pre-dated this operation, so
  // rolling back by deletion would destroy data we didn't create.
  private wasFreshlyCreated = false;

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
    // `alreadyExisted === true` ⇒ the row was already in the store when
    // `dataManager.create()` ran and the call was a no-op. Leave
    // `wasFreshlyCreated` false so `rollback()` is a no-op as well.
    this.wasFreshlyCreated = result.alreadyExisted !== true;
    return this.createdTransaction;
  }

  async rollback(): Promise<void> {
    // New-batch P2: skip rollback when the row was not freshly persisted
    // by this operation. Previously `rollback()` always deleted the row
    // whose `__backendId` matched, which silently destroyed pre-existing
    // data on any outer-transaction abort.
    if (this.createdTransaction && this.wasFreshlyCreated) {
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
  // Phase 6 Slice 1j (rev 12 L6): widened for `exactOptionalPropertyTypes`
  // — `dataManager.get()` returns `Transaction | undefined`.
  private originalTransaction?: Transaction | undefined;
  private updatedTransaction?: Transaction | undefined;
  
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
  // Phase 6 Slice 1j (rev 12 L6): widened for `exactOptionalPropertyTypes`
  // — `dataManager.get()` returns `Transaction | undefined`.
  private deletedTransaction?: Transaction | undefined;
  
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
    // New-batch P2: `result.data` now reflects only the rows actually
    // persisted by this call (drafts whose `__backendId` were not
    // already present). Track that subset so `rollback()` never deletes
    // a pre-existing row that was merely conflated by the idempotency
    // guard. Previously `result.data` was the full drafted array and
    // rollback happily deleted unrelated user data.
    this.createdTransactions = result.data;
    return this.createdTransactions;
  }

  async rollback(): Promise<void> {
    // Delete only the transactions actually created by this operation.
    // `createdTransactions` is already scoped to the persisted subset
    // by `execute()` above.
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
    for (const [, original] of this.originalTransactions) {
      await this.dataManager.update(original);
    }
  }
}

// Note: Split and merge operations use DataManager.splitTransaction() directly
// for atomic swap semantics. See data-manager.ts.