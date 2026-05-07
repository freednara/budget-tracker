/**
 * Tests for validation functions
 * Tests actual module exports from validator.ts
 */
import { describe, it, expect } from 'vitest';
import { validateAmount, validateDate, validateTransaction } from '../js/modules/core/validator.js';
import type { Transaction } from '../js/types/index.js';

// ==========================================
// LOCAL TEST UTILITY
// validateTransactionsOnLoad tests import-specific logic that doesn't exist in validator.ts
// This tests the concept of bulk transaction validation with __backendId checks
// ==========================================

interface LoadValidationError {
  index: number;
  transaction: unknown;
  errors: string[];
}

interface LoadValidationResult {
  valid: unknown[];
  invalid: LoadValidationError[];
  errors: string[];
}

// TODO: Replace this local reimplementation with tests for the real validateImportData() from validator.ts
function validateTransactionsOnLoad(transactions: unknown): LoadValidationResult {
  if (!Array.isArray(transactions)) {
    return { valid: [], invalid: [], errors: ['Data is not an array'] };
  }

  const valid: unknown[] = [];
  const invalid: LoadValidationError[] = [];
  const errors: string[] = [];

  transactions.forEach((tx: Record<string, unknown>, idx: number) => {
    const txErrors: string[] = [];

    if (!tx.type || !['expense', 'income'].includes(tx.type as string)) {
      txErrors.push(`Invalid type: ${tx.type}`);
    }

    if (typeof tx.amount !== 'number' || isNaN(tx.amount) || tx.amount <= 0) {
      txErrors.push(`Invalid amount: ${tx.amount}`);
    }

    if (!tx.date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date as string)) {
      txErrors.push(`Invalid date format: ${tx.date}`);
    }

    if (!tx.category || typeof tx.category !== 'string') {
      txErrors.push(`Invalid category: ${tx.category}`);
    }

    if (!tx.__backendId || typeof tx.__backendId !== 'string') {
      txErrors.push('Missing __backendId');
    }

    if (txErrors.length > 0) {
      invalid.push({ index: idx, transaction: tx, errors: txErrors });
      errors.push(`Transaction ${idx}: ${txErrors.join(', ')}`);
    } else {
      valid.push(tx);
    }
  });

  return { valid, invalid, errors };
}

// ==========================================
// TESTS FOR LOCAL UTILITY (import-specific validation)
// ==========================================

