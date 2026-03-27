/**
 * Data Manager Module
 * Handles data persistence and CRUD operations for transactions
 * Implements atomic operations to prevent race conditions
 *
 * Supports both IndexedDB (primary) and localStorage (fallback) backends
 * via the storage manager abstraction layer.
 */

import { SK, lsGet, lsSet } from '../core/state.js';
import { parseAmount, generateSecureId, getMonthKey } from '../core/utils.js';
import { validator } from '../core/validator.js';
import { emit, Events, on } from '../core/event-bus.js';
import { storageManager, STORES } from './storage-manager.js';
import { Mutex } from '../core/mutex.js';
import {
  DataSyncEvents,
  notifyDataSyncComplete,
  notifyDataSyncError,
  type TransactionDataDelta
} from '../core/data-sync-interface.js';
import stateRevision from '../core/state-revision.js';
import { getTabId } from '../core/tab-id.js';
import { broadcastManager } from '../core/multi-tab-sync-broadcast.js';
import { invalidateAllCache, invalidateMonthCache } from '../core/monthly-totals-cache.js';
import { applyTransactionPatch, replaceTransactionLedger } from '../core/signals.js';
import type {
  Transaction,
  DataHandler,
  OperationResult,
  TransactionDataChange
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

type PersistChange = TransactionDataChange;

function normalizeDeltaChange(change: TransactionDataDelta): PersistChange {
  return change as PersistChange;
}

function getChangedIds(change?: PersistChange): string[] {
  if (!change) return [];
  if (change.item?.__backendId) return [change.item.__backendId];
  if (change.items?.length) return change.items.map((item) => item.__backendId);
  if (change.id) return [change.id];
  if (change.ids?.length) return [...change.ids];
  return [];
}

function invalidateAffectedMonthCaches(currentTransactions: Transaction[], change?: PersistChange): void {
  if (!change) return;

  const months = new Set<string>();
  const transactionsById = new Map<string, Transaction>(
    currentTransactions.map((transaction) => [transaction.__backendId, transaction])
  );
  let requiresFullInvalidation = false;

  const maybeAddMonth = (transaction?: Transaction): void => {
    if (transaction?.date) {
      months.add(getMonthKey(transaction.date));
    }
  };

  maybeAddMonth(change.item);
  maybeAddMonth(change.previousItem);
  change.items?.forEach((transaction) => {
    maybeAddMonth(transaction);
  });

  if (change.id) {
    const transaction = transactionsById.get(change.id);
    if (transaction) {
      maybeAddMonth(transaction);
    } else {
      requiresFullInvalidation = true;
    }
  }

  change.ids?.forEach((id) => {
    const transaction = transactionsById.get(id);
    if (transaction) {
      maybeAddMonth(transaction);
    } else {
      requiresFullInvalidation = true;
    }
  });

  if (requiresFullInvalidation) {
    invalidateAllCache();
    return;
  }

  months.forEach((monthKey) => {
    invalidateMonthCache(monthKey);
  });
}

function getTransactionsFromCacheOrSnapshot(
  cachedTransactions: Transaction[],
  hasLoadedTransactions: boolean,
  fallbackTransactions: Transaction[]
): Transaction[] {
  return hasLoadedTransactions ? cachedTransactions : fallbackTransactions;
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
  private _transactionsCache: Transaction[] = [];
  private _hasLoadedTransactions: boolean = false;

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
      on(DataSyncEvents.REQUEST_RELOAD, async ({
        source,
        revision,
        tabId,
        timestamp
      }: {
        source: string;
        revision?: number;
        tabId?: string;
        timestamp?: number;
      }) => {
        const transactions = await this._readTransactionsFromStorage();
        invalidateAllCache();
        this._transactionsCache = transactions;
        this._hasLoadedTransactions = true;
        if (this._handler?.onDataChanged) {
          this._handler.onDataChanged(transactions);
        } else {
          replaceTransactionLedger(transactions);
        }
        emit(DataSyncEvents.TRANSACTION_UPDATED, { transactions, source, revision, tabId, timestamp });
      })
    );

    this._eventUnsubscribers.push(
      on(DataSyncEvents.REQUEST_APPLY_DELTA, ({
        change,
        source,
        revision,
        tabId,
        timestamp
      }: {
        change: TransactionDataDelta;
        source: string;
        revision?: number;
        tabId?: string;
        timestamp?: number;
      }) => {
        this.applyRemoteDelta(normalizeDeltaChange(change), { source, revision, tabId, timestamp });
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
    this._transactionsCache = transactions;
    this._hasLoadedTransactions = true;
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
    invalidateAllCache();
    this._transactionsCache = transactions;
    this._hasLoadedTransactions = true;
    if (this._handler) {
      this._handler.onDataChanged(transactions);
    } else {
      replaceTransactionLedger(transactions);
    }
  }

  /**
   * Clear ephemeral runtime state without touching durable storage.
   * Reserved for destructive reset/recovery paths.
   */
  resetRuntimeState(): void {
    this._transactionsCache = [];
    this._hasLoadedTransactions = false;
    this._idbWriteFailed = false;
  }

  /**
   * Replace the full transaction ledger through the durable storage path.
   * Used by import/restore/recovery flows, not hot CRUD paths.
   */
  async replaceAllTransactions(transactions: Transaction[]): Promise<OperationResult<Transaction[]>> {
    return this._atomicOperation(async (): Promise<OperationResult<Transaction[]>> => {
      const normalizedTransactions = transactions.map((transaction) => ({
        ...transaction,
        amount: parseAmount(transaction.amount)
      }));

      const ok = await this._persist(normalizedTransactions);
      if (!ok) {
        return { isOk: false, error: 'Storage write failed' };
      }

      return { isOk: true, data: normalizedTransactions };
    });
  }

  private applyRemoteDelta(
    change: PersistChange,
    metadata: { source: string; revision?: number; tabId?: string; timestamp?: number }
  ): void {
    const currentTransactions = getTransactionsFromCacheOrSnapshot(this._transactionsCache, this._hasLoadedTransactions, []);
    const nextTransactions = this._handler?.onDataPatched
      ? applyTransactionDelta(currentTransactions, change)
      : applyTransactionPatch(change);
    this._transactionsCache = nextTransactions;
    this._hasLoadedTransactions = true;
    invalidateAffectedMonthCaches(currentTransactions, change);
    if (this._handler?.onDataPatched) {
      this._handler.onDataPatched(change, nextTransactions);
    } else if (this._handler?.onDataChanged) {
      this._handler.onDataChanged(nextTransactions);
    } else {
      replaceTransactionLedger(nextTransactions);
    }
    emit(DataSyncEvents.TRANSACTION_DELTA_APPLIED, {
      change,
      source: metadata.source,
      revision: metadata.revision,
      tabId: metadata.tabId,
      timestamp: metadata.timestamp
    });
  }

  /**
   * Internal helper to persist transactions to all active backends
   * OPTIMIZED: Uses incremental updates for IndexedDB instead of clearing and re-writing everything
   */
  private async _persist(
    transactions: Transaction[],
    change?: PersistChange
  ): Promise<boolean> {
    const currentTransactions = getTransactionsFromCacheOrSnapshot(
      this._transactionsCache,
      this._hasLoadedTransactions,
      []
    );
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
                await storageManager.replaceTransactionWithSplits(change.id, change.items);
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
    if (anyBackendOk) {
      this._transactionsCache = transactions;
      this._hasLoadedTransactions = true;
    }

    if (anyBackendOk) {
      if (change && this._handler?.onDataPatched) {
        this._handler.onDataPatched(change, transactions);
      } else if (this._handler?.onDataChanged) {
        this._handler.onDataChanged(transactions);
      } else {
        replaceTransactionLedger(transactions);
      }
    }

    if (anyBackendOk) {
      try {
        const revision = await stateRevision.recordStateChange(SK.TX, null, getTabId(), {
          skipChecksum: true
        });
        if (change) {
          stateRevision.recordTransactionDelta(revision.revision, change, getTabId());
        }
        if (change) {
          invalidateAffectedMonthCaches(currentTransactions, change);
        } else {
          invalidateAllCache();
        }
        broadcastManager.sendStateUpdate(SK.TX, change, {
          revision: revision.revision,
          changeType: change?.type || 'reload',
          changedIds: getChangedIds(change)
        });
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
    if (this._hasLoadedTransactions) {
      return this._transactionsCache;
    }

    return this._readTransactionsFromStorage();
  }

  private async _readTransactionsFromStorage(): Promise<Transaction[]> {
    // If the last IDB write failed, read from localStorage (which has the latest data)
    // to prevent returning stale IDB data
    if (this._storageInitialized && this._useIndexedDB && !this._idbWriteFailed) {
      try {
        const transactions = await storageManager.getAll(STORES.TRANSACTIONS) as Transaction[];
        this._transactionsCache = transactions;
        this._hasLoadedTransactions = true;
        return transactions;
      } catch (err) {
        if (import.meta.env.DEV) console.error('DataManager: IndexedDB read failed, falling back:', err);
      }
    }
    // Fallback to localStorage
    const transactions = lsGet(SK.TX, []) as Transaction[];
    this._transactionsCache = transactions;
    this._hasLoadedTransactions = true;
    return transactions;
  }

  private async _getCachedTransactionsForMutation(): Promise<Transaction[]> {
    if (this._hasLoadedTransactions) {
      return this._transactionsCache;
    }

    return this._getTransactions();
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
      const data = await this._getCachedTransactionsForMutation();
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

      const data = await this._getCachedTransactionsForMutation();
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
      const data = await this._getCachedTransactionsForMutation();
      const idx = data.findIndex(t => t.__backendId === tx.__backendId);

      if (idx >= 0) {
        const newData = [...data];
        const previousTx = data[idx];
        newData[idx] = updatedTx;

        const ok = await this._persist(newData, { type: 'update', item: updatedTx, previousItem: previousTx });
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
      const data = await this._getCachedTransactionsForMutation();
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
      const data = await this._getCachedTransactionsForMutation();
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

function applyTransactionDelta(transactions: Transaction[], change: PersistChange): Transaction[] {
  switch (change.type) {
    case 'add':
      return change.item ? [...transactions, change.item] : transactions;
    case 'update':
      return change.item
        ? transactions.map((transaction) => transaction.__backendId === change.item!.__backendId ? change.item! : transaction)
        : transactions;
    case 'delete':
      return change.id ? transactions.filter((transaction) => transaction.__backendId !== change.id) : transactions;
    case 'batch-add':
      return change.items?.length ? [...transactions, ...change.items] : transactions;
    case 'batch-delete':
      return change.ids?.length
        ? transactions.filter((transaction) => !change.ids!.includes(transaction.__backendId))
        : transactions;
    case 'split': {
      const withoutOriginal = change.id
        ? transactions.filter((transaction) => transaction.__backendId !== change.id)
        : [...transactions];
      return change.items?.length ? [...withoutOriginal, ...change.items] : withoutOriginal;
    }
    default:
      return transactions;
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
