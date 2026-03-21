/**
 * Auto-Lock Module - Automatic screen lock on inactivity
 *
 * Listens for user activity events and triggers a lock callback
 * after a configurable period of inactivity. Only active when a PIN is set.
 *
 * @module auto-lock
 */
'use strict';

import { CONFIG } from '../../core/config.js';

// ==========================================
// MODULE STATE
// ==========================================

let timerId: ReturnType<typeof setTimeout> | null = null;
let paused = false;
let currentTimeoutMs: number = CONFIG.AUTO_LOCK.TIMEOUT_MS;
let lockCallback: (() => void) | null = null;

const ACTIVITY_EVENTS: readonly string[] = ['click', 'keydown', 'touchstart', 'scroll'];

// ==========================================
// INTERNAL HELPERS
// ==========================================

function onActivity(): void {
  if (paused) return;
  scheduleTimer();
}

function scheduleTimer(): void {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  timerId = setTimeout(() => {
    if (!paused && lockCallback) {
      lockCallback();
    }
  }, currentTimeoutMs);
}

function addListeners(): void {
  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, onActivity, { passive: true });
  }
}

function removeListeners(): void {
  for (const event of ACTIVITY_EVENTS) {
    window.removeEventListener(event, onActivity);
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Initialize auto-lock. Starts listening for activity immediately.
 *
 * @param onLock - Callback invoked when the inactivity timeout fires
 * @param timeoutMs - Override the default timeout (default: CONFIG.AUTO_LOCK.TIMEOUT_MS)
 * @returns A cleanup function that removes all listeners and clears timers
 */
export function initAutoLock(onLock: () => void, timeoutMs?: number): () => void {
  // Clean up any previous instance
  cleanup();

  lockCallback = onLock;
  currentTimeoutMs = timeoutMs ?? CONFIG.AUTO_LOCK.TIMEOUT_MS;
  paused = false;

  addListeners();
  scheduleTimer();

  return cleanup;
}

/**
 * Reset the inactivity timer (e.g. after programmatic activity).
 */
export function resetAutoLockTimer(): void {
  if (!paused && lockCallback) {
    scheduleTimer();
  }
}

/**
 * Pause auto-lock (e.g. while a modal is open).
 * The timer is cleared but listeners remain attached.
 */
export function pauseAutoLock(): void {
  paused = true;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

/**
 * Resume auto-lock after a pause. Restarts the timer.
 */
export function resumeAutoLock(): void {
  paused = false;
  if (lockCallback) {
    scheduleTimer();
  }
}

/**
 * Full cleanup — remove listeners, clear timer, reset state.
 */
function cleanup(): void {
  removeListeners();
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  paused = false;
  lockCallback = null;
}
