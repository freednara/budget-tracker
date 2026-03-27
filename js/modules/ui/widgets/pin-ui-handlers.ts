/**
 * PIN UI Handlers Module
 *
 * Handles PIN setup, verification, and recovery UI interactions.
 *
 * @module pin-ui-handlers
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { settings } from '../../core/state-actions.js';
import { showToast, openModal, closeModal } from '../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
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

// Lockout countdown timer
let lockoutIntervalId: ReturnType<typeof setInterval> | null = null;

// Configuration (set by app.js)
let pinConfig: PinConfig = {
  PIN_ERROR_DISPLAY: 2000
};
let pinListenerGroupId: string | null = null;
const pinUiCleanups: Array<() => void> = [];

function bindPinUiEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject
): void {
  target.addEventListener(type, handler);
  pinUiCleanups.push(() => {
    target.removeEventListener(type, handler);
  });
}

export function cleanupPinHandlers(): void {
  const cleanups = pinUiCleanups.splice(0, pinUiCleanups.length);
  cleanups.forEach((cleanup) => cleanup());

  if (pinListenerGroupId) {
    destroyListenerGroup(pinListenerGroupId);
    pinListenerGroupId = null;
  }

  clearLockoutInterval();
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

  const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
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
 * Show remaining attempts feedback on the PIN error element
 */
