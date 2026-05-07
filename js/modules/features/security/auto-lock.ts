/**
 * Auto-Lock Module - Automatic screen lock on inactivity
 *
 * Listens for user activity events and triggers a lock callback after a
 * configurable period of inactivity. Only active when a PIN is set.
 *
 * Phase 5g-7 Slice 6 (Inline-Behavior-Review rev 12) landed three fixes
 * in this module:
 *
 *   - M17: visibility-change now uses a grace period (default 30s) instead
 *     of firing the lock on every alt-tab. See `onVisibilityChange`.
 *   - M18: activity listeners moved from window-level to document-level
 *     with `capture: true` so inner-container scrolls (transaction list,
 *     modals, detail panel) reach the handler. `pointermove` added as a
 *     throttled activity source. See `addListeners` / `onActivity`.
 *   - M19: cross-tab sync via `BroadcastChannel('auto_lock_sync')`. Mirrors
 *     the proven pattern from `rate-limiter.ts`. See `initSyncChannel` /
 *     `broadcastMessage`. Degrades silently when BroadcastChannel is
 *     unavailable (the fallback to `storage` events the review proposed
 *     is deliberately deferred — neither rate-limiter nor this module
 *     implements it today, so keep the pattern consistent).
 *
 * @module auto-lock
 */
'use strict';

import { CONFIG } from '../../core/config.js';

// ==========================================
// MODULE STATE
// ==========================================

let timerId: ReturnType<typeof setTimeout> | null = null;
// Fixes M17 (Inline-Behavior-Review rev 12): dedicated grace-period timer
// for visibility-change locking. Tracked separately from the main
// inactivity timer so `resetAutoLockTimer` / `pauseAutoLock` / resumption
// don't accidentally clobber a pending hide-lock.
let visibilityLockTimerId: ReturnType<typeof setTimeout> | null = null;
let paused = false;
let currentTimeoutMs: number = CONFIG.AUTO_LOCK.TIMEOUT_MS;
let currentVisibilityDelayMs: number = CONFIG.AUTO_LOCK.VISIBILITY_LOCK_DELAY_MS;
let lockCallback: (() => void) | null = null;

// Fixes M18 (Inline-Behavior-Review rev 12): pointermove fires hundreds of
// times per second when the user is moving the cursor. Throttle to one
// timer-reset per POINTER_ACTIVITY_THROTTLE_MS so we don't churn the
// timer stack. 1 second is enough resolution for a 5-minute lock horizon.
let lastPointerActivityTs = 0;
const POINTER_ACTIVITY_THROTTLE_MS = 1_000;

// Fixes M19 (Inline-Behavior-Review rev 12): activity broadcasts are
// throttled to once per BROADCAST_THROTTLE_MS to avoid flooding the
// channel when the user is actively typing/scrolling. The channel is
// only used for cross-tab keep-alive; losing finer-grain resolution here
// is harmless (the receiver simply resets its own timer on every
// received activity).
let lastActivityBroadcastTs = 0;
const BROADCAST_THROTTLE_MS = 5_000;

// Fixes M18: `scroll` moved from window-level to document-level below;
// `pointermove` added for cursor-hover detection. Listener registration
// uses `capture: true` so events dispatched on descendants reach us
// without relying on bubbling (critical for inner-container scroll and
// for events that don't bubble by default).
const ACTIVITY_EVENTS: readonly string[] = [
  'click',
  'keydown',
  'touchstart',
  'scroll',
  'pointermove'
];

// ==========================================
// CROSS-TAB SYNC (M19)
// ==========================================

type AutoLockMessage = { type: 'lock' | 'activity' };

let syncChannel: BroadcastChannel | null = null;

function initSyncChannel(): void {
  if (syncChannel) return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      // Fixes M19 (Inline-Behavior-Review rev 12): `auto_lock_sync` is a
      // sibling of `pin_rate_limit_sync` (rate-limiter.ts) — same pattern,
      // separate channel so rate-limit broadcasts don't leak into
      // auto-lock handlers and vice-versa.
      syncChannel = new BroadcastChannel('auto_lock_sync');
      syncChannel.onmessage = (event: MessageEvent) => {
        const data = event.data as AutoLockMessage | undefined | null;
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
          return;
        }
        if (data.type === 'lock') {
          // Another tab locked — propagate to this tab without
          // re-broadcasting (which would cause an echo loop across the
          // tab set). BroadcastChannel doesn't echo to the sender, but
          // a third tab could otherwise relay.
          triggerLock({ broadcast: false });
        } else if (data.type === 'activity') {
          // Another tab saw activity — reset this tab's inactivity timer
          // so a user active in one tab keeps all tabs alive. Don't
          // re-broadcast (same echo concern).
          if (!paused && lockCallback) {
            scheduleTimer();
          }
        }
      };
    }
  } catch (e) {
    // BroadcastChannel not available; cross-tab sync disabled.
    // Matches rate-limiter.ts degradation contract.
    if (import.meta.env.DEV) {
      console.debug('[auto-lock] BroadcastChannel init failed:', e);
    }
  }
}

