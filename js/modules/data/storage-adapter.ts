/**
 * Storage Adapter Interface
 *
 * Defines the common interface for storage backends (IndexedDB, localStorage).
 * All storage operations are async for compatibility with IndexedDB.
 *
 * @module storage-adapter
 */

import type {
  StorageResult,
  StorageType,
  StoreName,
  Transaction,
  TransactionFilters
} from '../../types/index.js';

// Re-export types and constants from types file
export { STORES, SETTINGS_KEYS } from '../../types/index.js';
export type { StoreName, SettingKey, StorageResult, StorageType } from '../../types/index.js';

/**
 * Storage Adapter Abstract Base Class
 * Provides the interface that all storage backends must implement.
 */
export abstract class StorageAdapter {
  /**
   * Initialize the storage backend
   */
  abstract init(): Promise<StorageResult>;

  /**
   * Check if this storage backend is available
   */
  abstract isAvailable(): boolean;

  /**
   * Get the storage type name
   */
  abstract getType(): StorageType;

  // ==========================================
  // GENERIC CRUD OPERATIONS
  // ==========================================

  /**
   * Get a value from storage
   */
  abstract get(store: StoreName, key: string): Promise<unknown>;

  /**
   * Set a value in storage
   */
  abstract set(store: StoreName, key: string, value: unknown): Promise<boolean>;

  /**
   * Delete a value from storage
   */
  abstract delete(store: StoreName, key: string): Promise<boolean>;

  /**
   * Get all values from a store
   */
  abstract getAll(store: StoreName): Promise<unknown[]>;

  /**
   * Clear all values from a store
   */
  abstract clear(store: StoreName): Promise<boolean>;

  // ==========================================
  // TRANSACTION-SPECIFIC OPERATIONS
  // ==========================================

  /**
   * Get transactions for a specific month
   */
  abstract getTransactionsByMonth(monthKey: string): Promise<Transaction[]>;

  /**
   * Get transactions within a date range
   */
  abstract getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]>;

  /**
   * Count transactions matching filters
   */
  abstract countTransactions(filters?: TransactionFilters): Promise<number>;

  // ==========================================
  // BATCH OPERATIONS
  // ==========================================

  /**
   * Create multiple items in a store
   */
  abstract createBatch(store: StoreName, items: unknown[]): Promise<boolean>;

  /**
   * Update multiple items in a store
   */
  abstract updateBatch(store: StoreName, items: unknown[]): Promise<boolean>;

  /**
   * Delete multiple items from a store
   */
  abstract deleteBatch(store: StoreName, keys: string[]): Promise<boolean>;

  // ==========================================
  // EXPORT/IMPORT OPERATIONS
  // ==========================================

  /**
   * Export all data from storage
   */
  abstract exportAll(): Promise<Record<string, unknown>>;

  /**
   * Import data into storage
   */
  abstract importAll(data: Record<string, unknown>, overwrite?: boolean): Promise<boolean>;

  /**
   * Clear all data from storage
   */
  abstract clearAll(): Promise<boolean>;
}
