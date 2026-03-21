/**
 * IndexedDB Adapter
 *
 * Implements the StorageAdapter interface using IndexedDB.
 * Provides indexed queries, batch operations, and unlimited storage.
 *
 * @module indexeddb-adapter
 */

import { StorageAdapter, STORES, SETTINGS_KEYS } from './storage-adapter.js';
import type {
  StorageResult,
  StorageType,
  StoreName,
  Transaction,
  TransactionFilters
} from '../../types/index.js';

// ==========================================
// DATABASE CONFIGURATION
// ==========================================

const DB_NAME = 'BudgetTrackerDB';
const DB_VERSION = 1;

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface StorageStats {
  dbName: string;
  version: number | undefined;
  stores: Record<string, number | 'error'>;
}

interface CountFilters {
  type?: string;
  category?: string;
  reconciled?: boolean;
  monthKey?: string;
}

// ==========================================
// INDEXEDDB ADAPTER CLASS
// ==========================================

export class IndexedDBAdapter extends StorageAdapter {
  private db: IDBDatabase | null = null;
  private _initPromise: Promise<StorageResult> | null = null;

  constructor() {
    super();
  }

  /**
   * Check if IndexedDB is available in this environment
   */
  isAvailable(): boolean {
    try {
      return 'indexedDB' in window && indexedDB !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get the storage type name
   */
  getType(): StorageType {
    return 'indexeddb';
  }

  /**
   * Initialize the IndexedDB database
   */
  async init(): Promise<StorageResult> {
    // Return existing promise if already initializing
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = new Promise<StorageResult>((resolve) => {
      if (!this.isAvailable()) {
        resolve({ isOk: false, error: 'IndexedDB not available' });
        return;
      }

      const request: IDBOpenDBRequest = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this._createSchema(db);
      };

      request.onsuccess = (event: Event) => {
        this.db = (event.target as IDBOpenDBRequest).result;

        // Handle connection closing
        this.db.onclose = () => {
          if (import.meta.env.DEV) console.warn('IndexedDB connection closed unexpectedly');
          this.db = null;
          this._initPromise = null;
        };

        // Handle version change (another tab upgraded the DB)
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
          this._initPromise = null;
        };

        resolve({ isOk: true });
      };

      request.onerror = (event: Event) => {
        const target = event.target as IDBOpenDBRequest;
        if (import.meta.env.DEV) console.error('IndexedDB open error:', target.error);
        resolve({ isOk: false, error: target.error?.message || 'Failed to open database' });
      };

      request.onblocked = () => {
        resolve({ isOk: false, error: 'Database blocked by other tabs' });
      };
    });

    return this._initPromise;
  }