function broadcastMessage(msg: AutoLockMessage): void {
  try {
    syncChannel?.postMessage(msg);
  } catch (e) {
    if (import.meta.env.DEV) {
      console.debug('[auto-lock] Broadcast failed:', e);
    }
  }
}

function closeSyncChannel(): void {
  try {
    syncChannel?.close();
  } catch {
    // ignore
  }
  syncChannel = null;
}

// ==========================================
// INTERNAL HELPERS
// ==========================================

function triggerLock(opts: { broadcast: boolean } = { broadcast: true }): void {
  if (paused || !lockCallback) return;
  // Clear any pending visibility-lock timer — we're locking now, so the
  // grace window is moot.
  if (visibilityLockTimerId !== null) {
    clearTimeout(visibilityLockTimerId);
    visibilityLockTimerId = null;
  }
  // Fixes M19: broadcast before invoking the callback so sibling tabs
  // lock in approximately the same instant; callback-first would widen
  // the sync gap on slow lock-UI paths.
  if (opts.broadcast) {
    broadcastMessage({ type: 'lock' });
  }
  lockCallback();
}

function onActivity(event?: Event): void {
  if (paused) return;
  // Fixes M18: pointermove-specific throttle. Other activity events
  // (click, keydown, touchstart, scroll) are inherently low-frequency
  // and don't need rate-limiting.
  if (event && event.type === 'pointermove') {
    const now = Date.now();
    if (now - lastPointerActivityTs < POINTER_ACTIVITY_THROTTLE_MS) return;
    lastPointerActivityTs = now;
  }
  scheduleTimer();
  maybeBroadcastActivity();
}

function maybeBroadcastActivity(): void {
  // Fixes M19: broadcast throttle is separate from the pointer throttle
  // above. Even for low-frequency events (click, keydown), we don't want
  // to flood the channel on every keystroke.
  const now = Date.now();
  if (now - lastActivityBroadcastTs < BROADCAST_THROTTLE_MS) return;
  lastActivityBroadcastTs = now;
  broadcastMessage({ type: 'activity' });
}

function scheduleTimer(): void {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  timerId = setTimeout(() => {
    triggerLock();
  }, currentTimeoutMs);
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    // Fixes M17 (Inline-Behavior-Review rev 12): schedule a grace-period
    // lock rather than firing immediately. If the user returns before
    // the grace window elapses, the `visible` branch below cancels the
    // pending lock.
    if (visibilityLockTimerId !== null) {
      clearTimeout(visibilityLockTimerId);
      visibilityLockTimerId = null;
    }
    if (paused) return;
    if (currentVisibilityDelayMs <= 0) {
      // Zero-delay preserves legacy lock-on-hide behavior for anyone who
      // opts in explicitly (kiosk mode, high-security deployments).
      // Existing auto-lock.test.ts suite exercises this path by passing
      // `visibilityDelayMs: 0` to initAutoLock.
      triggerLock();
      return;
    }
    visibilityLockTimerId = setTimeout(() => {
      visibilityLockTimerId = null;
      triggerLock();
    }, currentVisibilityDelayMs);
  } else if (document.visibilityState === 'visible') {
    // User came back before the grace period expired — cancel the lock.
    if (visibilityLockTimerId !== null) {
      clearTimeout(visibilityLockTimerId);
      visibilityLockTimerId = null;
    }
  }
}

