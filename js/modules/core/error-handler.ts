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
  displayError,
  type TrackedError
} from './error-tracker.js';
import DOM from './dom-cache.js';
import { safeStorage, setStorageErrorHandler } from './safe-storage.js';
import { emit, Events } from './event-bus.js';

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
 * Backwards compatibility alias — historically `ErrorLogEntry` was an
 * untyped record; widened to `unknown` under Phase 6 cleanup. Callers
 * that need strong typing should import `ErrorInfo` directly.
 */
export type ErrorLogEntry = unknown;
export type ErrorListener = (errorInfo: ErrorInfo) => void;

type ToastType = 'error' | 'info' | 'warning';

// ==========================================
// ERROR HANDLER CLASS
// ==========================================

/**
 * Centralised error handler.
 *
 * Routes errors to the error tracker, displays user-facing toasts, and
 * notifies registered listeners. Listens for global unhandled rejections
 * via the `ErrorTracker` callback.
 */
class ErrorHandler {
  private listeners = new Set<ErrorListener>();

  /** Subscribes to unhandled-rejection events from the global `ErrorTracker`. */
  constructor() {
    onTrackerError((tracked) => {
      this.notifyListeners({
        message: tracked.message,
        error: new Error(tracked.message),
        critical: tracked.type === 'unhandledRejection'
      });
    });
  }

  /** Track an error and optionally show a user-facing notification. */
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

    // CR-Apr24-I finding 294: broadcast to registered listeners so
    // consumers using addListener() see manually handled errors too.
    this.notifyListeners(errorInfo);
  }

  /** Display a toast notification to the user via the UI bridge. */
  showUserNotification(message: string, type: ToastType = 'error'): void {
    emit(Events.SHOW_TOAST, { message, type });
  }

  /** Register a callback that is invoked whenever an error is handled. */
  addListener(callback: ErrorListener): void {
    this.listeners.add(callback);
    if (import.meta.env.DEV && this.listeners.size > 20) {
      console.warn(`[ErrorHandler] ${this.listeners.size} listeners registered — possible leak`);
    }
  }

  /** Remove a previously registered error listener. */
  removeListener(callback: ErrorListener): void {
    this.listeners.delete(callback);
  }

  /** Remove all registered error listeners. */
  clearListeners(): void {
    this.listeners.clear();
  }

  private notifyListeners(errorInfo: ErrorInfo): void {
    // Snapshot to protect against concurrent add/remove/clear during iteration
    const snapshot = Array.from(this.listeners);
    for (const callback of snapshot) {
      try {
        callback(errorInfo);
      } catch (e) {
        if (import.meta.env.DEV) console.warn('Error in error listener:', e);
      }
    }
  }

  /** Return the most recent tracked errors (newest last). */
  getRecentErrors(count = 10): TrackedError[] {
    return getStoredErrors().slice(-count);
  }

  /** Clear the persisted error log. */
  clearErrorLog(): void {
    clearTrackerLog();
  }
}

// ==========================================
// GLOBAL ERROR HANDLER INSTANCE
// ==========================================

/** Application-wide singleton error handler. */
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
      z-index: var(--z-pin);
      animation: slide-in var(--duration-slow) var(--ease-default);
    }

    .toast-content {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--surface, #fff);
      border-radius: 8px;
      box-shadow: var(--shadow-card);
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
