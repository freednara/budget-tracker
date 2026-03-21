/**
 * Storage Manager
 *
 * Factory and facade for storage adapters.
 * Automatically selects the best available storage backend and
 * handles multi-tab synchronization.
 *
 * @module storage-manager
 */

import { IndexedDBAdapter } from './indexeddb-adapter.js';
import { LocalStorageAdapter } from './localstorage-adapter.js';
import { STORES } from './storage-adapter.js';
import { emit, Events } from '../core/event-bus.js';
import { generateSecureId } from '../core/utils-dom.js';
import type {
  StorageResult,
  StorageType,
  StoreName,
  Transaction,
  TransactionFilters,
  SyncMessage
} from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type StorageAdapter = IndexedDBAdapter | LocalStorageAdapter;

interface InitResult {
  isOk: boolean;
  type: StorageType | null;
  error?: string;
}

interface ExportMeta {
  exportedAt: string;
  storageType: StorageType | null;
  version: string;
}

interface ExportData extends Record<string, unknown> {
  _meta?: ExportMeta;
}

interface StorageStats {
  initialized: boolean;
  type?: StorageType | null;
  [key: string]: unknown;
}

// ==========================================
// STORAGE MANAGER CLASS
// ==========================================

class StorageManager {
  private adapter: StorageAdapter | null = null;
  private type: StorageType | null = null;
  private syncChannel: BroadcastChannel | null = null;
  private _tabId: string;
  private _errorCount: number = 0;
  private _initialized: boolean = false;
  readonly ERROR_THRESHOLD: number = 5;

  constructor() {
    // Use secure ID generation for tab identification
    this._tabId = `tab_${Date.now()}_${generateSecureId().replace(/-/g, '').substring(0, 9)}`;
  }

  /**
   * Initialize the storage manager
   * Attempts IndexedDB first, falls back to localStorage
   */
  async init(): Promise<InitResult> {
    if (this._initialized && this.adapter) {
      return { isOk: true, type: this.type };
    }

    // Try IndexedDB first
    const idbAdapter = new IndexedDBAdapter();
    if (idbAdapter.isAvailable()) {
      const result = await idbAdapter.init();

      if (result.isOk) {
        this.adapter = idbAdapter;
        this.type = 'indexeddb';
        this._initialized = true;
        this._setupSync();

        // Storage: Using IndexedDB backend
        return { isOk: true, type: 'indexeddb' };
      }
    }

    // Fall back to localStorage
    const lsAdapter = new LocalStorageAdapter();
    if (lsAdapter.isAvailable()) {
      const result = await lsAdapter.init();

      if (result.isOk) {
        this.adapter = lsAdapter;
        this.type = 'localstorage';
        this._initialized = true;
        this._setupLocalStorageSync();

        // Storage: Using localStorage backend (IndexedDB unavailable)
        return { isOk: true, type: 'localstorage' };
      }
    }

    if (import.meta.env.DEV) console.error('Storage: No storage backend available');
    return { isOk: false, type: null, error: 'No storage backend available' };
  }

  /**
   * Set up BroadcastChannel for multi-tab sync
   */
  private _setupSync(): void {
    if (typeof BroadcastChannel === 'undefined') {
      // Fall back to localStorage events if BroadcastChannel not available
      this._setupLocalStorageSync();
      return;
    }

    try {
      this.syncChannel = new BroadcastChannel('budget_tracker_sync');

      this.syncChannel.onmessage = (event: MessageEvent<SyncMessage>) => {
        this._handleSyncMessage(event.data);
      };
    } catch (err) {
      if (import.meta.env.DEV) console.warn('BroadcastChannel setup failed, using localStorage sync:', err);
      this._setupLocalStorageSync();
    }
  }