function addListeners(): void {
  // Fixes M18 (Inline-Behavior-Review rev 12): move from `window` to
  // `document` with `capture: true`. Window-level scroll only fires for
  // the root document scroll — all of Harbor Ledger's scrollable
  // surfaces are inner containers (transaction list, category picker,
  // detail panel) whose scroll events don't bubble to window. Document
  // + capture-phase catches every scroll regardless of where it
  // originates. Same rationale applies to `pointermove` / `keydown`
  // under shadow-DOM or webview wrappers (Capacitor).
  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, onActivity, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function removeListeners(): void {
  // `capture` must match the addEventListener value for removal to
  // succeed — a subtle footgun if these two drift apart.
  const removeOpts: EventListenerOptions = { capture: true };
  for (const event of ACTIVITY_EVENTS) {
    document.removeEventListener(event, onActivity, removeOpts);
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Initialize auto-lock. Starts listening for activity immediately.
 *
 * @param onLock - Callback invoked when the inactivity timeout fires or
 *   when another tab signals a lock via the cross-tab channel.
 * @param timeoutMs - Override the default inactivity timeout.
 * @param visibilityDelayMs - Override the visibility-change grace period
 *   (Fixes M17 rev 12). Pass 0 for legacy lock-on-hide behavior.
 * @returns A cleanup function that removes listeners, clears timers, and
 *   closes the cross-tab channel.
 */
export function initAutoLock(
  onLock: () => void,
  timeoutMs?: number,
  visibilityDelayMs?: number
): () => void {
  // Clean up any previous instance
  cleanup();

  lockCallback = onLock;
  currentTimeoutMs = timeoutMs ?? CONFIG.AUTO_LOCK.TIMEOUT_MS;
  currentVisibilityDelayMs = visibilityDelayMs ?? CONFIG.AUTO_LOCK.VISIBILITY_LOCK_DELAY_MS;
  paused = false;
  lastPointerActivityTs = 0;
  lastActivityBroadcastTs = 0;

  initSyncChannel();
  addListeners();
  scheduleTimer();

  return cleanup;
}

/**
 * CR-Apr24-D1 [P2] findings 151, 154, 155: module-scoped auto-lock
 * controller. Pre-fix the init was only called once during bootstrap
 * (when a PIN already existed), and the returned cleanup was captured
 * in the orchestration scope but never used by any of the runtime PIN
 * mutation paths. As a result:
 *   - Remote PIN add (from another tab) → current tab keeps running
 *     without auto-lock coverage even though a PIN is now set.
 *   - Local clear-PIN → auto-lock keeps running with no PIN set;
 *     timer fires and the lock-callback shows the overlay against
 *     a no-longer-PIN-protected app.
 *   - Remote PIN clear → same as local-clear, but in sibling tabs.
 *
 * The fix: expose `startAutoLockIfNeeded` / `stopAutoLockIfActive`
 * that hold the active cleanup as module-private state. Any caller
 * (boot, storage-event handler, local clear-PIN handler) can now
 * idempotently start or stop auto-lock as the PIN signal changes.
 */
let _activeCleanup: (() => void) | null = null;

/**
 * Start auto-lock if it isn't already running. Idempotent — repeated
 * calls reuse the existing instance and ignore the new callback.
 *
 * Returns the cleanup function (also tracked internally so
 * `stopAutoLockIfActive` can dispose it).
 */
export function startAutoLockIfNeeded(
  onLock: () => void,
  timeoutMs?: number,
  visibilityDelayMs?: number
): () => void {
  if (_activeCleanup) return _activeCleanup;
  const cleanupFn = initAutoLock(onLock, timeoutMs, visibilityDelayMs);
  const wrappedCleanup: () => void = () => {
    cleanupFn();
    if (_activeCleanup === wrappedCleanup) {
      _activeCleanup = null;
    }
  };
  _activeCleanup = wrappedCleanup;
  return wrappedCleanup;
}

/**
 * Stop auto-lock if currently running. Idempotent — no-op when
 * already stopped.
 */
export function stopAutoLockIfActive(): void {
  if (_activeCleanup) {
    _activeCleanup();
    _activeCleanup = null;
  }
}

/**
 * Whether auto-lock is currently running. Used by tests + diagnostics.
 */
export function isAutoLockActive(): boolean {
  return _activeCleanup !== null;
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
 * Timers are cleared but listeners remain attached so resume is cheap.
 */
export function pauseAutoLock(): void {
  paused = true;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  // Fixes M17: the visibility grace timer must also be cleared on pause,
  // otherwise a modal opened while the tab is hidden would still
  // schedule a lock that fires mid-modal.
  if (visibilityLockTimerId !== null) {
    clearTimeout(visibilityLockTimerId);
    visibilityLockTimerId = null;
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
 * Full cleanup — remove listeners, clear timers, close sync channel,
 * reset state.
 */
function cleanup(): void {
  removeListeners();
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  if (visibilityLockTimerId !== null) {
    clearTimeout(visibilityLockTimerId);
    visibilityLockTimerId = null;
  }
  closeSyncChannel();
  paused = false;
  lockCallback = null;
  lastPointerActivityTs = 0;
  lastActivityBroadcastTs = 0;
}
