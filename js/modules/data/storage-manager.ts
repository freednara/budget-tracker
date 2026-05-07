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
import { trackError } from '../core/error-tracker.js';
import { generateSecureId } from '../core/utils-dom.js';

/** Tag the error so dashboards can filter storage-quota exhaustion events. */
function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number };
  return e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 || e.code === 1014;
}
import type {
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
  _exportErrors?: Record<string, string>;
}

interface StorageStats {
  initialized: boolean;
  type?: StorageType | null;
  [key: string]: unknown;
}

const VALID_SYNC_TYPES = new Set<SyncMessage['type']>([
  'create',
  'update',
  'delete',
  'batch',
  'clear'
]);

const VALID_SYNC_STORES = new Set<StoreName | 'all'>([
  ...Object.values(STORES),
  'all'
]);

const MAX_SYNC_MESSAGE_AGE_MS = 5 * 60 * 1000;
const MAX_SYNC_FUTURE_SKEW_MS = 10 * 1000;

/**
 * CR-Apr22 (slice 1 — finding #2, settings-shape mismatch on rollback):
 *
 * Cross-adapter export shape translation. Rollback feeds the IndexedDB
 * export directly to `LocalStorageAdapter.importAll()`, but the two
 * adapters disagree on the shape of the `settings` payload:
 *
 *   - IndexedDB `exportAll()` iterates every `STORES.*` including
 *     `STORES.SETTINGS` and calls `getAll()` — which returns an **array
 *     of `{key, value}` rows** keyed by the `key` IDB primary key.
 *   - LocalStorage `importAll()` consumes `data.settings` as a
 *     **keyed object** (`{theme: 'dark', currency: {...}, ...}`) and
 *     writes each entry through `_getSettingsKey(key)` →
 *     `SETTINGS_KEY_MAP` → the canonical `harbor_*` keys consumed by
 *     the app.
 *
 * Without translation, LS `importAll()` would enter its
 * `Object.entries(data.settings)` branch with an array, yielding entries
 * like `['0', {key: 'theme', value: 'dark'}]` — writing to
 * `harbor_0`, `harbor_1`, ... (keys no consumer reads) while every real
 * `harbor_theme`, `harbor_currency`, ... stays unwritten. The user reboots
 * onto LS with all settings defaulted and the IDB export effectively
 * lost. This helper is the single normalization point so the shape
 * divergence cannot recur at other IDB→LS handoffs.
 *
 * Returns a **new** payload; never mutates the input so callers retain
 * the raw export for diagnostic logging / partial-failure markers.
 */
export function normalizeIdbExportForLocalStorage(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const rawSettings = data.settings;

  if (Array.isArray(rawSettings)) {
    const settingsObject: Record<string, unknown> = {};
    for (const row of rawSettings) {
      if (row && typeof row === 'object') {
        const r = row as { key?: unknown; value?: unknown };
        if (typeof r.key === 'string' && r.key.length > 0) {
          // `value` may legitimately be any JSON-serializable shape
          // (booleans, numbers, nested objects). Preserve as-is.
          settingsObject[r.key] = r.value;
        }
      }
    }
    out.settings = settingsObject;
  }

  return out;
}

// ==========================================
// STORAGE MANAGER CLASS
// ==========================================

class StorageManager {
  private adapter: StorageAdapter | null = null;
  private type: StorageType | null = null;
  private syncChannel: BroadcastChannel | null = null;
  private storageSyncHandler: ((event: StorageEvent) => void) | null = null;
  private _tabId: string;
  private _errorCount: number = 0;
  private _initialized: boolean = false;
  private _syncMessageCounter: number = 0;
  /**
   * CR-Apr22 (slice 1 — finding #1, rollback re-trigger loop):
   * Once we've attempted rollback and recorded a failure marker (partial
   * export, LS init failure, LS importAll failure), we must not keep
   * firing `_triggerRollback` every time a subsequent IDB write fails —
   * that used to produce a hot loop of export-then-fail, spamming logs
   * and wasting a full data export on every single write error.
   *
   * The marker is a one-shot promise: "on the next boot, force LS
   * fallback" (see `_getRollbackFailureMarker` in `init`). The flag
   * below latches the same promise for the rest of the current session:
   * `_handleError` continues to emit per-op errors but `_triggerRollback`
   * short-circuits once rollback has already been attempted.
   */
  private _rollbackAttempted: boolean = false;
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