  /**
   * Set up localStorage events for multi-tab sync (fallback)
   */
  private _setupLocalStorageSync(): void {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key?.startsWith('budget_tracker_sync_')) {
        try {
          const message = JSON.parse(event.newValue || '') as SyncMessage;
          this._handleSyncMessage(message);
        } catch {
          // Ignore parse errors
        }
      }
    });
  }

  /**
   * Handle incoming sync messages from other tabs
   */
  private _handleSyncMessage(message: SyncMessage): void {
    // Ignore own messages
    if (message.tabId === this._tabId) return;

    // Emit event for UI to handle
    emit(Events.STORAGE_SYNC, {
      type: message.type,
      store: message.store,
      data: message.data,
      timestamp: message.timestamp
    });
  }

  /**
   * Broadcast a storage change to other tabs
   */
  broadcastChange(type: SyncMessage['type'], store: StoreName | 'all', data: unknown): void {
    const message: SyncMessage = {
      type,
      store,
      data,
      timestamp: Date.now(),
      tabId: this._tabId
    };

    if (this.syncChannel) {
      try {
        this.syncChannel.postMessage(message);
      } catch {
        // Fall back to localStorage method
        this._broadcastViaLocalStorage(message);
      }
    } else {
      this._broadcastViaLocalStorage(message);
    }
  }

  /**
   * Broadcast via localStorage (fallback method)
   */
  private _broadcastViaLocalStorage(message: SyncMessage): void {
    try {
      const key = `budget_tracker_sync_${Date.now()}`;
      localStorage.setItem(key, JSON.stringify(message));
      // Clean up after a short delay
      setTimeout(() => {
        try {
          localStorage.removeItem(key);
        } catch {
          // Ignore cleanup errors
        }
      }, 1000);
    } catch {
      // Ignore broadcast errors
    }
  }

  // ==========================================
  // PROXY METHODS TO ADAPTER
  // ==========================================

  /**
   * Get a value from storage
   */
  async get(store: StoreName, key: string): Promise<unknown> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.get(store, key);
      this._errorCount = 0; // Reset on success to prevent premature rollback after transient errors recover
      return result;
    } catch (err) {
      this._handleError(err, 'get', store);
      throw err;
    }
  }

  /**
   * Set a value in storage
   */
  async set(store: StoreName, key: string, value: unknown): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.set(store, key, value);
      if (result) {
        this._errorCount = 0; // Reset on success to prevent premature rollback after transient errors recover
        this.broadcastChange('update', store, { key, value });
      }
      return result;
    } catch (err) {
      this._handleError(err, 'set', store);
      throw err;
    }
  }

  /**
   * Delete a value from storage
   */
  async delete(store: StoreName, key: string): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.delete(store, key);
      if (result) {
        this._errorCount = 0; // Reset on success
        this.broadcastChange('delete', store, { key });
      }
      return result;
    } catch (err) {
      this._handleError(err, 'delete', store);
      throw err;
    }
  }

  /**
   * Get all values from a store
   */
  async getAll(store: StoreName): Promise<unknown[]> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.getAll(store);
      this._errorCount = 0; // Reset on success
      return result;
    } catch (err) {
      this._handleError(err, 'getAll', store);
      throw err;
    }
  }

  /**
   * Clear a store
   */
  async clear(store: StoreName): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.clear(store);
      if (result) {
        this._errorCount = 0; // Reset on success
        this.broadcastChange('clear', store, null);
      }
      return result;
    } catch (err) {
      this._handleError(err, 'clear', store);
      throw err;
    }
  }

  // ==========================================
  // TRANSACTION-SPECIFIC METHODS
  // ==========================================

  async getTransactionsByMonth(monthKey: string): Promise<Transaction[]> {
    this._checkInitialized();
    return this.adapter!.getTransactionsByMonth(monthKey);
  }

  async getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]> {
    this._checkInitialized();
    return this.adapter!.getTransactionsByDateRange(startDate, endDate);
  }

  async countTransactions(filters?: TransactionFilters): Promise<number> {
    this._checkInitialized();
    return this.adapter!.countTransactions(filters);
  }

  // ==========================================
  // BATCH METHODS
  // ==========================================

  async createBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.createBatch(store, items);
      if (result) {
        this._errorCount = 0; // Reset on success
        this.broadcastChange('batch', store, { type: 'create', count: items.length });
      }
      return result;
    } catch (err) {
      this._handleError(err, 'createBatch', store);
      throw err;
    }
  }

  async updateBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.updateBatch(store, items);
      if (result) {
        this._errorCount = 0; // Reset on success
        this.broadcastChange('batch', store, { type: 'update', count: items.length });
      }
      return result;
    } catch (err) {
      this._handleError(err, 'updateBatch', store);
      throw err;
    }
  }

  async deleteBatch(store: StoreName, keys: string[]): Promise<boolean> {
    this._checkInitialized();
    try {
      const result = await this.adapter!.deleteBatch(store, keys);
      if (result) {
        this._errorCount = 0; // Reset on success
        this.broadcastChange('batch', store, { type: 'delete', count: keys.length });
      }
      return result;
    } catch (err) {
      this._handleError(err, 'deleteBatch', store);
      throw err;
    }
  }

  // ==========================================
  // EXPORT/IMPORT METHODS
  // ==========================================

  async exportAll(): Promise<ExportData> {
    this._checkInitialized();
    const data: ExportData = await this.adapter!.exportAll();
    data._meta = {
      exportedAt: new Date().toISOString(),
      storageType: this.type,
      version: '2.7'
    };
    return data;
  }

  async importAll(data: Record<string, unknown>, overwrite: boolean = false): Promise<boolean> {
    this._checkInitialized();
    const result = await this.adapter!.importAll(data, overwrite);
    if (result) {
      this.broadcastChange('batch', 'all', { type: 'import' });
    }
    return result;
  }

  async clearAll(): Promise<boolean> {
    this._checkInitialized();
    const result = await this.adapter!.clearAll();
    if (result) {
      this.broadcastChange('clear', 'all', null);
    }
    return result;
  }

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  /**
   * Handle storage errors
   */
  private _handleError(err: unknown, operation: string, store: StoreName): void {
    this._errorCount++;
    if (import.meta.env.DEV) console.error(`Storage error in ${operation} for ${store}:`, err);

    if (this._errorCount >= this.ERROR_THRESHOLD && this.type === 'indexeddb') {
      this._triggerRollback();
    }
  }

  /**
   * Trigger rollback to localStorage
   */
  private _rollbackInProgress = false;

  private async _triggerRollback(): Promise<void> {
    if (this.type !== 'indexeddb' || this._rollbackInProgress) return;
    this._rollbackInProgress = true;

    if (import.meta.env.DEV) console.warn('Storage: Too many IndexedDB errors, rolling back to localStorage');

    try {
      // Export current data
      const data = await this.adapter!.exportAll();

      // Switch to localStorage adapter
      const lsAdapter = new LocalStorageAdapter();
      await lsAdapter.init();

      // Import data to localStorage
      await lsAdapter.importAll(data, true);

      // Switch adapter
      this.adapter = lsAdapter;
      this.type = 'localstorage';
      this._errorCount = 0;

      // Mark rollback in localStorage
      localStorage.setItem('budget_tracker_storage_rollback', JSON.stringify({
        reason: 'error_threshold',
        timestamp: Date.now()
      }));

    } catch (err) {
      if (import.meta.env.DEV) console.error('Storage rollback failed:', err);
    } finally {
      this._rollbackInProgress = false;
    }
  }

  /**
   * Check if storage is initialized
   */
  private _checkInitialized(): void {
    if (!this._initialized || !this.adapter) {
      throw new Error('Storage not initialized. Call init() first.');
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Get storage type
   */
  getType(): StorageType | null {
    return this.type;
  }

  /**
   * Check if using IndexedDB
   */
  isUsingIndexedDB(): boolean {
    return this.type === 'indexeddb';
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<StorageStats> {
    if (!this._initialized) {
      return { initialized: false };
    }

    // Check for IndexedDB adapter's getStats method
    if (this.adapter instanceof IndexedDBAdapter) {
      return {
        initialized: true,
        type: this.type,
        ...(await this.adapter.getStats())
      };
    }

    // Check for localStorage adapter's getStorageUsage method
    if (this.adapter instanceof LocalStorageAdapter) {
      return {
        initialized: true,
        type: this.type,
        ...this.adapter.getStorageUsage()
      };
    }

    return {
      initialized: true,
      type: this.type
    };
  }

  /**
   * Reset the storage manager (for testing)
   */
  reset(): void {
    if (this.syncChannel) {
      this.syncChannel.close();
      this.syncChannel = null;
    }
    this.adapter = null;
    this.type = null;
    this._initialized = false;
    this._errorCount = 0;
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const storageManager = new StorageManager();

// Export STORES for convenience
export { STORES };
