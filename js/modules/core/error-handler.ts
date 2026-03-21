/**
 * Error Handler Module
 * Provides centralized error handling and recovery mechanisms (Backwards compatibility wrapper)
 * 
 * @module error-handler
 * @deprecated Use ErrorTracker.ts instead
 */

import {
  trackError,
  getStoredErrors,
  clearErrorLog as clearTrackerLog,
  onError as onTrackerError,
  displayError
} from './error-tracker.js';
import DOM from './dom-cache.js';
import { esc } from './utils-dom.js';
import { safeStorage, setStorageErrorHandler } from './safe-storage.js';

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

/**
 * Backwards compatibility alias
 */
export type ErrorLogEntry = any;
export type ErrorListener = (errorInfo: ErrorInfo) => void;

type ToastType = 'error' | 'info' | 'warning';

// ==========================================
// ERROR HANDLER CLASS
// ==========================================

class ErrorHandler {
  private listeners = new Set<ErrorListener>();

  constructor() {
    // ErrorTracker handles its own global initialization
    onTrackerError((tracked) => {
      this.notifyListeners({
        message: tracked.message,
        error: new Error(tracked.message),
        critical: tracked.type === 'unhandledRejection'
      });
    });
  }

  handleError(errorInfo: ErrorInfo): void {
    const err = errorInfo.error instanceof Error ? errorInfo.error : new Error(errorInfo.message);
    
    trackError(err, {
      module: errorInfo.source || 'ErrorHandler',
      action: 'manual_handle'
    });

    if (errorInfo.critical || errorInfo.userMessage) {
      displayError(err, {
        userMessage: errorInfo.userMessage,
        context: { module: errorInfo.source }
      });
    }
  }

  showUserNotification(message: string, type: ToastType = 'error'): void {
    import('../ui/core/ui.js').then(({ showToast }) => showToast(message, type));
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
        if (import.meta.env.DEV) console.warn('Error in error listener:', e);
      }
    });
  }

  getRecentErrors(count = 10): any[] {
    return getStoredErrors().slice(-count);
  }

  clearErrorLog(): void {
    clearTrackerLog();
  }
}

// ==========================================
// GLOBAL ERROR HANDLER INSTANCE
// ==========================================

// Global error handler instance
export const errorHandler = new ErrorHandler();

// Register with safeStorage to maintain error reporting
setStorageErrorHandler(errorHandler);

export { safeStorage };

// withErrorHandling and tryCatch wrappers removed - unused throughout codebase.
// Error handling is done inline where context-specific recovery is needed.
// Error handling is done inline where context-specific recovery is needed.

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
