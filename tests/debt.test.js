/**
 * Tests for debt planner module
 * Validates debt calculations, payoff strategies, and interest calculations
 */
import { describe, it, expect } from 'vitest';
import { 
  calculateMonthlyInterest, 
  calculatePayoffDate, 
  calculateSnowball, 
  calculateAvalanche, 
  getDebtProgress 
} from '../js/modules/features/financial/debt-planner.js';

describe('calculateMonthlyInterest', () => {
  it('calculates monthly interest correctly', () => {
    // $1000 at 12% APR = $10/month interest
    const interest = calculateMonthlyInterest(1000, 0.12);
    expect(interest).toBe(10);
  });

  it('handles 0% APR', () => {
    const interest = calculateMonthlyInterest(1000, 0);
    expect(interest).toBe(0);
  });

  it('handles zero balance', () => {
    const interest = calculateMonthlyInterest(0, 0.12);
    expect(interest).toBe(0);
  });

  it('handles high interest rates', () => {
    // $1000 at 24% APR = $20/month interest
    const interest = calculateMonthlyInterest(1000, 0.24);
    expect(interest).toBe(20);
  });

  it('rounds to nearest cent', () => {
    // $1000 at 19.99% APR -> $16.65833 -> $16.66
    const interest = calculateMonthlyInterest(1000, 0.1999);
    expect(interest).toBeCloseTo(16.66, 2);
  });
});

describe('calculatePayoffDate', () => {
  const testDebt = {
    balance: 1000,
    minimumPayment: 50,
    interestRate: 0.12 // 12% APR
  };

  it('calculates payoff months for simple debt', () => {
    const result = calculatePayoffDate(testDebt);
    expect(result.months).toBeGreaterThan(0);
    expect(result.months).toBeLessThan(30); // Should pay off in ~22 months
  });

  it('reduces payoff time with extra payments', () => {
    const withoutExtra = calculatePayoffDate(testDebt);
    const withExtra = calculatePayoffDate(testDebt, 50);
    expect(withExtra.months).toBeLessThan(withoutExtra.months);
  });

  it('reduces total interest with extra payments', () => {
    const withoutExtra = calculatePayoffDate(testDebt);
    const withExtra = calculatePayoffDate(testDebt, 50);
    expect(withExtra.totalInterest).toBeLessThan(withoutExtra.totalInterest);
  });

  it('handles zero balance', () => {
    const result = calculatePayoffDate({ ...testDebt, balance: 0 });
    expect(result.months).toBe(0);
    expect(result.totalInterest).toBe(0);
  });

  it('handles zero payment (infinite)', () => {
    const result = calculatePayoffDate({ ...testDebt, minimumPayment: 0 });
    expect(result.months).toBe(Infinity);
  });

  it('handles 0% APR debt', () => {
    const noInterestDebt = { ...testDebt, interestRate: 0 };
    const result = calculatePayoffDate(noInterestDebt);
    expect(result.totalInterest).toBe(0);
    expect(result.months).toBe(20); // 1000 / 50 = 20 months
  });
});

describe('calculateSnowball', () => {
  const debts = [
    { id: 'high', name: 'High', balance: 5000, minimumPayment: 100, interestRate: 0.20, isActive: true },
    { id: 'low', name: 'Low', balance: 1000, minimumPayment: 50, interestRate: 0.10, isActive: true },
    { id: 'med', name: 'Med', balance: 3000, minimumPayment: 75, interestRate: 0.15, isActive: true }
  ];

  it('prioritizes smallest balance first', () => {
    const result = calculateSnowball(debts);
    expect(result.order[0].id).toBe('low'); // Smallest balance first
  });

  it('calculates total months to payoff', () => {
    const result = calculateSnowball(debts);
    expect(result.months).toBeGreaterThan(0);
    expect(result.months).toBeLessThan(150);
  });

  it('reduces payoff time with extra payments', () => {
    const withoutExtra = calculateSnowball(debts);
    const withExtra = calculateSnowball(debts, 100);
    expect(withExtra.months).toBeLessThan(withoutExtra.months);
  });

  it('handles empty debt list', () => {
    const result = calculateSnowball([]);
    expect(result.months).toBe(0);
    expect(result.totalInterest).toBe(0);
  });

  it('excludes inactive debts', () => {
    const mixed = [
      { id: 'active', name: 'Active', balance: 1000, minimumPayment: 50, interestRate: 0.10, isActive: true },
      { id: 'inactive', name: 'Inactive', balance: 5000, minimumPayment: 100, interestRate: 0.20, isActive: false }
    ];
    const result = calculateSnowball(mixed);
    expect(result.order.some(o => o.id === 'inactive')).toBe(false);
  });

  it('handles single debt', () => {
    const single = [{ id: 'only', name: 'Only', balance: 1000, minimumPayment: 100, interestRate: 0.12, isActive: true }];
    const result = calculateSnowball(single);
    expect(result.order.length).toBe(1);
    expect(result.months).toBeGreaterThan(0);
  });
});

