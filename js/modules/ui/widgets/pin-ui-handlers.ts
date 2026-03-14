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
import { showToast } from '../core/ui.js';
import { escapeHtml } from '../../core/utils.js';
import { validator } from '../../core/validator.js';
import {
  createPinWithRecovery,
  verifyPin as verifyPinCrypto,
  recoverPinHash,
  hasRecoveryEnabled,
  validateRecoveryPhrase
} from '../../features/security/pin-crypto.js';
import DOM from '../../core/dom-cache.js';
import type { PinBundle } from '../../../types/index.js';

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

// Configuration (set by app.js)
let pinConfig: PinConfig = {
  PIN_ERROR_DISPLAY: 2000
};

/**
 * Set PIN UI configuration
 */
export function setPinConfig(config: Partial<PinConfig>): void {
  pinConfig = { ...pinConfig, ...config };
}

// ==========================================
// PIN VERIFICATION
// ==========================================

/**
 * Verify entered PIN against stored PIN
 * Supports multiple formats: recovery-enabled, PBKDF2, SHA-256, plaintext
 */
export async function verifyPin(entered: string, stored: string): Promise<boolean> {
  // Check for recovery-enabled format (JSON with version: 2)
  if (hasRecoveryEnabled(stored)) {
    try {
      const bundle = JSON.parse(stored) as PinBundle;
      return verifyPinCrypto(entered, bundle.hash);
    } catch {
      return false;
    }
  }

  // Legacy PBKDF2 format (salt:hash with base64)
  if (stored.includes(':')) {
    return verifyPinCrypto(entered, stored);
  }

  // Very old legacy SHA-256 hash (64 hex chars, no salt)
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(entered));
    const hash = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hash === stored;
  }

  // Plaintext comparison (very old)
  return entered === stored;
}

/**
 * Check PIN entry and unlock if valid
 */
async function checkPinEntry(entered: string, explicit: boolean = false): Promise<void> {
  const pin = signals.pin.value;
  const isHashed = hasRecoveryEnabled(pin) || pin.includes(':') || /^[0-9a-f]{64}$/.test(pin);
  if (isHashed && !explicit) return; // hashed PIN: only verify on explicit submit

  const match = await verifyPin(entered, pin);
  if (match) {
    // Auto-upgrade legacy PIN to recovery-enabled format
    if (!hasRecoveryEnabled(pin)) {
      try {
        const { bundle } = await createPinWithRecovery(entered);
        settings.setPin(bundle);
        persist(SK.PIN, bundle);
        // Note: We don't show recovery phrase on auto-upgrade to avoid interruption
        // User can reset PIN in settings to get a new recovery phrase
      } catch (err) {
        console.warn('PIN upgrade failed:', err);
      }
    }
    DOM.get('pin-overlay')?.classList.remove('active');
    const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
    if (pinInput) pinInput.value = '';
  } else if (explicit || (!isHashed && entered.length >= pin.length)) {
    DOM.get('pin-error')?.classList.remove('hidden');
    const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
    if (pinInput) pinInput.value = '';
    setTimeout(() => DOM.get('pin-error')?.classList.add('hidden'), pinConfig.PIN_ERROR_DISPLAY);
  }
}

// ==========================================
// EVENT HANDLERS
// ==========================================

/**
 * Initialize all PIN-related event handlers
 */
export function initPinHandlers(): void {
  // PIN setup with recovery phrase
  DOM.get('save-pin-btn')?.addEventListener('click', async () => {
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
        grid.innerHTML = words.map((word, i) =>
          `<div class="p-2 rounded text-center" style="background: var(--bg-primary);">
            <span class="text-xs" style="color: var(--text-tertiary);">${i + 1}.</span>
            <span class="font-bold" style="color: var(--text-primary);">${escapeHtml(word)}</span>
          </div>`
        ).join('');
      }

      const phraseModal = DOM.get('recovery-phrase-modal');
      if (phraseModal) {
        phraseModal.classList.remove('hidden');
        phraseModal.classList.add('active');
      }
    } catch (err) {
      console.error('PIN setup failed:', err);
      showToast('Failed to set PIN', 'error');
    }
  });

  // Copy recovery phrase to clipboard
  DOM.get('copy-recovery-btn')?.addEventListener('click', () => {
    if (pendingRecoveryPhrase) {
      navigator.clipboard.writeText(pendingRecoveryPhrase).then(() => {
        showToast('Recovery phrase copied!', 'success');
      }).catch(() => {
        showToast('Copy failed - please write it down', 'error');
      });
    }
  });

  // Confirm recovery phrase saved
  DOM.get('confirm-recovery-btn')?.addEventListener('click', () => {
    pendingRecoveryPhrase = null;
    const phraseModal = DOM.get('recovery-phrase-modal');
    if (phraseModal) {
      phraseModal.classList.remove('active');
      phraseModal.classList.add('hidden');
    }
    showToast('PIN set with recovery!', 'success');
  });

  // Clear PIN
  DOM.get('clear-pin-btn')?.addEventListener('click', () => {
    settings.clearPin();
    persist(SK.PIN, '');
    showToast('PIN removed', 'info');
  });

  // Forgot PIN - show recovery modal
  DOM.get('forgot-pin-btn')?.addEventListener('click', () => {
    const pin = signals.pin.value;
    if (!hasRecoveryEnabled(pin)) {
      showToast('No recovery phrase set for this PIN', 'error');
      return;
    }
    const inputModal = DOM.get('recovery-input-modal');
    if (inputModal) {
      inputModal.classList.remove('hidden');
      inputModal.classList.add('active');
    }
    const input = DOM.get('recovery-phrase-input') as HTMLInputElement | null;
    if (input) input.value = '';
    DOM.get('recovery-error')?.classList.add('hidden');
  });

  // Cancel recovery
  DOM.get('cancel-recovery-btn')?.addEventListener('click', () => {
    const inputModal = DOM.get('recovery-input-modal');
    if (inputModal) {
      inputModal.classList.remove('active');
      inputModal.classList.add('hidden');
    }
  });

  // Submit recovery phrase
  DOM.get('submit-recovery-btn')?.addEventListener('click', async () => {
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
        const inputModal = DOM.get('recovery-input-modal');
        if (inputModal) {
          inputModal.classList.remove('active');
          inputModal.classList.add('hidden');
        }
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
      console.error('Recovery failed:', err);
      const errorEl = DOM.get('recovery-error');
      if (errorEl) {
        errorEl.textContent = 'Recovery failed';
        errorEl.classList.remove('hidden');
      }
    }
  });

  // PIN unlock input handlers
  DOM.get('pin-input')?.addEventListener('input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    const pin = signals.pin.value;
    const isHashed = hasRecoveryEnabled(pin) || pin.includes(':') || /^[0-9a-f]{64}$/.test(pin);
    if (!isHashed) checkPinEntry(target.value); // auto-verify legacy plaintext PINs only
  });

  DOM.get('pin-input')?.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLInputElement;
    if (e.key === 'Enter') checkPinEntry(target.value, true);
  });

  DOM.get('pin-submit-btn')?.addEventListener('click', () => {
    const pinInput = DOM.get('pin-input') as HTMLInputElement | null;
    if (pinInput) checkPinEntry(pinInput.value, true);
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