    const rollbackFailure = this._getRollbackFailureMarker();
    if (rollbackFailure) {
      const lsFallback = await this._initLocalStorageAdapter();
      if (lsFallback.isOk) {
        // New-batch P2: the marker was previously written once and
        // never cleared, which pinned the app on localStorage forever —
        // even after a successful recovery session. The marker is a
        // one-shot hint: "on the next boot, skip IDB and go straight
        // to LS". Once that boot has succeeded via LS we can safely
        // drop it so a future boot may attempt IDB again. If IDB is
        // still broken, the normal fallback path handles it. Retaining
        // the raw details in-memory avoids losing the diagnostic
        // context for the current session.
        try {
          localStorage.removeItem('harbor_storage_rollback_failed');
        } catch (err) {
          if (import.meta.env.DEV) console.warn('Failed to clear rollback-failure marker:', err);
        }
        if (import.meta.env.DEV) {
          console.warn(
            'Storage: forced localStorage fallback after prior rollback failure',
            rollbackFailure
          );
        }
        return lsFallback;
      }
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
    const fallbackResult = await this._initLocalStorageAdapter();
    if (fallbackResult.isOk) {
      return fallbackResult;
    }

    if (import.meta.env.DEV) console.error('Storage: No storage backend available');
    return { isOk: false, type: null, error: 'No storage backend available' };
  }

  private async _initLocalStorageAdapter(): Promise<InitResult> {
    const lsAdapter = new LocalStorageAdapter();
    if (lsAdapter.isAvailable()) {
      const result = await lsAdapter.init();

      if (result.isOk) {
        this.adapter = lsAdapter;
        this.type = 'localstorage';
        this._initialized = true;
        this._setupLocalStorageSync();
        return { isOk: true, type: 'localstorage' };
      }
    }

    return { isOk: false, type: null, error: 'No localStorage backend available' };
  }

