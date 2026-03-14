/**
 * Data Manager Module
 * Handles data persistence and CRUD operations for transactions
 * Implements atomic operations to prevent race conditions
 *
 * Supports both IndexedDB (primary) and localStorage (fallback) backends
 * via the storage manager abstraction layer.
 */

import { SK, lsGet, lsSet } from '../core/state.js';
import { parseAmount, generateId } from '../core/utils.js';
import { validator } from '../core/validator.js';
import { emit, Events } from '../core/event-bus.js';
import { storageManager, STORES } from './storage-manager.js';
import type {
  Transaction,
  DataHandler,
  OperationResult
} from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface SplitInput {
  category: string;
  amount: number | string;
  description?: string;
}

interface SplitResult {
  originalId: string;
  splits: Transaction[];
}

interface StorageStats {
  initialized: boolean;
  type: string;
  [key: string]: unknown;
}

// ==========================================
// DATA MANAGER CLASS
// ==========================================

/**
 * DataManager class
 * Manages transaction data operations with pluggable storage backend
 */
export class DataManager {
  private _handler: DataHandler | null = null;
  private _operationInProgress: boolean = false;
  private _pendingOperations: Array<() => Promise<unknown>> = [];
  private _useIndexedDB: boolean = false;
  private _storageInitialized: boolean = false;

  constructor() {
    // Properties initialized inline
  }