  /**
   * Create the database schema
   */
  private _createSchema(db: IDBDatabase): void {
    // Transactions store with indexes
    if (!db.objectStoreNames.contains(STORES.TRANSACTIONS)) {
      const txStore = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: '__backendId' });
      txStore.createIndex('by_date', 'date', { unique: false });
      txStore.createIndex('by_type', 'type', { unique: false });
      txStore.createIndex('by_category', 'category', { unique: false });
      txStore.createIndex('by_reconciled', 'reconciled', { unique: false });
      txStore.createIndex('by_date_type', ['date', 'type'], { unique: false });
    }

    // Settings store (key-value)
    if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
      db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
    }

    // Savings goals
    if (!db.objectStoreNames.contains(STORES.SAVINGS_GOALS)) {
      db.createObjectStore(STORES.SAVINGS_GOALS, { keyPath: 'id' });
    }

    // Savings contributions
    if (!db.objectStoreNames.contains(STORES.SAVINGS_CONTRIBUTIONS)) {
      const contribStore = db.createObjectStore(STORES.SAVINGS_CONTRIBUTIONS, { keyPath: 'id', autoIncrement: true });
      contribStore.createIndex('by_goal_id', 'goalId', { unique: false });
    }

    // Monthly allocations
    if (!db.objectStoreNames.contains(STORES.MONTHLY_ALLOCATIONS)) {
      db.createObjectStore(STORES.MONTHLY_ALLOCATIONS, { keyPath: 'monthKey' });
    }

    // Achievements
    if (!db.objectStoreNames.contains(STORES.ACHIEVEMENTS)) {
      db.createObjectStore(STORES.ACHIEVEMENTS, { keyPath: 'id' });
    }

    // Streak (single record)
    if (!db.objectStoreNames.contains(STORES.STREAK)) {
      db.createObjectStore(STORES.STREAK, { keyPath: 'id' });
    }

    // Custom categories
    if (!db.objectStoreNames.contains(STORES.CUSTOM_CATEGORIES)) {
      const catStore = db.createObjectStore(STORES.CUSTOM_CATEGORIES, { keyPath: 'id' });
      catStore.createIndex('by_type', 'type', { unique: false });
    }

    // Debts
    if (!db.objectStoreNames.contains(STORES.DEBTS)) {
      db.createObjectStore(STORES.DEBTS, { keyPath: 'id' });
    }

    // Filter presets
    if (!db.objectStoreNames.contains(STORES.FILTER_PRESETS)) {
      db.createObjectStore(STORES.FILTER_PRESETS, { keyPath: 'id' });
    }

    // Transaction templates
    if (!db.objectStoreNames.contains(STORES.TX_TEMPLATES)) {
      db.createObjectStore(STORES.TX_TEMPLATES, { keyPath: 'id' });
    }

    // Metadata
    if (!db.objectStoreNames.contains(STORES.METADATA)) {
      db.createObjectStore(STORES.METADATA, { keyPath: 'key' });
    }
  }

  /**
   * Get a transaction for the specified stores
   */
  private _getTransaction(storeNames: StoreName | StoreName[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return this.db.transaction(names, mode);
  }

  /**
   * Get an object store
   */
  private _getStore(storeName: StoreName, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this._getTransaction(storeName, mode).objectStore(storeName);
  }

  // ==========================================
  // GENERIC CRUD OPERATIONS
  // ==========================================

  async get(store: StoreName, key: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(store, 'readonly');
        const request = objectStore.get(key);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async set(store: StoreName, key: string, value: unknown): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(store, 'readwrite');
        // Ensure the value has the correct key
        const data: Record<string, unknown> = typeof value === 'object' && value !== null
          ? { ...value as object }
          : { value };

        // Set the appropriate key field based on store type
        if (store === STORES.SETTINGS) {
          data.key = key;
        } else if (store === STORES.TRANSACTIONS) {
          data.__backendId = key;
        } else if (store === STORES.MONTHLY_ALLOCATIONS) {
          data.monthKey = key;
        } else if (store === STORES.METADATA) {
          data.key = key;
        } else {
          data.id = key;
        }

        const request = objectStore.put(data);

        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async delete(store: StoreName, key: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(store, 'readwrite');
        const request = objectStore.delete(key);

        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async getAll(store: StoreName): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(store, 'readonly');
        const request = objectStore.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async clear(store: StoreName): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(store, 'readwrite');
        const request = objectStore.clear();

        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==========================================
  // TRANSACTION-SPECIFIC OPERATIONS
  // ==========================================

  async getTransactionsByMonth(monthKey: string): Promise<Transaction[]> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(STORES.TRANSACTIONS, 'readonly');
        const index = objectStore.index('by_date');

        // Create range for the month using first-day-of-next-month as exclusive upper bound
        const startDate = `${monthKey}-01`;
        const [y, m] = monthKey.split('-').map(Number);
        const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        const endDate = `${nextMonth}-01`;
        const range = IDBKeyRange.bound(startDate, endDate, false, true);

        const request = index.getAll(range);

        request.onsuccess = () => resolve((request.result || []) as Transaction[]);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(STORES.TRANSACTIONS, 'readonly');
        const index = objectStore.index('by_date');
        const range = IDBKeyRange.bound(startDate, endDate);

        const request = index.getAll(range);

        request.onsuccess = () => resolve((request.result || []) as Transaction[]);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async countTransactions(filters: TransactionFilters = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        const objectStore = this._getStore(STORES.TRANSACTIONS, 'readonly');

        // Optimization: If only filtering by month, use the date index
        if (Object.keys(filters).length === 1 && filters.monthKey) {
          const index = objectStore.index('by_date');
          // Use same boundary strategy as getTransactionsByMonth (exclusive upper bound on next month's first day)
          const [y, m] = filters.monthKey.split('-').map(Number);
          const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
          const range = IDBKeyRange.bound(`${filters.monthKey}-01`, `${nextMonth}-01`, false, true);
          const request = index.count(range);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          return;
        }

        // Optimization: If only filtering by type, use the type index
        if (Object.keys(filters).length === 1 && filters.type && filters.type !== 'all') {
          const index = objectStore.index('by_type');
          const request = index.count(IDBKeyRange.only(filters.type));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          return;
        }

        // Default: Full count or cursor-based filtered count
        if (Object.keys(filters).length === 0) {
          const request = objectStore.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          return;
        }

        // For complex filtered counts, we still need to iterate
        let count = 0;
        const request = objectStore.openCursor();

        request.onsuccess = (event: Event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            const tx = cursor.value as Transaction;
            let matches = true;

            if (filters.type && filters.type !== 'all' && tx.type !== filters.type) matches = false;
            if (filters.category && filters.category !== 'all' && tx.category !== filters.category) matches = false;
            if (filters.reconciled !== undefined && tx.reconciled !== filters.reconciled) matches = false;
            if (filters.monthKey && !tx.date?.startsWith(filters.monthKey)) matches = false;

            if (matches) count++;
            cursor.continue();
          } else {
            resolve(count);
          }
        };

        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==========================================
  // BATCH OPERATIONS
  // ==========================================

  async createBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this._getTransaction(store, 'readwrite');
        const objectStore = transaction.objectStore(store);

        items.forEach(item => {
          objectStore.add(item);
        });

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB createBatch failed for ${store}`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`IndexedDB createBatch aborted for ${store}`));
      } catch (err) {
        reject(err);
      }
    });
  }

  async updateBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this._getTransaction(store, 'readwrite');
        const objectStore = transaction.objectStore(store);

        items.forEach(item => {
          objectStore.put(item);
        });

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB updateBatch failed for ${store}`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`IndexedDB updateBatch aborted for ${store}`));
      } catch (err) {
        reject(err);
      }
    });
  }

  async deleteBatch(store: StoreName, keys: string[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this._getTransaction(store, 'readwrite');
        const objectStore = transaction.objectStore(store);

        keys.forEach(key => {
          objectStore.delete(key);
        });

        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB deleteBatch failed for ${store}`));
        transaction.onabort = () => reject(transaction.error ?? new Error(`IndexedDB deleteBatch aborted for ${store}`));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==========================================
  // EXPORT/IMPORT OPERATIONS
  // ==========================================

  async exportAll(): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};

    // Export all stores
    for (const storeName of Object.values(STORES)) {
      try {
        data[storeName] = await this.getAll(storeName as StoreName);
      } catch (err) {
        if (import.meta.env.DEV) console.warn(`Failed to export ${storeName}:`, err);
        data[storeName] = [];
      }
    }

    return data;
  }

  async importAll(data: Record<string, unknown>, overwrite: boolean = false): Promise<boolean> {
    try {
      if (!this.db) {
        return false;
      }

      // Get all store names that exist in the database
      const storeNames = Object.values(STORES).filter(name =>
        this.db!.objectStoreNames.contains(name)
      ) as StoreName[];

      if (overwrite) {
        // Use a single transaction for clear + import to make it atomic
        // If the tab closes mid-operation, the transaction is rolled back
        const tx = this.db.transaction(storeNames, 'readwrite');

        // Only clear stores that have data in the import payload —
        // do NOT clear unrelated stores (e.g. don't wipe savings when only updating transactions)
        for (const storeName of storeNames) {
          if (data[storeName] !== undefined) {
            tx.objectStore(storeName).clear();
          }
        }

        for (const storeName of storeNames) {
          const items = data[storeName];
          if (Array.isArray(items) && items.length > 0) {
            const store = tx.objectStore(storeName);
            for (const item of items) {
              // Use the store's keyPath to determine if item has a valid key
              const keyPath = store.keyPath as string | null;
              if (keyPath) {
                const key = (item as any)[keyPath];
                if (key != null) {
                  store.put(item);
                }
              } else {
                // Store uses out-of-line keys or auto-increment — just put directly
                store.put(item);
              }
            }
          }
        }

        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
      } else {
        // Non-overwrite: add items to existing stores
        for (const storeName of storeNames) {
          const items = data[storeName];
          if (Array.isArray(items) && items.length > 0) {
            await this.updateBatch(storeName, items);
          }
        }
      }

      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Import failed:', err);
      return false;
    }
  }

  async clearAll(): Promise<boolean> {
    try {
      if (!this.db) {
        return false;
      }

      // Use a single transaction for atomicity — all stores cleared or none
      const storeNames = Object.values(STORES).filter(name =>
        this.db!.objectStoreNames.contains(name)
      ) as StoreName[];

      const tx = this.db.transaction(storeNames, 'readwrite');
      for (const name of storeNames) {
        tx.objectStore(name).clear();
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Clear all transaction aborted'));
      });

      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.error('Clear all failed:', err);
      return false;
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Check if a store exists
   */
  hasStore(storeName: string): boolean {
    return this.db?.objectStoreNames.contains(storeName) || false;
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<StorageStats> {
    const stats: StorageStats = {
      dbName: DB_NAME,
      version: this.db?.version,
      stores: {}
    };

    for (const storeName of Object.values(STORES)) {
      if (this.hasStore(storeName)) {
        try {
          const count = await new Promise<number>((resolve, reject) => {
            const store = this._getStore(storeName as StoreName, 'readonly');
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          });
          stats.stores[storeName] = count;
        } catch {
          stats.stores[storeName] = 'error';
        }
      }
    }

    return stats;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._initPromise = null;
    }
  }
}
