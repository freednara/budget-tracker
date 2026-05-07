import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import {
  startAutoLockIfNeeded,
  stopAutoLockIfActive,
  isAutoLockActive
} from '../js/modules/features/security/auto-lock.js';
import { updateClearPinVisibility } from '../js/modules/ui/widgets/pin-ui-handlers.js';

/**
 * CR-Apr24-D1 [P2×4 + P3×1] — Remote PIN sync
 * (Code-Review-Report findings 150, 151, 154, 155, 163).
 *
 * Pre-fix: cross-tab PIN-state changes left the local app in
 * inconsistent states:
 *   (150) Remote PIN clear → locked tab stayed locked.
 *   (151) Remote PIN add → current tab kept running with no auto-lock.
 *   (154) Local clear-PIN → auto-lock kept running.
 *   (155) Remote PIN clear → sibling tabs kept auto-lock running.
 *   (163) Remote PIN change → Settings "Turn Off PIN" stayed stale.
 *
 * Fix: module-scoped auto-lock controller (`startAutoLockIfNeeded` /
 * `stopAutoLockIfActive` / `isAutoLockActive`) plus hoisted
 * `updateClearPinVisibility` that any path can call.
 */

function seedDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <button id="clear-pin-btn">Turn Off PIN</button>
    </div>
    <div id="pin-overlay">
      <input id="pin-input" />
      <div id="pin-error" class="hidden"></div>
    </div>
  `;
}

describe('CR-Apr24-D1 — Remote PIN sync', () => {
  beforeEach(() => {
    seedDom();
    signals.pin.value = '';
    // Clean any leftover auto-lock from a previous test.
    stopAutoLockIfActive();
  });

  afterEach(() => {
    stopAutoLockIfActive();
    document.body.innerHTML = '';
    signals.pin.value = '';
  });

  // ============================================================
  // Auto-lock controller idempotence (findings 151, 154, 155)
  // ============================================================

  describe('auto-lock module-scoped controller', () => {
    it('startAutoLockIfNeeded sets isAutoLockActive=true', () => {
      expect(isAutoLockActive()).toBe(false);
      startAutoLockIfNeeded(() => {});
      expect(isAutoLockActive()).toBe(true);
    });

    it('startAutoLockIfNeeded is idempotent — repeated calls do not stack listeners', () => {
      startAutoLockIfNeeded(() => {});
      const cleanup1 = startAutoLockIfNeeded(() => {});
      const cleanup2 = startAutoLockIfNeeded(() => {});

      // Same cleanup reference returned across redundant calls
      // (the controller reuses the active instance).
      expect(cleanup1).toBe(cleanup2);
      expect(isAutoLockActive()).toBe(true);
    });

    it('stopAutoLockIfActive tears down the controller', () => {
      startAutoLockIfNeeded(() => {});
      expect(isAutoLockActive()).toBe(true);
      stopAutoLockIfActive();
      expect(isAutoLockActive()).toBe(false);
    });

    it('stopAutoLockIfActive is idempotent (safe no-op when nothing running)', () => {
      expect(isAutoLockActive()).toBe(false);
      expect(() => {
        stopAutoLockIfActive();
        stopAutoLockIfActive();
      }).not.toThrow();
      expect(isAutoLockActive()).toBe(false);
    });

    it('cleanup returned by startAutoLockIfNeeded clears the active flag', () => {
      const cleanup = startAutoLockIfNeeded(() => {});
      expect(isAutoLockActive()).toBe(true);
      cleanup();
      expect(isAutoLockActive()).toBe(false);
    });
  });

  // ============================================================
  // updateClearPinVisibility (finding 163)
  // ============================================================

  describe('updateClearPinVisibility — module-level export', () => {
    it('hides the Turn Off PIN button when signals.pin is empty', () => {
      const btn = document.getElementById('clear-pin-btn') as HTMLElement;
      btn.hidden = false;

      signals.pin.value = '';
      updateClearPinVisibility();

      expect(btn.hidden).toBe(true);
    });

    it('shows the Turn Off PIN button when signals.pin is set', () => {
      const btn = document.getElementById('clear-pin-btn') as HTMLElement;
      btn.hidden = true;

      signals.pin.value = 'somehash';
      updateClearPinVisibility();

      expect(btn.hidden).toBe(false);
    });

    it('is a clean no-op when the button is not in the DOM (Settings not mounted)', () => {
      document.body.innerHTML = '<div id="app"></div>';
      signals.pin.value = 'somehash';
      expect(() => updateClearPinVisibility()).not.toThrow();
    });

    it('reflects signal flips bidirectionally across repeated calls', () => {
      const btn = document.getElementById('clear-pin-btn') as HTMLElement;

      signals.pin.value = '';
      updateClearPinVisibility();
      expect(btn.hidden).toBe(true);

      signals.pin.value = 'h1';
      updateClearPinVisibility();
      expect(btn.hidden).toBe(false);

      signals.pin.value = '';
      updateClearPinVisibility();
      expect(btn.hidden).toBe(true);
    });
  });

  // ============================================================
  // Integration shape: cross-tab handler can compose these primitives
  // ============================================================

  describe('cross-tab handler integration shape', () => {
    it('PIN-add path: starts auto-lock + updates Settings visibility', () => {
      const btn = document.getElementById('clear-pin-btn') as HTMLElement;
      btn.hidden = true;

      // Simulate the storage-events.ts SK.PIN handler when remote tab adds PIN:
      signals.pin.value = 'remoteHash';
      const callback = vi.fn();

      startAutoLockIfNeeded(callback);
      updateClearPinVisibility();

      expect(isAutoLockActive()).toBe(true);
      expect(btn.hidden).toBe(false);
    });

    it('PIN-clear path: stops auto-lock + updates Settings visibility', () => {
      // Pre-condition: PIN set, auto-lock running.
      signals.pin.value = 'h1';
      startAutoLockIfNeeded(() => {});
      const btn = document.getElementById('clear-pin-btn') as HTMLElement;
      btn.hidden = false;

      // Simulate remote clear:
      signals.pin.value = '';
      stopAutoLockIfActive();
      updateClearPinVisibility();

      expect(isAutoLockActive()).toBe(false);
      expect(btn.hidden).toBe(true);
    });

    it('rapid add → clear → add sequence stays consistent', () => {
      // Stress-test idempotence — simulate a flurry of cross-tab PIN events.
      signals.pin.value = 'h1';
      startAutoLockIfNeeded(() => {});
      expect(isAutoLockActive()).toBe(true);

      signals.pin.value = '';
      stopAutoLockIfActive();
      expect(isAutoLockActive()).toBe(false);

      signals.pin.value = 'h2';
      startAutoLockIfNeeded(() => {});
      expect(isAutoLockActive()).toBe(true);

      signals.pin.value = '';
      stopAutoLockIfActive();
      expect(isAutoLockActive()).toBe(false);
    });
  });
});
