/**
 * Tests for the shared baseline-delta helper.
 *
 * Every analytics surface that previously inlined
 * `prev > 0 ? (curExp - prevExp) / prevExp * 100 : 0` now routes through
 * `computeBaselineDelta`. These tests lock in the classification and
 * formatting behavior so the fabrication pattern cannot silently return.
 */
import { describe, it, expect } from 'vitest';
import {
  computeBaselineDelta,
  formatBaselineDelta,
  type BaselineDelta
} from '../js/modules/core/baseline.js';

describe('computeBaselineDelta', () => {
  describe('classifies the comparison', () => {
    it('returns "no-data" when both sides are zero', () => {
      const d = computeBaselineDelta(0, 0);
      expect(d.status).toBe('no-data');
      expect(d.percent).toBeNull();
      expect(d.delta).toBe(0);
    });

    it('returns "new" when previous is zero and current is non-zero', () => {
      const d = computeBaselineDelta(500, 0);
      expect(d.status).toBe('new');
      expect(d.percent).toBeNull();
      expect(d.delta).toBe(500);
    });

    it('returns "new" for any non-zero current regardless of magnitude', () => {
      // The fabrication bug: 0 → 6 and 0 → 600 should not both collapse
      // to "+100%". Both should surface as "new".
      const small = computeBaselineDelta(6, 0);
      const large = computeBaselineDelta(600, 0);
      expect(small.status).toBe('new');
      expect(large.status).toBe('new');
    });

    it('returns "comparable" with a percent when both sides exist', () => {
      const d = computeBaselineDelta(120, 100);
      expect(d.status).toBe('comparable');
      expect(d.percent).toBeCloseTo(20, 5);
      expect(d.delta).toBe(20);
    });
  });

  describe('signed percent', () => {
    it('reports positive percent when current exceeds previous', () => {
      const d = computeBaselineDelta(150, 100);
      expect(d.percent).toBeCloseTo(50, 5);
    });

    it('reports negative percent when current is below previous', () => {
      const d = computeBaselineDelta(80, 100);
      expect(d.percent).toBeCloseTo(-20, 5);
    });

    it('reports 0% when current equals previous', () => {
      const d = computeBaselineDelta(100, 100);
      expect(d.percent).toBe(0);
      expect(d.status).toBe('comparable');
    });
  });

  describe('negative baselines (savings can go negative)', () => {
    it('improvement from -100 to -50 is a positive 50%', () => {
      // abs(-100) is the denominator; delta is +50 (improvement).
      const d = computeBaselineDelta(-50, -100);
      expect(d.percent).toBeCloseTo(50, 5);
      expect(d.delta).toBe(50);
    });

    it('regression from -50 to -100 is a negative 100%', () => {
      const d = computeBaselineDelta(-100, -50);
      expect(d.percent).toBeCloseTo(-100, 5);
      expect(d.delta).toBe(-50);
    });
  });

  describe('edge cases', () => {
    it('treats a tiny non-zero current against a zero previous as "new"', () => {
      const d = computeBaselineDelta(0.01, 0);
      expect(d.status).toBe('new');
    });

    it('is symmetric: swapping inputs flips the sign of percent', () => {
      const a = computeBaselineDelta(150, 100);
      const b = computeBaselineDelta(100, 150);
      // 150→100 is -33.3%, denominator 150
      // 100→150 is +50%, denominator 100
      // So not strictly symmetric in magnitude — but signs must invert.
      expect(Math.sign(a.percent as number)).toBe(1);
      expect(Math.sign(b.percent as number)).toBe(-1);
    });
  });
});

describe('formatBaselineDelta', () => {
  it('renders "—" for no-data', () => {
    const d: BaselineDelta = { status: 'no-data', percent: null, delta: 0 };
    expect(formatBaselineDelta(d)).toBe('—');
  });

  it('renders "New" for the new-baseline case', () => {
    const d: BaselineDelta = { status: 'new', percent: null, delta: 42 };
    expect(formatBaselineDelta(d)).toBe('New');
  });

  it('renders positive deltas with a "+" sign', () => {
    const d = computeBaselineDelta(112, 100);
    expect(formatBaselineDelta(d)).toBe('+12%');
  });

  it('renders negative deltas with a "-" sign and absolute value', () => {
    const d = computeBaselineDelta(92, 100);
    expect(formatBaselineDelta(d)).toBe('-8%');
  });

  it('renders a flat comparison as "0%" (not "—" or "New")', () => {
    const d = computeBaselineDelta(100, 100);
    expect(formatBaselineDelta(d)).toBe('0%');
  });

  it('rounds to the nearest whole percent', () => {
    const d = computeBaselineDelta(101.4, 100);
    expect(formatBaselineDelta(d)).toBe('+1%');
  });
});
