import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import {
  recordPayment,
  getDebtProgress,
  getTotalDebtSummary,
  calculateTotalInterestPaid
} from '../js/modules/features/financial/debt-planner.js';
import type { Debt } from '../js/types/index.js';

/**
 * CR-Apr24-A1 — Debt Planner correctness residuals:
 *   - Finding 25 [P2] recordPayment over-payment cap
 *   - Finding 34 [P2] getDebtProgress.paid clamped at 0
 *   - Finding 35 [P2] getTotalDebtSummary.totalPaid clamped at 0
 *   - Finding 36 [P2] calculateTotalInterestPaid clamps principal-paid
 *     before the interest subtraction
 *
 * All four share the same root cause: a debt whose current balance has
 * grown above its original (negative amortization, manual balance bump,
 * late fees) breaks the invariant that `paid = original - current >= 0`.
 * Without the clamps, the UI can render "-$42 paid", "$1,000 paid" when
 * the user only paid $500 (over-payment), or inflated interest totals.
 */

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    create: vi.fn().mockResolvedValue({ isOk: true, data: { __backendId: 'tx_mock', amount: 100 } }),
    update: vi.fn().mockResolvedValue({ isOk: true }),
    delete: vi.fn().mockResolvedValue({ isOk: true })
  }
}));

function makeDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: 'debt_1',
    name: 'Test Debt',
    type: 'credit_card',
    balance: 1000,
    originalBalance: 1000,
    interestRate: 0.12, // 12% APR → 1% monthly
    minimumPayment: 50,
    dueDay: 15,
    createdAt: '2026-01-01',
    payments: [],
    isActive: true,
    ...overrides
  } as Debt;
}

