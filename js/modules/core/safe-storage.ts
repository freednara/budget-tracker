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
  handleError(info: { message: string; error: any; critical?: boolean; userMessage?: string }): void;
}

let errorHandler: StorageErrorHandler | null = null;

/**
 * Register the error handler instance
 */
export function setStorageErrorHandler(handler: StorageErrorHandler): void {
  errorHandler = handler;
}

/**
 * Safe localStorage wrapper with error handling
 */
export const safeStorage = {
  getItem(key: string): string | null {
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
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
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
      if (import.meta.env.DEV) console.warn(`SafeStorage: Failed to parse JSON for ${key}, using fallback`, error);
      return fallback;
    }
  },

  setJSON(key: string, value: unknown): boolean {
    try {
      return this.setItem(key, JSON.stringify(value));
    } catch (error) {
      if (import.meta.env.DEV) console.warn(`SafeStorage: Failed to stringify JSON for ${key}`, error);
      return false;
    }
  },

  clear(): void {
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
