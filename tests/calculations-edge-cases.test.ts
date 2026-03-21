/**
 * Edge Case Tests for Financial Calculations
 * Tests leap years, precision limits, timezone shifts, and other edge cases
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Transaction } from '../js/types/index.js';
import {
  calcVelocityPure,
  getYearStatsPure,
  getAllTimeStatsPure
} from '../js/modules/features/financial/calculations.js';
import {
  toCents,
  toDollars,
  addAmounts,
  parseMonthKey,
  getMonthKey
} from '../js/modules/core/utils.js';

function tx(overrides: Partial<Transaction> & { type: 'expense' | 'income'; amount: number; date: string; category: string }): Transaction {
  return {
    __backendId: `test_${Math.random().toString(36).slice(2)}`,
    description: 'Test',
    currency: 'USD',
    recurring: false,
    ...overrides
  };
}

// ==========================================
// LEAP YEAR TESTS
// ==========================================

describe('Leap Year Edge Cases', () => {
  it('handles spending velocity correctly in February 2024 (leap year)', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 290, date: '2024-02-01', category: 'food' }),
      tx({ type: 'expense', amount: 290, date: '2024-02-29', category: 'food' }) // Feb 29th!
    ];
    
    // Test on Feb 29, 2024
    const result = calcVelocityPure(transactions, '2024-02', new Date(2024, 1, 29));
    expect(result.actual).toBe(580); // Both transactions
    expect(result.dailyRate).toBe(20); // 580 / 29 days
    expect(result.projected).toBe(580); // Completed month
  });

  it('handles spending velocity correctly in February 2023 (non-leap year)', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 280, date: '2023-02-01', category: 'food' }),
      tx({ type: 'expense', amount: 280, date: '2023-02-28', category: 'food' })
    ];
    
    // Test on Feb 28, 2023
    const result = calcVelocityPure(transactions, '2023-02', new Date(2023, 1, 28));
    expect(result.actual).toBe(560);
    expect(result.dailyRate).toBe(20); // 560 / 28 days
    expect(result.projected).toBe(560);
  });

  it('handles year-end boundary correctly', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2023-12-31', category: 'party' }),
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: 'hangover' })
    ];
    
    // December 2023 should only include the first transaction
    const dec2023 = calcVelocityPure(transactions, '2023-12', new Date(2024, 0, 1));
    expect(dec2023.actual).toBe(100);
    
    // January 2024 should only include the second transaction
    const jan2024 = calcVelocityPure(transactions, '2024-01', new Date(2024, 0, 1));
    expect(jan2024.actual).toBe(100);
  });
});

// ==========================================
// PRECISION LIMIT TESTS
// ==========================================

describe('Floating Point Precision Edge Cases', () => {
  it('maintains precision when adding 0.01 one million times', () => {
    // This is why we use integer math (cents)!
    let totalCents = 0;
    const iterations = 1000000;
    
    for (let i = 0; i < iterations; i++) {
      totalCents += toCents(0.01);
    }
    
    const totalDollars = toDollars(totalCents);
    expect(totalDollars).toBe(10000.00); // Exactly $10,000
  });

  it('handles JavaScript 0.1 + 0.2 !== 0.3 problem', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 0.1, date: '2024-01-01', category: 'test' }),
      tx({ type: 'expense', amount: 0.2, date: '2024-01-01', category: 'test' })
    ];
    
    const result = calcVelocityPure(transactions, '2024-01', new Date(2024, 0, 1));
    // Should be exactly 0.3, not 0.30000000000000004
    expect(result.actual).toBe(0.3);
  });

  it('handles very large amounts correctly', () => {
    const largeAmount = 999999999.99; // Max supported amount
    const transactions: Transaction[] = [
      tx({ type: 'income', amount: largeAmount, date: '2024-01-01', category: 'lottery' })
    ];
    
    const stats = getYearStatsPure(transactions, '2024');
    expect(stats.income).toBe(largeAmount);
    expect(stats.net).toBe(largeAmount);
  });

  it('handles very small amounts correctly', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 0.01, date: '2024-01-01', category: 'penny' }),
      tx({ type: 'expense', amount: 0.01, date: '2024-01-01', category: 'penny' }),
      tx({ type: 'expense', amount: 0.01, date: '2024-01-01', category: 'penny' })
    ];
    
    const stats = getYearStatsPure(transactions, '2024');
    expect(stats.expenses).toBe(0.03); // Exactly 3 cents
  });
});

// ==========================================
// TIMEZONE SHIFT TESTS
// ==========================================

describe('Timezone and Date Boundary Edge Cases', () => {
  it('handles transaction at 11:59 PM on month boundary', () => {
    // Transaction made at 11:59 PM on Jan 31
    const transactions: Transaction[] = [
      tx({
        type: 'expense',
        amount: 100,
        date: '2024-01-31', // ISO date string
        category: 'late-night'
      })
    ];
    
    // Should be in January, not February
    const jan = calcVelocityPure(transactions, '2024-01', new Date(2024, 1, 1));
    const feb = calcVelocityPure(transactions, '2024-02', new Date(2024, 1, 1));
    
    expect(jan.actual).toBe(100);
    expect(feb.actual).toBe(0);
  });

  it('handles DST transition correctly', () => {
    // March 10, 2024 - Spring forward in US
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2024-03-09', category: 'before-dst' }),
      tx({ type: 'expense', amount: 100, date: '2024-03-10', category: 'dst-day' }),
      tx({ type: 'expense', amount: 100, date: '2024-03-11', category: 'after-dst' })
    ];
    
    const result = calcVelocityPure(transactions, '2024-03', new Date(2024, 2, 15));
    expect(result.actual).toBe(300); // All three transactions
  });

  it('handles invalid date strings gracefully', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2024-02-30', category: 'invalid' }), // Feb 30 doesn't exist
      tx({ type: 'expense', amount: 100, date: '2024-13-01', category: 'invalid' }), // Month 13 doesn't exist
      tx({ type: 'expense', amount: 100, date: 'not-a-date', category: 'invalid' })
    ];
    
    // Should handle invalid dates without crashing
    expect(() => {
      calcVelocityPure(transactions, '2024-02', new Date(2024, 1, 28));
    }).not.toThrow();
  });
});

// ==========================================
// ACCUMULATION OVERFLOW TESTS
// ==========================================

describe('Accumulation and Overflow Edge Cases', () => {
  it('handles accumulation of many small transactions', () => {
    // Create 10,000 transactions of $0.01
    const transactions: Transaction[] = [];
    for (let i = 0; i < 10000; i++) {
      transactions.push(tx({
        type: 'expense',
        amount: 0.01,
        date: '2024-01-01',
        category: 'micro'
      }));
    }
    
    const stats = getYearStatsPure(transactions, '2024');
    expect(stats.expenses).toBe(100); // Exactly $100
    expect(stats.transactionCount).toBe(10000);
  });

  it('handles negative amounts correctly', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: -50, date: '2024-01-01', category: 'refund' }), // Negative expense
      tx({ type: 'income', amount: -100, date: '2024-01-01', category: 'fee' }) // Negative income
    ];

    // toCents(-50) = -5000, toCents(-100) = -10000 -- negatives are accumulated as-is
    const stats = getYearStatsPure(transactions, '2024');
    // Negative expense amount is included in the expense total (reduces it)
    expect(stats.expenses).toBe(-50);
    // Negative income amount is included in the income total (reduces it)
    expect(stats.income).toBe(-100);
    // Net = income - expenses = -100 - (-50) = -50
    expect(stats.net).toBe(-50);
  });
});

// ==========================================
// EMPTY AND NULL TESTS
// ==========================================

describe('Empty and Null Edge Cases', () => {
  it('handles empty transaction array', () => {
    const result = calcVelocityPure([], '2024-01', new Date(2024, 0, 15));
    expect(result.actual).toBe(0);
    expect(result.dailyRate).toBe(0);
    expect(result.projected).toBe(0);
  });

  it('handles transactions with missing fields', () => {
    const transactions = [
      { type: 'expense', amount: 100 }, // Missing date
      { type: 'expense', date: '2024-01-01' }, // Missing amount
      { amount: 100, date: '2024-01-01' } // Missing type
    ] as unknown as Transaction[];
    
    // Should not crash
    expect(() => {
      calcVelocityPure(transactions, '2024-01', new Date(2024, 0, 15));
    }).not.toThrow();
  });

  it('handles all-time stats with no transactions', () => {
    const result = getAllTimeStatsPure([]);
    expect(result).toBeNull(); // Should return null for empty data
  });
});

// ==========================================
// MONTH BOUNDARY TESTS
// ==========================================

describe('Month Boundary Edge Cases', () => {
  it('handles months with different day counts correctly', () => {
    const testCases = [
      { month: '2024-01', days: 31 }, // January
      { month: '2024-02', days: 29 }, // February (leap year)
      { month: '2023-02', days: 28 }, // February (non-leap)
      { month: '2024-04', days: 30 }, // April
    ];
    
    testCases.forEach(({ month, days }) => {
      const viewDate = parseMonthKey(month);
      const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
      expect(daysInMonth).toBe(days);
    });
  });

  it('handles calculation on first day of month', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: 'test' })
    ];

    // Calculate on Jan 1
    const result = calcVelocityPure(transactions, '2024-01', new Date(2024, 0, 1));
    expect(result.dailyRate).toBe(100); // $100 / 1 day
    expect(result.projected).toBe(3100); // $100 * 31 days
  });

  it('handles calculation on last day of month', () => {
    const transactions: Transaction[] = [];
    for (let i = 1; i <= 31; i++) {
      transactions.push(tx({
        type: 'expense',
        amount: 10,
        date: `2024-01-${i.toString().padStart(2, '0')}`,
        category: 'daily'
      }));
    }
    
    // Calculate on Jan 31
    const result = calcVelocityPure(transactions, '2024-01', new Date(2024, 0, 31));
    expect(result.actual).toBe(310); // $10 * 31 days
    expect(result.dailyRate).toBe(10); // $310 / 31 days
    expect(result.projected).toBe(310); // Same as actual for completed month
  });
});

// ==========================================
// CATEGORY AGGREGATION TESTS
// ==========================================

describe('Category Aggregation Edge Cases', () => {
  it('handles special characters in category names', () => {
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: 'Food & Drinks' }),
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: 'Car/Transport' }),
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: '🎉 Party' }),
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: 'Health (Medical)' })
    ];
    
    const stats = getYearStatsPure(transactions, '2024');
    expect(stats.topCategories).toHaveLength(4);
    expect(stats.expenses).toBe(400);
  });

  it('handles very long category names', () => {
    const longCategory = 'A'.repeat(1000); // 1000 character category name
    const transactions: Transaction[] = [
      tx({ type: 'expense', amount: 100, date: '2024-01-01', category: longCategory })
    ];
    
    const stats = getYearStatsPure(transactions, '2024');
    expect(stats.topCategories[0].id).toBe(longCategory);
  });
});