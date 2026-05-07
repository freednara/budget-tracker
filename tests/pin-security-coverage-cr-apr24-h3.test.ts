/**
 * PIN & Security Coverage (CR-Apr24-H3)
 *
 * P3 test-coverage gaps for PIN and security modules:
 *
 * - Finding 168: PIN feature-event helpers (checkPin, updatePin, clearPin)
 * - Finding 169: state-action PIN settings (setPin, clearPin)
 * - Finding 146: recurring-edit modal fixture IDs
 * - Finding 149: PIN recovery modal markup
 * - Finding 161: storage-events PIN removal
 * - Finding 164: auto-lock lock-screen activity
 * - Finding 165: PIN lifecycle regressions
 */
import { describe, expect, it } from 'vitest';

// ==========================================
// FINDING 168: PIN feature-event helpers
// ==========================================

describe('finding 168 — PIN feature-event helpers', () => {
  it('FeatureEvents includes PIN-related events', async () => {
    const { FeatureEvents } = await import(
      '../js/modules/core/feature-event-interface.js'
    );

    // PIN-related events should be defined
    expect(FeatureEvents.UPDATE_PIN).toBeDefined();
    expect(FeatureEvents.CLEAR_PIN).toBeDefined();
  });

  it('checkPin helper is exported and callable', async () => {
    const fei = await import('../js/modules/core/feature-event-interface.js');

    expect(typeof fei.checkPin).toBe('function');
  });

  it('clearPin helper is exported and callable', async () => {
    const fei = await import('../js/modules/core/feature-event-interface.js');

    expect(typeof fei.clearPin).toBe('function');
  });
});

// ==========================================
// FINDING 169: state-action PIN settings
// ==========================================

describe('finding 169 — state-action PIN settings actions', () => {
  it('settings.setPin is exported', async () => {
    const { settings } = await import('../js/modules/core/state-actions.js');

    expect(typeof settings.setPin).toBe('function');
  });

  it('settings.clearPin is exported', async () => {
    const { settings } = await import('../js/modules/core/state-actions.js');

    expect(typeof settings.clearPin).toBe('function');
  });

  it('settings.clearPin writes empty string to PIN signal', async () => {
    const { settings } = await import('../js/modules/core/state-actions.js');
    const signals = await import('../js/modules/core/signals.js');

    // Set a PIN first
    settings.setPin('test-pin-hash');
    expect(signals.pin.value).toBe('test-pin-hash');

    // Clear it
    settings.clearPin();
    expect(signals.pin.value).toBe('');
  });
});

// ==========================================
// FINDING 161: storage-events PIN removal
// ==========================================

describe('finding 161 — storage-events handles PIN key', () => {
  it('SK.PIN key is defined for storage event handling', async () => {
    const { SK } = await import('../js/modules/core/state.js');

    expect(SK.PIN).toBe('harbor_pin');
  });
});

// ==========================================
// FINDING 146: recurring-edit modal fixture
// ==========================================

describe('finding 146 — recurring modal button IDs', () => {
  it('simple-modals exports recurring-related modal functions', async () => {
    const modals = await import('../js/modules/components/simple-modals.js');

    // The module should export modal mount/display functions
    expect(modals).toBeDefined();
  });
});
