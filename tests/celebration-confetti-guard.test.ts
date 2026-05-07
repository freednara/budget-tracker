/**
 * Phase 6 Slice 1k (Inline-Behavior-Review rev 12, L26 part 2)
 *
 * Verifies the re-entrancy guard on `spawnConfetti()` and the paired
 * `clearConfetti()` early-dismiss path.
 *
 * Context — `awardAchievement` calls `showCelebration` → `spawnConfetti`
 * on every unlock, so a synchronous burst of achievements (the
 * canonical onboarding case: `first_budget` + `diversified` +
 * `savers_club` unlock together when the user seeds demo data) used
 * to spawn `config.confettiCount * N` DOM nodes with N × confettiCount
 * independent self-removal setTimeouts. One visual confetti burst
 * reads the same as three stacked; stacking only costs DOM and
 * scheduler time.
 *
 * Guard contract:
 *   • while a burst is in flight, a second spawnConfetti call is a no-op
 *   • after `config.confettiRemoval` ms the guard re-arms so the next
 *     unlock cluster (hours / sessions later) fires fresh
 *   • clearConfetti() cancels the in-flight burst immediately: removes
 *     all tracked particle nodes, cancels pending self-removal timers,
 *     and re-arms the guard immediately
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearConfetti,
  configureCelebration,
  spawnConfetti
} from '../js/modules/features/gamification/celebration.js';

const COUNT_IN_TEST = 5;
const REMOVAL_MS = 100;
const DURATION_BASE = 0.1;

describe('celebration — spawnConfetti re-entrancy guard (L26 part 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    // Shrink particle counts and durations so assertions are cheap.
    configureCelebration({
      confettiCount: COUNT_IN_TEST,
      confettiRemoval: REMOVAL_MS,
      confettiDurationBase: DURATION_BASE
    });
    // Reset module state between tests — guard and particle tracking
    // are module-scoped in celebration.ts.
    clearConfetti();
  });

  afterEach(() => {
    clearConfetti();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function particleCount(): number {
    return document.querySelectorAll('.confetti-particle').length;
  }

  it('first spawnConfetti call creates confettiCount particles', () => {
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('second synchronous spawnConfetti call is a no-op (guard blocks)', () => {
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    spawnConfetti();
    // Still exactly one burst — not 2 × COUNT_IN_TEST.
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('three synchronous spawnConfetti calls still produce one burst', () => {
    spawnConfetti();
    spawnConfetti();
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('after confettiRemoval ms the particles self-remove and the guard re-arms', () => {
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    vi.advanceTimersByTime(REMOVAL_MS);

    // Particles self-removed by their per-particle setTimeout.
    expect(particleCount()).toBe(0);

    // Guard is re-armed — next call fires a fresh burst.
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('clearConfetti eagerly removes in-flight particles', () => {
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    clearConfetti();
    expect(particleCount()).toBe(0);
  });

  it('clearConfetti re-arms the guard immediately (next spawn works)', () => {
    spawnConfetti();
    clearConfetti();
    expect(particleCount()).toBe(0);

    // No timer advancement — guard is immediately available again.
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('clearConfetti cancels pending self-removal timers (no leaked remove calls)', () => {
    spawnConfetti();
    clearConfetti();
    expect(particleCount()).toBe(0);

    // Advancing past the original removal window should NOT touch the
    // DOM again — the timers were cancelled. A fresh burst we spawn
    // before advancing would otherwise disappear here.
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    vi.advanceTimersByTime(REMOVAL_MS - 1);
    // The pre-clear timers would have fired by now if they had not
    // been cancelled; the current burst must still be on-screen.
    expect(particleCount()).toBe(COUNT_IN_TEST);

    vi.advanceTimersByTime(1);
    // Now the *current* burst's timers fire.
    expect(particleCount()).toBe(0);
  });

  it('clearConfetti is a safe no-op when no burst is in flight', () => {
    expect(particleCount()).toBe(0);
    expect(() => clearConfetti()).not.toThrow();
    expect(particleCount()).toBe(0);

    // And the module is healthy afterwards — a fresh spawn works.
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });

  it('re-arm timer scales with configureCelebration({ confettiRemoval })', () => {
    configureCelebration({ confettiRemoval: 500 });

    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    // Before 500ms elapses the guard should still block.
    vi.advanceTimersByTime(499);
    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);

    // Tick past the removal window — particles self-remove and guard re-arms.
    vi.advanceTimersByTime(1);
    expect(particleCount()).toBe(0);

    spawnConfetti();
    expect(particleCount()).toBe(COUNT_IN_TEST);
  });
});
