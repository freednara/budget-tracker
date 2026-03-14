/**
 * LocalStorage Adapter
 *
 * Implements the StorageAdapter interface using localStorage.
 * Provides fallback storage when IndexedDB is unavailable.
 * Maintains backward compatibility with existing localStorage structure.
 *
 * @module localstorage-adapter
 */

import { StorageAdapter, STORES, SETTINGS_KEYS } from './storage-adapter.js';
import { safeStorage } from '../core/error-handler.js';
import { SK } from '../core/state.js';
import type {
  StorageResult,
  StorageType,
  StoreName,
  SettingKey,
  Transaction,
  TransactionFilters,
  SavingsGoal
} from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface StorageUsage {
  total: number;
  limit: number;
  usage: Record<string, number>;
  percentUsed: number;
}

interface CountFilters extends TransactionFilters {
  monthKey?: string;
}

// ==========================================
// STORE TO LOCALSTORAGE KEY MAPPING
// ==========================================

/**
 * Map store names to existing localStorage keys
 */
const STORE_KEY_MAP: Partial<Record<StoreName, string>> = {
  [STORES.TRANSACTIONS]: SK.TX,
  [STORES.SAVINGS_GOALS]: SK.SAVINGS,
  [STORES.SAVINGS_CONTRIBUTIONS]: SK.SAVINGS_CONTRIB,
  [STORES.MONTHLY_ALLOCATIONS]: SK.ALLOC,
  [STORES.ACHIEVEMENTS]: SK.ACHIEVE,
  [STORES.STREAK]: SK.STREAK,
  [STORES.CUSTOM_CATEGORIES]: SK.CUSTOM_CAT,
  [STORES.DEBTS]: SK.DEBTS,
  [STORES.FILTER_PRESETS]: SK.FILTER_PRESETS,
  [STORES.TX_TEMPLATES]: SK.TX_TEMPLATES,
  [STORES.METADATA]: 'budget_tracker_metadata'
};

/**
 * Map settings keys to existing localStorage keys
 */
const SETTINGS_KEY_MAP: Partial<Record<SettingKey, string>> = {
  [SETTINGS_KEYS.THEME]: SK.THEME,
  [SETTINGS_KEYS.CURRENCY]: SK.CURRENCY,
  [SETTINGS_KEYS.PIN]: SK.PIN,
  [SETTINGS_KEYS.SECTIONS]: SK.SECTIONS,
  [SETTINGS_KEYS.INSIGHT_PERSONALITY]: SK.INSIGHT_PERS,
  [SETTINGS_KEYS.ALERTS]: SK.ALERTS,
  [SETTINGS_KEYS.ROLLOVER_SETTINGS]: SK.ROLLOVER_SETTINGS,
  [SETTINGS_KEYS.ONBOARDING]: SK.ONBOARD,
  [SETTINGS_KEYS.LAST_BACKUP]: SK.LAST_BACKUP,
  [SETTINGS_KEYS.FILTER_EXPANDED]: SK.FILTER_EXPANDED
};

// ==========================================
// LOCALSTORAGE ADAPTER CLASS
// ==========================================

export class LocalStorageAdapter extends StorageAdapter {
  private _cache: Map<string, unknown>;

  constructor() {
    super();
    this._cache = new Map(); // In-memory cache for performance
  }

