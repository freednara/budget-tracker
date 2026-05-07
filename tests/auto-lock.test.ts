import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initAutoLock, pauseAutoLock, resetAutoLockTimer, resumeAutoLock } from '../js/modules/features/security/auto-lock.js';

// Fixes M19 (Inline-Behavior-Review rev 12): minimal MockBroadcastChannel
// mirroring the pattern in tests/multi-tab-sync-broadcast.test.ts.
// Tests register the mock on `globalThis` before initAutoLock, then drive
// cross-tab messages by invoking `onmessage` directly on each instance.
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];
  name: string;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    this.messages.push(data);
  }

  close(): void {
    MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter((instance) => instance !== this);
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('auto-lock', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalBroadcastChannel = (globalThis as typeof globalThis & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    MockBroadcastChannel.reset();
    (globalThis as typeof globalThis & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    MockBroadcastChannel.reset();
    // Restore the original BroadcastChannel (or the undefined we observed on
    // entry). Cast through `unknown` so the assignment doesn't trip the
    // strict-mode typecheck on the non-optional `globalThis.BroadcastChannel`.
    // Phase 6 Slice 1j (rev 12 L6): narrower cast with explicit
    // `| undefined` for `exactOptionalPropertyTypes`.
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel | undefined }).BroadcastChannel =
      originalBroadcastChannel;
  });

  it('locks immediately when the document becomes hidden with zero-delay override', () => {
    // Fixes M17 (Inline-Behavior-Review rev 12): pass visibilityDelayMs: 0
    // to preserve legacy lock-on-hide behavior explicitly. Default is now
    // a 30s grace period — see the "grace period" test below.
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 0);

    setVisibility('hidden');

    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('defers visibility-change lock through the grace period', () => {
    // Fixes M17: verify the grace-period path (schedule, don't fire
    // immediately, fire after the delay if still hidden).
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 30_000);

    setVisibility('hidden');
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(29_999);
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cancels a pending visibility-change lock when the tab becomes visible again', () => {
    // Fixes M17: verify the return-before-grace cancellation path. This
    // is the core UX guarantee — user alt-tabs to Mail, comes back in
    // 5s, no lock. We advance well past the 30s grace window (to prove
    // the cancel worked) but stay inside the 60s inactivity window — the
    // inactivity timer is an orthogonal concern tested separately above.
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 30_000);

    setVisibility('hidden');
    vi.advanceTimersByTime(5_000);
    setVisibility('visible');

    // 5s + 40s = 45s total, past the 30s grace threshold but short of
    // the 60s inactivity expiry.
    vi.advanceTimersByTime(40_000);
    expect(onLock).not.toHaveBeenCalled();
    cleanup();
  });

  it('respects pause and resume across visibility changes', () => {
    // Regression: pause must suppress the lock, and the hide event while
    // paused must not schedule a latent grace-period timer that fires
    // after resume. Passes visibilityDelayMs: 0 to keep the test simple
    // (the paused-behavior contract is orthogonal to the grace period).
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 0);

    pauseAutoLock();
    setVisibility('hidden');
    expect(onLock).not.toHaveBeenCalled();

    setVisibility('visible');
    resumeAutoLock();
    setVisibility('hidden');

    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('still supports timer-based locking after manual reset', () => {
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 5_000);

    resetAutoLockTimer();
    vi.advanceTimersByTime(4_999);
    expect(onLock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('broadcasts a lock message when triggerLock fires (cross-tab M19)', () => {
    // Fixes M19 (Inline-Behavior-Review rev 12): sibling tabs must receive
    // a lock broadcast so they lock in sync. Zero-delay visibility lock
    // keeps the test deterministic.
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 0);

    setVisibility('hidden');
    expect(onLock).toHaveBeenCalledTimes(1);

    const channel = MockBroadcastChannel.instances.find((c) => c.name === 'auto_lock_sync');
    expect(channel).toBeDefined();
    expect(channel!.messages).toContainEqual({ type: 'lock' });
    cleanup();
  });

  it('locks when another tab broadcasts a lock message, without re-broadcasting', () => {
    // Fixes M19: external 'lock' must call our lockCallback but must NOT
    // re-broadcast (echo loop guard).
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 30_000);

    const channel = MockBroadcastChannel.instances.find((c) => c.name === 'auto_lock_sync');
    expect(channel).toBeDefined();
    channel!.messages.length = 0; // clear any init-time messages

    channel!.onmessage?.(new MessageEvent('message', { data: { type: 'lock' } }));

    expect(onLock).toHaveBeenCalledTimes(1);
    // No re-broadcast — otherwise a third tab would relay infinitely.
    expect(channel!.messages).toEqual([]);
    cleanup();
  });

  it('resets the inactivity timer when another tab broadcasts activity (cross-tab keep-alive)', () => {
    // Fixes M19: activity in Tab A must reset Tab B's timer so Tab B
    // doesn't lock while Tab A is in active use.
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 10_000, 30_000);

    const channel = MockBroadcastChannel.instances.find((c) => c.name === 'auto_lock_sync');
    expect(channel).toBeDefined();

    vi.advanceTimersByTime(9_000);
    // Sibling tab signals activity — our timer should reset.
    channel!.onmessage?.(new MessageEvent('message', { data: { type: 'activity' } }));

    // Advance past the old expiry — lock should NOT have fired.
    vi.advanceTimersByTime(2_000); // total 11s since init; old timer would have expired at 10s
    expect(onLock).not.toHaveBeenCalled();

    // Advance past the new expiry (scheduleTimer from activity happened at t=9s; new expiry is t=19s).
    vi.advanceTimersByTime(8_000); // total 19s
    expect(onLock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('ignores malformed cross-tab messages', () => {
    // Fixes M19: defensive payload guard on the BroadcastChannel handler.
    // A malicious extension on a sibling origin (same eTLD+1) could post
    // garbage to this channel; we must not throw or miscount.
    const onLock = vi.fn();
    const cleanup = initAutoLock(onLock, 60_000, 30_000);

    const channel = MockBroadcastChannel.instances.find((c) => c.name === 'auto_lock_sync');
    expect(channel).toBeDefined();

    // These should all be ignored without throwing.
    channel!.onmessage?.(new MessageEvent('message', { data: null }));
    channel!.onmessage?.(new MessageEvent('message', { data: undefined }));
    channel!.onmessage?.(new MessageEvent('message', { data: 'not-an-object' }));
    channel!.onmessage?.(new MessageEvent('message', { data: { type: 42 } }));
    channel!.onmessage?.(new MessageEvent('message', { data: { type: 'unknown' } }));

    expect(onLock).not.toHaveBeenCalled();
    cleanup();
  });
});