describe('calculateAvalanche', () => {
  const debts = [
    { id: 'high', name: 'High', balance: 1000, minimumPayment: 50, interestRate: 0.20, isActive: true },
    { id: 'low', name: 'Low', balance: 1000, minimumPayment: 50, interestRate: 0.10, isActive: true },
    { id: 'med', name: 'Med', balance: 1000, minimumPayment: 50, interestRate: 0.15, isActive: true }
  ];

  it('prioritizes highest interest rate first', () => {
    const result = calculateAvalanche(debts, 2000); // Massive extra payment to immediately kill the targeted debt
    expect(result.order[0].id).toBe('high'); // Highest interest first
  });

  it('calculates total interest paid', () => {
    const avalanche = calculateAvalanche(debts);
    expect(avalanche.totalInterest).toBeGreaterThan(0);
    expect(avalanche.months).toBeGreaterThan(0);
  });

  it('handles debts with same interest rate', () => {
    const sameRate = [
      { id: 'big', name: 'Big', balance: 5000, minimumPayment: 100, interestRate: 0.15, isActive: true },
      { id: 'small', name: 'Small', balance: 1000, minimumPayment: 50, interestRate: 0.15, isActive: true }
    ];
    const result = calculateAvalanche(sameRate);
    expect(result.order.length).toBe(2);
  });
});

describe('getDebtProgress', () => {
  it('calculates progress for partially paid debt', () => {
    const debt = { balance: 750, originalBalance: 1000 };
    const progress = getDebtProgress(debt);
    expect(progress.paid).toBe(250);
    expect(progress.current).toBe(750);
    expect(progress.percentComplete).toBe(25);
  });

  it('handles fully paid debt', () => {
    const debt = { balance: 0, originalBalance: 1000 };
    const progress = getDebtProgress(debt);
    expect(progress.percentComplete).toBe(100);
  });

  it('handles new debt (no payments)', () => {
    const debt = { balance: 1000, originalBalance: 1000 };
    const progress = getDebtProgress(debt);
    expect(progress.percentComplete).toBe(0);
  });

  it('uses balance as original if originalBalance missing', () => {
    const debt = { balance: 1000 };
    const progress = getDebtProgress(debt);
    expect(progress.paid).toBe(0);
    expect(progress.percentComplete).toBe(0);
  });
});

describe('Strategy comparison', () => {
  const debts = [
    { id: 'high-rate', name: 'High Rate', balance: 2000, minimumPayment: 100, interestRate: 0.18, isActive: true },
    { id: 'low-balance', name: 'Low Balance', balance: 500, minimumPayment: 50, interestRate: 0.12, isActive: true }
  ];

  it('both strategies eventually pay off all debts', () => {
    const snowball = calculateSnowball(debts, 50); 
    const avalanche = calculateAvalanche(debts, 50);
    expect(snowball.months).toBeLessThan(600);
    expect(avalanche.months).toBeLessThan(600);
  });

  it('snowball provides psychological wins (smallest first)', () => {
    const snowball = calculateSnowball(debts);
    expect(snowball.order[0].id).toBe('low-balance');
  });

  it('both strategies calculate interest', () => {
    const snowball = calculateSnowball(debts, 50);
    const avalanche = calculateAvalanche(debts, 50);
    expect(snowball.totalInterest).toBeGreaterThan(0);
    expect(avalanche.totalInterest).toBeGreaterThan(0);
  });
});

describe('Edge cases', () => {
  it('handles very high interest rate', () => {
    const highInterest = {
      balance: 1000,
      minimumPayment: 200, 
      interestRate: 0.50 
    };
    const result = calculatePayoffDate(highInterest);
    expect(result.months).toBeGreaterThan(0);
    expect(result.months).toBeLessThan(100);
  });

  it('handles minimum payment less than interest accrual', () => {
    const underwater = {
      balance: 10000,
      minimumPayment: 10, 
      interestRate: 0.24 
    };
    const result = calculatePayoffDate(underwater);
    expect(result.months).toBe(Infinity);
  });

  it('handles cents precision in calculations', () => {
    const debt = {
      balance: 99.99,
      minimumPayment: 25.50,
      interestRate: 0.1999
    };
    const result = calculatePayoffDate(debt);
    expect(Number.isFinite(result.totalInterest)).toBe(true);
  });
});
