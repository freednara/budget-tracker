/**
 * Tests for error-handler.ts
 * Verifies error routing, listener management, toast notifications, and cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ==========================================
// MOCKS
// ==========================================

const {
  trackErrorMock, getStoredErrorsMock, clearTrackerLogMock,
  onTrackerErrorMock, displayErrorMock, emitMock
} = vi.hoisted(() => ({
  trackErrorMock: vi.fn(),
  getStoredErrorsMock: vi.fn((): unknown[] => []),
  clearTrackerLogMock: vi.fn(),
  onTrackerErrorMock: vi.fn(),
  displayErrorMock: vi.fn(),
  emitMock: vi.fn()
}));

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: trackErrorMock,
  getStoredErrors: getStoredErrorsMock,
  clearErrorLog: clearTrackerLogMock,
  onError: onTrackerErrorMock,
  displayError: displayErrorMock
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  default: { get: vi.fn(() => null) },
  DOM: { get: vi.fn(() => null) }
}));

vi.mock('../js/modules/core/utils-dom.js', () => ({
  esc: vi.fn((s: string) => s)
}));

vi.mock('../js/modules/core/safe-storage.js', () => ({
  safeStorage: {},
  setStorageErrorHandler: vi.fn()
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: emitMock,
  Events: { SHOW_TOAST: 'SHOW_TOAST' }
}));

import { errorHandler } from '../js/modules/core/error-handler.js';

// Capture the onError callback registered at module init (before clearAllMocks wipes it)
const onErrorCallback = onTrackerErrorMock.mock.calls[0]?.[0] as ((tracked: { message: string; type: string }) => void) | undefined;

// ==========================================
// TESTS
// ==========================================

describe('ErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorHandler.clearListeners();
  });

  afterEach(() => {
    errorHandler.clearListeners();
  });

  describe('handleError', () => {
    it('tracks the error via ErrorTracker', () => {
      const err = new Error('test failure');
      errorHandler.handleError({ message: 'test failure', error: err, source: 'TestModule' });

      expect(trackErrorMock).toHaveBeenCalledWith(err, {
        module: 'TestModule',
        action: 'manual_handle'
      });
    });

    it('uses ErrorHandler as default source when none provided', () => {
      errorHandler.handleError({ message: 'no source' });

      expect(trackErrorMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ module: 'ErrorHandler' })
      );
    });

    it('creates Error from message when error is not an Error instance', () => {
      errorHandler.handleError({ message: 'string error', error: 'not an error' });

      expect(trackErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'string error' }),
        expect.any(Object)
      );
    });

    it('displays error when critical flag is set', () => {
      const err = new Error('critical');
      errorHandler.handleError({ message: 'critical', error: err, critical: true, source: 'Core' });

      expect(displayErrorMock).toHaveBeenCalledWith(err, {
        userMessage: undefined,
        context: { module: 'Core' }
      });
    });

    it('displays error when userMessage is provided', () => {
      const err = new Error('issue');
      errorHandler.handleError({
        message: 'issue',
        error: err,
        userMessage: 'Something went wrong'
      });

      expect(displayErrorMock).toHaveBeenCalledWith(err, {
        userMessage: 'Something went wrong',
        context: { module: undefined }
      });
    });

    it('does not display error for non-critical errors without userMessage', () => {
      errorHandler.handleError({ message: 'silent error' });

      expect(displayErrorMock).not.toHaveBeenCalled();
    });
  });

  describe('showUserNotification', () => {
    it('emits SHOW_TOAST with error type by default', () => {
      errorHandler.showUserNotification('Something failed');

      expect(emitMock).toHaveBeenCalledWith('SHOW_TOAST', {
        message: 'Something failed',
        type: 'error'
      });
    });

    it('emits SHOW_TOAST with specified type', () => {
      errorHandler.showUserNotification('Heads up', 'warning');

      expect(emitMock).toHaveBeenCalledWith('SHOW_TOAST', {
        message: 'Heads up',
        type: 'warning'
      });
    });
  });

  describe('listener management', () => {
    it('notifies registered listeners on handleError', () => {
      const listener = vi.fn();
      errorHandler.addListener(listener);

      // Trigger via the onTrackerError callback captured at module init
      expect(onErrorCallback).toBeDefined();

      onErrorCallback!({ message: 'unhandled', type: 'unhandledRejection' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'unhandled',
          critical: true
        })
      );
    });

    it('removes a listener via removeListener', () => {
      const listener = vi.fn();
      errorHandler.addListener(listener);
      errorHandler.removeListener(listener);

      onErrorCallback!({ message: 'test', type: 'error' });

      expect(listener).not.toHaveBeenCalled();
    });

    it('clears all listeners via clearListeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      errorHandler.addListener(listener1);
      errorHandler.addListener(listener2);
      errorHandler.clearListeners();

      onErrorCallback!({ message: 'test', type: 'error' });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('handles errors thrown by listeners gracefully', () => {
      const badListener = vi.fn(() => { throw new Error('listener broke'); });
      const goodListener = vi.fn();
      errorHandler.addListener(badListener);
      errorHandler.addListener(goodListener);

      expect(() => onErrorCallback!({ message: 'test', type: 'error' })).not.toThrow();

      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe('getRecentErrors', () => {
    it('returns last N errors from tracker', () => {
      const errors: unknown[] = Array.from({ length: 15 }, (_, i) => ({ message: `err${i}` }));
      getStoredErrorsMock.mockReturnValue(errors);

      const recent = errorHandler.getRecentErrors(5);

      expect(recent).toHaveLength(5);
      expect(recent[0]).toEqual({ message: 'err10' });
      expect(recent[4]).toEqual({ message: 'err14' });
    });

    it('defaults to 10 errors', () => {
      const errors: unknown[] = Array.from({ length: 20 }, (_, i) => ({ message: `err${i}` }));
      getStoredErrorsMock.mockReturnValue(errors);

      const recent = errorHandler.getRecentErrors();
      expect(recent).toHaveLength(10);
    });
  });

  describe('clearErrorLog', () => {
    it('delegates to error tracker clearErrorLog', () => {
      errorHandler.clearErrorLog();
      expect(clearTrackerLogMock).toHaveBeenCalled();
    });
  });
});
