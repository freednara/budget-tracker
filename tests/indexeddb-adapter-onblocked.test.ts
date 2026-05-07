/**
 * Phase 6 Slice 1e (Inline-Behavior-Review rev 12, L11)
 *
 * Verifies the `onblocked` handler in IndexedDBAdapter.init() no longer
 * goes silent. Previously the handler just resolved with
 * `{ isOk: false, error: 'Database blocked by other tabs' }` and the
 * user saw nothing — no toast, no console, no tracked error. When
 * Harbor Ledger is open in multiple tabs and the live tab tries to
 * upgrade the schema, `request.onblocked` fires and the upgrade cannot
 * proceed until the blocker closes.
 *
 * The L11 fix:
 *   - emits Events.SHOW_TOAST so the user sees an actionable message
 *     ("close the other tab and reload"),
 *   - routes trackError so monitoring captures the blocked state,
 *   - still resolves with isOk: false (unchanged contract for callers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  Events: {
    SHOW_TOAST: 'ui:show_toast',
  },
}));

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn(),
}));

describe('IndexedDBAdapter onblocked handler (L11)', () => {
  let fakeRequest: {
    onupgradeneeded: ((e: unknown) => void) | null;
    onsuccess: ((e: unknown) => void) | null;
    onerror: ((e: unknown) => void) | null;
    onblocked: (() => void) | null;
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    fakeRequest = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };

    // Stub indexedDB.open so the adapter wires handlers onto our
    // fakeRequest and we can trigger onblocked manually.
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => fakeRequest),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits SHOW_TOAST, fires trackError, and resolves { isOk: false } when onblocked fires', async () => {
    const { emit, Events } = await import('../js/modules/core/event-bus.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');
    const { IndexedDBAdapter } = await import('../js/modules/data/indexeddb-adapter.js');

    const adapter = new IndexedDBAdapter();
    const pending = adapter.init();

    // Simulate the browser deciding our upgrade is blocked by another
    // tab holding the DB open.
    fakeRequest.onblocked?.();

    const result = await pending;

    expect(result).toEqual({ isOk: false, error: 'Database blocked by other tabs' });

    // User-visible toast surfaced via the event bus.
    expect(emit).toHaveBeenCalledWith(
      Events.SHOW_TOAST,
      expect.objectContaining({
        message: expect.stringMatching(/another tab/i),
        type: 'error',
      })
    );

    // Monitoring/observability pipeline gets the incident too.
    expect(trackError).toHaveBeenCalledTimes(1);
    const blockedCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!blockedCall) throw new Error('expected trackError to have been called');
    const [message, context, type] = blockedCall;
    expect(message).toMatch(/blocked by another tab/i);
    expect(context).toMatchObject({
      module: 'indexeddb-adapter',
      action: 'init_blocked_by_other_tab',
    });
    expect(type).toBe('error');
  });

  it('does not emit SHOW_TOAST or trackError on the happy (onsuccess) path', async () => {
    const { emit } = await import('../js/modules/core/event-bus.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');
    const { IndexedDBAdapter } = await import('../js/modules/data/indexeddb-adapter.js');

    const adapter = new IndexedDBAdapter();
    const pending = adapter.init();

    // Simulate a successful upgrade-free open.
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      onclose: null,
      onversionchange: null,
      close: vi.fn(),
    };
    fakeRequest.onsuccess?.({ target: { result: fakeDb } });

    const result = await pending;
    expect(result).toEqual({ isOk: true });

    expect(emit).not.toHaveBeenCalled();
    expect(trackError).not.toHaveBeenCalled();
  });
});