  /**
   * Check if localStorage is available
   */
  isAvailable(): boolean {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the storage type name
   */
  getType(): StorageType {
    return 'localstorage';
  }

  /**
   * Initialize the storage
   */
  async init(): Promise<StorageResult> {
    if (!this.isAvailable()) {
      return { isOk: false, error: 'localStorage not available' };
    }
    return { isOk: true };
  }

  /**
   * Get the localStorage key for a store
   */
  private _getStoreKey(store: StoreName): string {
    return STORE_KEY_MAP[store] || `budget_tracker_${store}`;
  }

  /**
   * Get the localStorage key for a settings key
   */
  private _getSettingsKey(settingsKey: string): string {
    return SETTINGS_KEY_MAP[settingsKey as SettingKey] || `budget_tracker_${settingsKey}`;
  }

  // ==========================================
  // GENERIC CRUD OPERATIONS
  // ==========================================

  async get(store: StoreName, key: string): Promise<unknown> {
    if (store === STORES.SETTINGS) {
      // Settings are stored individually
      const lsKey = this._getSettingsKey(key);
      return safeStorage.getJSON(lsKey, undefined);
    }

    // For other stores, get the array and find the item
    const storeKey = this._getStoreKey(store);
    const data = safeStorage.getJSON(storeKey, []);

    if (Array.isArray(data)) {
      return data.find(item => this._getItemKey(store, item) === key);
    }

    // Handle object stores (like savingsGoals which is an object)
    if (typeof data === 'object' && data !== null) {
      return (data as Record<string, unknown>)[key];
    }

    return undefined;
  }

  async set(store: StoreName, key: string, value: unknown): Promise<boolean> {
    try {
      if (store === STORES.SETTINGS) {
        // Settings are stored individually
        const lsKey = this._getSettingsKey(key);
        return safeStorage.setJSON(lsKey, value);
      }

      if (store === STORES.STREAK) {
        // Streak is a single object
        const storeKey = this._getStoreKey(store);
        return safeStorage.setJSON(storeKey, value);
      }

      if (store === STORES.SAVINGS_GOALS) {
        // Savings goals is an object map
        const storeKey = this._getStoreKey(store);
        const data = safeStorage.getJSON(storeKey, {}) as Record<string, unknown>;
        data[key] = value;
        return safeStorage.setJSON(storeKey, data);
      }

      // For array stores, update or add the item
      const storeKey = this._getStoreKey(store);
      const data = safeStorage.getJSON(storeKey, []) as unknown[];

      if (Array.isArray(data)) {
        const index = data.findIndex(item =>
          this._getItemKey(store, item as Record<string, unknown>) === key
        );
        if (index >= 0) {
          data[index] = value;
        } else {
          data.push(value);
        }
        return safeStorage.setJSON(storeKey, data);
      }

      return false;
    } catch (err) {
      console.error(`LocalStorage set error for ${store}/${key}:`, err);
      return false;
    }
  }

  async delete(store: StoreName, key: string): Promise<boolean> {
    try {
      if (store === STORES.SETTINGS) {
        localStorage.removeItem(this._getSettingsKey(key));
        return true;
      }

      if (store === STORES.SAVINGS_GOALS) {
        const storeKey = this._getStoreKey(store);
        const data = safeStorage.getJSON(storeKey, {}) as Record<string, unknown>;
        delete data[key];
        return safeStorage.setJSON(storeKey, data);
      }

      const storeKey = this._getStoreKey(store);
      const data = safeStorage.getJSON(storeKey, []);

      if (Array.isArray(data)) {
        const filtered = data.filter(item => this._getItemKey(store, item) !== key);
        return safeStorage.setJSON(storeKey, filtered);
      }

      return false;
    } catch (err) {
      console.error(`LocalStorage delete error for ${store}/${key}:`, err);
      return false;
    }
  }

  async getAll(store: StoreName): Promise<unknown[]> {
    const storeKey = this._getStoreKey(store);
    const data = safeStorage.getJSON(storeKey, store === STORES.SAVINGS_GOALS ? {} : []);

    // Convert object to array if needed
    if (store === STORES.SAVINGS_GOALS && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data as Record<string, SavingsGoal>).map(([key, goal]) => ({
        ...goal,
        id: key // Use the object key as the id
      }));
    }

    if (store === STORES.STREAK) {
      // Streak is a single object, return as array with one item
      return data ? [{ id: 'current', ...(data as Record<string, unknown>) }] : [];
    }

    return Array.isArray(data) ? data : [];
  }

  async clear(store: StoreName): Promise<boolean> {
    try {
      const storeKey = this._getStoreKey(store);
      localStorage.removeItem(storeKey);
      return true;
    } catch (err) {
      console.error(`LocalStorage clear error for ${store}:`, err);
      return false;
    }
  }

  /**
   * Get the key property for an item based on store type
   */
  private _getItemKey(store: StoreName, item: Record<string, unknown>): string {
    if (store === STORES.TRANSACTIONS) return item.__backendId as string;
    if (store === STORES.MONTHLY_ALLOCATIONS) return item.monthKey as string;
    if (store === STORES.METADATA) return item.key as string;
    return item.id as string;
  }

  // ==========================================
  // TRANSACTION-SPECIFIC OPERATIONS
  // ==========================================

  async getTransactionsByMonth(monthKey: string): Promise<Transaction[]> {
    const all = await this.getAll(STORES.TRANSACTIONS) as Transaction[];
    return all.filter(t => t.date && t.date.startsWith(monthKey));
  }

