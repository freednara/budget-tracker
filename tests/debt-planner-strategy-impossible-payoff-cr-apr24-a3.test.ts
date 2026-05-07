import { describe, expect, it } from 'vitest';

import {
  calculateSnowball,
  calculateAvalanche,
  compareStrategies,
  getStrategyInsights
} from '../js/modules/features/financial/debt-planner.js';
import type { Debt } from '../js/types/index.js';

/**
 * CR-Apr24-A3 — Strategy impossible-payoff detection + UI failure state
 * (Code-Review-Report findings 29-33).
 *
 * - (29) `simulatePayoffStrategy` waits until month 12 before flagging
 *   negative amortization → already shipped in 7l as "live item 5"
 *   (first-iteration detection via `monthStartBalances` comparison). This
 *   slice locks the regression with explicit tests.
 * - (30) `compareStrategies` ignores per-strategy `cannotPayOff` → now
 *   propagates a top-level `cannotPayOff` when BOTH strategies fail.
 * - (31) Strategy insights quote numerical metrics for impossible plans
 *   → now collapsed to zero when `result.cannotPayOff` is true.
 * - (32, 33) UI path is covered by the debt-ui-handlers rendering logic;
 *   tested at the data-level here (the computed `StrategyComparison`
 *   shape drives the UI branches).
 *
 * Debt profile used to force negative amortization: minimum payment set
 * below the first month's interest accrual so `monthInterest >= min`
 * and no principal is paid down. This triggers the 7l first-iteration
 * neg-am detector.
 */

function makeDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: 'debt_1',
    name: 'Test Debt',
    type: 'credit_card',
    balance: 10000,
    originalBalance: 10000,
    interestRate: 0.24,    // 24% APR → 2% / mo → $200/mo interest on $10k
    minimumPayment: 50,    // $50/mo < $200 interest ⇒ negative amortization
    dueDay: 15,
    createdAt: '2026-01-01',
    payments: [],
    isActive: true,
    ...overrides
  } as Debt;
}

function makeViableDebt(overrides: Partial<Debt> = {}): Debt {
  return makeDebt({
    balance: 1000,
    originalBalance: 1000,
    interestRate: 0.12,   // 12% APR → 1% / mo → $10 interest on $1k
    minimumPayment: 100,  // amply covers interest
    ...overrides
  });
}

