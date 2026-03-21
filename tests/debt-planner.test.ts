/**
 * Debt Planner Tests
 * Tests amortization schedules, payoff strategies, and interest calculations
 */
import { describe, it, expect } from 'vitest';
import {
  generateAmortizationSchedule,
  compareStrategies,
  getDebtProgress,
  calculateMonthlyInterest,
  calculatePayoffDate
} from '../js/modules/features/financial/debt-planner.js';
import type { Debt } from '../js/types/index.js';

function createDebt(overrides: Partial<Debt & { originalBalance?: number }> = {}): Debt {
  return {
    id: 'debt_1',
    name: 'Test Debt',
    balance: 1000,
    originalBalance: 1000,
    interestRate: 0.12, // 12% APR
    minimumPayment: 50,
    type: 'credit_card',
    isActive: true,
    dueDay: 15,
    ...overrides
  } as Debt;
}

describe('Amortization Schedule', () => {
  it('should generate a schedule that pays off the debt', () => {
    const debt = createDebt({ balance: 1000, interestRate: 0.12, minimumPayment: 100 });
    const schedule = generateAmortizationSchedule(debt);

    expect(schedule.length).toBeGreaterThan(0);
    expect(schedule[schedule.length - 1].balance).toBe(0);
  });

  it('should calculate correct interest and principal split', () => {
    const debt = createDebt({ balance: 1200, interestRate: 0.12, minimumPayment: 200 });
    const schedule = generateAmortizationSchedule(debt);

    // First month: interest = 1200 * 0.12/12 = 12.00
    expect(schedule[0].interest).toBe(12);
    expect(schedule[0].principal).toBe(188); // 200 - 12
    expect(schedule[0].balance).toBe(1012); // 1200 - 188
  });

  it('should return empty schedule for zero balance', () => {
    const debt = createDebt({ balance: 0 });
    expect(generateAmortizationSchedule(debt)).toHaveLength(0);
  });

  it('should return empty schedule for zero payment', () => {
    const debt = createDebt({ minimumPayment: 0 });
    expect(generateAmortizationSchedule(debt)).toHaveLength(0);
  });

  it('should handle zero interest rate (interest-free)', () => {
    const debt = createDebt({ balance: 500, interestRate: 0, minimumPayment: 100 });
    const schedule = generateAmortizationSchedule(debt);

    expect(schedule).toHaveLength(5); // 500/100 = 5 months
    schedule.forEach(entry => expect(entry.interest).toBe(0));
    expect(schedule[schedule.length - 1].balance).toBe(0);
  });

  it('should stop when payment does not cover interest (negative amortization)', () => {
    const debt = createDebt({ balance: 10000, interestRate: 0.36, minimumPayment: 10 });
    // Monthly interest = 10000 * 0.03 = 300, payment = 10
    const schedule = generateAmortizationSchedule(debt);

    expect(schedule).toHaveLength(1);
    expect(schedule[0].principal).toBe(0);
    expect(schedule[0].interest).toBe(300);
  });

  it('should apply extra payments correctly', () => {
    const debt = createDebt({ balance: 1000, interestRate: 0, minimumPayment: 100 });
    const noExtra = generateAmortizationSchedule(debt, 0);
    const withExtra = generateAmortizationSchedule(debt, 100);

    expect(noExtra).toHaveLength(10);
    expect(withExtra).toHaveLength(5);
  });

  it('should handle final payment smaller than regular payment', () => {
    const debt = createDebt({ balance: 250, interestRate: 0, minimumPayment: 100 });
    const schedule = generateAmortizationSchedule(debt);

    expect(schedule).toHaveLength(3);
    expect(schedule[2].payment).toBe(50); // Last payment is the remaining 50
    expect(schedule[2].balance).toBe(0);
  });

  it('should respect maxMonths limit', () => {
    const debt = createDebt({ balance: 100000, interestRate: 0.06, minimumPayment: 100 });
    const schedule = generateAmortizationSchedule(debt, 0, 12);

    expect(schedule.length).toBeLessThanOrEqual(12);
  });
});

describe('Strategy Comparison', () => {
  it('should handle single debt (both strategies identical)', () => {
    const result = compareStrategies([createDebt()], 100);
    expect(result.snowball.months).toBe(result.avalanche.months);
  });

  it('should show avalanche saves on interest for high-rate debts', () => {
    const debts = [
      createDebt({ id: 'd1', balance: 5000, interestRate: 0.24, minimumPayment: 100, name: 'High Rate' }),
      createDebt({ id: 'd2', balance: 2000, interestRate: 0.06, minimumPayment: 50, name: 'Low Rate' })
    ];
    const result = compareStrategies(debts, 200);

    // Avalanche targets high interest first, should save on total interest
    expect(result.avalanche.totalInterest).toBeLessThanOrEqual(result.snowball.totalInterest);
  });
});

describe('Debt Progress', () => {
  it('should calculate correct progress when originalBalance is set', () => {
    const debt = createDebt({ balance: 600, originalBalance: 1000 });
    const progress = getDebtProgress(debt);

    expect(progress.percentComplete).toBeCloseTo(40, 0);
    expect(progress.paid).toBeCloseTo(400, 0);
  });

  it('should handle fully paid debt', () => {
    const debt = createDebt({ balance: 0, originalBalance: 1000 });
    const progress = getDebtProgress(debt);

    expect(progress.percentComplete).toBe(100);
  });

  it('should handle debt without originalBalance (uses current balance)', () => {
    const debt = createDebt({ balance: 500, originalBalance: undefined as any });
    const progress = getDebtProgress(debt);

    // Without originalBalance, getDebtProgress uses current balance as original, so 0% paid
    expect(progress.percentComplete).toBe(0);
  });
});

describe('Monthly Interest Calculation', () => {
  it('should calculate correct monthly interest', () => {
    // $1200 at 12% APR = $12/month interest
    expect(calculateMonthlyInterest(1200, 0.12)).toBe(12);
  });

  it('should return 0 for zero balance', () => {
    expect(calculateMonthlyInterest(0, 0.12)).toBe(0);
  });

  it('should return 0 for zero APR', () => {
    expect(calculateMonthlyInterest(1000, 0)).toBe(0);
  });

  it('should handle small balances without precision loss', () => {
    // $1.00 at 12% APR = $0.01/month
    expect(calculateMonthlyInterest(1, 0.12)).toBe(0.01);
  });
});

describe('Payoff Date Calculation', () => {
  it('should calculate payoff for interest-free debt', () => {
    const debt = createDebt({ balance: 500, interestRate: 0, minimumPayment: 100 });
    const info = calculatePayoffDate(debt);

    expect(info.months).toBe(5);
    expect(info.totalInterest).toBe(0);
  });

  it('should return 0 months for zero balance', () => {
    const debt = createDebt({ balance: 0 });
    const info = calculatePayoffDate(debt);

    expect(info.months).toBe(0);
  });

  it('should account for extra payments', () => {
    const debt = createDebt({ balance: 1000, interestRate: 0, minimumPayment: 100 });
    const noExtra = calculatePayoffDate(debt, 0);
    const withExtra = calculatePayoffDate(debt, 100);

    expect(withExtra.months).toBeLessThan(noExtra.months);
  });

  it('should include total interest paid', () => {
    const debt = createDebt({ balance: 1000, interestRate: 0.12, minimumPayment: 100 });
    const info = calculatePayoffDate(debt);

    expect(info.totalInterest).toBeGreaterThan(0);
    expect(info.months).toBeGreaterThan(10); // More than 10 months due to interest
  });
});