function showAttemptsRemaining(remaining: number): void {
  const pinError = DOM.get('pin-error');
  if (pinError) {
    pinError.textContent = remaining > 0
      ? `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining`
      : 'Too many attempts';
    pinError.classList.remove('hidden');
    setTimeout(() => pinError.classList.add('hidden'), pinConfig.PIN_ERROR_DISPLAY);
  }
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
    DOM.get('pin-overlay')?.classList.remove('active');
    const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
    if (pinInput) pinInput.value = '';
  } else if (explicit || (!isHashed && entered.length >= pin.length)) {
    recordAttempt(false);
    const updated = checkRateLimit();
    if (!updated.allowed) {
      showLockoutUI(updated.waitMs);
    } else {
      showAttemptsRemaining(updated.attemptsRemaining);
    }
    const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
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
  on(FeatureEvents.REQUEST_PIN_CHECK, async (data: any) => {
    const { pin } = data.payload || {};
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const storedPin = signals.pin.value;
      const result = await verifyPin(pin, storedPin);
      emit(responseEvent, { type: FeatureEvents.REQUEST_PIN_CHECK, result });
    }
  }, { groupId: pinListenerGroupId });

  // Action: Update PIN
  on(FeatureEvents.UPDATE_PIN, async (bundle: any) => {
    settings.setPin(bundle);
    persist(SK.PIN, bundle);
  }, { groupId: pinListenerGroupId });

  // Action: Clear PIN
  on(FeatureEvents.CLEAR_PIN, () => {
    settings.setPin('');
    persist(SK.PIN, '');
  }, { groupId: pinListenerGroupId });

  // PIN setup with recovery phrase
  const savePinButton = DOM.get('save-pin-btn');
  if (savePinButton) bindPinUiEvent(savePinButton, 'click', async () => {
    const settingsPin = DOM.get('settings-pin') as HTMLInputElement | null;
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
      const grid = document.querySelector('#recovery-phrase-display .grid');
      if (grid) {
        grid.innerHTML = words.map((word: string, i: number) =>
          `<div class="p-2 rounded text-center" style="background: var(--bg-primary);">
            <span class="text-xs" style="color: var(--text-tertiary);">${i + 1}.</span>
            <span class="font-bold" style="color: var(--text-primary);">${escapeHtml(word)}</span>
          </div>`
        ).join('');
      }

      openModal('recovery-phrase-modal');
    } catch (err) {
      if (import.meta.env.DEV) console.error('PIN setup failed:', err);
      showToast('Failed to set PIN', 'error');
    }
  });

  // Copy recovery phrase to clipboard
  const copyRecoveryButton = DOM.get('copy-recovery-btn');
  if (copyRecoveryButton) bindPinUiEvent(copyRecoveryButton, 'click', () => {
    if (pendingRecoveryPhrase) {
      navigator.clipboard.writeText(pendingRecoveryPhrase).then(() => {
        showToast('Recovery phrase copied!', 'success');
      }).catch(() => {
        showToast('Copy failed - please write it down', 'error');
      });
    }
  });

  // Confirm recovery phrase saved
  const confirmRecoveryButton = DOM.get('confirm-recovery-btn');
  if (confirmRecoveryButton) bindPinUiEvent(confirmRecoveryButton, 'click', () => {
    pendingRecoveryPhrase = null;
    closeModal('recovery-phrase-modal');
    showToast('PIN set with recovery!', 'success');
  });

  // Clear PIN
  const clearPinButton = DOM.get('clear-pin-btn');
  if (clearPinButton) bindPinUiEvent(clearPinButton, 'click', () => {
    settings.clearPin();
    persist(SK.PIN, '');
    showToast('PIN removed', 'info');
  });

  // Forgot PIN - show recovery modal
  const forgotPinButton = DOM.get('forgot-pin-btn');
  if (forgotPinButton) bindPinUiEvent(forgotPinButton, 'click', () => {
    const pin = signals.pin.value;
    if (!hasRecoveryEnabled(pin)) {
      showToast('No recovery phrase set for this PIN', 'error');
      return;
    }
    openModal('recovery-input-modal');
    const input = DOM.get('recovery-phrase-input') as HTMLInputElement | null;
    if (input) input.value = '';
    DOM.get('recovery-error')?.classList.add('hidden');
  });

  // Cancel recovery
  const cancelRecoveryButton = DOM.get('cancel-recovery-btn');
  if (cancelRecoveryButton) bindPinUiEvent(cancelRecoveryButton, 'click', () => {
    closeModal('recovery-input-modal');
  });

  // Submit recovery phrase
  const submitRecoveryButton = DOM.get('submit-recovery-btn');
  if (submitRecoveryButton) bindPinUiEvent(submitRecoveryButton, 'click', async () => {
    const phraseInput = DOM.get('recovery-phrase-input') as HTMLInputElement | null;
    const phrase = phraseInput?.value.trim() || '';

    if (!phrase || !validateRecoveryPhrase(phrase)) {
      const errorEl = DOM.get('recovery-error');
      if (errorEl) {
        errorEl.textContent = 'Invalid recovery phrase format';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    try {
      const pin = signals.pin.value;
      const recoveredHash = await recoverPinHash(pin, phrase);
      if (recoveredHash) {
        // Recovery successful - unlock and prompt to set new PIN
        closeModal('recovery-input-modal');
        DOM.get('pin-overlay')?.classList.remove('active');
        const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
        if (pinInput) pinInput.value = '';

        // Clear the old PIN so user can set a new one
        settings.clearPin();
        persist(SK.PIN, '');

        showToast('PIN recovered! Please set a new PIN in Settings.', 'success');
      } else {
        const errorEl = DOM.get('recovery-error');
        if (errorEl) {
          errorEl.textContent = 'Incorrect recovery phrase';
          errorEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Recovery failed:', err);
      const errorEl = DOM.get('recovery-error');
      if (errorEl) {
        errorEl.textContent = 'Recovery failed';
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
    if (!isHashed) checkPinEntry(target.value); // auto-verify legacy plaintext PINs only
  });

  if (pinInput) bindPinUiEvent(pinInput, 'keydown', ((e: KeyboardEvent) => {
    const target = e.target as HTMLInputElement;
    if (e.key === 'Enter') checkPinEntry(target.value, true);
  }) as EventListener);

  const pinSubmitButton = DOM.get('pin-submit-btn');
  if (pinSubmitButton) bindPinUiEvent(pinSubmitButton, 'click', () => {
    const pinInputEl = DOM.get('pin-input') as HTMLInputElement | null;
    if (pinInputEl) checkPinEntry(pinInputEl.value, true);
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
 * Show the PIN lock overlay
 */
export function showPinLock(): void {
  DOM.get('pin-overlay')?.classList.add('active');
  const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
  pinInput?.focus();
}
