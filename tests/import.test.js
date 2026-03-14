/**
 * Tests for import/export functionality
 * Tests actual module exports from import-export.ts where possible
 */
import { describe, it, expect } from 'vitest';
import { findContentDuplicates } from '../js/modules/features/import-export/import-export.js';

// ==========================================
// LOCAL TEST UTILITIES
// These test useful concepts but don't exist as standalone exports
// ==========================================

/**
 * CSV escape function - tests CSV escaping concept
 * Note: Production code has buildCsvContent with inline csvEsc that includes
 * formula injection protection. This tests basic CSV escaping.
 */
function escapeCsvField(field) {
  if (field == null) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCsvRow(fields) {
  return fields.map(escapeCsvField).join(',');
}

/**
 * Simple hash for testing - production uses fuzzy matching in findContentDuplicates
 */
function hashTransaction(tx) {
  return `${tx.type}|${tx.amount}|${tx.date}|${tx.category}|${tx.description || ''}`;
}

// ==========================================
// TESTS FOR LOCAL UTILITIES (CSV escaping concept)
// ==========================================

describe('escapeCsvField (local utility)', () => {
  it('returns plain values unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(123)).toBe('123');
  });

  it('wraps comma-containing values in quotes', () => {
    expect(escapeCsvField('hello, world')).toBe('"hello, world"');
  });

  it('escapes double quotes', () => {
    expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
  });

  it('handles newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('handles null and undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('handles complex cases', () => {
    expect(escapeCsvField('"test, with" both')).toBe('"""test, with"" both"');
  });
});

describe('buildCsvRow (local utility)', () => {
  it('joins fields with commas', () => {
    expect(buildCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('escapes fields as needed', () => {
    expect(buildCsvRow(['plain', 'has, comma', 'end'])).toBe('plain,"has, comma",end');
  });

  it('handles empty array', () => {
    expect(buildCsvRow([])).toBe('');
  });
});

describe('hashTransaction (local utility)', () => {
  it('creates consistent hash for same transaction', () => {
    const tx = { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', description: 'lunch' };
    expect(hashTransaction(tx)).toBe('expense|100|2024-06-15|food|lunch');
  });

  it('handles missing description', () => {
    const tx = { type: 'expense', amount: 100, date: '2024-06-15', category: 'food' };
    expect(hashTransaction(tx)).toBe('expense|100|2024-06-15|food|');
  });

  it('produces different hashes for different transactions', () => {
    const tx1 = { type: 'expense', amount: 100, date: '2024-06-15', category: 'food' };
    const tx2 = { type: 'expense', amount: 100, date: '2024-06-16', category: 'food' };
    expect(hashTransaction(tx1)).not.toBe(hashTransaction(tx2));
  });
});

// ==========================================
// TESTS FOR ACTUAL MODULE: findContentDuplicates
// Note: Real function returns just the duplicates array (not { duplicates, unique })
// and uses fuzzy matching (similar descriptions, amounts within 5%)
// ==========================================

describe('findContentDuplicates (module)', () => {
  const existing = [
    { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', description: 'lunch' },
    { type: 'income', amount: 1000, date: '2024-06-01', category: 'salary', description: 'paycheck' }
  ];

  it('identifies exact duplicates', () => {
    const incoming = [
      { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', description: 'lunch' }
    ];

    const duplicates = findContentDuplicates(incoming, existing);
    expect(duplicates.length).toBe(1);
  });

  it('returns empty for unique transactions', () => {
    const incoming = [
      { type: 'expense', amount: 50, date: '2024-06-20', category: 'transport', description: 'taxi' }
    ];

    const duplicates = findContentDuplicates(incoming, existing);
    expect(duplicates.length).toBe(0);
  });

  it('uses fuzzy matching for amounts within 5%', () => {
    const incoming = [
      // 102 is within 5% of 100, same date/type/category/description
      { type: 'expense', amount: 102, date: '2024-06-15', category: 'food', description: 'lunch' }
    ];

    const duplicates = findContentDuplicates(incoming, existing);
    expect(duplicates.length).toBe(1);
  });

  it('uses fuzzy matching for similar descriptions', () => {
    const incoming = [
      // "Lunch" matches "lunch" (case insensitive)
      { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', description: 'Lunch' }
    ];

    const duplicates = findContentDuplicates(incoming, existing);
    expect(duplicates.length).toBe(1);
  });

  it('handles mixed duplicates and unique', () => {
    const incoming = [
      { type: 'expense', amount: 100, date: '2024-06-15', category: 'food', description: 'lunch' }, // dup
      { type: 'expense', amount: 50, date: '2024-06-20', category: 'transport', description: 'taxi' } // unique
    ];

    const duplicates = findContentDuplicates(incoming, existing);
    expect(duplicates.length).toBe(1);
  });

  it('handles empty arrays', () => {
    expect(findContentDuplicates([], existing).length).toBe(0);
    expect(findContentDuplicates([{ type: 'expense', amount: 10, date: '2024-01-01', category: 'x' }], []).length).toBe(0);
  });
});
