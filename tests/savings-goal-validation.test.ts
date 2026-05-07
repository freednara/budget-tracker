/**
 * Phase 6 Slice 1f (Inline-Behavior-Review rev 12, L42 + L26)
 *
 * L42 verifies that `data-actions.savingsGoals.addGoal()` rejects
 * non-positive or non-finite target values at the input boundary,
 * throwing a RangeError and routing trackError instead of silently
 * persisting `{target: 0}` / `{target: NaN}` / `{target: -5}`.
 *
 * L26 verifies the downstream `insightSavingsGoal()` helper now
 * returns `null` (skip) instead of synthesizing a percentage when a
 * goal record has a non-positive target — prior behavior hid the bad
 * state with `g.target || 1`, producing a misleading "0%" reading.
 *
 * The pair is tested together so the end-to-end story is visible:
 *   • input rejected at L42 → no bad record reaches persistence
 *   • any bad record that survived (legacy / pre-L42 data) → skipped
 *     by L26 instead of displayed as "0%"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn()
}));

describe('savingsGoals.addGoal validation (L42)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a valid positive target and returns a non-empty id', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    const id = savingsGoals.addGoal({ name: 'Emergency fund', target: 5000 });
    expect(id).toMatch(/^sg_/);
  });

  it('throws RangeError for target = 0', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    const { trackError } = await import('../js/modules/core/error-tracker.js');

    expect(() =>
      savingsGoals.addGoal({ name: 'Zero goal', target: 0 })
    ).toThrow(RangeError);

    expect(trackError).toHaveBeenCalledTimes(1);
    const zeroCall = (trackError as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!zeroCall) throw new Error('expected trackError to have been called');
    const [message, context, type] = zeroCall;
    expect(message).toMatch(/invalid target/i);
    expect(context).toMatchObject({
      module: 'data-actions',
      action: 'addGoal_invalid_target'
    });
    expect(type).toBe('error');
  });

  it('throws RangeError for a negative target', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    expect(() =>
      savingsGoals.addGoal({ name: 'Negative', target: -100 })
    ).toThrow(RangeError);
  });

  it('throws RangeError for NaN target', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    expect(() =>
      savingsGoals.addGoal({ name: 'Not a number', target: Number.NaN })
    ).toThrow(RangeError);
  });

  it('throws RangeError for Infinity target', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    expect(() =>
      savingsGoals.addGoal({ name: 'Infinite', target: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });

  it('does not write to the signal when validation fails', async () => {
    const { savingsGoals } = await import('../js/modules/core/actions/data-actions.js');
    const signalsModule = await import('../js/modules/core/signals.js');
    const before = { ...signalsModule.savingsGoals.value };

    expect(() =>
      savingsGoals.addGoal({ name: 'Bad', target: 0 })
    ).toThrow();

    expect(signalsModule.savingsGoals.value).toEqual(before);
  });
});

describe('insightSavingsGoal — downstream defense (L26)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // Minimal InsightContext — insightSavingsGoal only reads the signal,
  // not the context, so empty totals are fine.
  const emptyCtx = {
    income: 0,
    expenses: 0,
    savings: 0,
    balance: 0
  } as any;

  it('returns null for a goal with target = 0 (no synthesized percentage)', async () => {
    const signalsModule = await import('../js/modules/core/signals.js');
    const { insightSavingsGoal } = await import(
      '../js/modules/features/personalization/insights.js'
    );

    // Inject a legacy/malformed goal record directly into the signal —
    // simulates a record that pre-dated L42 and survived hydration.
    signalsModule.savingsGoals.value = {
      bad_goal_1: { id: 'bad_goal_1', name: 'Broken', target: 0, saved: 100, deadline: '' } as any
    };

    const result = insightSavingsGoal('friendly', emptyCtx);
    expect(result).toBeNull();
  });

  it('returns null for a goal with negative target', async () => {
    const signalsModule = await import('../js/modules/core/signals.js');
    const { insightSavingsGoal } = await import(
      '../js/modules/features/personalization/insights.js'
    );

    signalsModule.savingsGoals.value = {
      neg_goal: { id: 'neg_goal', name: 'Negative', target: -500, saved: 200, deadline: '' } as any
    };

    const result = insightSavingsGoal('friendly', emptyCtx);
    expect(result).toBeNull();
  });

  it('returns null for a goal with NaN target', async () => {
    const signalsModule = await import('../js/modules/core/signals.js');
    const { insightSavingsGoal } = await import(
      '../js/modules/features/personalization/insights.js'
    );

    signalsModule.savingsGoals.value = {
      nan_goal: { id: 'nan_goal', name: 'Bogus', target: Number.NaN, saved: 50, deadline: '' } as any
    };

    const result = insightSavingsGoal('friendly', emptyCtx);
    expect(result).toBeNull();
  });

  it('returns a real percentage for a well-formed goal (positive control)', async () => {
    const signalsModule = await import('../js/modules/core/signals.js');
    const { insightSavingsGoal } = await import(
      '../js/modules/features/personalization/insights.js'
    );

    signalsModule.savingsGoals.value = {
      good: { id: 'good', name: 'Emergency Fund', target: 1000, saved: 250, deadline: '' } as any
    };

    const result = insightSavingsGoal('friendly', emptyCtx);
    expect(result).not.toBeNull();
    const text = typeof result === 'string' ? result : result?.text ?? '';
    expect(text).toMatch(/Emergency Fund/);
    expect(text).toMatch(/25%/); // 250/1000
  });

  it('returns null when there are no goals at all (unchanged pre-existing contract)', async () => {
    const signalsModule = await import('../js/modules/core/signals.js');
    const { insightSavingsGoal } = await import(
      '../js/modules/features/personalization/insights.js'
    );

    signalsModule.savingsGoals.value = {};

    const result = insightSavingsGoal('friendly', emptyCtx);
    expect(result).toBeNull();
  });
});