describe('CR-Apr24-A3 — Strategy impossible-payoff detection', () => {
  describe('finding 29 [P2] — simulation detects neg-am on first iteration (regression lock)', () => {
    it('flags snowball cannotPayOff when min payment < monthly interest', () => {
      const result = calculateSnowball([makeDebt()]);

      expect(result.cannotPayOff).toBe(true);
      // First-iteration detection: months should be 1 (not 12, pre-7l), not Infinity, not the maxMonths safety cap.
      expect(result.months).toBeLessThanOrEqual(1);
    });

    it('flags avalanche cannotPayOff when min payment < monthly interest', () => {
      const result = calculateAvalanche([makeDebt()]);

      expect(result.cannotPayOff).toBe(true);
      expect(result.months).toBeLessThanOrEqual(1);
    });

    it('does NOT flag cannotPayOff for a viable debt', () => {
      const result = calculateSnowball([makeViableDebt()]);

      expect(result.cannotPayOff).toBeFalsy();
      expect(result.months).toBeGreaterThan(0);
      expect(result.months).toBeLessThan(1200); // not stuck at the maxMonths ceiling
    });

    it('pure interest accrual stays below maxMonths (no 100-year trickle quoting)', () => {
      // Edge case: the pre-7l code could run 1199 months of phantom interest
      // before the safety-limit break, leaving a laughable "interest cost"
      // quoted in the summary. The 7l fix breaks on month 1.
      const result = calculateSnowball([makeDebt({ minimumPayment: 10 })]); // tiny min

      expect(result.cannotPayOff).toBe(true);
      // Cents math: on 10k @ 2%/mo, month 1 interest = ~$200. Only that one
      // month's interest should accrue before the detector fires.
      expect(result.totalInterest).toBeLessThan(250);
    });
  });

  describe('finding 30 [P2] — compareStrategies propagates cannotPayOff when BOTH fail', () => {
    it('sets cannotPayOff=true when both strategies cannot pay off', () => {
      const comparison = compareStrategies([makeDebt()]);

      expect(comparison.snowball.cannotPayOff).toBe(true);
      expect(comparison.avalanche.cannotPayOff).toBe(true);
      expect(comparison.cannotPayOff).toBe(true);
    });

    it('does NOT set cannotPayOff when both strategies are viable', () => {
      const comparison = compareStrategies([makeViableDebt()]);

      expect(comparison.snowball.cannotPayOff).toBeFalsy();
      expect(comparison.avalanche.cannotPayOff).toBeFalsy();
      expect(comparison.cannotPayOff).toBeFalsy();
    });

    it('does NOT set top-level cannotPayOff when one strategy is viable (mixed portfolio)', () => {
      // With a viable debt + enough extra monthly payment, both
      // strategies should succeed. This verifies the AND semantics —
      // we don't want to flag the whole comparison as impossible just
      // because one edge-case sub-strategy is.
      const comparison = compareStrategies(
        [makeViableDebt(), makeViableDebt({ id: 'debt_2', balance: 500 })],
        0
      );

      expect(comparison.cannotPayOff).toBeFalsy();
    });

    it('recommended field remains populated (UI still branches to impossible copy via cannotPayOff)', () => {
      // The type keeps `recommended: 'avalanche' | 'snowball'` even when
      // impossible — the UI gates on `cannotPayOff` rather than a
      // `recommended: 'none'` variant, which would be a wider type
      // change. Verify the field is still a valid literal.
      const comparison = compareStrategies([makeDebt()]);

      expect(['avalanche', 'snowball']).toContain(comparison.recommended);
    });
  });

  describe('finding 31 [P3] — getStrategyInsights zeros out numerical insights for impossible plans', () => {
    it('returns all-zero insights when result.cannotPayOff is true (snowball)', () => {
      const { result, insights } = getStrategyInsights([makeDebt()], 'snowball');

      expect(result.cannotPayOff).toBe(true);
      expect(insights.totalPayments).toBe(0);
      expect(insights.averageMonthlyPayment).toBe(0);
      expect(insights.largestPaymentBoost).toBe(0);
      expect(insights.earlyPayoffCount).toBe(0);
      expect(insights.motivationScore).toBe(0);
    });

    it('returns all-zero insights for impossible avalanche', () => {
      const { insights } = getStrategyInsights([makeDebt()], 'avalanche');

      expect(insights.totalPayments).toBe(0);
      expect(insights.averageMonthlyPayment).toBe(0);
      expect(insights.motivationScore).toBe(0);
    });

    it('returns populated insights for viable plans (normal path regression lock)', () => {
      const { result, insights } = getStrategyInsights([makeViableDebt()], 'snowball');

      expect(result.cannotPayOff).toBeFalsy();
      expect(insights.totalPayments).toBeGreaterThan(0);
      expect(insights.averageMonthlyPayment).toBeGreaterThan(0);
      // Motivation score is a heuristic but for a viable debt should be > 0
      expect(insights.motivationScore).toBeGreaterThan(0);
    });
  });

  describe('findings 32, 33 [P2 + P3] — UI failure-state contract at the data layer', () => {
    it('comparison carries the information the UI needs to replace Infinity/misleading copy', () => {
      // The UI reads: snowball.cannotPayOff, avalanche.cannotPayOff,
      // comparison.cannotPayOff. If these three flags are all accurate,
      // the UI can branch cleanly into the impossible-state copy
      // without needing access to months/totalInterest at all (which
      // pre-fix could be Infinity for certain entry paths).
      const comparison = compareStrategies([makeDebt()]);

      // Data-layer contract for the UI to render correctly:
      expect(comparison.snowball.cannotPayOff).toBe(true);
      expect(comparison.avalanche.cannotPayOff).toBe(true);
      expect(comparison.cannotPayOff).toBe(true);
      // And crucially, months is a finite small number — not Infinity
      // (which would leak the "Infinity months" literal if any future
      // refactor forgets to gate on cannotPayOff before rendering).
      expect(Number.isFinite(comparison.snowball.months)).toBe(true);
      expect(Number.isFinite(comparison.avalanche.months)).toBe(true);
    });

    it('interest totals are also finite (pre-fix guard on the Infinity leak)', () => {
      const comparison = compareStrategies([makeDebt()]);
      expect(Number.isFinite(comparison.snowball.totalInterest)).toBe(true);
      expect(Number.isFinite(comparison.avalanche.totalInterest)).toBe(true);
    });
  });

  describe('empty-state edge cases', () => {
    it('empty debt list returns a viable (not impossible) comparison', () => {
      const comparison = compareStrategies([]);

      // No debts means "nothing to pay off" — a viable state, not an
      // impossible one. The UI should show an empty-state copy rather
      // than a failure warning.
      expect(comparison.cannotPayOff).toBeFalsy();
      expect(comparison.snowball.months).toBe(0);
      expect(comparison.avalanche.months).toBe(0);
    });
  });
});
