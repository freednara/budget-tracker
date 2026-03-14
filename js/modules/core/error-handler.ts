/**
 * Error Handler Module
 * Provides centralized error handling and recovery mechanisms
 *
 * @module error-handler
 */

import DOM from './dom-cache.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ErrorInfo {
  message: string;
  source?: string;
  line?: number;
  column?: number;
  error?: Error | unknown;
  critical?: boolean;
  userMessage?: string;
}

export interface ErrorLogEntry extends ErrorInfo {
  timestamp: string;
}

export type ErrorListener = (errorInfo: ErrorInfo) => void;

type ToastType = 'error' | 'info';

// ==========================================
// ERROR HANDLER CLASS
// ==========================================

class ErrorHandler {
  private errorLog: ErrorLogEntry[] = [];
  private maxLogSize = 100;
  private listeners = new Set<ErrorListener>();

  constructor() {
    this.setupGlobalHandler();
  }

  private setupGlobalHandler(): void {
    window.addEventListener('error', (event: ErrorEvent) => {
      this.handleError({
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error
      });
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      this.handleError({
        message: `Unhandled Promise: ${event.reason}`,
        error: event.reason
      });
    });
  }

  handleError(errorInfo: ErrorInfo): void {
    this.logError(errorInfo);
    this.notifyListeners(errorInfo);

    if (errorInfo.critical) {
      this.showUserNotification(errorInfo.userMessage || 'An error occurred. Your data is safe.');
    }
  }

  private logError(errorInfo: ErrorInfo): void {
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      ...errorInfo
    };

    this.errorLog.push(entry);

    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog.shift();
    }

    if (console && console.warn) {
      console.warn('Error logged:', entry);
    }
  }

  showUserNotification(message: string, type: ToastType = 'error'): void {
    const existingToast = DOM.get('error-toast');
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'error-toast';
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-icon">${type === 'error' ? '⚠️' : 'ℹ️'}</span>
        <span class="toast-message">${this.escapeHtml(message)}</span>
        <button class="toast-close">×</button>
      </div>
    `;

    // Use addEventListener instead of inline onclick for CSP compliance
    const closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => toast.remove());
    }

    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  addListener(callback: ErrorListener): void {
    this.listeners.add(callback);
  }

  removeListener(callback: ErrorListener): void {
    this.listeners.delete(callback);
  }

  private notifyListeners(errorInfo: ErrorInfo): void {
    this.listeners.forEach(callback => {
      try {
        callback(errorInfo);
      } catch (e) {
        console.warn('Error in error listener:', e);
      }
    });
  }

  getRecentErrors(count = 10): ErrorLogEntry[] {
    return this.errorLog.slice(-count);
  }

  clearErrorLog(): void {
    this.errorLog = [];
  }
}

// ==========================================
// GLOBAL ERROR HANDLER INSTANCE
// ==========================================

// Global error handler instance
export const errorHandler = new ErrorHandler();

// ==========================================
// SAFE STORAGE WRAPPER
// ==========================================

/**
 * Safe localStorage wrapper with error handling
 */
export const safeStorage = {
  getItem(key: string): string | null {
    try {
      const value = localStorage.getItem(key);
      return value;
    } catch (error) {
      errorHandler.handleError({
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
        errorHandler.handleError({
          message: `localStorage quota exceeded for key: ${key}`,
          error,
          critical: true,
          userMessage: 'Storage is full! Please export your data and clear old entries.'
        });
      } else {
        errorHandler.handleError({
          message: `Failed to write to localStorage: ${key}`,
          error,
          userMessage: 'Unable to save data. Please check your browser settings.'
        });
      }
      return false;
    }
  },

  removeItem(key: string): boolean {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      errorHandler.handleError({
        message: `Failed to remove from localStorage: ${key}`,
        error
      });
      return false;
    }
  },

  clear(): boolean {
    try {
      localStorage.clear();
      return true;
    } catch (error) {
      errorHandler.handleError({
        message: 'Failed to clear localStorage',
        error,
        userMessage: 'Unable to clear storage. Please try again.'
      });
      return false;
    }
  },

  getJSON<T>(key: string, defaultValue: T): T {
    try {
      const value = this.getItem(key);
      if (value === null) return defaultValue;
      return JSON.parse(value) as T;
    } catch (error) {
      errorHandler.handleError({
        message: `Failed to parse JSON from localStorage: ${key}`,
        error
      });
      return defaultValue;
    }
  },

  setJSON(key: string, value: unknown): boolean {
    try {
      const json = JSON.stringify(value);
      return this.setItem(key, json);
    } catch (error) {
      errorHandler.handleError({
        message: `Failed to stringify JSON for localStorage: ${key}`,
        error
      });
      return false;
    }
  }
};

// ==========================================
// ERROR HANDLING WRAPPERS
// ==========================================

interface WithErrorHandlingOptions {
  message?: string;
  critical?: boolean;
  userMessage?: string;
  fallback?: unknown;
}

/**
 * Wrap async functions with error handling
 */
export function withErrorHandling<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: WithErrorHandlingOptions = {}
): (...args: Parameters<T>) => Promise<ReturnType<T> | unknown> {
  return async function(this: unknown, ...args: Parameters<T>): Promise<ReturnType<T> | unknown> {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      errorHandler.handleError({
        message: options.message || `Error in ${fn.name || 'anonymous function'}`,
        error,
        critical: options.critical,
        userMessage: options.userMessage
      });

      if (options.fallback !== undefined) {
        return options.fallback;
      }

      throw error;
    }
  };
}

/**
 * Wrap sync functions with error handling
 */
export function tryCatch<T>(fn: () => T, fallback: T | null = null): T | null {
  try {
    return fn();
  } catch (error) {
    errorHandler.handleError({
      message: `Error in sync operation`,
      error
    });
    return fallback;
  }
}

// ==========================================
// TOAST STYLES
// ==========================================

// Add toast styles if not present
if (!DOM.get('error-handler-styles')) {
  const style = document.createElement('style');
  style.id = 'error-handler-styles';
  style.textContent = `
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      animation: slide-in 0.3s ease;
    }

    .toast-content {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--surface, #fff);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      border-left: 4px solid var(--color-expense, #e74c3c);
      max-width: 400px;
    }

    .toast-error .toast-content {
      border-left-color: var(--color-expense, #e74c3c);
    }

    .toast-info .toast-content {
      border-left-color: var(--color-income, #27ae60);
    }

    .toast-icon {
      font-size: 20px;
    }

    .toast-message {
      flex: 1;
      color: var(--text-primary, #000);
      font-size: 14px;
    }

    .toast-close {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--text-secondary, #666);
      padding: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .toast-close:hover {
      color: var(--text-primary, #000);
    }

    .toast-fade-out {
      animation: slide-out 0.3s ease forwards;
    }

    @keyframes slide-in {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes slide-out {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }

    @media (max-width: 480px) {
      .toast {
        left: 10px;
        right: 10px;
        top: 10px;
      }

      .toast-content {
        max-width: none;
      }
    }
  `;
  document.head.appendChild(style);
}

export default errorHandler;