  async getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]> {
    const all = await this.getAll(STORES.TRANSACTIONS) as Transaction[];
    return all.filter(t => t.date && t.date >= startDate && t.date <= endDate);
  }

  async countTransactions(filters: TransactionFilters = {}): Promise<number> {
    let transactions = await this.getAll(STORES.TRANSACTIONS) as Transaction[];
    const countFilters = filters as CountFilters;

    if (countFilters.type) {
      transactions = transactions.filter(t => t.type === countFilters.type);
    }
    if (countFilters.category) {
      transactions = transactions.filter(t => t.category === countFilters.category);
    }
    if (countFilters.reconciled !== undefined) {
      transactions = transactions.filter(t => t.reconciled === countFilters.reconciled);
    }
    if (countFilters.monthKey) {
      transactions = transactions.filter(t => t.date?.startsWith(countFilters.monthKey!));
    }

    return transactions.length;
  }

  // ==========================================
  // BATCH OPERATIONS
  // ==========================================

  async createBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    try {
      const storeKey = this._getStoreKey(store);
      const existing = safeStorage.getJSON(storeKey, []) as unknown[];
      const combined = [...existing, ...items];
      return safeStorage.setJSON(storeKey, combined);
    } catch (err) {
      console.error(`LocalStorage createBatch error for ${store}:`, err);
      return false;
    }
  }

  async updateBatch(store: StoreName, items: unknown[]): Promise<boolean> {
    try {
      const storeKey = this._getStoreKey(store);
      const existing = safeStorage.getJSON(storeKey, []) as Record<string, unknown>[];

      // Create a map for quick lookup
      const itemMap = new Map<string, unknown>();
      (items as Record<string, unknown>[]).forEach(item => {
        const key = this._getItemKey(store, item);
        itemMap.set(key, item);
      });

      // Update existing items or add new ones
      const updated = existing.map(item => {
        const key = this._getItemKey(store, item);
        return itemMap.has(key) ? itemMap.get(key) : item;
      }) as unknown[];

      // Add any new items that weren't in the existing array
      const existingKeys = new Set(existing.map(item => this._getItemKey(store, item)));
      (items as Record<string, unknown>[]).forEach(item => {
        const key = this._getItemKey(store, item);
        if (!existingKeys.has(key)) {
          updated.push(item);
        }
      });

      return safeStorage.setJSON(storeKey, updated);
    } catch (err) {
      console.error(`LocalStorage updateBatch error for ${store}:`, err);
      return false;
    }
  }

  async deleteBatch(store: StoreName, keys: string[]): Promise<boolean> {
    try {
      const storeKey = this._getStoreKey(store);
      const existing = safeStorage.getJSON(storeKey, []) as Record<string, unknown>[];
      const keySet = new Set(keys);
      const filtered = existing.filter(item => !keySet.has(this._getItemKey(store, item)));
      return safeStorage.setJSON(storeKey, filtered);
    } catch (err) {
      console.error(`LocalStorage deleteBatch error for ${store}:`, err);
      return false;
    }
  }

  // ==========================================
  // EXPORT/IMPORT OPERATIONS
  // ==========================================

  async exportAll(): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};

    // Export all stores
    for (const storeName of Object.values(STORES)) {
      data[storeName] = await this.getAll(storeName as StoreName);
    }

    // Export settings
    const settings: Record<string, unknown> = {};
    for (const settingsKey of Object.values(SETTINGS_KEYS)) {
      const value = safeStorage.getJSON(this._getSettingsKey(settingsKey), undefined);
      if (value !== undefined) {
        settings[settingsKey] = value;
      }
    }
    data.settings = settings;

    return data;
  }

  async importAll(data: Record<string, unknown>, overwrite: boolean = false): Promise<boolean> {
    try {
      // Clear if overwrite mode
      if (overwrite) {
        for (const storeName of Object.values(STORES)) {
          await this.clear(storeName as StoreName);
        }
      }

      // Import each store
      for (const storeName of Object.values(STORES)) {
        const items = data[storeName];
        if (items) {
          if (overwrite) {
            const storeKey = this._getStoreKey(storeName as StoreName);
            safeStorage.setJSON(storeKey, items);
          } else {
            await this.updateBatch(storeName as StoreName, items as unknown[]);
          }
        }
      }

      // Import settings
      if (data.settings && typeof data.settings === 'object') {
        for (const [key, value] of Object.entries(data.settings as Record<string, unknown>)) {
          const lsKey = this._getSettingsKey(key);
          safeStorage.setJSON(lsKey, value);
        }
      }

      return true;
    } catch (err) {
      console.error('LocalStorage import failed:', err);
      return false;
    }
  }

  async clearAll(): Promise<boolean> {
    try {
      // Clear all known keys
      for (const storeName of Object.values(STORES)) {
        localStorage.removeItem(this._getStoreKey(storeName as StoreName));
      }
      for (const settingsKey of Object.values(SETTINGS_KEYS)) {
        localStorage.removeItem(this._getSettingsKey(settingsKey));
      }
      return true;
    } catch (err) {
      console.error('LocalStorage clearAll failed:', err);
      return false;
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Get storage usage estimate
   */
  getStorageUsage(): StorageUsage {
    let totalSize = 0;
    const storeUsage: Record<string, number> = {};

    for (const [storeName, lsKey] of Object.entries(STORE_KEY_MAP)) {
      if (lsKey) {
        const value = localStorage.getItem(lsKey);
        const size = value ? new Blob([value]).size : 0;
        storeUsage[storeName] = size;
        totalSize += size;
      }
    }

    return {
      total: totalSize,
      limit: 5 * 1024 * 1024, // 5MB typical limit
      usage: storeUsage,
      percentUsed: (totalSize / (5 * 1024 * 1024)) * 100
    };
  }
}
