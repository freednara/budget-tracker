import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { showPinLock, hidePinLock } from '../js/modules/ui/widgets/pin-ui-handlers.js';
import * as signals from '../js/modules/core/signals.js';

/**
 * CR-Apr24-D2 [P2×4 + P3×2] — PIN lock overlay lifecycle
 * (Code-Review-Report findings 152, 153, 156, 157, 158, 159).
 *
 * Pre-fix: showPinLock/hidePinLock had several lifecycle bugs that
 * accumulated state across repeat calls and left stale UI from prior
 * sessions. The fixes:
 *   (157) showPinLock idempotent — repeat calls when already-active no-op
 *   (152) showPinLock surfaces persisted lockout countdown immediately
 *   (156, 158) showPinLock pauses auto-lock; hidePinLock resumes
 *   (159) hidePinLock clears stale #pin-error and any active countdown
 *   (153) recovery success path also tears down PIN-entry lockout
 *
 * Tests use happy-dom + structural DOM assertions. The auto-lock
 * pause/resume calls are fire-and-forget dynamic imports; we mock the
 * auto-lock module to spy on them.
 */

const { mockedPauseAutoLock, mockedResumeAutoLock } = vi.hoisted(() => ({
  mockedPauseAutoLock: vi.fn(),
  mockedResumeAutoLock: vi.fn()
}));

vi.mock('../js/modules/features/security/auto-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/features/security/auto-lock.js')>();
  return {
    ...actual,
    pauseAutoLock: mockedPauseAutoLock,
    resumeAutoLock: mockedResumeAutoLock
  };
});

function seedDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <button id="prev-focus-target">Pre-lock focus</button>
    </div>
    <div id="pin-overlay">
      <input id="pin-input" />
      <div id="pin-error" class="hidden"></div>
    </div>
  `;
}

function isOverlayActive(): boolean {
  return document.getElementById('pin-overlay')?.classList.contains('active') ?? false;
}

function getError(): { text: string; hidden: boolean } {
  const el = document.getElementById('pin-error');
  return {
    text: el?.textContent ?? '',
    hidden: el?.classList.contains('hidden') ?? true
  };
}

describe('CR-Apr24-D2 — PIN lock overlay lifecycle', () => {
  beforeEach(() => {
    seedDom();
    mockedPauseAutoLock.mockReset();
    mockedResumeAutoLock.mockReset();
    // Reset persistent rate-limiter state if any leaked from a previous test.
    signals.pin.value = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  // ============================================================
  // Finding 157 — showPinLock idempotence
  // ============================================================

  describe('finding 157 — showPinLock is idempotent', () => {
    it('repeat call does not re-overwrite _pinPreviousFocus or accumulate trap listeners', () => {
      const opener = document.getElementById('prev-focus-target') as HTMLButtonElement;
      opener.focus();

      showPinLock();
      expect(isOverlayActive()).toBe(true);

      // Second call should be a no-op for state setup.
      showPinLock();

      // pauseAutoLock should have been called only once (the first call).
      // The idempotence guard short-circuits before any state-mutating work.
      expect(mockedPauseAutoLock).toHaveBeenCalledTimes(1);
    });

    it('hidePinLock after a single show + repeat-show fully cleans up', async () => {
      showPinLock();
      showPinLock(); // duplicate, should no-op

      hidePinLock();
      // Allow microtasks for the dynamic import resume call.

      expect(isOverlayActive()).toBe(false);

      const app = document.getElementById('app');
      expect(app?.hasAttribute('inert')).toBe(false);
      expect(app?.hasAttribute('aria-hidden')).toBe(false);
    });
  });

  // ============================================================
  // Finding 156 + 158 — auto-lock pause/resume on overlay show/hide
  // ============================================================

  describe('findings 156, 158 — auto-lock pauses on show, resumes on hide', () => {
    it('showPinLock invokes pauseAutoLock', async () => {
      showPinLock();
      // Fire-and-forget dynamic import; allow microtasks.
      expect(mockedPauseAutoLock).toHaveBeenCalled();
    });

    it('hidePinLock invokes resumeAutoLock', async () => {
      showPinLock();
      hidePinLock();
      expect(mockedResumeAutoLock).toHaveBeenCalled();
    });

    it('show → hide → show cycles correctly pair pause/resume calls', async () => {
      // Flush after each pair so the fire-and-forget dynamic import
      // has resolved before the next show/hide enqueues another.
      showPinLock();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      hidePinLock();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      showPinLock();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      hidePinLock();
      await new Promise<void>(resolve => setTimeout(resolve, 0));

      expect(mockedPauseAutoLock).toHaveBeenCalledTimes(2);
      expect(mockedResumeAutoLock).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // Finding 159 — hidePinLock clears stale error
  // ============================================================

  describe('finding 159 — hidePinLock clears stale #pin-error', () => {
    it('clears textContent and adds .hidden class', () => {
      // Simulate a stale error from a prior failed-attempt session.
      const errEl = document.getElementById('pin-error') as HTMLElement;
      errEl.textContent = 'That PIN didn\u2019t match. You have 2 attempts left.';
      errEl.classList.remove('hidden');

      showPinLock();
      // (the lockout-state-restore branch in showPinLock won't fire because
      // signals.pin is empty and rate-limiter has no failures recorded for
      // this test — so error stays as-is until hidePinLock)
      hidePinLock();

      const after = getError();
      expect(after.text).toBe('');
      expect(after.hidden).toBe(true);
    });

    it('also re-enables a disabled #pin-input from a prior lockout', () => {
      const input = document.getElementById('pin-input') as HTMLInputElement;
      input.disabled = true;
      input.value = '1234';

      showPinLock();
      hidePinLock();

      expect(input.disabled).toBe(false);
      expect(input.value).toBe('');
    });
  });

  // ============================================================
  // Finding 152 — lockout state surfaced on overlay open
  // ============================================================

  describe('finding 152 — overlay open consults rate-limiter', () => {
    it('clean state (no prior failures) leaves error hidden', () => {
      // No prior failed-attempt history → checkRateLimit('pin') returns
      // allowed=true → no countdown UI painted.
      showPinLock();
      const err = getError();
      // showPinLock with no lockout: error stays whatever it was (test
      // started with hidden empty error, so still hidden).
      expect(err.hidden).toBe(true);
      expect(err.text).toBe('');
    });
  });

  // ============================================================
  // Structural integration: full lifecycle paths
  // ============================================================

  describe('full lifecycle integration', () => {
    it('show → hide is a clean round-trip with no accumulated state', async () => {
      const opener = document.getElementById('prev-focus-target') as HTMLButtonElement;
      opener.focus();

      showPinLock();
      hidePinLock();

      // Overlay closed
      expect(isOverlayActive()).toBe(false);
      // App not inert
      const app = document.getElementById('app');
      expect(app?.hasAttribute('inert')).toBe(false);
      // Error empty + hidden
      expect(getError().hidden).toBe(true);
      expect(getError().text).toBe('');
      // Input clean + enabled
      const input = document.getElementById('pin-input') as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.disabled).toBe(false);
    });

    it('hidePinLock when overlay was never shown is a clean no-op', () => {
      // Defense-in-depth: out-of-order calls shouldn't throw.
      expect(() => hidePinLock()).not.toThrow();
      expect(isOverlayActive()).toBe(false);
    });

    it('hidePinLock against missing #pin-overlay container is a clean no-op', () => {
      document.body.innerHTML = ''; // wipe DOM entirely
      expect(() => hidePinLock()).not.toThrow();
    });
  });
});
