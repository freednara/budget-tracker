/**
 * Tests for pin-ui-handlers Slice 14 (L31) fixes:
 *   1. Hide-timer race — error-message hide timer must be stored and
 *      cleared-before-set so two failed attempts in quick succession don't
 *      let the first timer wipe the second message prematurely.
 *   2. Recovery-phrase memory retention — pendingRecoveryPhrase must be
 *      cleared on ANY modal dismissal (backdrop/Escape/programmatic close),
 *      not only on the explicit confirm-recovery click.
 *
 * Observable-behavior test strategy: the module's internal state is probed
 * through its public side effects (DOM class state for the timer race,
 * clipboard.writeText call absence for the phrase retention) rather than
 * via test-only exports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — isolate pin-ui-handlers from storage + crypto side effects
// ---------------------------------------------------------------------------

// Partial mocks — preserve the broader module surface that transitive
// imports rely on (lsGet, getStored, etc.) and override only what we
// need to silence side effects.
vi.mock('../js/modules/core/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/core/state.js')>();
  return { ...actual, persist: vi.fn() };
});

vi.mock('../js/modules/core/state-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/core/state-actions.js')>();
  return {
    ...actual,
    settings: { ...actual.settings, setPin: vi.fn(), clearPin: vi.fn() },
  };
});

const mockVerifyPin = vi.fn(async (..._args: unknown[]) => false);
const mockCreatePinWithRecovery = vi.fn(async (..._args: unknown[]) => ({
  bundle: 'mock:bundle:value',
  recoveryPhrase: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
}));
const mockHasRecoveryEnabled = vi.fn((..._args: unknown[]) => false);
const mockRecoverPinHash = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
const mockValidateRecoveryPhrase = vi.fn((..._args: unknown[]) => true);

vi.mock('../js/modules/features/security/pin-crypto.js', () => ({
  verifyPin: (...args: unknown[]) => mockVerifyPin(...args),
  createPinWithRecovery: (...args: unknown[]) => mockCreatePinWithRecovery(...args),
  hasRecoveryEnabled: (...args: unknown[]) => mockHasRecoveryEnabled(...args),
  recoverPinHash: (...args: unknown[]) => mockRecoverPinHash(...args),
  validateRecoveryPhrase: (...args: unknown[]) => mockValidateRecoveryPhrase(...args),
}));

const mockCheckRateLimit = vi.fn((..._args: unknown[]) => ({ allowed: true, waitMs: 0, attemptsRemaining: 3 }));
const mockRecordAttempt = vi.fn((..._args: unknown[]) => undefined);
vi.mock('../js/modules/features/security/rate-limiter.js', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
  formatLockoutTime: (ms: number) => `${Math.ceil(ms / 1000)}s`,
}));

// Use the real event-bus — it's a thin wrapper and avoids mock-shape drift.

// Use real signals + validator + DOM modules

// ---------------------------------------------------------------------------
// DOM fixture — enumerate every element id the module touches
// ---------------------------------------------------------------------------

const DOM_FIXTURE = `
  <div id="app"></div>
  <div id="pin-overlay"></div>
  <input id="pin-input" />
  <div id="pin-error" class="hidden"></div>
  <input id="settings-pin" />
  <div id="recovery-phrase-modal" class="modal-overlay hidden">
    <div id="recovery-phrase-display"><div class="grid"></div></div>
  </div>
  <button id="save-pin-btn">Save</button>
  <button id="copy-recovery-btn">Copy</button>
  <button id="confirm-recovery-btn">Confirm</button>
  <button id="clear-pin-btn">Clear</button>
  <button id="forgot-pin-btn">Forgot</button>
  <div id="recovery-input-modal" class="modal-overlay hidden"></div>
  <input id="recovery-phrase-input" />
  <div id="recovery-error" class="hidden"></div>
  <button id="submit-recovery-btn">Submit</button>
  <button id="cancel-recovery-btn">Cancel</button>
  <button id="pin-submit-btn">Unlock</button>
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pin-ui-handlers L31 — hide-timer race', () => {
  let cleanupPinHandlers: () => void;
  let initPinHandlers: () => void;
  let setPinConfig: (c: { PIN_ERROR_DISPLAY: number }) => void;
  let signals: typeof import('../js/modules/core/signals.js');

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = DOM_FIXTURE;
    mockVerifyPin.mockReset().mockResolvedValue(false);
    mockHasRecoveryEnabled.mockReset().mockReturnValue(false);
    mockCheckRateLimit.mockReset().mockReturnValue({ allowed: true, waitMs: 0, attemptsRemaining: 2 });
    mockRecordAttempt.mockReset();

    // Fresh imports so each test gets its own module-state
    const mod = await import('../js/modules/ui/widgets/pin-ui-handlers.js');
    cleanupPinHandlers = mod.cleanupPinHandlers;
    initPinHandlers = mod.initPinHandlers;
    setPinConfig = mod.setPinConfig;
    signals = await import('../js/modules/core/signals.js');
    signals.pin.value = '1234'; // legacy plaintext PIN — triggers auto-verify path

    vi.useFakeTimers();
    setPinConfig({ PIN_ERROR_DISPLAY: 2000 });
    initPinHandlers();
  });

  afterEach(() => {
    cleanupPinHandlers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function enterPinAndWait(value: string): Promise<void> {
    const input = document.getElementById('pin-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    // Allow async checkPinEntry to resolve before advancing timers
    await flushMicrotasks();
  }

  it('cancels the prior hide timer when a second error fires before the first has fired', async () => {
    const pinError = document.getElementById('pin-error') as HTMLElement;

    // First failed attempt — schedules hide timer #1
    await enterPinAndWait('9999');
    expect(pinError.classList.contains('hidden')).toBe(false);
    const firstMessage = pinError.textContent;
    expect(firstMessage).toMatch(/attempt/);

    // Advance part-way, then fire a second failed attempt. Without the fix
    // the first timer is still pending and will hide the second message at
    // (PIN_ERROR_DISPLAY - 500ms) from now instead of the full 2000ms.
    vi.advanceTimersByTime(1500);
    expect(pinError.classList.contains('hidden')).toBe(false);

    mockCheckRateLimit.mockReturnValue({ allowed: true, waitMs: 0, attemptsRemaining: 1 });
    await enterPinAndWait('8888');
    expect(pinError.classList.contains('hidden')).toBe(false);

    // 500ms after second error — the first timer would have fired at this
    // point without the clear-before-set fix. Error must still be visible.
    vi.advanceTimersByTime(500);
    expect(pinError.classList.contains('hidden')).toBe(false);

    // 1999ms after second error — still within the second timer's window.
    vi.advanceTimersByTime(1499);
    expect(pinError.classList.contains('hidden')).toBe(false);

    // 2001ms after second error — the (single, fresh) timer fires now.
    vi.advanceTimersByTime(2);
    expect(pinError.classList.contains('hidden')).toBe(true);
  });

  it('hides the error after exactly one PIN_ERROR_DISPLAY window for a single attempt', async () => {
    const pinError = document.getElementById('pin-error') as HTMLElement;

    await enterPinAndWait('9999');
    expect(pinError.classList.contains('hidden')).toBe(false);

    vi.advanceTimersByTime(1999);
    expect(pinError.classList.contains('hidden')).toBe(false);

    vi.advanceTimersByTime(2);
    expect(pinError.classList.contains('hidden')).toBe(true);
  });

  it('cleanupPinHandlers clears a pending hide-timer', async () => {
    const pinError = document.getElementById('pin-error') as HTMLElement;

    await enterPinAndWait('9999');
    expect(pinError.classList.contains('hidden')).toBe(false);

    cleanupPinHandlers();

    // Hide-timer is cancelled — advancing past its window must not toggle
    // the DOM state (we confirm no pending timer exists by exhausting the
    // fake-timer queue and verifying the error stays visible).
    vi.advanceTimersByTime(10_000);
    expect(pinError.classList.contains('hidden')).toBe(false);
  });
});

describe('pin-ui-handlers L31 — recovery-phrase memory retention', () => {
  let cleanupPinHandlers: () => void;
  let initPinHandlers: () => void;
  let signals: typeof import('../js/modules/core/signals.js');
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = DOM_FIXTURE;
    mockCreatePinWithRecovery.mockReset().mockResolvedValue({
      bundle: 'mock:bundle:value',
      recoveryPhrase: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    });
    mockHasRecoveryEnabled.mockReset().mockReturnValue(false);

    clipboardWriteText = vi.fn(() => Promise.resolve());
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
      writable: true,
    });

    const mod = await import('../js/modules/ui/widgets/pin-ui-handlers.js');
    cleanupPinHandlers = mod.cleanupPinHandlers;
    initPinHandlers = mod.initPinHandlers;
    signals = await import('../js/modules/core/signals.js');
    signals.pin.value = '';

    initPinHandlers();
  });

  afterEach(() => {
    cleanupPinHandlers();
    document.body.innerHTML = '';
  });

  async function triggerPinSetupFlow(): Promise<void> {
    const settingsPin = document.getElementById('settings-pin') as HTMLInputElement;
    settingsPin.value = '1234';
    (document.getElementById('save-pin-btn') as HTMLButtonElement).click();
    // Await the async save-pin handler's createPinWithRecovery promise
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  }

  function simulateModalClose(id: string): void {
    // Mirror closeModal's DOM mutation so the MutationObserver sees the
    // same class transition that production would produce. Done through
    // raw DOM API — not via ui.ts — because the class transition itself
    // is the observable the fix relies on.
    const modal = document.getElementById(id) as HTMLElement;
    modal.classList.remove('active');
    modal.classList.add('hidden');
  }

  it('clears pendingRecoveryPhrase when the modal is dismissed without clicking Confirm', async () => {
    await triggerPinSetupFlow();

    // Sanity: phrase is set, modal is open, copy works
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(clipboardWriteText).toHaveBeenCalledWith(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
    );

    // Dismiss the modal without clicking Confirm (e.g., Escape or backdrop
    // click). The observer must zero the phrase.
    simulateModalClose('recovery-phrase-modal');

    // Allow MutationObserver callbacks to flush (microtask queue)
    await flushMicrotasks();

    // Subsequent copy attempt must NOT reach clipboard.writeText, because
    // pendingRecoveryPhrase is null — the falsy guard in the copy handler
    // short-circuits.
    clipboardWriteText.mockClear();
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it('clears pendingRecoveryPhrase when the user clicks Confirm', async () => {
    await triggerPinSetupFlow();

    // Click Confirm — this path explicitly zeroes the phrase AND triggers
    // the observer via closeModal().
    (document.getElementById('confirm-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    clipboardWriteText.mockClear();
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it('cleanupPinHandlers zeroes any retained phrase and disposes the observer', async () => {
    await triggerPinSetupFlow();

    // Sanity: phrase is readable
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);

    cleanupPinHandlers();

    // Re-init after cleanup — the previous observer must be gone and
    // pendingRecoveryPhrase must be null. Verify no stale clipboard write
    // is possible from a lingering handler (observer + button cleanup).
    clipboardWriteText.mockClear();
    // copy-recovery-btn cleanup removed the listener so a click does nothing
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it('re-opening the modal sets up a fresh observer that clears a new phrase', async () => {
    await triggerPinSetupFlow();

    // First dismissal — clears phrase
    simulateModalClose('recovery-phrase-modal');
    await flushMicrotasks();

    // Simulate a re-open flow (second PIN save)
    const settingsPin = document.getElementById('settings-pin') as HTMLInputElement;
    settingsPin.value = '5678';
    mockCreatePinWithRecovery.mockResolvedValueOnce({
      bundle: 'mock:bundle:second',
      recoveryPhrase: 'zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar',
    });
    (document.getElementById('save-pin-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Second phrase is readable
    clipboardWriteText.mockClear();
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).toHaveBeenCalledWith(
      'zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar'
    );

    // Second dismissal — fresh observer must also clear
    simulateModalClose('recovery-phrase-modal');
    await flushMicrotasks();
    clipboardWriteText.mockClear();
    (document.getElementById('copy-recovery-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});
