/**
 * Tests for data management functionality
 * localStorage operations and data persistence
 * Uses actual module exports where possible
 */
import { describe, it, expect, beforeEach } from 'vitest';
// localStorage is provided by happy-dom environment
import { SK, lsGet, lsSet } from '../js/modules/core/state.js';
import { createTransaction, resetIdCounter } from './test-data-factory.js';

// ==========================================
// TEST UTILITIES
// Category definitions for testing (simplified test data)
// Different from production categories - used to test lookup logic
// ==========================================

const TEST_EXPENSE_CATS = [
  { id: 'food', name: 'Food & Dining', emoji: '🍕', color: '#ef4444' },
  { id: 'transport', name: 'Transportation', emoji: '🚗', color: '#f59e0b' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', color: '#8b5cf6' }
];

const TEST_INCOME_CATS = [
  { id: 'salary', name: 'Salary', emoji: '💰', color: '#22c55e' },
  { id: 'freelance', name: 'Freelance', emoji: '💻', color: '#06b6d4' }
];

/**
 * Category lookup function for testing
 * Pure function that accepts custom categories as parameter
 */
interface TestCatInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
  type?: string;
}

function getCatInfoTest(type: string, catId: string | null | undefined, customCats: TestCatInfo[] = []) {
  const allCats: TestCatInfo[] = type === 'expense'
    ? [...TEST_EXPENSE_CATS, ...customCats.filter(c => c.type === 'expense')]
    : [...TEST_INCOME_CATS, ...customCats.filter(c => c.type === 'income')];

  return allCats.find(c => c.id === catId) || {
    id: catId || 'unknown',
    name: catId || 'Unknown',
    emoji: '❓',
    color: '#666'
  };
}

// ==========================================
// TESTS FOR lsGet / lsSet (from state.ts)
// ==========================================

describe('lsGet / lsSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores and retrieves simple values', () => {
    lsSet('test_key', 'hello');
    expect(lsGet('test_key', null)).toBe('hello');
  });

  it('stores and retrieves objects', () => {
    const obj = { name: 'test', value: 123 };
    lsSet('test_obj', obj);
    expect(lsGet('test_obj', null)).toEqual(obj);
  });

  it('stores and retrieves arrays', () => {
    const arr = [1, 2, 3, { nested: true }];
    lsSet('test_arr', arr);
    expect(lsGet('test_arr', null)).toEqual(arr);
  });

  it('returns default for missing keys', () => {
    expect(lsGet('nonexistent', 'default')).toBe('default');
    expect(lsGet('nonexistent', null)).toBeNull();
  });

  it('handles null values', () => {
    lsSet('null_value', null);
    expect(lsGet('null_value', 'default')).toBeNull();
  });

  it('handles numbers', () => {
    lsSet('number', 42);
    expect(lsGet('number', null)).toBe(42);
  });

  it('handles boolean values', () => {
    lsSet('bool_true', true);
    lsSet('bool_false', false);
    expect(lsGet('bool_true', null)).toBe(true);
    expect(lsGet('bool_false', null)).toBe(false);
  });
});

// ==========================================
// TESTS FOR STORAGE KEYS (from state.ts)
// ==========================================

