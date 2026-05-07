/**
 * `loadAndCall` — M6 (Inline-Behavior-Review rev 12).
 *
 * The helper wraps a floating `import().then(fn)` shape so any loader
 * failure routes through `trackError` instead of becoming an unhandled
 * rejection. These tests lock in the two-branch contract:
 *   1. success → callback invoked with the resolved module,
 *   2. failure → `trackError` records the loader error with the caller
 *      context (default action `dynamic_import_failed`, overridable).
 *
 * The DI wiring in `app-init-di.ts` and the lazy-chart branch in
 * `chart-renderers.ts` both depend on this behavior. An earlier shape
 * (`import('./m.js').then(fn)` with no `.catch`) dropped the promise,
 * so a network blip or broken chunk after deploy left the triggering
 * button wired to nothing with zero telemetry — which is what M6 flags.
 *
 * Note on the filtering pattern: error-tracker's M28 `console.error`
 * capture surfaces every `[Error Tracked]` dev-log as its own tracked
 * error, so we filter captured listeners for the specific message we
 * emitted rather than asserting `length === 1`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadAndCall,
  onError,
  clearErrorLog,
  initialize as initializeErrorTracker,
  resetCircuitBreaker,
} from '../js/modules/core/error-tracker.js';

// Drain pending microtasks (import resolution + the helper's .then/.catch).
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

interface CapturedErr {
  message: string;
  module: string | undefined;
  action: string | undefined;
}

describe('loadAndCall (M6 — Inline-Behavior-Review rev 12)', () => {
  beforeEach(() => {
    initializeErrorTracker();
    clearErrorLog();
    resetCircuitBreaker();
  });

  it('invokes the callback with the resolved module on success', async () => {
    const fn = vi.fn();
    loadAndCall(() => Promise.resolve({ greeting: 'hello' }), fn);
    await flushMicrotasks();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ greeting: 'hello' });
  });

  it('routes loader failures through trackError with default context', async () => {
    const captured: CapturedErr[] = [];
    const unsub = onError((err) => {
      captured.push({
        message: err.message,
        module: err.context.module,
        action: err.context.action,
      });
    });

    const cbSpy = vi.fn();
    loadAndCall(() => Promise.reject(new Error('M6 test loader fail default ctx')), cbSpy);
    await flushMicrotasks();

    expect(cbSpy).not.toHaveBeenCalled();
    const matched = captured.find((e) => e.message.includes('M6 test loader fail default ctx'));
    expect(matched).toBeDefined();
    // Default action when caller passes no context.
    expect(matched?.action).toBe('dynamic_import_failed');

    unsub();
  });

  it('honors caller-provided module + action context on failure', async () => {
    const captured: CapturedErr[] = [];
    const unsub = onError((err) => {
      captured.push({
        message: err.message,
        module: err.context.module,
        action: err.context.action,
      });
    });

    loadAndCall(
      () => Promise.reject(new Error('M6 test custom ctx loader fail')),
      () => { /* never runs */ },
      { module: 'TestModule', action: 'custom_action' }
    );
    await flushMicrotasks();

    const matched = captured.find((e) => e.message.includes('M6 test custom ctx loader fail'));
    expect(matched).toBeDefined();
    expect(matched?.module).toBe('TestModule');
    // Caller-supplied action overrides the helper's default.
    expect(matched?.action).toBe('custom_action');

    unsub();
  });

  it('wraps non-Error rejection values into Error instances', async () => {
    const captured: string[] = [];
    const unsub = onError((err) => {
      captured.push(err.message);
    });

    // Simulate a pre-ES2022 reject(string) or any non-Error payload.
    loadAndCall(
      () => Promise.reject('M6 test string rejection payload'),
      () => {}
    );
    await flushMicrotasks();

    const matched = captured.find((m) => m.includes('M6 test string rejection payload'));
    expect(matched).toBeDefined();

    unsub();
  });

  it('also captures synchronous callback throws via the same catch chain', async () => {
    // Observation: `Promise.resolve(x).then(fn).catch(cb)` runs `cb` when
    // `fn` throws. That means loadAndCall's `.catch` clause widens the
    // telemetry net — a callback that throws synchronously is reported
    // as a dynamic-import failure alongside the loader itself. Documented
    // as a pragmatic feature: the helper protects the entire "load +
    // apply" pipeline from silent drop.
    const captured: string[] = [];
    const unsub = onError((err) => {
      captured.push(err.message);
    });

    loadAndCall(
      () => Promise.resolve({ run: () => { throw new Error('M6 test callback boom'); } }),
      (mod: { run: () => void }) => mod.run()
    );
    await flushMicrotasks();

    const matched = captured.find((m) => m.includes('M6 test callback boom'));
    expect(matched).toBeDefined();

    unsub();
  });
});
