import { describe, expect, it } from 'vitest';
import { computePaceIndicatorVisual } from '../js/modules/components/daily-allowance.js';
import type { SpendingPaceData, SpendingPaceStatus } from '../js/types/index.js';

/**
 * CR-Apr22-D slice 2 [P1] coverage — spending-pace indicator always hidden.
 *
 * The bug: `mountSpendingPaceIndicator`'s effect body assigned
 *   paceEl.className = `spending-pace-indicator ${statusClass} hidden`;
 * hardcoding the `hidden` token every time the effect re-ran, which made
 * the dashboard indicator effectively dead (display:none on every render).
 *
 * The fix: the className derivation now lives in a pure exported helper
 * (`computePaceIndicatorVisual`) whose returned string NEVER contains the
 * `hidden` token. The effect reads the helper result and assigns it
 * verbatim. These tests lock the contract end-to-end at the helper layer:
 *   (a) no return path ever includes `hidden` — the P1 regression lock;
 *   (b) every status value produces the expected status class;
 *   (c) the layout-preserving `mb-3` utility is always present;
 *   (d) the four primary statuses produce the documented icon + text.
 */

function makePace(overrides: Partial<SpendingPaceData> = {}): SpendingPaceData {
  return {
    status: 'no-budget',
    percentOfBudget: 0,
    expectedPercent: 0,
    difference: 0,
    ...overrides
  };
}

describe('computePaceIndicatorVisual — regression lock: never `hidden` (CR-Apr22-D slice 2 [P1])', () => {
  const statuses: SpendingPaceStatus[] = ['no-budget', 'under', 'on-track', 'over'];

  it.each(statuses)('returns a className that does NOT include "hidden" for status=%s', (status) => {
    const result = computePaceIndicatorVisual(makePace({ status, difference: 10 }));
    expect(result.className.split(/\s+/)).not.toContain('hidden');
  });

  it('also omits "hidden" for an unexpected status (defensive default branch)', () => {
    // Cast through unknown to exercise the switch's default arm — the
    // production type union is exhaustive, but we want to lock the
    // never-hidden invariant even if a new status sneaks in later.
    const rogue = makePace({ status: 'future-variant' as unknown as SpendingPaceStatus });
    const result = computePaceIndicatorVisual(rogue);
    expect(result.className.split(/\s+/)).not.toContain('hidden');
  });
});

describe('computePaceIndicatorVisual — className layout contract (CR-Apr22-D slice 2)', () => {
  it('always carries the base `spending-pace-indicator` class', () => {
    const result = computePaceIndicatorVisual(makePace({ status: 'on-track' }));
    expect(result.className.split(/\s+/)).toContain('spending-pace-indicator');
  });

  it('always carries `mb-3` so the hero-card layout stays stable across toggles', () => {
    // mb-3 is the margin-bottom utility from the HTML scaffold. Before
    // this slice the effect clobbered the whole className and lost it;
    // the helper now preserves it. If this test fails, the indicator
    // will collapse the space between it and the pace panel below.
    for (const status of ['no-budget', 'under', 'on-track', 'over'] as const) {
      const result = computePaceIndicatorVisual(makePace({ status, difference: 5 }));
      expect(result.className.split(/\s+/)).toContain('mb-3');
    }
  });

  it('applies the correct status class per SpendingPaceStatus', () => {
    expect(computePaceIndicatorVisual(makePace({ status: 'no-budget' })).className)
      .toContain('pace-neutral');
    expect(computePaceIndicatorVisual(makePace({ status: 'under', difference: -20 })).className)
      .toContain('pace-under');
    expect(computePaceIndicatorVisual(makePace({ status: 'on-track' })).className)
      .toContain('pace-on-track');
    expect(computePaceIndicatorVisual(makePace({ status: 'over', difference: 15 })).className)
      .toContain('pace-over');
  });

  it('falls back to `pace-neutral` in the defensive default branch', () => {
    const rogue = makePace({ status: 'future-variant' as unknown as SpendingPaceStatus });
    expect(computePaceIndicatorVisual(rogue).className).toContain('pace-neutral');
  });
});

describe('computePaceIndicatorVisual — icon + text content (CR-Apr22-D slice 2)', () => {
  it('no-budget → "—" icon + "No budget set" text', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'no-budget' }));
    expect(r.icon).toBe('—');
    expect(r.text).toBe('No budget set');
  });

  it('on-track → "•" icon + "On track" text (no percent number)', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'on-track', difference: 0 }));
    expect(r.icon).toBe('•');
    expect(r.text).toBe('On track');
  });

  it('under → "✓" icon + absolute-value percent under-pace text', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'under', difference: -17 }));
    expect(r.icon).toBe('✓');
    // The helper uses Math.abs(difference) then Math.round. difference
    // comes in as the signed `percentOfBudget - expectedPercent`; under
    // pace is negative. Copy should drop the sign.
    expect(r.text).toBe('17% under pace');
  });

  it('over → "!" icon + signed percent over-pace text', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'over', difference: 23 }));
    expect(r.icon).toBe('!');
    expect(r.text).toBe('23% over pace');
  });

  it('caps extreme positive percentages at >999 for display readability (over)', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'over', difference: 2500 }));
    // `capPercent` replaces values > 999 with the literal `>999` string.
    expect(r.text).toBe('>999% over pace');
  });

  it('caps extreme negative percentages after absolute-value (under)', () => {
    const r = computePaceIndicatorVisual(makePace({ status: 'under', difference: -1500 }));
    expect(r.text).toBe('>999% under pace');
  });

  it('rounds non-integer differences before formatting', () => {
    expect(computePaceIndicatorVisual(makePace({ status: 'over', difference: 4.6 })).text)
      .toBe('5% over pace');
    expect(computePaceIndicatorVisual(makePace({ status: 'under', difference: -4.4 })).text)
      .toBe('4% under pace');
  });

  it('defensive default branch → "Unknown" text, "—" icon', () => {
    const rogue = makePace({ status: 'future-variant' as unknown as SpendingPaceStatus });
    const r = computePaceIndicatorVisual(rogue);
    expect(r.icon).toBe('—');
    expect(r.text).toBe('Unknown');
  });
});

describe('computePaceIndicatorVisual — purity (CR-Apr22-D slice 2)', () => {
  it('is referentially stable for identical inputs (no hidden state)', () => {
    const pace = makePace({ status: 'over', difference: 12 });
    const first = computePaceIndicatorVisual(pace);
    const second = computePaceIndicatorVisual(pace);
    expect(first).toEqual(second);
  });

  it('does not mutate the input pace data', () => {
    const pace = makePace({ status: 'under', difference: -10 });
    const snapshot = { ...pace };
    computePaceIndicatorVisual(pace);
    expect(pace).toEqual(snapshot);
  });
});
