/**
 * Phase 6 Slice 1d (Inline-Behavior-Review rev 12, L10)
 *
 * Verifies the SubtleCrypto -> xxHash32 fallback in
 * `state-revision.calculateChecksum` is no longer silent. When
 * `crypto.subtle.digest('SHA-256', ...)` throws (unsupported platform,
 * non-secure context, restricted WebView), the fallback path MUST
 * route a `trackError` the first time it fires in a session so the
 * monitoring dashboard sees the entropy downgrade.
 *
 * Subsequent fallbacks stay silent (once-per-session latch) because
 * the condition is platform-stable within a JS context — surfacing
 * the same signal every checksum would just spam the pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn(),
}));

describe('state-revision checksum fallback telemetry (L10)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires trackError the first time SubtleCrypto throws and stays silent thereafter', async () => {
    // Force crypto.subtle.digest to reject so calculateChecksum takes
    // the xxHash32 fallback path.
    const failingDigest = vi.fn().mockRejectedValue(new Error('SubtleCrypto unavailable'));
    vi.stubGlobal('crypto', {
      ...(globalThis.crypto ?? {}),
      subtle: { digest: failingDigest },
    } as unknown as Crypto);

    const { trackError } = await import('../js/modules/core/error-tracker.js');
    const { recordStateChange } = await import('../js/modules/core/state-revision.js');

    // First call that requires a checksum (CHECKSUM_KEYS = [SK.TX]).
    await recordStateChange('harbor_transactions', [{ id: 'tx-1', amount: 100 }], 'tab-A');

    expect(failingDigest).toHaveBeenCalledTimes(1);
    expect(trackError).toHaveBeenCalledTimes(1);
    const checksumCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!checksumCall) throw new Error('expected trackError to have been called');
    const [message, context, type] = checksumCall;
    expect(message).toMatch(/SubtleCrypto unavailable/);
    expect(message).toMatch(/xxHash32/);
    expect(context).toMatchObject({
      module: 'state-revision',
      action: 'xxhash_fallback_engaged',
    });
    expect(type).toBe('validationError');

    // Second call — fallback still engaged, but trackError MUST NOT
    // fire again (once-per-session latch).
    await recordStateChange('harbor_transactions', [{ id: 'tx-2', amount: 200 }], 'tab-A');

    expect(failingDigest).toHaveBeenCalledTimes(2);
    expect(trackError).toHaveBeenCalledTimes(1);
  });

  it('does not fire trackError when SubtleCrypto succeeds (happy path)', async () => {
    const passingDigest = vi
      .fn<(algo: string, data: ArrayBufferLike) => Promise<ArrayBuffer>>()
      .mockResolvedValue(new Uint8Array(32).buffer);
    vi.stubGlobal('crypto', {
      ...(globalThis.crypto ?? {}),
      subtle: { digest: passingDigest },
    } as unknown as Crypto);

    const { trackError } = await import('../js/modules/core/error-tracker.js');
    const { recordStateChange } = await import('../js/modules/core/state-revision.js');

    await recordStateChange('harbor_transactions', [{ id: 'tx-1', amount: 100 }], 'tab-A');

    expect(passingDigest).toHaveBeenCalledTimes(1);
    expect(trackError).not.toHaveBeenCalled();
  });
});
