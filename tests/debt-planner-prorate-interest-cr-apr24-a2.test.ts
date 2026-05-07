import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { recordPayment } from '../js/modules/features/financial/debt-planner.js';
import type { Debt } from '../js/types/index.js';

/**
 * CR-Apr24-A2 [P2] — Debt per-payment interest timing (Code-Review-Report
 * finding 24).
 *
 * Pre-fix: `DebtPaymentOperation.execute()` charged a full month of
 * interest on every recorded payment, regardless of days elapsed since
 * the previous accrual. A user making four $50 payments in the same
 * month got four full-month interest allocations — the per-payment
 * principal/interest split and the rendered "Principal: $X, Interest:
 * $Y" note string were both misleading.
 *
 * Fix: `Debt.lastInterestAccrualDate?: string` new field. `execute()`
 * computes `daysElapsed = paymentDate - (lastInterestAccrualDate ??
 * createdAt ?? paymentDate)` and prorates `interestCents =
 * fullMonthInterest * (min(30, daysElapsed) / 30)`. The field is stamped
 * forward on every successful payment.
 *
 * Contract: this slice only REDUCES interest allocations relative to the
 * pre-fix full-month charge — it never increases them. Cap at 30 days
 * guarantees the upper bound equals the pre-fix value.
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
    interestRate: 0.12, // 12% APR → 1% monthly → $10 full-month interest on $1k
    minimumPayment: 50,
    dueDay: 15,
    createdAt: '2026-03-01',
    payments: [],
    isActive: true,
    ...overrides
  } as Debt;
}

describe('CR-Apr24-A2 — debt per-payment interest prorated by elapsed days', () => {
  const originalDebts = signals.debts.value;

  beforeEach(() => {
    signals.debts.value = [];
  });

  afterEach(() => {
    signals.debts.value = originalDebts;
    vi.clearAllMocks();
  });

  describe('first payment (no prior lastInterestAccrualDate)', () => {
    it('falls back to createdAt for the accrual anchor', async () => {
      // Debt created 30 days before the payment → should charge ~full month.
      // 12% APR on $1000 → $10/mo interest. 30 days elapsed → $10 allocated.
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01'
      })];

      const result = await recordPayment('debt_1', 100, '2026-03-31'); // 30 days

      expect(result.isOk).toBe(true);
      expect(result.payment?.interest).toBeCloseTo(10, 2); // ~$10 full month
    });

    it('charges less interest when debt is newer than 30 days', async () => {
      // Debt created 7 days before payment → 7/30 of full month interest.
      // $10 full month × 7/30 ≈ $2.33.
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01'
      })];

      const result = await recordPayment('debt_1', 100, '2026-03-08'); // 7 days

      expect(result.isOk).toBe(true);
      expect(result.payment?.interest).toBeCloseTo(10 * 7 / 30, 2);
    });

    it('charges zero interest on a same-day payment', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-15'
      })];

      const result = await recordPayment('debt_1', 100, '2026-03-15');

      expect(result.isOk).toBe(true);
      expect(result.payment?.interest).toBe(0);
      // All $100 went to principal.
      expect(result.payment?.principal).toBeCloseTo(100, 2);
    });
  });

  describe('repeated payments within the same month — the core fix scenario', () => {
    it('four $50 payments in one month accrue ~ONE month of interest total (not four)', async () => {
      // This is the finding-24 regression lock. Pre-fix: each payment charged
      // full $10 interest = $40 total across 4 payments. Post-fix: the four
      // payments span roughly one month of real time and collectively charge
      // ~one month's interest, prorated by actual elapsed days.
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01',
        payments: []
      })];

      const p1 = await recordPayment('debt_1', 50, '2026-03-08'); // 7 days since createdAt
      const p2 = await recordPayment('debt_1', 50, '2026-03-15'); // 7 days since p1
      const p3 = await recordPayment('debt_1', 50, '2026-03-22'); // 7 days since p2
      const p4 = await recordPayment('debt_1', 50, '2026-03-29'); // 7 days since p3

      expect(p1.isOk && p2.isOk && p3.isOk && p4.isOk).toBe(true);

      const totalInterestCharged =
        (p1.payment?.interest ?? 0) +
        (p2.payment?.interest ?? 0) +
        (p3.payment?.interest ?? 0) +
        (p4.payment?.interest ?? 0);

      // 28 days total elapsed. Interest should be ~28/30 × $10 ≈ $9.33 total.
      // Pre-fix value would have been 4 × $10 = $40. Post-fix < $10.
      expect(totalInterestCharged).toBeLessThan(15);
      expect(totalInterestCharged).toBeGreaterThan(5);
    });

    it('same-day repeat payment charges zero additional interest', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01',
        payments: []
      })];

      // First payment on day 15 — charges 14 days of interest.
      const first = await recordPayment('debt_1', 50, '2026-03-15');
      expect(first.isOk).toBe(true);
      const firstInterest = first.payment?.interest ?? -1;
      expect(firstInterest).toBeGreaterThan(0);

      // Same-day second payment — charges zero interest (days=0).
      const second = await recordPayment('debt_1', 50, '2026-03-15');
      expect(second.isOk).toBe(true);
      expect(second.payment?.interest).toBe(0);
      // Full $50 went to principal.
      expect(second.payment?.principal).toBeCloseTo(50, 2);
    });
  });

  describe('gap > 30 days (cap enforcement)', () => {
    it('a payment 6 months after creation charges ONLY one month of interest, not six', async () => {
      // Pre-fix already charged one month (full interest on every payment),
      // so this is the "no regression upward" test. The cap ensures we
      // don't start charging 6x interest when the schema change lets us
      // read historical gaps.
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2025-09-01' // 6+ months ago
      })];

      const result = await recordPayment('debt_1', 100, '2026-03-15');

      expect(result.isOk).toBe(true);
      // Full-month ceiling = $10; must be ≤ $10 not $60.
      expect(result.payment?.interest).toBeLessThanOrEqual(10);
      expect(result.payment?.interest).toBeGreaterThanOrEqual(9.9); // basically at cap
    });

    it('cap at exactly 30 days yields exactly full-month interest', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-02-15'
      })];

      const result = await recordPayment('debt_1', 100, '2026-03-17'); // exactly 30 days later

      expect(result.isOk).toBe(true);
      expect(result.payment?.interest).toBeCloseTo(10, 2);
    });
  });

  describe('lastInterestAccrualDate stamped forward on every payment', () => {
    it('updates the debt record with the payment date as the new accrual anchor', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01'
      })];

      await recordPayment('debt_1', 50, '2026-03-15');

      const updated = signals.debts.value.find(d => d.id === 'debt_1');
      expect(updated?.lastInterestAccrualDate).toBe('2026-03-15');
    });

    it('next payment prorates from the stamped date, not createdAt', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01',
        // Pre-seed lastInterestAccrualDate to simulate a previous payment
        lastInterestAccrualDate: '2026-03-20'
      })];

      // Payment 10 days after last accrual (not 24 days since createdAt).
      const result = await recordPayment('debt_1', 50, '2026-03-30');

      expect(result.isOk).toBe(true);
      // 10 days × $10/30 ≈ $3.33
      expect(result.payment?.interest).toBeCloseTo(10 * 10 / 30, 2);
    });
  });

  describe('payment cap (A1 interaction) uses prorated interest for the cap', () => {
    it('cap on a same-day same-day payment equals balance exactly (zero interest)', async () => {
      signals.debts.value = [makeDebt({
        balance: 500,
        interestRate: 0.24,
        createdAt: '2026-03-15'
      })];

      // Same-day payment: no interest accrued → cap = balance exactly ($500).
      const atCap = await recordPayment('debt_1', 500, '2026-03-15');
      expect(atCap.isOk).toBe(true);

      // Zero-state check: debt should be fully paid off.
      const updated = signals.debts.value.find(d => d.id === 'debt_1');
      expect(updated?.balance).toBe(0);
    });

    it('cap after 30 days is balance + full-month interest', async () => {
      signals.debts.value = [makeDebt({
        balance: 500,
        interestRate: 0.24, // 2%/mo → $10 on $500
        createdAt: '2026-02-10'
      })];

      // 33 days later — capped at 30 → full month of interest $10, cap = $510.
      const overByOne = await recordPayment('debt_1', 511, '2026-03-15');
      expect(overByOne.isOk).toBe(false);
      expect(overByOne.error).toMatch(/\$510/);
    });
  });

  describe('robustness fallbacks', () => {
    it('falls back to createdAt when lastInterestAccrualDate is missing', async () => {
      signals.debts.value = [makeDebt({
        balance: 1000,
        interestRate: 0.12,
        createdAt: '2026-03-01'
      })];

      const result = await recordPayment('debt_1', 50, '2026-03-15'); // 14 days

      expect(result.isOk).toBe(true);
      expect(result.payment?.interest).toBeCloseTo(10 * 14 / 30, 2);
    });
  });
});
