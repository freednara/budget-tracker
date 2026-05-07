/**
 * Phase 6 Slice 1e (Inline-Behavior-Review rev 12, L14)
 *
 * Covers the openModal-failure path in async-modal.ts. Previously each
 * of asyncConfirm / asyncAlert / asyncPrompt wrapped its body in a
 * `new Promise((resolve) => { ... openModal(id); ... })` executor. If
 * `openModal` threw synchronously (DOM torn down, swipe-manager state
 * corrupt, etc.) the caller would await a promise that never settles,
 * AND the 3-4 event listeners already attached (cancel/ok click,
 * keydown on document, backdrop click on the modal) would leak —
 * accumulating across retries until the tab's keydown stack dispatches
 * stale handlers into freed closures.
 *
 * The L14 fix wraps each openModal call in a helper that calls the
 * existing cleanup() function (detaching every listener), routes
 * trackError for monitoring visibility, and rejects the returned
 * promise so the caller can recover.
 *
 * These tests verify the three guarantees:
 *   1. The promise REJECTS (does not hang).
 *   2. trackError is called with the expected module/action/type shape.
 *   3. Listeners attached before the throw are detached by cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the ui-core openModal/closeModal pair so we can force openModal
// to throw on demand. closeModal stays a no-op — cleanup() calls it,
// and we want cleanup() itself to succeed even when openModal throws.
vi.mock('../js/modules/ui/core/ui.js', () => ({
  openModal: vi.fn(() => {
    throw new Error('openModal boom');
  }),
  closeModal: vi.fn(),
}));

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn(),
}));

describe('async-modal openModal failure path (L14)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('asyncConfirm rejects, fires trackError, and detaches listeners when openModal throws', async () => {
    const { asyncConfirm } = await import('../js/modules/ui/components/async-modal.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');

    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    await expect(
      asyncConfirm({ message: 'Delete this transaction?' })
    ).rejects.toThrow(/openModal boom/);

    // trackError fired with the expected shape.
    expect(trackError).toHaveBeenCalledTimes(1);
    const firstCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!firstCall) throw new Error('expected trackError to have been called');
    const [message, context, type] = firstCall;
    expect(message).toMatch(/async-modal: openModal\('async-confirm-modal'\) threw/);
    expect(context).toMatchObject({
      module: 'async-modal',
      action: 'asyncConfirm_openModal_threw',
    });
    expect(type).toBe('error');

    // Every document-level keydown listener that was attached must
    // have been removed by cleanup() in the catch branch.
    const keydownAdds = addSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;
    const keydownRemoves = removeSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;
    expect(keydownAdds).toBeGreaterThan(0);
    expect(keydownRemoves).toBe(keydownAdds);
  });

  it('asyncAlert rejects and fires trackError when openModal throws', async () => {
    const { asyncAlert } = await import('../js/modules/ui/components/async-modal.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');

    await expect(
      asyncAlert({ message: 'Backup complete', type: 'success' })
    ).rejects.toThrow(/openModal boom/);

    expect(trackError).toHaveBeenCalledTimes(1);
    const alertCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!alertCall) throw new Error('expected trackError to have been called');
    const [, context] = alertCall;
    expect(context).toMatchObject({
      module: 'async-modal',
      action: 'asyncAlert_openModal_threw',
    });
  });

  it('asyncPrompt rejects and fires trackError when openModal throws', async () => {
    const { asyncPrompt } = await import('../js/modules/ui/components/async-modal.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');

    await expect(
      asyncPrompt({ message: 'Name this template', defaultValue: 'Rent' })
    ).rejects.toThrow(/openModal boom/);

    expect(trackError).toHaveBeenCalledTimes(1);
    const promptCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!promptCall) throw new Error('expected trackError to have been called');
    const [, context] = promptCall;
    expect(context).toMatchObject({
      module: 'async-modal',
      action: 'asyncPrompt_openModal_threw',
    });
  });

  it('closeModal is invoked as part of cleanup so the dialog does not stay "open"', async () => {
    const uiModule = await import('../js/modules/ui/core/ui.js');
    const { asyncConfirm } = await import('../js/modules/ui/components/async-modal.js');

    await expect(
      asyncConfirm({ message: 'Delete this?' })
    ).rejects.toThrow();

    // cleanup() calls closeModal('async-confirm-modal') whether the
    // caller confirmed, cancelled, OR hit the openModal failure path.
    expect(uiModule.closeModal).toHaveBeenCalledWith('async-confirm-modal');
  });
});
