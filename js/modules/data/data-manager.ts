/**
 * Data Manager Module
 * Handles data persistence and CRUD operations for transactions
 * Implements atomic operations to prevent race conditions
 *
 * Supports both IndexedDB (primary) and localStorage (fallback) backends
 * via the storage manager abstraction layer.
 */

import { SK, lsGet, lsSet } from '../core/state.js';
import { parseAmount, generateSecureId } from '../core/utils.js';
import { validator } from '../core/validator.js';
import { emit, Events, on } from '../core/event-bus.js';
import { storageManager, STORES } from './storage-manager.js';
import { Mutex } from '../core/mutex.js';
import { DataSyncEvents, notifyDataSyncComplete, notifyDataSyncError } from '../core/data-sync-interface.js';
import stateRevision from '../core/state-revision.js';
import { getTabId } from '../core/tab-id.js';
import { broadcastManager } from '../core/multi-tab-sync-broadcast.js';
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
  private _operationMutex: Mutex = new Mutex();
  private _pendingOperations: Array<() => Promise<unknown>> = [];
  private _useIndexedDB: boolean = false;
  private _storageInitialized: boolean = false;
  private _idbWriteFailed: boolean = false;
  private _eventUnsubscribers: Array<() => void> = [];

  constructor() {
    // Properties initialized inline
  }

  /**
   * Execute an atomic operation with retry mechanism using mutex
   */
  private async _atomicOperation<T extends OperationResult>(
    operation: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    if (!this._handler) {
      return { isOk: false, error: 'DataManager not initialized. Call init() first.' } as T;
    }
    return this._operationMutex.runExclusive(async () => {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await operation();
          if (result.isOk) return result;
          // Only retry storage write failures (transient); return immediately for
          // deterministic failures like "not found" or "validation failed"
          if (result.error === 'Storage write failed') {
            throw new Error(result.error);
          }
          return result;
        } catch (error) {
          lastError = error as Error;
          if (attempt < maxRetries - 1) {
            // Exponential backoff: 100ms, 200ms, 400ms
            await new Promise(resolve =>
              setTimeout(resolve, Math.pow(2, attempt) * 100)
            );
          }
        }
      }

      if (import.meta.env.DEV) console.error('Atomic operation failed after retries:', lastError);
      return {
        isOk: false,
        error: lastError?.message || 'Operation failed after retries'
      } as T;
    });
  }

  /**
   * Initialize the data manager with a change handler
   * Initializes storage backend (IndexedDB preferred, localStorage fallback)
   */
  async init(handler: DataHandler): Promise<OperationResult> {
    this._handler = handler;

    // Clean up previous event listeners to prevent duplicates on re-init
    this._eventUnsubscribers.forEach(unsub => unsub());
    this._eventUnsubscribers = [];

    // Set up event listeners for data sync
    this._eventUnsubscribers.push(
      on(DataSyncEvents.REQUEST_RELOAD, async ({ source }: { source: string }) => {
        const transactions = await this.getAll();
        emit(DataSyncEvents.TRANSACTION_UPDATED, { transactions });
      })
    );

    this._eventUnsubscribers.push(
      on(DataSyncEvents.REQUEST_SYNC, async ({ changes, source }: { changes: Transaction[], source: string }) => {
        try {
          await this.syncFromStorage(changes);
          notifyDataSyncComplete({ success: true });
        } catch (error) {
          notifyDataSyncError(error as Error);
        }
      })
    );

    // Initialize storage manager (IndexedDB or localStorage)
    try {
      const storageResult = await storageManager.init();
      if (storageResult.isOk) {
        this._useIndexedDB = storageManager.isUsingIndexedDB();
        this._storageInitialized = true;
        // DataManager initialized with selected storage backend
      } else {
        if (import.meta.env.DEV) console.warn('DataManager: Storage manager init failed, using localStorage fallback');
        this._useIndexedDB = false;
        this._storageInitialized = false;
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('DataManager: Storage init error:', err);
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
  async getAll(): Promise<Transaction[]> {
    return this._getTransactions();
  }

  /**
   * Get a single transaction by its backend ID
   * Optimized for IndexedDB lookups
   */
  async get(id: string): Promise<Transaction | undefined> {
    if (!id) return undefined;

    // Try IndexedDB first if available
    if (this._storageInitialized && this._useIndexedDB) {
      try {
        const tx = await storageManager.get(STORES.TRANSACTIONS, id);
        return tx as Transaction | undefined;
      } catch (err) {
        if (import.meta.env.DEV) console.error(`DataManager: IndexedDB get failed for ${id}:`, err);
      }
    }

    // Fallback to localStorage scan
    const transactions = await this._getTransactions();
    return transactions.find(t => t.__backendId === id);
  }

  /**
   * Sync transactions from external storage update
   * Used by multi-tab synchronization
   */
  syncFromStorage(transactions: Transaction[]): void {
    // Update internal state without triggering storage write
    // since the data is already in storage from another tab
    if (this._handler) {
      this._handler.onDataChanged(transactions);
    }
  }

  /**
   * Internal helper to persist transactions to all active backends
   * OPTIMIZED: Uses incremental updates for IndexedDB instead of clearing and re-writing everything
   */
  private async _persist(
    transactions: Transaction[],
    change?: { 
      type: 'add' | 'update' | 'delete' | 'batch-add' | 'batch-delete' | 'split',
      item?: Transaction,
      items?: Transaction[],
      id?: string,
      ids?: string[]
    }
  ): Promise<boolean> {
    let lsOk = false;
    let idbOk = false;
    let idbAttempted = false;

    // When IndexedDB is active and healthy, skip the expensive synchronous localStorage write
    // (JSON.stringify of 5000+ transactions takes 10-50ms). localStorage is only needed as fallback.
    const skipLsWrite = this._storageInitialized && this._useIndexedDB && !this._idbWriteFailed;

    // 1. Write to localStorage only when IDB is unavailable or has failed
    if (!skipLsWrite) {
      lsOk = lsSet(SK.TX, transactions);
    }

    // 2. Update IndexedDB if initialized
    if (this._storageInitialized && this._useIndexedDB) {
      idbAttempted = true;
      try {
        if (change) {
          // Perform incremental update
          switch (change.type) {
            case 'add':
              if (change.item) await storageManager.set(STORES.TRANSACTIONS, change.item.__backendId, change.item);
              break;
            case 'update':
              if (change.item) await storageManager.set(STORES.TRANSACTIONS, change.item.__backendId, change.item);
              break;
            case 'delete':
              if (change.id) await storageManager.delete(STORES.TRANSACTIONS, change.id);
              break;
            case 'batch-add':
              if (change.items) await storageManager.updateBatch(STORES.TRANSACTIONS, change.items);
              break;
            case 'batch-delete':
              if (change.ids) await storageManager.deleteBatch(STORES.TRANSACTIONS, change.ids);
              break;
            case 'split':
              if (change.id && change.items) {
                // Create splits first, then delete original. If creation fails,
                // the original transaction is preserved (no data loss).
                await storageManager.updateBatch(STORES.TRANSACTIONS, change.items);
                await storageManager.delete(STORES.TRANSACTIONS, change.id);
              }
              break;
            default:
              await storageManager.importAll({ [STORES.TRANSACTIONS]: transactions }, true);
          }
        } else {
          // Fallback to full overwrite
          await storageManager.importAll({ [STORES.TRANSACTIONS]: transactions }, true);
        }
        
        idbOk = true;
        this._idbWriteFailed = false;
      } catch (err) {
        if (import.meta.env.DEV) console.error('DataManager: IndexedDB persistence failed:', err);
        this._idbWriteFailed = true;
        // IDB failed — write to localStorage as fallback
        if (!lsOk) lsOk = lsSet(SK.TX, transactions);
      }
    }

    // At least one active backend must succeed
    const anyBackendOk = lsOk || (idbAttempted && idbOk);

    // 3. Update in-memory state if at least one backend succeeded
    if (anyBackendOk && this._handler) {
      this._handler.onDataChanged(transactions);
    }

    if (anyBackendOk) {
      try {
        await stateRevision.recordStateChange(SK.TX, transactions, getTabId());
        broadcastManager.sendStateUpdate(SK.TX, transactions);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('DataManager: failed to broadcast transaction sync update:', error);
        }
      }
    }

    return anyBackendOk;
  }

  /**
   * Get all transactions from storage (private implementation)
   */
  private async _getTransactions(): Promise<Transaction[]> {
    // If the last IDB write failed, read from localStorage (which has the latest data)
    // to prevent returning stale IDB data
    if (this._storageInitialized && this._useIndexedDB && !this._idbWriteFailed) {
      try {
        return await storageManager.getAll(STORES.TRANSACTIONS) as Transaction[];
      } catch (err) {
        if (import.meta.env.DEV) console.error('DataManager: IndexedDB read failed, falling back:', err);
      }
    }
    // Fallback to localStorage
    return lsGet(SK.TX, []) as Transaction[];
  }

  /**
   * Create a new transaction
   */
  async create(txData: Partial<Transaction>): Promise<OperationResult<Transaction>> {
    // Use validator for comprehensive transaction validation
    const validation = validator.validateTransaction(txData);
    if (!validation.valid) {
      if (import.meta.env.DEV) console.error('dataSdk.create: validation failed', validation.errors);
      return {
        isOk: false,
        error: 'Validation failed: ' + Object.values(validation.errors).join(', '),
        errors: validation.errors
      };
    }

    // Use sanitized data from validator
    const tx: Transaction = {
      ...validation.sanitized,
      __backendId: txData.__backendId || `tx_${generateSecureId()}`
    } as Transaction;

    return this._atomicOperation(async (): Promise<OperationResult<Transaction>> => {
      const data = await this._getTransactions();
      // Idempotency guard: skip if already persisted (e.g. from a partial retry)
      if (data.some(t => t.__backendId === tx.__backendId)) {
        return { isOk: true, data: tx };
      }
      const newData = [...data, tx];

      const ok = await this._persist(newData, { type: 'add', item: tx });
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      emit(Events.TRANSACTION_ADDED, tx);
      return { isOk: true, data: tx };
    });
  }

  /**
   * Create multiple transactions in batch
   */
  async createBatch(txArray: Partial<Transaction>[]): Promise<OperationResult<Transaction[]>> {
    if (!txArray.length) return { isOk: true, data: [] };

    // Validate all transactions before persisting
    const validationErrors: string[] = [];
    for (let i = 0; i < txArray.length; i++) {
      const validation = validator.validateTransaction(txArray[i]);
      if (!validation.valid) {
        validationErrors.push(`Item ${i}: ${Object.values(validation.errors).join(', ')}`);
      } else {
        txArray[i] = validation.sanitized;
      }
    }
    if (validationErrors.length > 0) {
      return { isOk: false, error: `Batch validation failed: ${validationErrors.slice(0, 3).join('; ')}` };
    }

    return this._atomicOperation(async (): Promise<OperationResult<Transaction[]>> => {
      const newTransactions: Transaction[] = txArray.map(txData => ({
        ...txData,
        amount: parseAmount(txData.amount ?? 0),
        __backendId: txData.__backendId || `tx_${generateSecureId()}`
      } as Transaction));

      const data = await this._getTransactions();
      // Idempotency guard: filter out any items already persisted from a partial retry
      const existingIds = new Set(data.map(t => t.__backendId));
      const toAdd = newTransactions.filter(t => !existingIds.has(t.__backendId));
      if (toAdd.length === 0) {
        return { isOk: true, data: newTransactions };
      }
      const newData = [...data, ...toAdd];

      const ok = await this._persist(newData, { type: 'batch-add', items: toAdd });
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      // Emit event only for actually-added transactions
      if (toAdd.length === 1) {
        emit(Events.TRANSACTION_ADDED, toAdd[0]);
      } else if (toAdd.length > 1) {
        emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: toAdd, count: toAdd.length });
      }
      return { isOk: true, data: newTransactions };
    });
  }

  /**
   * Update an existing transaction
   */
  async update(tx: Transaction): Promise<OperationResult<Transaction>> {
    if (!tx.__backendId) {
      if (import.meta.env.DEV) console.error('dataSdk.update: missing __backendId');
      return { isOk: false, error: 'Missing __backendId' };
    }

    const updatedTx: Transaction = { ...tx, amount: parseAmount(tx.amount) };

    return this._atomicOperation(async (): Promise<OperationResult<Transaction>> => {
      // OPTIMIZATION OPPORTUNITY: _getTransactions() loads ALL transactions from storage.
      // For single-item update, an indexed IDB put() would avoid the full read + linear scan.
      const data = await this._getTransactions();
      const idx = data.findIndex(t => t.__backendId === tx.__backendId);

      if (idx >= 0) {
        const newData = [...data];
        newData[idx] = updatedTx;

        const ok = await this._persist(newData, { type: 'update', item: updatedTx });
        if (!ok) return { isOk: false, error: 'Storage write failed' };

        emit(Events.TRANSACTION_UPDATED, updatedTx);
        return { isOk: true, data: updatedTx };
      }

      return { isOk: false, error: 'Transaction not found' };
    });
  }

  /**
   * Delete a transaction
   */
  async delete(tx: Transaction): Promise<OperationResult> {
    return this._atomicOperation(async (): Promise<OperationResult> => {
      // OPTIMIZATION OPPORTUNITY: _getTransactions() loads ALL transactions from storage.
      // For single-item delete, an indexed IDB delete() would avoid the full read.
      const data = await this._getTransactions();
      const newData = data.filter(t => t.__backendId !== tx.__backendId);

      if (newData.length === data.length) {
        return { isOk: false, error: 'Transaction not found' };
      }

      const ok = await this._persist(newData, { type: 'delete', id: tx.__backendId });
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      emit(Events.TRANSACTION_DELETED, tx);
      return { isOk: true };
    });
  }

  /**
   * Split a transaction into multiple parts atomically with rollback capability
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

    // Use integer arithmetic to avoid floating point errors
    const origCents = Math.round(parseAmount(originalTx.amount) * 100);
    let splitTotalCents = 0;
    
    // Validate and accumulate using cents
    for (const split of splits) {
      const amountCents = Math.round(parseAmount(split.amount) * 100);
      if (amountCents <= 0) {
        return { isOk: false, error: 'All split amounts must be positive' };
      }
      splitTotalCents += amountCents;
    }

    // Exact match required (no tolerance)
    if (splitTotalCents !== origCents) {
      const splitTotal = splitTotalCents / 100;
      const origAmount = origCents / 100;
      return {
        isOk: false,
        error: `Split total (${splitTotal.toFixed(2)}) does not match original (${origAmount.toFixed(2)})`
      };
    }

    // Create all split transactions
    const newSplits: Transaction[] = splits.map(split => ({
      type: originalTx.type,
      category: split.category,
      amount: Math.round(parseAmount(split.amount) * 100) / 100, // Round to 2 decimals
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
      __backendId: `tx_${generateSecureId()}`
    }));

    return this._atomicOperation(async (): Promise<OperationResult<SplitResult>> => {
      const data = await this._getTransactions();
      const origIdx = data.findIndex(t => t.__backendId === originalTx.__backendId);
      
      if (origIdx < 0) {
        return { isOk: false, error: 'Original transaction not found' };
      }

      // Perform atomic swap in memory
      const newData = [
        ...data.slice(0, origIdx),
        ...newSplits,
        ...data.slice(origIdx + 1)
      ];

      const ok = await this._persist(newData, { 
        type: 'split', 
        id: originalTx.__backendId, 
        items: newSplits 
      });
      if (!ok) return { isOk: false, error: 'Storage write failed' };

      emit(Events.TRANSACTION_DELETED, originalTx);
      emit(Events.TRANSACTIONS_BATCH_ADDED, { transactions: newSplits, count: newSplits.length });

      return {
        isOk: true,
        data: { originalId: originalTx.__backendId, splits: newSplits }
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