describe('Storage keys', () => {
  it('uses consistent key names', () => {
    expect(SK.TX).toContain('budget_tracker');
    expect(SK.SAVINGS).toContain('budget_tracker');
    expect(SK.ALLOC).toContain('budget_tracker');
  });

  it('has unique keys', () => {
    const keys = Object.values(SK);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});

// ==========================================
// TESTS FOR getCatInfoTest (test utility)
// Tests category lookup logic
// ==========================================

describe('getCatInfoTest', () => {
  it('finds expense categories', () => {
    const cat = getCatInfoTest('expense', 'food');
    expect(cat.name).toBe('Food & Dining');
    expect(cat.emoji).toBe('🍕');
    expect(cat.color).toBe('#ef4444');
  });

  it('finds income categories', () => {
    const cat = getCatInfoTest('income', 'salary');
    expect(cat.name).toBe('Salary');
    expect(cat.emoji).toBe('💰');
  });

  it('returns unknown for missing categories', () => {
    const cat = getCatInfoTest('expense', 'nonexistent');
    expect(cat.name).toBe('nonexistent');
    expect(cat.emoji).toBe('❓');
  });

  it('includes custom categories', () => {
    const customCats = [
      { id: 'custom_1', name: 'Custom Cat', emoji: '🎯', color: '#ff0000', type: 'expense' }
    ];
    const cat = getCatInfoTest('expense', 'custom_1', customCats);
    expect(cat.name).toBe('Custom Cat');
    expect(cat.emoji).toBe('🎯');
  });

  it('filters custom categories by type', () => {
    const customCats = [
      { id: 'expense_custom', name: 'Expense Custom', emoji: '💸', color: '#ff0000', type: 'expense' },
      { id: 'income_custom', name: 'Income Custom', emoji: '💵', color: '#00ff00', type: 'income' }
    ];

    // Looking for income category shouldn't find expense custom
    const cat = getCatInfoTest('income', 'expense_custom', customCats);
    expect(cat.emoji).toBe('❓'); // Should fall back to unknown

    // Looking for income category should find income custom
    const cat2 = getCatInfoTest('income', 'income_custom', customCats);
    expect(cat2.name).toBe('Income Custom');
  });

  it('handles null/undefined category id', () => {
    const cat = getCatInfoTest('expense', null);
    expect(cat.name).toBe('Unknown');

    const cat2 = getCatInfoTest('expense', undefined);
    expect(cat2.name).toBe('Unknown');
  });
});

// ==========================================
// TESTS FOR TRANSACTION STRUCTURE
// ==========================================

describe('Transaction structure', () => {
  beforeEach(() => {
    localStorage.clear();
    resetIdCounter();
  });

  it('has all required fields', () => {
    const tx = createTransaction();
    expect(tx).toHaveProperty('__backendId');
    expect(tx).toHaveProperty('type');
    expect(tx).toHaveProperty('amount');
    expect(tx).toHaveProperty('date');
    expect(tx).toHaveProperty('category');
  });

  it('has valid type', () => {
    const tx = createTransaction({ type: 'expense' });
    expect(['expense', 'income']).toContain(tx.type);
  });

  it('has positive amount', () => {
    const tx = createTransaction({ amount: 100 });
    expect(tx.amount).toBeGreaterThan(0);
  });

  it('has valid date format', () => {
    const tx = createTransaction({ date: '2024-06-15' });
    expect(tx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stores in localStorage correctly', () => {
    const tx = createTransaction({ amount: 100, description: 'Lunch' });
    lsSet(SK.TX, [tx]);

    const retrieved = lsGet(SK.TX, []) as Array<{ amount: number; __backendId: string }>;
    expect(retrieved.length).toBe(1);
    expect(retrieved[0].amount).toBe(100);
    expect(retrieved[0].__backendId).toBe(tx.__backendId);
  });
});

// ==========================================
// TESTS FOR BUDGET ALLOCATION STRUCTURE
// ==========================================

describe('Budget allocation structure', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores monthly allocations by category', () => {
    const alloc = {
      '2024-06': { food: 500, transport: 200, shopping: 300 },
      '2024-07': { food: 550, transport: 200 }
    };

    lsSet(SK.ALLOC, alloc);
    const retrieved = lsGet(SK.ALLOC, {}) as Record<string, Record<string, number>>;

    expect(retrieved['2024-06'].food).toBe(500);
    expect(retrieved['2024-07'].food).toBe(550);
  });

  it('handles empty allocations', () => {
    lsSet(SK.ALLOC, {});
    expect(lsGet(SK.ALLOC, {})).toEqual({});
  });
});

// ==========================================
// TESTS FOR SAVINGS GOALS STRUCTURE
// ==========================================

describe('Savings goals structure', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores savings goals with progress', () => {
    const goals = {
      'sg_1': {
        name: 'Emergency Fund',
        target_amount: 10000,
        saved_amount: 2500,
        deadline: '2025-12-31'
      },
      'sg_2': {
        name: 'Vacation',
        target_amount: 3000,
        saved_amount: 1000,
        deadline: '2024-08-01'
      }
    };

    lsSet(SK.SAVINGS, goals);
    const retrieved = lsGet(SK.SAVINGS, {}) as Record<string, { name: string; target_amount: number; saved_amount: number; deadline: string }>;

    expect(Object.keys(retrieved).length).toBe(2);
    expect(retrieved['sg_1'].name).toBe('Emergency Fund');
    expect(retrieved['sg_1'].saved_amount).toBe(2500);
  });

  it('calculates progress percentage correctly', () => {
    const goal = {
      target_amount: 1000,
      saved_amount: 250
    };

    const progress = (goal.saved_amount / goal.target_amount) * 100;
    expect(progress).toBe(25);
  });
});
