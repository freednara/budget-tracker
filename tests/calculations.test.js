/**
 * Tests for calculation functions
 * Statistics and velocity calculations
 * Uses pure function exports from the actual calculations module
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  toCents,
  toDollars,
  addAmounts,
  subtractAmounts,
  parseAmount,
  sumByType,
  getMonthKey,
  parseMonthKey
} from '../js/modules/core/utils.js';
import {
  calcVelocityPure,
  getYearStatsPure,
  getAllTimeStatsPure
} from '../js/modules/features/financial/calculations.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  MAX_AMOUNT: 999999999.99,
  MIN_AMOUNT: 0.01
};

// ==========================================
// TESTS FOR calcVelocityPure
// ==========================================

describe('calcVelocityPure', () => {
  const transactions = [
    { type: 'expense', amount: 100, date: '2024-06-01', category: 'food' },
    { type: 'expense', amount: 200, date: '2024-06-15', category: 'transport' },
    { type: 'expense', amount: 150, date: '2024-06-20', category: 'shopping' },
    { type: 'income', amount: 3000, date: '2024-06-01', category: 'salary' }
  ];

  it('calculates daily rate for completed month', () => {
    // July 2024 reference date - June is a completed month
    const result = calcVelocityPure(transactions, '2024-06', new Date(2024, 6, 15));
    expect(result.actual).toBe(450); // 100 + 200 + 150
    expect(result.dailyRate).toBeCloseTo(15, 1); // 450 / 30 days
    expect(result.projected).toBeCloseTo(450, 1); // Same as actual for completed month
  });

  it('calculates projected spending for current month', () => {
    // June 15, 2024 - mid-month
    const midMonthDate = new Date(2024, 5, 15); // June 15
    const result = calcVelocityPure(transactions, '2024-06', midMonthDate);
    expect(result.actual).toBe(450);
    expect(result.dailyRate).toBe(30); // 450 / 15 days
    expect(result.projected).toBe(900); // 30 * 30 days
  });

  it('handles empty transactions', () => {
    const result = calcVelocityPure([], '2024-06', new Date(2024, 6, 15));
    expect(result.actual).toBe(0);
    expect(result.dailyRate).toBe(0);
    expect(result.projected).toBe(0);
  });

  it('handles month with only income', () => {
    const incomeOnly = [
      { type: 'income', amount: 5000, date: '2024-06-01', category: 'salary' }
    ];
    const result = calcVelocityPure(incomeOnly, '2024-06', new Date(2024, 6, 15));
    expect(result.actual).toBe(0);
  });

  it('handles first day of month', () => {
    const firstDayRef = new Date(2024, 5, 1); // June 1
    const result = calcVelocityPure(transactions, '2024-06', firstDayRef);
    expect(result.dailyRate).toBe(450); // All expenses / 1 day
  });
});

// ==========================================
// TESTS FOR getYearStatsPure
// ==========================================

describe('getYearStatsPure', () => {
  const transactions = [
    { type: 'income', amount: 5000, date: '2024-01-15', category: 'salary' },
    { type: 'income', amount: 5000, date: '2024-06-15', category: 'salary' },
    { type: 'expense', amount: 1000, date: '2024-01-20', category: 'rent' },
    { type: 'expense', amount: 500, date: '2024-02-10', category: 'food' },
    { type: 'expense', amount: 300, date: '2024-03-05', category: 'transport' },
    { type: 'expense', amount: 200, date: '2024-04-01', category: 'shopping' },
    // Different year
    { type: 'income', amount: 4000, date: '2023-12-15', category: 'salary' }
  ];

  it('calculates total income for year', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.income).toBe(10000);
  });

  it('calculates total expenses for year', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.expenses).toBe(2000);
  });

  it('calculates net savings', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.net).toBe(8000);
  });

  it('calculates savings rate', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.savingsRate).toBe(80); // (10000 - 2000) / 10000 * 100
  });

  it('identifies top spending categories', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.topCategories[0].id).toBe('rent');
    expect(result.topCategories[0].amount).toBe(1000);
  });

  it('counts transactions correctly', () => {
    const result = getYearStatsPure(transactions, '2024');
    expect(result.transactionCount).toBe(6); // Excludes 2023 transaction
  });

  it('handles year with no transactions', () => {
    const result = getYearStatsPure(transactions, '2025');
    expect(result.income).toBe(0);
    expect(result.expenses).toBe(0);
    expect(result.savingsRate).toBe(0);
    expect(result.transactionCount).toBe(0);
  });

  it('handles year with only expenses', () => {
    const expenseOnly = [
      { type: 'expense', amount: 500, date: '2024-01-01', category: 'food' }
    ];
    const result = getYearStatsPure(expenseOnly, '2024');
    expect(result.savingsRate).toBe(0); // No income = 0% savings rate
    expect(result.net).toBe(-500);
  });
});

// ==========================================
// TESTS FOR getAllTimeStatsPure
// ==========================================

describe('getAllTimeStatsPure', () => {
  const transactions = [
    { type: 'income', amount: 5000, date: '2023-01-15', category: 'salary' },
    { type: 'income', amount: 5500, date: '2024-06-15', category: 'salary' },
    { type: 'expense', amount: 2000, date: '2023-06-01', category: 'rent' },
    { type: 'expense', amount: 1500, date: '2024-03-15', category: 'shopping' }
  ];

  it('calculates total income across all time', () => {
    const result = getAllTimeStatsPure(transactions);
    expect(result.totalIncome).toBe(10500);
  });

  it('calculates total expenses across all time', () => {
    const result = getAllTimeStatsPure(transactions);
    expect(result.totalExpenses).toBe(3500);
  });

  it('calculates net savings', () => {
    const result = getAllTimeStatsPure(transactions);
    expect(result.netSavings).toBe(7000);
  });

  it('identifies first and last transaction dates', () => {
    const result = getAllTimeStatsPure(transactions);
    expect(result.firstDate).toBe('2023-01-15');
    expect(result.lastDate).toBe('2024-06-15');
  });

  it('returns null for empty transactions', () => {
    const result = getAllTimeStatsPure([]);
    expect(result).toBeNull();
  });

  it('handles transactions without dates', () => {
    const mixed = [
      { type: 'income', amount: 1000, date: '2024-01-01', category: 'salary' },
      { type: 'expense', amount: 500, category: 'food' } // No date
    ];
    const result = getAllTimeStatsPure(mixed);
    expect(result.transactionCount).toBe(1); // Only counts dated transactions
  });
});

// ==========================================
// FLOATING-POINT PRECISION TESTS
// ==========================================

describe('Floating-point precision', () => {
  it('handles classic 0.1 + 0.2 precision issue', () => {
    // Without integer math: 0.1 + 0.2 = 0.30000000000000004
    const transactions = [
      { type: 'expense', amount: 0.1, date: '2024-06-01', category: 'food' },
      { type: 'expense', amount: 0.2, date: '2024-06-02', category: 'food' }
    ];
    const result = sumByType(transactions, 'expense');
    expect(result).toBe(0.3); // Should be exactly 0.3, not 0.30000000000000004
  });

  it('handles repeated small amounts without drift', () => {
    // 10 transactions of $0.01 should equal $0.10 exactly
    const transactions = Array.from({ length: 10 }, (_, i) => ({
      type: 'expense',
      amount: 0.01,
      date: `2024-06-${String(i + 1).padStart(2, '0')}`,
      category: 'food'
    }));
    const result = sumByType(transactions, 'expense');
    expect(result).toBe(0.10);
  });

  it('handles many transactions without accumulating error', () => {
    // 100 transactions of $19.99 should equal $1999.00 exactly
    const transactions = Array.from({ length: 100 }, (_, i) => ({
      type: 'expense',
      amount: 19.99,
      date: `2024-06-01`,
      category: 'shopping'
    }));
    const result = sumByType(transactions, 'expense');
    expect(result).toBe(1999.00);
  });

  it('handles mixed decimals accurately', () => {
    const transactions = [
      { type: 'income', amount: 1234.56, date: '2024-06-01', category: 'salary' },
      { type: 'income', amount: 789.01, date: '2024-06-02', category: 'bonus' },
      { type: 'income', amount: 0.43, date: '2024-06-03', category: 'interest' }
    ];
    const result = sumByType(transactions, 'income');
    expect(result).toBe(2024.00); // 1234.56 + 789.01 + 0.43 = 2024.00
  });

  it('handles year stats with precision-sensitive amounts', () => {
    const transactions = [
      { type: 'expense', amount: 33.33, date: '2024-01-01', category: 'food' },
      { type: 'expense', amount: 33.33, date: '2024-02-01', category: 'food' },
      { type: 'expense', amount: 33.34, date: '2024-03-01', category: 'food' }
    ];
    const result = getYearStatsPure(transactions, '2024');
    expect(result.expenses).toBe(100.00); // Should be exactly 100, not 99.99999...
  });

  it('handles net calculations without precision loss', () => {
    const transactions = [
      { type: 'income', amount: 1000.00, date: '2024-01-01', category: 'salary' },
      { type: 'expense', amount: 333.33, date: '2024-01-02', category: 'rent' },
      { type: 'expense', amount: 333.33, date: '2024-01-03', category: 'food' },
      { type: 'expense', amount: 333.34, date: '2024-01-04', category: 'transport' }
    ];
    const result = getYearStatsPure(transactions, '2024');
    expect(result.net).toBe(0.00); // 1000 - 333.33 - 333.33 - 333.34 = 0
  });
});

// ==========================================
// EDGE CASES - AMOUNTS
// ==========================================

describe('Edge cases - amounts', () => {
  it('handles zero amounts in calculations', () => {
    const txWithZero = [
      { type: 'expense', amount: 0, date: '2024-06-01', category: 'food' },
      { type: 'expense', amount: 100, date: '2024-06-02', category: 'food' }
    ];
    const result = getYearStatsPure(txWithZero, '2024');
    expect(result.expenses).toBe(100);
  });

  it('handles MAX_AMOUNT values', () => {
    const maxAmountTx = [
      { type: 'income', amount: CONFIG.MAX_AMOUNT, date: '2024-06-01', category: 'salary' }
    ];
    const result = getAllTimeStatsPure(maxAmountTx);
    expect(result.totalIncome).toBe(CONFIG.MAX_AMOUNT);
  });

  it('handles very small amounts (MIN_AMOUNT)', () => {
    const minAmountTx = [
      { type: 'expense', amount: CONFIG.MIN_AMOUNT, date: '2024-06-01', category: 'food' },
      { type: 'expense', amount: CONFIG.MIN_AMOUNT, date: '2024-06-02', category: 'food' }
    ];
    const result = getYearStatsPure(minAmountTx, '2024');
    expect(result.expenses).toBeCloseTo(0.02, 2);
  });

  it('handles string amounts (legacy data)', () => {
    const stringAmounts = [
      { type: 'expense', amount: '100.50', date: '2024-06-01', category: 'food' },
      { type: 'income', amount: '500', date: '2024-06-01', category: 'salary' }
    ];
    const result = getYearStatsPure(stringAmounts, '2024');
    expect(result.expenses).toBe(100.50);
    expect(result.income).toBe(500);
  });

  it('handles NaN amounts gracefully', () => {
    const badAmounts = [
      { type: 'expense', amount: NaN, date: '2024-06-01', category: 'food' },
      { type: 'expense', amount: 100, date: '2024-06-02', category: 'food' }
    ];
    const result = getYearStatsPure(badAmounts, '2024');
    expect(result.expenses).toBe(100); // NaN treated as 0
  });
});

// ==========================================
// EXPORT/IMPORT ROUND-TRIP
// (Local test utilities - not in production)
// ==========================================

describe('Export/Import round-trip', () => {
  // Simple export format (subset of actual format)
  function exportData(transactions, settings = {}) {
    return JSON.stringify({
      version: '2.5.0',
      exportDate: new Date().toISOString(),
      transactions: transactions.map(tx => ({ ...tx })),
      settings
    });
  }

  function importData(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data.transactions || !Array.isArray(data.transactions)) {
        return { error: 'Invalid format', transactions: [] };
      }
      return { transactions: data.transactions, settings: data.settings || {} };
    } catch (e) {
      return { error: e.message, transactions: [] };
    }
  }

  it('preserves transaction data through export/import', () => {
    const original = [
      { __backendId: 'tx_1', type: 'expense', amount: 99.99, date: '2024-06-15', category: 'food', description: 'Lunch' },
      { __backendId: 'tx_2', type: 'income', amount: 1000, date: '2024-06-01', category: 'salary', description: 'Paycheck' }
    ];

    const exported = exportData(original);
    const imported = importData(exported);

    expect(imported.error).toBeUndefined();
    expect(imported.transactions.length).toBe(2);
    expect(imported.transactions[0].amount).toBe(99.99);
    expect(imported.transactions[1].category).toBe('salary');
  });

  it('preserves special characters in descriptions', () => {
    const original = [
      { __backendId: 'tx_1', type: 'expense', amount: 50, date: '2024-06-15', category: 'food', description: 'Café "Special" & More' }
    ];

    const exported = exportData(original);
    const imported = importData(exported);

    expect(imported.transactions[0].description).toBe('Café "Special" & More');
  });

  it('preserves unicode emojis', () => {
    const original = [
      { __backendId: 'tx_1', type: 'expense', amount: 25, date: '2024-06-15', category: 'food', description: '🍕 Pizza night 🎉' }
    ];

    const exported = exportData(original);
    const imported = importData(exported);

    expect(imported.transactions[0].description).toBe('🍕 Pizza night 🎉');
  });

  it('handles empty transactions array', () => {
    const exported = exportData([]);
    const imported = importData(exported);

    expect(imported.transactions.length).toBe(0);
  });

  it('handles invalid JSON gracefully', () => {
    const imported = importData('not valid json{');
    expect(imported.error).toBeDefined();
    expect(imported.transactions.length).toBe(0);
  });
});

// ==========================================
// CENTS UTILITY FUNCTIONS TESTS
// ==========================================

describe('toCents', () => {
  it('converts whole dollars to cents', () => {
    expect(toCents(1)).toBe(100);
    expect(toCents(10)).toBe(1000);
    expect(toCents(100)).toBe(10000);
  });

  it('converts decimal amounts to cents', () => {
    expect(toCents(1.50)).toBe(150);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.01)).toBe(1);
  });

  it('handles string input', () => {
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('100')).toBe(10000);
    expect(toCents('0.50')).toBe(50);
  });

  it('handles invalid input', () => {
    expect(toCents(NaN)).toBe(0);
    expect(toCents('abc')).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents(null)).toBe(0);
  });

  it('rounds to nearest cent', () => {
    expect(toCents(1.999)).toBe(200);  // Rounds up
    expect(toCents(1.994)).toBe(199);  // Rounds down
    expect(toCents(1.995)).toBe(200);  // Rounds up (banker's rounding)
  });

  it('handles zero', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents('0')).toBe(0);
    expect(toCents(0.00)).toBe(0);
  });
});

describe('toDollars', () => {
  it('converts cents to dollars', () => {
    expect(toDollars(100)).toBe(1);
    expect(toDollars(1999)).toBe(19.99);
    expect(toDollars(1)).toBe(0.01);
  });

  it('handles zero', () => {
    expect(toDollars(0)).toBe(0);
  });

  it('handles large amounts', () => {
    expect(toDollars(99999999999)).toBe(999999999.99);
  });
});

describe('addAmounts', () => {
  it('adds two amounts without floating-point errors', () => {
    expect(addAmounts(0.1, 0.2)).toBe(0.3);  // Classic floating-point test
    expect(addAmounts(0.1, 0.2, 0.3)).toBe(0.6);
  });

  it('adds multiple amounts', () => {
    expect(addAmounts(10, 20, 30, 40)).toBe(100);
    expect(addAmounts(1.11, 2.22, 3.33)).toBe(6.66);
  });

  it('handles single amount', () => {
    expect(addAmounts(100)).toBe(100);
  });

  it('handles no amounts', () => {
    expect(addAmounts()).toBe(0);
  });

  it('handles mixed string and number input', () => {
    expect(addAmounts('10.50', 20, '5.25')).toBe(35.75);
  });

  it('handles repeated small amounts without drift', () => {
    // Add 0.01 one hundred times
    const amounts = Array(100).fill(0.01);
    expect(addAmounts(...amounts)).toBe(1);
  });
});

describe('subtractAmounts', () => {
  it('subtracts amounts without floating-point errors', () => {
    expect(subtractAmounts(0.3, 0.1)).toBe(0.2);
    expect(subtractAmounts(1, 0.01)).toBe(0.99);
  });

  it('handles negative results', () => {
    expect(subtractAmounts(10, 15)).toBe(-5);
    expect(subtractAmounts(0, 100)).toBe(-100);
  });

  it('handles zero subtraction', () => {
    expect(subtractAmounts(100, 0)).toBe(100);
    expect(subtractAmounts(0, 0)).toBe(0);
  });
});

describe('parseAmount', () => {
  it('parses valid number input', () => {
    expect(parseAmount(100)).toBe(100);
    expect(parseAmount(19.99)).toBe(19.99);
  });

  it('parses valid string input', () => {
    expect(parseAmount('100')).toBe(100);
    expect(parseAmount('19.99')).toBe(19.99);
    expect(parseAmount('0.50')).toBe(0.5);
  });

  it('returns 0 for invalid input', () => {
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount(NaN)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount(null)).toBe(0);
  });

  it('returns 0 for negative amounts', () => {
    expect(parseAmount(-10)).toBe(0);
    expect(parseAmount('-50')).toBe(0);
  });

  it('rounds to cents precision', () => {
    expect(parseAmount(19.999)).toBe(20);
    expect(parseAmount(19.994)).toBe(19.99);
    expect(parseAmount('10.555')).toBe(10.56);
  });

  it('handles zero', () => {
    expect(parseAmount(0)).toBe(0);
    expect(parseAmount('0')).toBe(0);
  });

  it('handles amounts with leading/trailing spaces in strings', () => {
    expect(parseAmount(' 100 ')).toBe(100);
    expect(parseAmount(' 19.99')).toBe(19.99);
  });
});