describe('validateTransactionsOnLoad (local utility)', () => {
  it('validates correct transactions', () => {
    const transactions = [
      { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', __backendId: 'abc123' },
      { type: 'income', amount: 1000, date: '2024-06-01', category: 'salary', __backendId: 'def456' }
    ];

    const result = validateTransactionsOnLoad(transactions);
    expect(result.valid.length).toBe(2);
    expect(result.invalid.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it('rejects invalid type', () => {
    const transactions = [
      { type: 'transfer', amount: 100, date: '2024-06-15', category: 'food', __backendId: 'abc123' }
    ];

    const result = validateTransactionsOnLoad(transactions);
    expect(result.valid.length).toBe(0);
    expect(result.invalid.length).toBe(1);
    expect(result.invalid[0]?.errors).toContain('Invalid type: transfer');
  });

  it('rejects negative amount', () => {
    const transactions = [
      { type: 'expense', amount: -50, date: '2024-06-15', category: 'food', __backendId: 'abc123' }
    ];

    const result = validateTransactionsOnLoad(transactions);
    expect(result.valid.length).toBe(0);
    expect(result.invalid[0]?.errors.some(e => e.includes('Invalid amount'))).toBe(true);
  });

  it('rejects invalid date format', () => {
    const transactions = [
      { type: 'expense', amount: 100, date: '06/15/2024', category: 'food', __backendId: 'abc123' }
    ];

    const result = validateTransactionsOnLoad(transactions);
    expect(result.valid.length).toBe(0);
    expect(result.invalid[0]?.errors.some(e => e.includes('Invalid date'))).toBe(true);
  });

  it('rejects missing backendId', () => {
    const transactions = [
      { type: 'expense', amount: 100, date: '2024-06-15', category: 'food' }
    ];

    const result = validateTransactionsOnLoad(transactions);
    expect(result.valid.length).toBe(0);
    expect(result.invalid[0]?.errors).toContain('Missing __backendId');
  });

  it('handles non-array input', () => {
    const result = validateTransactionsOnLoad('not an array');
    expect(result.valid.length).toBe(0);
    expect(result.errors).toContain('Data is not an array');
  });

  it('handles empty array', () => {
    const result = validateTransactionsOnLoad([]);
    expect(result.valid.length).toBe(0);
    expect(result.invalid.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});

// ==========================================
// TESTS FOR MODULE: validateAmount
// ==========================================

describe('validateAmount (module)', () => {
  it('accepts valid amounts', () => {
    expect(validateAmount('100').valid).toBe(true);
    expect(validateAmount('0.01').valid).toBe(true);
    expect(validateAmount(50.5).valid).toBe(true);
  });

  it('rejects non-numeric values', () => {
    expect(validateAmount('abc').valid).toBe(false);
  });

  it('rejects empty string', () => {
    const result = validateAmount('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Amount is required — enter how much was spent or received.');
    }
  });

  it('rejects amounts below minimum (0.01)', () => {
    const result = validateAmount('0');
    expect(result.valid).toBe(false);
  });

  it('rejects amounts above maximum (999,999.99)', () => {
    expect(validateAmount('9999999').valid).toBe(false);
    expect(validateAmount('1000000').valid).toBe(false);
  });

  it('accepts the maximum valid amount (999,999.99)', () => {
    expect(validateAmount('999999.99').valid).toBe(true);
  });

  it('returns parsed numeric value for valid amounts', () => {
    const result = validateAmount('123.45');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(123.45);
    }
  });

  it('handles currency symbols and commas', () => {
    // The real validator strips $ and commas before parsing
    const result = validateAmount('$1,234.56');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(1234.56);
    }
  });

  // M9 (Inline-Behavior-Review rev 12): validator now routes through
  // localeService.parseNumber. These assertions lock in the locale-aware
  // contract — the prior pattern regex rejected every non-en-US format.
  it('accepts numeric values passed in directly without locale parsing', () => {
    const result = validateAmount(42.5);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(42.5);
    }
  });

  it('rejects NaN / Infinity numeric inputs', () => {
    expect(validateAmount(NaN).valid).toBe(false);
    expect(validateAmount(Infinity).valid).toBe(false);
    expect(validateAmount(-Infinity).valid).toBe(false);
  });

  it('rejects whitespace-only strings', () => {
    const result = validateAmount('   ');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Amount is required — enter how much was spent or received.');
    }
  });

  it('rejects input that strips to empty (pure currency symbol)', () => {
    const result = validateAmount('$');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Amount must be a valid number — remove any letters or extra symbols.');
    }
  });
});

// ==========================================
// TESTS FOR MODULE: validateDate
// Note: Returns string value, not Date object
// ==========================================

describe('validateDate (module)', () => {
  it('accepts valid dates', () => {
    expect(validateDate('2024-06-15').valid).toBe(true);
    expect(validateDate('2024-01-01').valid).toBe(true);
    expect(validateDate('2024-12-31').valid).toBe(true);
  });

  it('rejects empty date', () => {
    const result = validateDate('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Date is required — pick when this transaction happened.');
    }
  });

  it('rejects wrong format', () => {
    expect(validateDate('06/15/2024').valid).toBe(false);
    expect(validateDate('2024/06/15').valid).toBe(false);
    expect(validateDate('15-06-2024').valid).toBe(false);
  });

  it('rejects impossible calendar dates (C12 round-trip check, rev 12)', () => {
    // Previous behavior accepted Feb 30 because JS Date silently overflowed it
    // to Mar 2. The rev-12 round-trip YMD comparison rejects it, and any
    // overflow date corruption is caught at the input boundary instead of
    // being persisted verbatim and reinterpreted on every downstream read.
    expect(validateDate('2024-02-30').valid).toBe(false);
    expect(validateDate('2026-04-31').valid).toBe(false);
    expect(validateDate('2026-09-31').valid).toBe(false);
  });

  it('accepts Feb 29 in leap years and rejects in non-leap years', () => {
    expect(validateDate('2024-02-29').valid).toBe(true); // 2024 is a leap year
    expect(validateDate('2000-02-29').valid).toBe(true); // year-2000 leap year
    expect(validateDate('2023-02-29').valid).toBe(false); // C12: rejected (was rolling to Mar 1)
    expect(validateDate('2100-02-29').valid).toBe(false); // year-2100 is NOT a leap year
  });

  it('returns date string for valid dates (not Date object)', () => {
    const result = validateDate('2024-06-15');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('2024-06-15'); // Returns string, not Date
    }
  });
});

// ==========================================
// TESTS FOR MODULE: validateTransaction
// ==========================================

describe('validateTransaction (module)', () => {
  it('validates a complete valid transaction', () => {
    const tx = {
      type: 'expense' as const,
      amount: 100,
      date: '2024-06-15',
      category: 'food',
      description: 'lunch'
    };

    const result = validateTransaction(tx);
    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors).length).toBe(0);
  });

  it('returns errors for invalid fields', () => {
    const tx = {
      type: 'invalid',
      amount: 'abc',
      date: 'bad-date',
      category: ''
    };

    const result = validateTransaction(tx as unknown as Partial<Transaction>);
    expect(result.valid).toBe(false);
    expect(result.errors.type).toBeDefined();
    expect(result.errors.amount).toBeDefined();
    expect(result.errors.date).toBeDefined();
    expect(result.errors.category).toBeDefined();
  });

  it('returns sanitized transaction in result', () => {
    const tx = {
      type: 'expense' as const,
      amount: '100.50',
      date: '2024-06-15',
      category: 'food'
    };

    const result = validateTransaction(tx as unknown as Partial<Transaction>);
    expect(result.valid).toBe(true);
    expect(result.sanitized.amount).toBe(100.50); // Parsed to number
  });
});
