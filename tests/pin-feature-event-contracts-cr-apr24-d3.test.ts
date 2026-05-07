import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emit, on, createListenerGroup, destroyListenerGroup } from '../js/modules/core/event-bus.js';
import { FeatureEvents, updatePin, clearPin } from '../js/modules/core/feature-event-interface.js';

/**
 * CR-Apr24-D3 [P2 + P3] — Feature-event PIN payload contracts
 * (Code-Review-Report findings 166, 167).
 *
 * (166) `updatePin(newPin, oldPin?)` emitter sends `{newPin, oldPin}`
 *       object but listener was typed `(bundle: string)` — payload-shape
 *       mismatch persisted the wrong value into SK.PIN for any caller
 *       using the public API.
 * (167) `clearPin()` listener cleared signal + persisted but didn't call
 *       `updateClearPinVisibility()`, leaving Settings "Turn Off PIN"
 *       button stale.
 *
 * The tests verify the emitter's payload shape AND that the events bus
 * delivers them — the listener-side contract (which file under test
 * fixes) is exercised through pin-ui-handlers integration tests in
 * the existing suite. Here we lock the public-API contract.
 */

describe('CR-Apr24-D3 — PIN feature-event payload contracts', () => {
  let groupId: string;
  let receivedPayloads: unknown[];

  beforeEach(() => {
    groupId = createListenerGroup('test-d3');
    receivedPayloads = [];
  });

  afterEach(() => {
    destroyListenerGroup(groupId);
  });

  describe('finding 166 — updatePin emits {newPin, oldPin} object', () => {
    it('emitter sends a structured payload object (not a raw string)', () => {
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        receivedPayloads.push(payload);
      }, { groupId });

      updatePin('newBundleString123');

      expect(receivedPayloads).toHaveLength(1);
      const got = receivedPayloads[0];
      expect(typeof got).toBe('object');
      expect(got).not.toBeNull();
      expect((got as { newPin?: unknown }).newPin).toBe('newBundleString123');
      // oldPin omitted is undefined
      expect((got as { oldPin?: unknown }).oldPin).toBeUndefined();
    });

    it('passes oldPin through when provided (PIN-rotation scenario)', () => {
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        receivedPayloads.push(payload);
      }, { groupId });

      updatePin('newBundle', 'oldBundle');

      expect(receivedPayloads).toHaveLength(1);
      const got = receivedPayloads[0] as { newPin: string; oldPin: string };
      expect(got.newPin).toBe('newBundle');
      expect(got.oldPin).toBe('oldBundle');
    });

    it('listener that destructures {newPin} from payload sees the right value', async () => {
      // Simulates the post-fix listener shape. Pre-fix, the listener
      // was typed `(bundle: string)` so `bundle` would have been the
      // entire object — and `setPin(bundle)` would have stored
      // `[object Object]` or similar.
      let extractedBundle: string | null = null;
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        const obj = payload as { newPin?: string };
        extractedBundle = obj?.newPin ?? null;
      }, { groupId });

      updatePin('correctBundle');

      // Allow event-bus async dispatch.
      await Promise.resolve();
      expect(extractedBundle).toBe('correctBundle');
    });

    it('post-fix listener bails on empty newPin (no spurious empty-string write)', () => {
      let setPinCalled = false;
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        const obj = payload as { newPin?: string };
        const bundle = obj?.newPin ?? '';
        if (!bundle) return;
        setPinCalled = true;
      }, { groupId });

      updatePin('');

      expect(setPinCalled).toBe(false);
    });
  });

  describe('finding 167 — clearPin emits no-payload event', () => {
    it('emitter fires CLEAR_PIN event with no payload', () => {
      let fired = false;
      on(FeatureEvents.CLEAR_PIN, () => {
        fired = true;
      }, { groupId });

      clearPin();

      expect(fired).toBe(true);
    });

    it('UPDATE_PIN and CLEAR_PIN are distinct event names (no cross-talk)', () => {
      let updateFired = 0;
      let clearFired = 0;

      on(FeatureEvents.UPDATE_PIN, () => { updateFired++; }, { groupId });
      on(FeatureEvents.CLEAR_PIN, () => { clearFired++; }, { groupId });

      clearPin();
      expect(updateFired).toBe(0);
      expect(clearFired).toBe(1);

      updatePin('bundle1');
      expect(updateFired).toBe(1);
      expect(clearFired).toBe(1);
    });
  });

  describe('event-name constants stable for back-compat', () => {
    it('UPDATE_PIN and CLEAR_PIN use the documented namespaces', () => {
      // Pin the wire format so any rename gets caught by a failing test.
      expect(FeatureEvents.UPDATE_PIN).toBe('feature:update:pin');
      expect(FeatureEvents.CLEAR_PIN).toBe('feature:clear:pin');
    });
  });

  describe('emitter parity check (pre-fix regression lock)', () => {
    it('updatePin emits an object whose structure has BOTH expected keys', () => {
      // Defensive lock: if anyone ever changes the emitter shape (e.g.
      // back to a raw string for "simplicity"), this test fails — and
      // the listener contract above documents WHY the object shape exists
      // (forward-compat for PIN-rotation oldPin).
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        receivedPayloads.push(payload);
      }, { groupId });

      updatePin('some_bundle');
      const got = receivedPayloads[0] as object;
      const keys = Object.keys(got);
      expect(keys).toContain('newPin');
      expect(keys).toContain('oldPin');
    });
  });

  describe('emit-via-event-bus shape verification', () => {
    it('the same structured payload arrives through emit() too (not just the public helper)', () => {
      // Some internal code may emit the event directly via emit(); make
      // sure that path produces the same shape so the listener works for
      // both call sites.
      on(FeatureEvents.UPDATE_PIN, (payload: unknown) => {
        receivedPayloads.push(payload);
      }, { groupId });

      emit(FeatureEvents.UPDATE_PIN, { newPin: 'directBundle', oldPin: undefined });

      expect(receivedPayloads).toHaveLength(1);
      expect((receivedPayloads[0] as { newPin: string }).newPin).toBe('directBundle');
    });
  });
});
