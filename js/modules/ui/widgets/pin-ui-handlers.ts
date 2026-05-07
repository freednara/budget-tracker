/**
 * PIN UI Handlers Module
 *
 * Handles PIN setup, verification, and recovery UI interactions.
 *
 * @module pin-ui-handlers
 */
'use strict';

import { createEventBinder } from '../../core/event-binding.js';
import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { settings } from '../../core/state-actions.js';
import { showToast, openModal, closeModal, trapFocus } from '../core/ui.js';
import { escapeHtml } from '../../core/utils-dom.js';
import { validator } from '../../core/validator.js';
import {
  createPinWithRecovery,
  recoverPinHash,
  hasRecoveryEnabled,
  validateRecoveryPhrase,
  verifyPin
} from '../../features/security/pin-crypto.js';
import { on, emit, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import DOM from '../../core/dom-cache.js';
import { checkRateLimit, recordAttempt, formatLockoutTime } from '../../features/security/rate-limiter.js';
import { pauseAutoLock, resumeAutoLock, stopAutoLockIfActive } from '../../features/security/auto-lock.js';
// PinBundle type now only used internally by pin-crypto.ts

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface PinConfig {
  PIN_ERROR_DISPLAY: number;
}

// ==========================================
// MODULE STATE
// ==========================================

// Store pending recovery phrase for display
let pendingRecoveryPhrase: string | null = null;

// Lockout countdown timers (one per rate-limit namespace)
let lockoutIntervalId: ReturnType<typeof setInterval> | null = null;
let recoveryLockoutIntervalId: ReturnType<typeof setInterval> | null = null;

// Hide-timer for the PIN error message. Fixes L31: without storing the
// timer ID, two errors within PIN_ERROR_DISPLAY ms race — the first timer
// fires and hides the *second* message prematurely. Clear-before-set
// guarantees each new error gets its full display window.
let pinErrorHideTimer: ReturnType<typeof setTimeout> | null = null;

// MutationObserver watching the recovery-phrase modal for any close path
// (confirm, Escape, backdrop click). Zeroes pendingRecoveryPhrase on every
// dismissal, not just the explicit confirm. Fixes L31 recovery-phrase memory
// retention. Tracked at module scope so cleanupPinHandlers can dispose it
// if the handlers are re-initialized while the modal happens to be open.
let recoveryPhraseObserver: MutationObserver | null = null;

// Configuration (set by app.js)
let pinConfig: PinConfig = {
  PIN_ERROR_DISPLAY: 2000
};
let pinListenerGroupId: string | null = null;
const pinUiCleanups: Array<() => void> = [];
const bindPinUiEvent = createEventBinder(pinUiCleanups);

export function cleanupPinHandlers(): void {
  const cleanups = pinUiCleanups.splice(0, pinUiCleanups.length);
  cleanups.forEach((cleanup) => cleanup());

  if (pinListenerGroupId) {
    destroyListenerGroup(pinListenerGroupId);
    pinListenerGroupId = null;
  }

  clearLockoutInterval();
  clearRecoveryLockoutInterval();
  clearPinErrorHideTimer();
  teardownRecoveryPhraseObserver();
  // Defense-in-depth: zero the phrase if anything left it set. The observer
  // is the primary clearer on any modal dismissal; this line guarantees we
  // do not survive a cleanup cycle with a phrase still in memory.
  pendingRecoveryPhrase = null;
}

/**
 * Set PIN UI configuration
 */
export function setPinConfig(config: Partial<PinConfig>): void {
  pinConfig = { ...pinConfig, ...config };
}

// ==========================================
// RATE-LIMIT UI HELPERS
// ==========================================

/**
 * Show lockout countdown on the PIN error element and disable input
 */
function showLockoutUI(waitMs: number): void {
  clearLockoutInterval();
  // Lockout UI owns the error element until the countdown resolves.
  // Cancel any pending attempts-remaining hide so it does not wipe the
  // lockout message mid-countdown. Fixes L31 race edge case.
  clearPinErrorHideTimer();

  const pinInput = DOM.get<HTMLInputElement>('pin-input');
  const pinError = DOM.get('pin-error');
  if (pinInput) {
    pinInput.disabled = true;
    pinInput.value = '';
  }

  const endTime = Date.now() + waitMs;

  function updateCountdown(): void {
    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      clearLockoutInterval();
      if (pinError) {
        pinError.textContent = '';
        pinError.classList.add('hidden');
      }
      if (pinInput) {
        pinInput.disabled = false;
        pinInput.focus();
      }
      return;
    }
    if (pinError) {
      pinError.textContent = `Locked for ${formatLockoutTime(remaining)}`;
      pinError.classList.remove('hidden');
    }
  }

  updateCountdown();
  lockoutIntervalId = setInterval(updateCountdown, 1000);
}

