/**
 * Safe Storage Module
 * 
 * Standalone localStorage wrapper with error handling.
 * Extracted to avoid circular dependencies between core modules.
 */

/**
 * Interface for the error handler used by safeStorage
 */
interface StorageErrorHandler {
  handleError(info: { message: string; error: unknown; critical?: boolean; userMessage?: string }): void;
}

let errorHandler: StorageErrorHandler | null = null;

/**
 * Register the error handler instance
 */
export function setStorageErrorHandler(handler: StorageErrorHandler): void {
  errorHandler = handler;
}

/**
 * Returns true when localStorage is available (i.e. we are NOT in a
 * Web Worker, Service Worker, or other restricted context).
 */
const hasLocalStorage = typeof localStorage !== 'undefined';

// ERR-04: In-memory fallback for quota-exceeded or storage-unavailable writes.
// When a localStorage write fails, the value is cached here so the current
// session continues without data loss. Reads check the overlay first, so the
// app sees the "written" value even though it never hit disk. The fallback is
// session-scoped (cleared on page unload) and not synced across tabs.
const _memoryFallback = new Map<string, string>();

/**
 * Safe localStorage wrapper with error handling.
 *
 * Worker-safe: every method gracefully returns a no-op / fallback value
 * when localStorage is unavailable (Web Worker, Service Worker, etc.).
 * This prevents ReferenceErrors when modules that depend on safe-storage
 * are transitively imported into worker threads.
 */
export const safeStorage = {
  getItem(key: string): string | null {
    // ERR-04: Check in-memory fallback first (most recent write wins)
    const fallback = _memoryFallback.get(key);
    if (fallback !== undefined) return fallback;
    if (!hasLocalStorage) return null;
    try {
      return localStorage.getItem(key);
    } catch (error) {
      errorHandler?.handleError({
        message: `Failed to read from localStorage: ${key}`,
        error,
        userMessage: 'Unable to load saved data. Please check your browser settings.'
      });
      return null;
    }
  },

  setItem(key: string, value: string): boolean {
    if (!hasLocalStorage) {
      _memoryFallback.set(key, value);
      return false;
    }
    try {
      localStorage.setItem(key, value);
      // If this key was previously in fallback, clear it since LS now has the value
      _memoryFallback.delete(key);
      return true;
    } catch (error) {
      // ERR-04: Stash in memory so the session doesn't lose data
      _memoryFallback.set(key, value);
      if ((error as DOMException).name === 'QuotaExceededError') {
        errorHandler?.handleError({
          message: `localStorage quota exceeded for key: ${key}`,
          error,
          critical: true,
          userMessage: 'Storage is full! Please export your data and clear old entries.'
        });
      } else {
        errorHandler?.handleError({
          message: `Failed to write to localStorage: ${key}`,
          error,
          userMessage: 'Unable to save data. Please check your browser settings.'
        });
      }
      return false;
    }
  },

  removeItem(key: string): void {
    _memoryFallback.delete(key); // ERR-04: also clear fallback
    if (!hasLocalStorage) return;
    try {
      localStorage.removeItem(key);
    } catch (error) {
      errorHandler?.handleError({
        message: `Failed to remove from localStorage: ${key}`,
        error
      });
    }
  },

  getJSON<T>(key: string, fallback: T): T {
    const value = this.getItem(key);
    if (value === null) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      // CR-Apr24-I finding 268: route malformed-JSON failures through the
      // registered error handler so production gets telemetry, not silence.
      if (import.meta.env.DEV) console.warn(`SafeStorage: Failed to parse JSON for ${key}, using fallback`, error);
      errorHandler?.handleError({
        message: `Failed to parse JSON from localStorage: ${key}`,
        error,
        userMessage: 'Saved data appears corrupted and was reset to defaults.'
      });
      return fallback;
    }
  },

  setJSON(key: string, value: unknown): boolean {
    try {
      return this.setItem(key, JSON.stringify(value));
    } catch (error) {
      // CR-Apr24-I finding 269: route stringify failures through the
      // registered error handler so production gets telemetry.
      if (import.meta.env.DEV) console.warn(`SafeStorage: Failed to stringify JSON for ${key}`, error);
      errorHandler?.handleError({
        message: `Failed to stringify JSON for localStorage: ${key}`,
        error
      });
      return false;
    }
  },

  clear(): void {
    if (!hasLocalStorage) return;
    try {
      localStorage.clear();
    } catch (error) {
      errorHandler?.handleError({
        message: 'Failed to clear localStorage',
        error
      });
    }
  }
};