  /**
   * Execute an atomic operation with retry mechanism
   */
  private async _atomicOperation<T extends OperationResult>(
    operation: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let retries = maxRetries;

    while (retries > 0) {
      try {
        // Wait for any pending operations to complete
        while (this._operationInProgress) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }

        this._operationInProgress = true;
        const result = await operation();
        this._operationInProgress = false;

        if (result.isOk) return result;
        throw new Error(result.error || 'Operation failed');
      } catch (error) {
        this._operationInProgress = false;
        retries--;

        if (retries === 0) {
          const err = error as Error;
          console.error('Atomic operation failed after retries:', err);
          return { isOk: false, error: err.message } as T;
        }

        // Brief delay before retry
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 10));
      }
    }

    // This should never be reached, but TypeScript requires a return
    return { isOk: false, error: 'Unexpected error in atomic operation' } as T;
  }

  /**
   * Initialize the data manager with a change handler
   * Initializes storage backend (IndexedDB preferred, localStorage fallback)
   */
  async init(handler: DataHandler): Promise<OperationResult> {
    this._handler = handler;

    // Initialize storage manager (IndexedDB or localStorage)
    try {
      const storageResult = await storageManager.init();
      if (storageResult.isOk) {
        this._useIndexedDB = storageManager.isUsingIndexedDB();
        this._storageInitialized = true;
        console.log(`DataManager: Using ${storageResult.type} backend`);
      } else {
        console.warn('DataManager: Storage manager init failed, using localStorage fallback');
        this._useIndexedDB = false;
        this._storageInitialized = false;
      }
    } catch (err) {
      console.error('DataManager: Storage init error:', err);
      this._useIndexedDB = false;
      this._storageInitialized = false;
    }

    // Load initial data
    const transactions = await this._getTransactions();
    handler.onDataChanged(transactions);

    return { isOk: true };
  }

  /**
   * Get all transactions from storage
   */
  private async _getTransactions(): Promise<Transaction[]> {
    if (this._storageInitialized && this._useIndexedDB) {
      try {
        return await storageManager.getAll(STORES.TRANSACTIONS) as Transaction[];
      } catch (err) {
        console.error('DataManager: IndexedDB read failed, falling back:', err);
      }
    }
    // Fallback to localStorage
    return lsGet(SK.TX, []) as Transaction[];
  }

  /**
   * Save transactions to storage
   */
  private async _saveTransactions(transactions: Transaction[]): Promise<boolean> {
    // Always save to localStorage for backward compatibility
    const lsOk = lsSet(SK.TX, transactions);

    // If using IndexedDB, sync there too (handled by storage manager events)
    // The storage manager handles multi-tab sync via BroadcastChannel

    return lsOk;
  }

  /**
   * Create a new transaction
   */
  async create(txData: Partial<Transaction>): Promise<OperationResult<Transaction>> {
    // Use validator for comprehensive transaction validation
    const validation = validator.validateTransaction(txData);
    if (!validation.valid) {
      console.error('dataSdk.create: validation failed', validation.errors);
      return {
        isOk: false,
        error: 'Validation failed: ' + Object.values(validation.errors).join(', '),
        errors: validation.errors
      };
    }

    // Use sanitized data from validator
    const tx: Transaction = {
      ...validation.sanitized,
      __backendId: txData.__backendId || `tx_${generateId()}`
    } as Transaction;

    return this._atomicOperation(async (): Promise<OperationResult<Transaction>> => {
      // Try IndexedDB first if available
      if (this._storageInitialized && this._useIndexedDB) {
        try {
          await storageManager.set(STORES.TRANSACTIONS, tx.__backendId, tx);
          const newData = await this._getTransactions();
          this._handler?.onDataChanged(newData);
          emit(Events.TRANSACTION_ADDED, tx);
          return { isOk: true, data: tx };
        } catch (err) {
          console.error('DataManager: IndexedDB create failed, falling back:', err);
        }
      }

      // Fallback to localStorage
      const data = lsGet(SK.TX, []) as Transaction[];
      const newData = [...data, tx]; // Don't mutate original array

      const ok = lsSet(SK.TX, newData);
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      // Update state BEFORE emitting event so handlers see current data
      this._handler?.onDataChanged(newData);
      emit(Events.TRANSACTION_ADDED, tx);
      return { isOk: true, data: tx };
    });
  }

  /**
   * Create multiple transactions in batch
   */
  async createBatch(txArray: Partial<Transaction>[]): Promise<OperationResult<Transaction[]>> {
    if (!txArray.length) return { isOk: true, data: [] };

    return this._atomicOperation(async (): Promise<OperationResult<Transaction[]>> => {
      const newTransactions: Transaction[] = txArray.map(txData => ({
        ...txData,
        amount: parseAmount(txData.amount ?? 0),
        __backendId: txData.__backendId || `tx_${generateId()}`
      } as Transaction));

      // Try IndexedDB first if available
      if (this._storageInitialized && this._useIndexedDB) {
        try {
          await storageManager.createBatch(STORES.TRANSACTIONS, newTransactions);
          const newData = await this._getTransactions();
          this._handler?.onDataChanged(newData);
          if (newTransactions.length === 1) {
            emit(Events.TRANSACTION_ADDED, newTransactions[0]);
          } else {
            emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: newTransactions, count: newTransactions.length });
          }
          return { isOk: true, data: newTransactions };
        } catch (err) {
          console.error('DataManager: IndexedDB createBatch failed, falling back:', err);
        }
      }

      // Fallback to localStorage
      const data = lsGet(SK.TX, []) as Transaction[];
      const newData = [...data, ...newTransactions]; // Don't mutate original array

      const ok = lsSet(SK.TX, newData);
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      // Update state BEFORE emitting events so handlers see current data
      this._handler?.onDataChanged(newData);
      // Emit single batch event for all transactions (performance optimization)
      if (newTransactions.length === 1) {
        emit(Events.TRANSACTION_ADDED, newTransactions[0]);
      } else {
        emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: newTransactions, count: newTransactions.length });
      }
      return { isOk: true, data: newTransactions };
    });
  }

  /**
   * Update an existing transaction
   */
  async update(tx: Transaction): Promise<OperationResult> {
    if (!tx.__backendId) {
      console.error('dataSdk.update: missing __backendId');
      return { isOk: false, error: 'Missing __backendId' };
    }

    const updatedTx: Transaction = { ...tx, amount: parseAmount(tx.amount) };

    return this._atomicOperation(async (): Promise<OperationResult> => {
      // Try IndexedDB first if available
      if (this._storageInitialized && this._useIndexedDB) {
        try {
          // Check if transaction exists
          const existing = await storageManager.get(STORES.TRANSACTIONS, tx.__backendId);
          if (!existing) {
            return { isOk: false, error: 'Transaction not found' };
          }

          await storageManager.set(STORES.TRANSACTIONS, tx.__backendId, updatedTx);
          const newData = await this._getTransactions();
          this._handler?.onDataChanged(newData);
          emit(Events.TRANSACTION_UPDATED, updatedTx);
          return { isOk: true };
        } catch (err) {
          console.error('DataManager: IndexedDB update failed, falling back:', err);
        }
      }

      // Fallback to localStorage
      const data = lsGet(SK.TX, []) as Transaction[];
      const idx = data.findIndex(t => t.__backendId === tx.__backendId);

      if (idx >= 0) {
        const newData = [...data]; // Don't mutate original array
        newData[idx] = updatedTx;

        const ok = lsSet(SK.TX, newData);
        if (!ok) return { isOk: false, error: 'Storage write failed' };

        // Update state BEFORE emitting event so handlers see current data
        this._handler?.onDataChanged(newData);
        emit(Events.TRANSACTION_UPDATED, updatedTx);
        return { isOk: true };
      }

      return { isOk: false, error: 'Transaction not found' };
    });
  }

  /**
   * Delete a transaction
   */
  async delete(tx: Transaction): Promise<OperationResult> {
    return this._atomicOperation(async (): Promise<OperationResult> => {
      // Try IndexedDB first if available
      if (this._storageInitialized && this._useIndexedDB) {
        try {
          await storageManager.delete(STORES.TRANSACTIONS, tx.__backendId);
          const newData = await this._getTransactions();
          this._handler?.onDataChanged(newData);
          emit(Events.TRANSACTION_DELETED, tx);
          return { isOk: true };
        } catch (err) {
          console.error('DataManager: IndexedDB delete failed, falling back:', err);
        }
      }

      // Fallback to localStorage
      const data = lsGet(SK.TX, []) as Transaction[];
      const newData = data.filter(t => t.__backendId !== tx.__backendId);

      const ok = lsSet(SK.TX, newData);
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      // Update state BEFORE emitting event so handlers see current data
      this._handler?.onDataChanged(newData);
      emit(Events.TRANSACTION_DELETED, tx);
      return { isOk: true };
    });
  }

  /**
   * Split a transaction into multiple parts atomically
   * This operation either succeeds completely or fails completely,
   * preventing partial failures that could corrupt the ledger.
   */
  async splitTransaction(
    originalTx: Transaction,
    splits: SplitInput[]
  ): Promise<OperationResult<SplitResult>> {
    if (!originalTx.__backendId) {
      return { isOk: false, error: 'Missing original transaction ID' };
    }

    if (!Array.isArray(splits) || splits.length === 0) {
      return { isOk: false, error: 'No valid splits provided' };
    }

    // Validate split amounts sum to original (within rounding tolerance)
    const splitTotal = splits.reduce((sum, s) => sum + parseAmount(s.amount), 0);
    const origAmount = parseAmount(originalTx.amount);
    const tolerance = 0.01; // Allow 1 cent tolerance for rounding

    if (Math.abs(splitTotal - origAmount) > tolerance) {
      return {
        isOk: false,
        error: `Split total (${splitTotal.toFixed(2)}) does not match original (${origAmount.toFixed(2)})`
      };
    }

    // Create all split transactions
    const newSplits: Transaction[] = splits.map(split => ({
      type: originalTx.type,
      category: split.category,
      amount: parseAmount(split.amount),
      description: split.description || `Split: ${originalTx.description || ''}`,
      date: originalTx.date,
      tags: originalTx.tags,
      notes: `Split from ${originalTx.__backendId}`,
      currency: originalTx.currency || '',
      recurring: false,
      recurring_type: undefined,
      recurring_end: undefined,
      reconciled: true,
      splits: true,
      __backendId: `tx_${generateId()}`
    }));

    return this._atomicOperation(async (): Promise<OperationResult<SplitResult>> => {
      // Try IndexedDB first if available
      if (this._storageInitialized && this._useIndexedDB) {
        try {
          // Verify original exists
          const existing = await storageManager.get(STORES.TRANSACTIONS, originalTx.__backendId);
          if (!existing) {
            return { isOk: false, error: 'Original transaction not found' };
          }

          // Delete original and create splits
          await storageManager.delete(STORES.TRANSACTIONS, originalTx.__backendId);
          await storageManager.createBatch(STORES.TRANSACTIONS, newSplits);

          const newData = await this._getTransactions();
          this._handler?.onDataChanged(newData);
          emit(Events.TRANSACTION_DELETED, originalTx);
          emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: newSplits, count: newSplits.length });

          return {
            isOk: true,
            data: { originalId: originalTx.__backendId, splits: newSplits }
          };
        } catch (err) {
          console.error('DataManager: IndexedDB split failed, falling back:', err);
        }
      }

      // Fallback to localStorage
      const data = lsGet(SK.TX, []) as Transaction[];

      // Validate original transaction exists
      const origIdx = data.findIndex(t => t.__backendId === originalTx.__backendId);
      if (origIdx < 0) {
        return { isOk: false, error: 'Original transaction not found' };
      }

      // Perform the atomic swap: remove original, add all splits in one write
      const newData = [
        ...data.slice(0, origIdx),      // Keep data before original
        ...newSplits,                    // Add split transactions
        ...data.slice(origIdx + 1)       // Keep data after original
      ];

      // Write all changes atomically
      const ok = lsSet(SK.TX, newData);
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      // Update state BEFORE emitting events
      this._handler?.onDataChanged(newData);

      // Emit events after successful write
      emit(Events.TRANSACTION_DELETED, originalTx);
      // Emit single batch event for all split transactions (performance optimization)
      emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: newSplits, count: newSplits.length });

      return {
        isOk: true,
        data: {
          originalId: originalTx.__backendId,
          splits: newSplits
        }
      };
    });
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<StorageStats> {
    if (this._storageInitialized) {
      return await storageManager.getStats() as StorageStats;
    }
    return { initialized: false, type: 'localstorage' };
  }

  /**
   * Check if using IndexedDB
   */
  isUsingIndexedDB(): boolean {
    return this._useIndexedDB;
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

/**
 * Default data manager instance
 * This is the primary interface for transaction CRUD operations
 */
export const dataSdk = new DataManager();