function clearLockoutInterval(): void {
  if (lockoutIntervalId !== null) {
    clearInterval(lockoutIntervalId);
    lockoutIntervalId = null;
  }
}

/**
 * Cancel any pending PIN-error auto-hide. Called before scheduling a fresh
 * hide so two errors in quick succession don't race — each new message gets
 * its own full PIN_ERROR_DISPLAY window instead of being wiped early by the
 * prior timer. Also called on lockout takeover, successful unlock, and
 * handler teardown. Fixes L31.
 */
function clearPinErrorHideTimer(): void {
  if (pinErrorHideTimer !== null) {
    clearTimeout(pinErrorHideTimer);
    pinErrorHideTimer = null;
  }
}

/**
 * Show remaining attempts feedback on the PIN error element
 */
function showAttemptsRemaining(remaining: number): void {
  const pinError = DOM.get('pin-error');
  if (pinError) {
    pinError.textContent = remaining > 0
      ? `That PIN didn\u2019t match. You have ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
      : 'Too many attempts. Your account is locked for security.';
    pinError.classList.remove('hidden');
    // Clear-before-set: cancel any in-flight hide from a prior error before
    // scheduling this one's, so the older timer cannot fire and hide the
    // newer message early. See clearPinErrorHideTimer doc for full context.
    clearPinErrorHideTimer();
    pinErrorHideTimer = setTimeout(() => {
      pinError.classList.add('hidden');
      pinErrorHideTimer = null;
    }, pinConfig.PIN_ERROR_DISPLAY);
  }
}

/**
 * Show lockout countdown on the recovery-phrase error element and disable submit.
 * Mirrors showLockoutUI but scoped to the recovery modal and the
 * `pin_recovery_phrase` rate-limit namespace. Fixes M27.
 */
function showRecoveryLockoutUI(waitMs: number): void {
  clearRecoveryLockoutInterval();

  const submitBtn = DOM.get<HTMLButtonElement>('submit-recovery-btn');
  const phraseInput = DOM.get<HTMLInputElement>('recovery-phrase-input');
  const recoveryError = DOM.get('recovery-error');
  if (submitBtn) submitBtn.disabled = true;
  if (phraseInput) phraseInput.disabled = true;

  const endTime = Date.now() + waitMs;

  function updateCountdown(): void {
    // CR-Apr24-I finding 145: if the recovery modal was dismissed while
    // the lockout countdown was running, stop the timer instead of
    // re-enabling and focusing controls in a hidden modal.
    const modal = DOM.get('recovery-input-modal');
    if (!modal || !modal.classList.contains('active')) {
      clearRecoveryLockoutInterval();
      return;
    }

    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      clearRecoveryLockoutInterval();
      if (recoveryError) {
        recoveryError.textContent = '';
        recoveryError.classList.add('hidden');
      }
      if (submitBtn) submitBtn.disabled = false;
      if (phraseInput) {
        phraseInput.disabled = false;
        phraseInput.focus();
      }
      return;
    }
    if (recoveryError) {
      recoveryError.textContent = `Too many attempts. Try again in ${formatLockoutTime(remaining)}.`;
      recoveryError.classList.remove('hidden');
    }
  }

  updateCountdown();
  recoveryLockoutIntervalId = setInterval(updateCountdown, 1000);
}

function clearRecoveryLockoutInterval(): void {
  if (recoveryLockoutIntervalId !== null) {
    clearInterval(recoveryLockoutIntervalId);
    recoveryLockoutIntervalId = null;
  }
}

/**
 * Open the recovery-phrase display modal and attach a MutationObserver that
 * zeroes `pendingRecoveryPhrase` on any dismissal path (confirm click,
 * Escape, backdrop click, programmatic close). Closes L31 recovery-phrase
 * memory retention: previously the phrase stayed in module scope for the
 * page lifetime unless the user explicitly clicked Confirm.
 *
 * Scope decision: watching DOM state via MutationObserver catches every
 * dismissal path without requiring ui.ts to emit a modal-closed event.
 * One-shot: the observer disconnects itself on first close.
 */
function openRecoveryPhraseModalWithCleanup(): void {
  openModal('recovery-phrase-modal');

  const modal = DOM.get('recovery-phrase-modal');
  if (!modal) return;

  // If a prior observer is still live (e.g., a programmatic re-open without
  // close in between), dispose it first.
  teardownRecoveryPhraseObserver();

  const observer = new MutationObserver(() => {
    // `closeModal` removes 'active' and adds 'hidden'. Either absence of
    // 'active' or presence of 'hidden' signals dismissal.
    if (!modal.classList.contains('active') || modal.classList.contains('hidden')) {
      pendingRecoveryPhrase = null;
      teardownRecoveryPhraseObserver();
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  recoveryPhraseObserver = observer;
}

function teardownRecoveryPhraseObserver(): void {
  if (recoveryPhraseObserver) {
    recoveryPhraseObserver.disconnect();
    recoveryPhraseObserver = null;
  }
}

/**
 * Write a wrong-phrase message that surfaces the remaining attempt count
 * when the counter is below the full budget. Keeps UX gentle while signaling
 * that the path is throttled.
 */
function showRecoveryAttemptsRemaining(remaining: number): void {
  const errorEl = DOM.get('recovery-error');
  if (!errorEl) return;
  if (remaining > 0 && remaining < 3) {
    errorEl.textContent = `That phrase doesn\u2019t match. ${remaining} attempt${remaining === 1 ? '' : 's'} left before this path is temporarily locked.`;
  } else {
    errorEl.textContent = 'That phrase doesn\u2019t match. Check for typos \u2014 each word matters.';
  }
  errorEl.classList.remove('hidden');
}

// ==========================================
// PIN VERIFICATION
// ==========================================

// verifyPin is now fully handled by pin-crypto.ts (single source of truth for all formats)
export { verifyPin };

/**
 * Check PIN entry and unlock if valid
 */
async function checkPinEntry(entered: string, explicit: boolean = false): Promise<void> {
  const pin = signals.pin.value;
  const isHashed = hasRecoveryEnabled(pin) || pin.includes(':') || /^[0-9a-f]{64}$/.test(pin);
  if (isHashed && !explicit) return; // hashed PIN: only verify on explicit submit

  // Rate-limit check before attempting verification
  const limit = checkRateLimit();
  if (!limit.allowed) {
    showLockoutUI(limit.waitMs);
    return;
  }

  const match = await verifyPin(entered, pin);
  if (match) {
    recordAttempt(true);
    clearLockoutInterval();
    // Cancel any pending attempts-remaining hide — otherwise an old timer
    // could fire post-unlock and mutate a now-unrelated DOM state.
    clearPinErrorHideTimer();
    // Auto-upgrade legacy PIN to recovery-enabled format
    if (!hasRecoveryEnabled(pin)) {
      try {
        const { bundle } = await createPinWithRecovery(entered);
        settings.setPin(bundle);
        persist(SK.PIN, bundle);
        // Note: We don't show recovery phrase on auto-upgrade to avoid interruption
        // User can reset PIN in settings to get a new recovery phrase
      } catch (err) {
        if (import.meta.env.DEV) console.warn('PIN upgrade failed:', err);
      }
    }
    hidePinLock();
  } else if (explicit || (!isHashed && entered.length >= pin.length)) {
    recordAttempt(false);
    const updated = checkRateLimit();
    if (!updated.allowed) {
      showLockoutUI(updated.waitMs);
    } else {
      showAttemptsRemaining(updated.attemptsRemaining);
    }
    const pinInput = DOM.get<HTMLInputElement>('pin-input');
    if (pinInput) pinInput.value = '';
  }
}

// ==========================================
// EVENT HANDLERS
// ==========================================

/**
 * Initialize all PIN-related event handlers and register feature event listeners
 */
export function initPinHandlers(): void {
  cleanupPinHandlers();
  pinListenerGroupId = createListenerGroup('pin-ui-handlers');

  // Register Feature Event Listeners
  // Request: PIN check
  on(FeatureEvents.REQUEST_PIN_CHECK, async (data: { payload?: { pin?: string }; responseEvent?: string }) => {
    const pin = data.payload?.pin ?? '';
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const storedPin = signals.pin.value;
      const result = await verifyPin(pin, storedPin);
      emit(responseEvent, { type: FeatureEvents.REQUEST_PIN_CHECK, result });
    }
  }, { groupId: pinListenerGroupId });

  // Action: Update PIN
  //
  // CR-Apr24-D3 [P2] finding 166: payload contract mismatch. Pre-fix
  // the listener was typed `(bundle: string)`, but the emitter
  // (`feature-event-interface.ts:updatePin`) sends `{newPin, oldPin}`
  // as an object. Any caller using the public `updatePin()` helper
  // would have persisted the literal object (or its `[object Object]`
  // string coercion) into `SK.PIN`, breaking the lock screen on the
  // very next reload. Local in-module callers go through the
  // save-pin-btn click handler below (which calls `settings.setPin`
  // directly with a real bundle), so the bug never surfaced — but the
  // public API contract was a foot-gun for any external caller. Fix:
  // destructure `{newPin}` from the payload. `oldPin` remains in the
  // emit shape for forward-compat (e.g. a future PIN-rotation flow
  // that needs the prior bundle for re-encryption) but is currently
  // unused.
  on(FeatureEvents.UPDATE_PIN, async (payload: { newPin: string; oldPin?: string }) => {
    const bundle = payload?.newPin ?? '';
    if (!bundle) return;
    settings.setPin(bundle);
    persist(SK.PIN, bundle);
    // Mirror the local save-pin path: keep Settings "Turn Off PIN"
    // visibility in lockstep with the new PIN state.
    updateClearPinVisibility();
  }, { groupId: pinListenerGroupId });

  // Action: Clear PIN
  //
  // CR-Apr24-D3 [P3] finding 167: pre-fix the listener cleared the
  // signal + persisted but didn't call `updateClearPinVisibility()`.
  // The local clear-PIN button handler does — that's how Settings
  // stays in sync when the user clicks "Turn Off PIN" directly. But
  // any caller using the public `clearPin()` feature-event helper
  // would have left an open Settings sheet showing a stale "Turn Off
  // PIN" button against a now-empty pin signal. Same fix as the
  // cross-tab path in storage-events.ts (CR-Apr24-D1 finding 163).
  on(FeatureEvents.CLEAR_PIN, () => {
    settings.setPin('');
    persist(SK.PIN, '');
    updateClearPinVisibility();
    // Match the local clear-PIN handler's auto-lock teardown so the
    // public API path leaves the same state as a direct button click.
    stopAutoLockIfActive();
  }, { groupId: pinListenerGroupId });

  // PIN setup with recovery phrase
  const savePinButton = DOM.get('save-pin-btn');
  if (savePinButton) bindPinUiEvent(savePinButton, 'click', async () => {
    const settingsPin = DOM.get<HTMLInputElement>('settings-pin');
    const pin = settingsPin?.value.trim() || '';
    const pinValidation = validator.validatePin(pin);
    if (!pinValidation.valid) {
      showToast(pinValidation.error || 'PIN must be 4-6 digits', 'error');
      return;
    }

    try {
      // Create PIN with recovery phrase
      const { bundle, recoveryPhrase } = await createPinWithRecovery(pin);

      // Store the bundle
      settings.setPin(bundle);
      persist(SK.PIN, bundle);
      if (settingsPin) settingsPin.value = '';

      // Display recovery phrase
      pendingRecoveryPhrase = recoveryPhrase;
      const words = recoveryPhrase.split(' ');
      const grid = DOM.query('#recovery-phrase-display .grid');
      if (grid) {
        const wordItems = words.map((word: string, i: number) => {
          const item = document.createElement('div');
          item.className = 'p-2 rounded text-center bg-primary';

          const label = document.createElement('span');
          label.className = 'text-xs text-tertiary';
          label.textContent = `${i + 1}.`;

          const text = document.createElement('span');
          text.className = 'font-bold text-primary';
          text.textContent = escapeHtml(word);

          item.append(label, text);
          return item;
        });

        grid.replaceChildren(...wordItems);
      }

      openRecoveryPhraseModalWithCleanup();
    } catch (err) {
      if (import.meta.env.DEV) console.error('PIN setup failed:', err);
      showToast('PIN couldn\u2019t be saved. Make sure your browser allows local storage and try again.', 'error');
    }
  });

  // Copy recovery phrase to clipboard
  const copyRecoveryButton = DOM.get('copy-recovery-btn');
  if (copyRecoveryButton) bindPinUiEvent(copyRecoveryButton, 'click', () => {
    if (pendingRecoveryPhrase) {
      navigator.clipboard.writeText(pendingRecoveryPhrase).then(() => {
        showToast('Recovery phrase copied!', 'success');
      }).catch(() => {
        showToast('Couldn\u2019t copy \u2014 try selecting the phrase and copying manually, or write it down somewhere safe.', 'error');
      });
    }
  });

  // Confirm recovery phrase saved
  const confirmRecoveryButton = DOM.get('confirm-recovery-btn');
  if (confirmRecoveryButton) bindPinUiEvent(confirmRecoveryButton, 'click', () => {
    pendingRecoveryPhrase = null;
    closeModal('recovery-phrase-modal');
    updateClearPinVisibility();
    showToast('PIN set with recovery!', 'success');
  });

  // Toggle "Turn Off PIN" button visibility based on PIN state.
  // Inner function delegates to the module-level export so cross-tab
  // paths (storage-events.ts) can call the same code without relying
  // on a closure-scoped helper that's only reachable from this init.
  updateClearPinVisibility();

  // Clear PIN
  // CR-Apr24-D1 [P2] finding 154: tear down the local auto-lock
  // instance when the user explicitly turns off PIN. Pre-fix: clearing
  // the PIN signal left the inactivity-timer + activity listeners
  // running, so a later timer expiration would call `showPinLock()`
  // against an app that no longer has a PIN. The lock screen would
  // appear over a non-PIN-protected app and trap the user with no
  // unlock path (they could submit any value or none).
  const clearPinButton = DOM.get('clear-pin-btn');
  if (clearPinButton) bindPinUiEvent(clearPinButton, 'click', () => {
    settings.clearPin();
    persist(SK.PIN, '');
    updateClearPinVisibility();
    // CR-Apr24-D1 [P2] finding 154: synchronous tear-down of any
    // active auto-lock instance now that there's no PIN to enforce.
    stopAutoLockIfActive();
    showToast('PIN turned off', 'info');
  });

  // Forgot PIN - show recovery modal
  const forgotPinButton = DOM.get('forgot-pin-btn');
  if (forgotPinButton) bindPinUiEvent(forgotPinButton, 'click', () => {
    const pin = signals.pin.value;
    if (!hasRecoveryEnabled(pin)) {
      showToast('No recovery phrase was saved for this PIN. If you can\u2019t remember your PIN, you\u2019ll need to reset your data from Settings.', 'error');
      return;
    }
    openModal('recovery-input-modal');
    const input = DOM.get<HTMLInputElement>('recovery-phrase-input');
    if (input) input.value = '';
    // CR-Apr24-I finding 147: only hide the recovery-error element when
    // the user is not currently locked out.  If a lockout is active the
    // error element displays the countdown timer — hiding it would leave
    // the submit button disabled with no visible explanation.
    const lockoutCheck = checkRateLimit('pin_recovery_phrase');
    if (lockoutCheck.allowed) {
      DOM.get('recovery-error')?.classList.add('hidden');
    } else {
      showRecoveryLockoutUI(lockoutCheck.waitMs);
    }
  });

  // Cancel recovery
  const cancelRecoveryButton = DOM.get('cancel-recovery-btn');
  if (cancelRecoveryButton) bindPinUiEvent(cancelRecoveryButton, 'click', () => {
    closeModal('recovery-input-modal');
  });

  // Submit recovery phrase
  // M27: rate-limit the recovery path with a dedicated 'pin_recovery_phrase'
  // namespace. Closes the defense-in-depth gap where the PIN-reset path via
  // recovery-phrase submission could be mashed with no throttling. Namespaced
  // separately from the PIN counter so legitimate phrase-typo recovery does
  // not tangle with PIN entry — and exhausting PIN attempts does not block
  // the legitimate owner from using recovery, which is the entire point of
  // recovery.
  const submitRecoveryButton = DOM.get('submit-recovery-btn');
  if (submitRecoveryButton) bindPinUiEvent(submitRecoveryButton, 'click', async () => {
    // Rate-limit check before any phrase work — bail early if locked out.
    const preCheck = checkRateLimit('pin_recovery_phrase');
    if (!preCheck.allowed) {
      showRecoveryLockoutUI(preCheck.waitMs);
      return;
    }

    const phraseInput = DOM.get<HTMLInputElement>('recovery-phrase-input');
    const phrase = phraseInput?.value.trim() || '';

    if (!phrase || !validateRecoveryPhrase(phrase)) {
      recordAttempt(false, 'pin_recovery_phrase');
      const after = checkRateLimit('pin_recovery_phrase');
      if (!after.allowed) {
        showRecoveryLockoutUI(after.waitMs);
      } else {
        showRecoveryAttemptsRemaining(after.attemptsRemaining);
      }
      return;
    }

    try {
      const pin = signals.pin.value;
      const recoveredHash = await recoverPinHash(pin, phrase);
      if (recoveredHash) {
        // Recovery successful — reset the counter for this namespace and
        // unlock. Leaves the 'pin' namespace's counter untouched so a
        // post-recovery PIN-entry keeps whatever lockout state it had.
        recordAttempt(true, 'pin_recovery_phrase');
        clearRecoveryLockoutInterval();
        // CR-Apr24-D2 [P2] finding 153: also clear the PIN-entry
        // lockout interval. Pre-fix: if the user opened the recovery
        // flow WHILE the PIN-entry lockout countdown was still ticking
        // on the main overlay, the recovery-success path closed the
        // recovery modal and called `hidePinLock()` — but the
        // background `lockoutIntervalId` (PIN-entry timer) kept
        // running. After hidePinLock the overlay was hidden but the
        // interval kept calling `updateCountdown` against the now-
        // hidden overlay's elements, eventually re-enabling and
        // refocusing #pin-input on a hidden modal. The new
        // hidePinLock() call below also clears it (defense in depth)
        // but doing it here documents the recovery semantics: PIN
        // recovered → all PIN state torn down, including any in-flight
        // countdowns from prior failed attempts.
        clearLockoutInterval();
        clearPinErrorHideTimer();
        closeModal('recovery-input-modal');
        hidePinLock();

        // Clear the old PIN so user can set a new one
        settings.clearPin();
        persist(SK.PIN, '');

        showToast('PIN recovered! Please set a new PIN in Settings.', 'success');
      } else {
        recordAttempt(false, 'pin_recovery_phrase');
        const after = checkRateLimit('pin_recovery_phrase');
        if (!after.allowed) {
          showRecoveryLockoutUI(after.waitMs);
        } else {
          showRecoveryAttemptsRemaining(after.attemptsRemaining);
        }
      }
    } catch (err) {
      // Crypto exceptions do not count as failed attempts — they indicate
      // a data-integrity problem rather than a guess. Surface the error but
      // don't escalate the lockout counter.
      if (import.meta.env.DEV) console.error('Recovery failed:', err);
      const errorEl = DOM.get('recovery-error');
      if (errorEl) {
        errorEl.textContent = 'Recovery couldn\u2019t be completed. Double-check your phrase and try again, or reset your data from Settings.';
        errorEl.classList.remove('hidden');
      }
    }
  });

  // PIN unlock input handlers
  const pinInput = DOM.get('pin-input');
  if (pinInput) bindPinUiEvent(pinInput, 'input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    const pin = signals.pin.value;
    const isHashed = hasRecoveryEnabled(pin) || pin.includes(':') || /^[0-9a-f]{64}$/.test(pin);
    if (!isHashed) void checkPinEntry(target.value); // auto-verify legacy plaintext PINs only
  });

  if (pinInput) bindPinUiEvent(pinInput, 'keydown', ((e: KeyboardEvent) => {
    const target = e.target as HTMLInputElement;
    if (e.key === 'Enter') void checkPinEntry(target.value, true);
  }) as EventListener);

  const pinSubmitButton = DOM.get('pin-submit-btn');
  if (pinSubmitButton) bindPinUiEvent(pinSubmitButton, 'click', () => {
    const pinInputEl = DOM.get<HTMLInputElement>('pin-input');
    if (pinInputEl) void checkPinEntry(pinInputEl.value, true);
  });
}

// ==========================================
// PIN LOCK FUNCTIONS
// ==========================================

/**
 * Check if PIN lock should be shown on app load
 */
export function shouldShowPinLock(): boolean {
  const pin = signals.pin.value;
  return !!(pin && pin.length > 0);
}

/**
 * Sync the visibility of the Settings "Turn Off PIN" button to the
 * current `signals.pin` value.
 *
 * CR-Apr24-D1 [P2] finding 163, [P3] findings 162, 167: pre-fix this
 * helper was a closure-scoped function inside `setupPinUiHandlers`,
 * reachable only from the local clear-PIN button handler and the
 * recovery-success path. Cross-tab `SK.PIN` updates and the public
 * `FeatureEvents.CLEAR_PIN` listener had no way to call it, so an
 * already-mounted Settings sheet could keep showing "Turn Off PIN"
 * after another tab cleared the PIN. Hoisting to module scope makes
 * the helper callable from any path that mutates the pin signal.
 *
 * Idempotent + DOM-defensive: missing button (Settings not mounted)
 * is a clean no-op.
 */
export function updateClearPinVisibility(): void {
  const btn = DOM.get('clear-pin-btn');
  if (btn) (btn as HTMLElement).hidden = !signals.pin.value;
}

// ------------------------------------------------------------------
// PIN lock focus-management state (Design-Review-Apr21 P2)
// ------------------------------------------------------------------
// The PIN overlay is security-critical: it advertises `role="dialog"`
// and `aria-modal="true"` at the markup level, but prior to this batch
// it only toggled a `.active` class and focused the input — it did
// NOT take the rest of the app out of the tab order or trap focus
// inside the overlay. That left the underlying transactions/budget
// surfaces reachable via Tab and via AT browse mode while the lock
// screen was "showing," which is exactly what `aria-modal` promises
// won't happen.
//
// We can't route the overlay through the shared `openModal`/`closeModal`
// helpers in `ui/core/ui.ts` because those target `.modal-overlay`
// elements — the PIN overlay has its own z-index tier (`--z-pin`) and
// its own opaque background that would conflict with `.modal-overlay`
// styles. Instead, `showPinLock` / `hidePinLock` mirror the important
// parts of that contract inline: mark `#app` inert + `aria-hidden`,
// remember the previously-focused element, install a focus trap using
// the shared `trapFocus` helper, and restore everything on close.
let _pinPreviousFocus: Element | null = null;
let _pinFocusTrapHandler: ((e: KeyboardEvent) => void) | null = null;

/**
 * Show the PIN lock overlay with proper modal semantics.
 *
 * CR-Apr24-D2 [P2/P3] findings 152, 156, 157, 158:
 *  - (157) Idempotent: a repeat call when the overlay is already
 *    active is a no-op for state setup. Pre-fix, every call overwrote
 *    `_pinPreviousFocus` (so the saved focus target was lost) and
 *    installed a fresh `keydown` trap (so old traps leaked and
 *    `hidePinLock` only removed the most recent one). The early-out
 *    on `overlay.classList.contains('active')` closes both windows.
 *  - (152) Lockout state restore: if `checkRateLimit('pin')` reports
 *    a not-allowed state on overlay open (from a prior failed-attempt
 *    burst that exhausted the limiter and persisted across refreshes),
 *    paint the countdown UI immediately so the user sees the same
 *    locked-out state they'd see if they hadn't refreshed. Pre-fix
 *    the overlay opened with the input enabled and no countdown,
 *    misleadingly inviting another attempt.
 *  - (156, 158) Pause auto-lock for the lifetime of the overlay so
 *    typing the PIN doesn't reset the inactivity timer (creating
 *    relock loops) AND doesn't broadcast cross-tab keep-alive that
 *    keeps sibling tabs awake while THIS tab is locked.
 */
export function showPinLock(): void {
  const overlay = DOM.get('pin-overlay');
  if (!overlay) return;

  // Idempotence guard (157): if already active, don't re-bind state.
  if (overlay.classList.contains('active')) return;

  // Remember the previously-focused element so we can restore it on unlock.
  _pinPreviousFocus = document.activeElement;

  // Take the rest of the app out of the tab order and the accessibility
  // tree so the lock screen is actually the only interactive surface
  // (matches the role="dialog" aria-modal="true" markup contract).
  const app = DOM.get('app');
  if (app) {
    app.setAttribute('inert', '');
    app.setAttribute('aria-hidden', 'true');
  }

  overlay.classList.add('active');

  // Install a focus trap using the shared helper from ui/core/ui.ts.
  const trap = (e: KeyboardEvent) => trapFocus(e, overlay);
  overlay.addEventListener('keydown', trap);
  _pinFocusTrapHandler = trap;

  const pinInput = DOM.get('pin-input');
  pinInput?.focus();

  // CR-Apr24-D2 [P2] findings 156, 158: pause auto-lock activity tracking
  // while the overlay is shown. Activity captured by the lock screen
  // (PIN typing, etc.) shouldn't reset the inactivity timer (would create
  // relock loops if the lock-callback fired again mid-overlay) and
  // shouldn't broadcast cross-tab keep-alive (would keep sibling tabs
  // awake while THIS tab is in fact locked). pauseAutoLock is a
  // synchronous no-op when auto-lock isn't initialized, so the call
  // is always safe.
  pauseAutoLock();

  // CR-Apr24-D2 [P3] finding 152: surface persisted lockout state.
  // If a prior session exhausted the rate limit and the lockout window
  // is still active, paint the countdown UI immediately so the
  // overlay reflects reality. Without this, the input + submit button
  // appear active and the user gets a confusing "wait, can I type?"
  // experience until they submit and discover the lockout that way.
  const rate = checkRateLimit('pin');
  if (!rate.allowed && rate.waitMs > 0) {
    showLockoutUI(rate.waitMs);
  }
}

/**
 * Hide the PIN lock overlay and undo all modal-scoped side-effects
 * installed by `showPinLock` (inert on `#app`, focus trap, focus
 * restoration, and clearing the input).
 *
 * CR-Apr24-D2 [P2/P3] findings 156, 159: also clears any active
 * lockout countdown timer, resets the #pin-error message + visibility
 * (so the next lock doesn't reopen with a stale "Locked for X" or
 * "wrong PIN" message from the prior session), and resumes auto-lock
 * if it was paused on overlay open. Idempotent — safe to call on a
 * non-active overlay.
 */
export function hidePinLock(): void {
  const overlay = DOM.get('pin-overlay');
  if (!overlay) return;

  overlay.classList.remove('active');

  if (_pinFocusTrapHandler) {
    overlay.removeEventListener('keydown', _pinFocusTrapHandler);
    _pinFocusTrapHandler = null;
  }

  const app = DOM.get('app');
  if (app) {
    app.removeAttribute('inert');
    app.removeAttribute('aria-hidden');
  }

  // Clear the PIN field so a subsequent lock doesn't show stale digits.
  const pinInput = DOM.get<HTMLInputElement>('pin-input');
  if (pinInput) {
    pinInput.value = '';
    // Re-enable in case a lockout had disabled it.
    pinInput.disabled = false;
  }

  // CR-Apr24-D2 [P3] finding 159: clear stale error copy + countdown.
  // Pre-fix: hidePinLock left whatever text was last written to
  // #pin-error in place. The next lock screen would reopen showing
  // "That PIN didn't match" or "Locked for 4:32" from the previous
  // session — confusing and misleading. Wipe the slate clean.
  clearLockoutInterval();
  clearPinErrorHideTimer();
  const pinError = DOM.get('pin-error');
  if (pinError) {
    pinError.textContent = '';
    pinError.classList.add('hidden');
  }

  // CR-Apr24-D2 [P2] findings 156, 158: resume auto-lock activity
  // tracking now that the overlay is gone. Synchronous + safe when
  // auto-lock was never initialized.
  resumeAutoLock();

  // Restore focus to whatever had it before the overlay appeared.
  if (_pinPreviousFocus instanceof HTMLElement) {
    _pinPreviousFocus.focus();
  }
  _pinPreviousFocus = null;
}