  private _getRollbackFailureMarker():
    | { reason?: string; timestamp?: number; exportErrors?: Record<string, string> }
    | null {
    try {
      const stored = localStorage.getItem('harbor_storage_rollback_failed');
      if (!stored) return null;
      return JSON.parse(stored) as { reason?: string; timestamp?: number; exportErrors?: Record<string, string> };
    } catch {
      return null;
    }
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
      this.syncChannel = new BroadcastChannel('harbor_sync');

      this.syncChannel.onmessage = (event: MessageEvent<SyncMessage | { type: 'force_close_for_reset'; senderTabId?: string }>) => {
        // Round 7 fix: handle reset force-close signal from sibling tab.
        // Close our IDB connections so the resetting tab can deleteDatabase().
        // CR-May01: skip the message when it was sent by THIS tab — the
        // resetting tab must NOT close its own IDB connection; it needs the
        // connection alive for `storageManager.clearAll()` to succeed.
        if (event.data && typeof event.data === 'object' && (event.data as { type: string }).type === 'force_close_for_reset') {
          const sender = (event.data as { senderTabId?: string }).senderTabId;
          if (sender && sender === this._tabId) {
            // Message from ourselves — ignore.
            return;
          }
          if (import.meta.env.DEV) console.info('[storage-manager] Received force_close_for_reset — closing IDB and reloading');
          this._closeAllConnections();
          // Reload after a brief delay to let the resetting tab proceed
          setTimeout(() => window.location.reload(), 500);
          return;
        }
        this._handleSyncMessage(event.data as SyncMessage);
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
    if (this.storageSyncHandler) {
      window.removeEventListener('storage', this.storageSyncHandler);
    }

    this.storageSyncHandler = (event: StorageEvent) => {
      if (event.key?.startsWith('harbor_sync_')) {
        try {
          const message = JSON.parse(event.newValue || '') as SyncMessage;
          this._handleSyncMessage(message);
        } catch {
          // Ignore parse errors
        }
      }
    };

    window.addEventListener('storage', this.storageSyncHandler);
  }

  /**
   * Handle incoming sync messages from other tabs
   */
  private _handleSyncMessage(message: SyncMessage): void {
    if (!this._isValidSyncMessage(message)) {
      if (import.meta.env.DEV) console.warn('Ignoring invalid storage sync payload', message);
      return;
    }

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

  private _isValidSyncMessage(message: unknown): message is SyncMessage {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const candidate = message as Partial<SyncMessage>;
    if (!VALID_SYNC_TYPES.has(candidate.type as SyncMessage['type'])) {
      return false;
    }

    if (!VALID_SYNC_STORES.has(candidate.store as StoreName | 'all')) {
      return false;
    }

    if (typeof candidate.tabId !== 'string' || candidate.tabId.trim().length === 0) {
      return false;
    }

    if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) {
      return false;
    }

    const now = Date.now();
    if (candidate.timestamp < now - MAX_SYNC_MESSAGE_AGE_MS) {
      return false;
    }

    if (candidate.timestamp > now + MAX_SYNC_FUTURE_SKEW_MS) {
      return false;
    }

    return true;
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
   *
   * Fixes H1 (Inline-Behavior-Review rev 12): previously both catches
   * were empty. The outer catch silently dropped the entire cross-tab
   * broadcast (so remote tabs never heard about the change); the inner
   * silently leaked `harbor_sync_*` keys under a tight quota. Both now
   * route through `trackError`; QuotaExceededError is annotated on the
   * action string so it can be filtered in error-tracker dashboards.
   */
  private _broadcastViaLocalStorage(message: SyncMessage): void {
    const key = `harbor_sync_${Date.now()}_${this._tabId}_${this._syncMessageCounter++}`;
    try {
      localStorage.setItem(key, JSON.stringify(message));
      // Clean up after a short delay
      setTimeout(() => {
        try {
          localStorage.removeItem(key);
        } catch (cleanupErr: unknown) {
          // Orphan key left behind — log so we can see if this accumulates.
          const quota = isQuotaExceeded(cleanupErr) ? '.quota' : '';
          trackError(cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)), {
            module: 'storage-manager',
            action: `broadcastViaLocalStorage.cleanup${quota}`
          });
        }
      }, 1000);
    } catch (err: unknown) {
      const quota = isQuotaExceeded(err) ? '.quota' : '';
      trackError(err instanceof Error ? err : new Error(String(err)), {
        module: 'storage-manager',
        action: `broadcastViaLocalStorage${quota}`
      });
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

  async replaceTransactionWithSplits(originalId: string, splits: Transaction[]): Promise<boolean> {
    this._checkInitialized();
    try {
      let result = false;

      if (this.adapter instanceof IndexedDBAdapter) {
        result = await this.adapter.replaceTransactionWithSplits(originalId, splits);
      } else {
        const existingTransactions = await this.adapter!.getAll(STORES.TRANSACTIONS) as Transaction[];
        const originalIndex = existingTransactions.findIndex((transaction) => transaction.__backendId === originalId);
        if (originalIndex < 0) {
          return false;
        }
        const nextTransactions = [
          ...existingTransactions.slice(0, originalIndex),
          ...splits,
          ...existingTransactions.slice(originalIndex + 1)
        ];
        result = await this.adapter!.importAll({ [STORES.TRANSACTIONS]: nextTransactions }, true);
      }

      if (result) {
        this._errorCount = 0;
        this.broadcastChange('batch', STORES.TRANSACTIONS, {
          type: 'split',
          count: splits.length,
          originalId
        });
      }

      return result;
    } catch (err) {
      this._handleError(err, 'replaceTransactionWithSplits', STORES.TRANSACTIONS);
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

    // CR-Apr22 (slice 1 — finding #1): `_rollbackAttempted` short-circuits
    // the threshold check so a failed rollback does not keep re-triggering
    // a full export+import attempt on every subsequent failing write.
    if (
      this._errorCount >= this.ERROR_THRESHOLD &&
      this.type === 'indexeddb' &&
      !this._rollbackAttempted
    ) {
      void this._triggerRollback();
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
      const data = await this.adapter!.exportAll() as ExportData;
      const exportErrors = data._exportErrors || {};
      if (Object.keys(exportErrors).length > 0) {
        this._recordRollbackFailure({
          reason: 'partial_export',
          timestamp: Date.now(),
          exportErrors
        });
        // CR-Apr22 (slice 1 — finding #1): latch the attempt and clear
        // the error count. Without these, every subsequent failing IDB
        // write would re-increment past the threshold and re-enter this
        // method, producing a hot loop of re-exports. The design choice
        // to refuse partial-snapshot import is intentional — the marker
        // ensures the NEXT boot forces LS fallback (see `init`) — but the
        // current session must not keep trying to roll back over and over.
        this._rollbackAttempted = true;
        this._errorCount = 0;
        return;
      }

      const importableData: Record<string, unknown> = { ...data };
      delete importableData._meta;
      delete importableData._exportErrors;

      // CR-Apr22 (slice 1 — finding #2): translate IDB export shape
      // (settings as array of `{key, value}` rows) into the LS import
      // shape (settings as keyed object) before handing off. Without
      // this the LS adapter writes every settings row to `harbor_0`,
      // `harbor_1`, ... instead of the canonical `harbor_theme`,
      // `harbor_currency`, ... keys, silently dropping every setting
      // on rollback. See `normalizeIdbExportForLocalStorage` for the
      // full shape-mismatch rationale.
      const normalizedData = normalizeIdbExportForLocalStorage(importableData);

      // Switch to localStorage adapter
      const lsAdapter = new LocalStorageAdapter();
      const initResult = await lsAdapter.init();
      if (!initResult.isOk) {
        throw new Error('Failed to initialize localStorage adapter during rollback');
      }

      // Import data to localStorage
      const importResult = await lsAdapter.importAll(normalizedData, true);
      if (!importResult) {
        throw new Error('Failed to import rollback snapshot into localStorage');
      }

      // Switch adapter
      this.adapter = lsAdapter;
      this.type = 'localstorage';
      this._errorCount = 0;

      // Mark rollback in localStorage
      localStorage.setItem('harbor_storage_rollback', JSON.stringify({
        reason: 'error_threshold',
        timestamp: Date.now(),
        exportErrors
      }));

    } catch (err) {
      if (import.meta.env.DEV) console.error('Storage rollback failed:', err);
      this._recordRollbackFailure({
        reason: err instanceof Error ? err.message : String(err),
        timestamp: Date.now()
      });
      // CR-Apr22 (slice 1 — finding #1): same latch as the partial-export
      // path. Once we've tried and failed, further in-session retriggers
      // are pure waste — the marker takes care of the next boot.
      this._rollbackAttempted = true;
      this._errorCount = 0;
    } finally {
      this._rollbackInProgress = false;
    }
  }

  private _recordRollbackFailure(details: { reason: string; timestamp: number; exportErrors?: Record<string, string> }): void {
    try {
      localStorage.setItem('harbor_storage_rollback_failed', JSON.stringify(details));
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Failed to persist rollback failure details:', err);
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
   * Get the unique tab identifier for this instance.
   * Used by app-reset to tag the force_close_for_reset broadcast so
   * this tab's own listener can ignore the self-sent message.
   */
  getTabId(): string {
    return this._tabId;
  }

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
   * Close all active IDB connections without resetting internal state.
   * Called by sibling tabs in response to a force_close_for_reset signal
   * so the resetting tab can delete the database without being blocked.
   */
  private _closeAllConnections(): void {
    if (this.adapter instanceof IndexedDBAdapter) {
      this.adapter.close();
    }
  }

  /**
   * Reset the storage manager (for testing)
   */
  reset(): void {
    if (this.adapter instanceof IndexedDBAdapter) {
      this.adapter.close();
    }
    if (this.syncChannel) {
      this.syncChannel.close();
      this.syncChannel = null;
    }
    if (this.storageSyncHandler) {
      window.removeEventListener('storage', this.storageSyncHandler);
      this.storageSyncHandler = null;
    }
    this.adapter = null;
    this.type = null;
    this._initialized = false;
    this._errorCount = 0;
    this._syncMessageCounter = 0;
    // CR-Apr22 (slice 1 — finding #1): clear the session latch so tests
    // (and any dev-mode resets) don't inherit a "rollback already attempted"
    // state from a previous run.
    this._rollbackAttempted = false;
    this._rollbackInProgress = false;
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const storageManager = new StorageManager();

// Export STORES for convenience
export { STORES };