describe('CR-Apr24-A1 — debt-planner correctness residuals', () => {
  const originalDebts = signals.debts.value;

  beforeEach(() => {
    signals.debts.value = [];
  });

  afterEach(() => {
    signals.debts.value = originalDebts;
    vi.clearAllMocks();
  });

  describe('finding 25 [P2] — recordPayment rejects overpayments', () => {
    it('rejects a payment that exceeds (balance + one month of interest)', async () => {
      // Debt: $500 balance, 12% APR → $5 interest/mo. Max acceptable = $505.
      signals.debts.value = [makeDebt({ balance: 500 })];

      const result = await recordPayment('debt_1', 1000); // $1,000 on a $500 debt

      expect(result.isOk).toBe(false);
      expect(result.error).toMatch(/exceeds remaining balance/i);
      // Error message must include the actual cap so the UI can hint the
      // user toward the exact payoff amount without an extra round-trip.
      expect(result.error).toMatch(/\$505\.00|505\.00/);
    });

    it('accepts a payment exactly equal to (balance + interest)', async () => {
      signals.debts.value = [makeDebt({ balance: 500 })];

      const result = await recordPayment('debt_1', 505); // exact cap

      expect(result.isOk).toBe(true);
    });

    it('accepts a partial payment well under the cap', async () => {
      signals.debts.value = [makeDebt({ balance: 500 })];

      const result = await recordPayment('debt_1', 100);

      expect(result.isOk).toBe(true);
    });

    it('allows the user to zero out a debt with (balance + interest) exact payoff', async () => {
      signals.debts.value = [makeDebt({ balance: 200, interestRate: 0.24 })]; // 2%/mo
      // interest = 200 * 0.02 = $4. max = $204.

      const result = await recordPayment('debt_1', 204);

      expect(result.isOk).toBe(true);
      // Post-payment: balance should be 0 (interest + all remaining principal paid).
      const live = signals.debts.value.find(d => d.id === 'debt_1');
      expect(live?.balance).toBe(0);
    });
  });

  describe('finding 34 [P2] — getDebtProgress.paid clamped at 0', () => {
    it('returns paid=0 (not negative) when current balance exceeds original', async () => {
      const debt = makeDebt({ originalBalance: 1000, balance: 1200 }); // +$200 neg-amort

      const progress = getDebtProgress(debt);

      expect(progress.paid).toBe(0);
      expect(progress.percentComplete).toBe(0);
    });

    it('returns paid=0 when balance equals original (no progress yet)', () => {
      const debt = makeDebt({ originalBalance: 1000, balance: 1000 });

      const progress = getDebtProgress(debt);

      expect(progress.paid).toBe(0);
    });

    it('returns the correct positive paid amount under normal progress', () => {
      const debt = makeDebt({ originalBalance: 1000, balance: 600 });

      const progress = getDebtProgress(debt);

      expect(progress.paid).toBe(400);
      expect(progress.percentComplete).toBe(40);
    });

    it('clamps percentComplete at 0 when balance > original (regression lock on existing clamp)', () => {
      const debt = makeDebt({ originalBalance: 500, balance: 750 });

      const progress = getDebtProgress(debt);

      expect(progress.percentComplete).toBe(0);
      expect(progress.paid).toBe(0);
    });
  });

  describe('finding 35 [P2] — getTotalDebtSummary.totalPaid clamped at 0', () => {
    it('returns totalPaid=0 when a single debt has grown above original', () => {
      signals.debts.value = [makeDebt({ originalBalance: 1000, balance: 1500 })];

      const summary = getTotalDebtSummary();

      expect(summary.totalPaid).toBe(0);
      expect(summary.percentComplete).toBe(0);
    });

    it('returns totalPaid=0 when one debt grown enough to drag the portfolio negative', () => {
      signals.debts.value = [
        makeDebt({ id: 'd1', originalBalance: 1000, balance: 800 }), // +$200 progress
        makeDebt({ id: 'd2', originalBalance: 1000, balance: 1500 }) // -$500 regression
      ];
      // Raw portfolio: 2000 original, 2300 current → -$300 "paid" pre-fix.

      const summary = getTotalDebtSummary();

      expect(summary.totalPaid).toBe(0);
      expect(summary.percentComplete).toBe(0);
    });

    it('reports accurate totals when all debts show positive progress', () => {
      signals.debts.value = [
        makeDebt({ id: 'd1', originalBalance: 1000, balance: 600 }),
        makeDebt({ id: 'd2', originalBalance: 500, balance: 200 })
      ];

      const summary = getTotalDebtSummary();

      expect(summary.totalBalance).toBe(800);
      expect(summary.totalOriginal).toBe(1500);
      expect(summary.totalPaid).toBe(700);
      // 700 / 1500 = 46.67% → rounds to 47
      expect(summary.percentComplete).toBe(47);
    });
  });

  describe('finding 36 [P2] — calculateTotalInterestPaid clamps principal-paid', () => {
    it('does NOT overstate interest when balance has grown above original', () => {
      // $500 in payments, balance grew from 1000 → 1200 (principal "paid" = -200)
      // Pre-fix: Math.max(0, 500 - (-200)) = 700 ← WRONG (payments were only 500)
      // Post-fix: principalPaid clamped to 0 → max(0, 500 - 0) = 500 ← upper-bound
      const debt = makeDebt({
        originalBalance: 1000,
        balance: 1200,
        payments: [
          { id: 'p1', date: '2026-01-01', amount: 250, principal: 0, interest: 250, transactionId: 'tx1' },
          { id: 'p2', date: '2026-02-01', amount: 250, principal: 0, interest: 250, transactionId: 'tx2' }
        ]
      });

      const interest = calculateTotalInterestPaid(debt);

      // Interest must NEVER exceed the total payment sum (500). Pre-fix returned 700.
      expect(interest).toBeLessThanOrEqual(500);
      // The clamped upper bound: when balance > original, all payments are
      // attributed to interest (we can't separate fee-accrued principal).
      expect(interest).toBe(500);
    });

    it('computes interest correctly under normal (balance < original) progress', () => {
      const debt = makeDebt({
        originalBalance: 1000,
        balance: 700,       // principal-paid = 300
        payments: [
          { id: 'p1', date: '2026-01-01', amount: 200, principal: 150, interest: 50, transactionId: 'tx1' },
          { id: 'p2', date: '2026-02-01', amount: 200, principal: 150, interest: 50, transactionId: 'tx2' }
        ]
      });
      // Total paid = 400, principalPaid = 300 → interest = 100
      const interest = calculateTotalInterestPaid(debt);

      expect(interest).toBe(100);
    });

    it('returns 0 when payments array is empty (null-safety)', () => {
      const debt = makeDebt({ originalBalance: 1000, balance: 1000, payments: [] });

      expect(calculateTotalInterestPaid(debt)).toBe(0);
    });
  });
});
