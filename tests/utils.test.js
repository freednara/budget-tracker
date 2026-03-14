/**
 * Tests for utility functions
 * Tests actual module exports from utils.ts
 */
import { describe, it, expect } from 'vitest';
import {
  parseLocalDate,
  getMonthKey,
  parseMonthKey,
  esc,
  debounce,
  sumByType
} from '../js/modules/core/utils.js';

// sanitizeId is not exported from utils.ts - keep local for testing concept
function sanitizeId(id) {
  if (typeof id !== 'string') return String(id).slice(0, 128);
  return id.replace(/[<>&"']/g, '').slice(0, 128);
}

// Tests
describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD correctly', () => {
    const result = parseLocalDate('2024-06-15');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(5); // 0-indexed
    expect(result.getDate()).toBe(15);
  });

  it('handles Date objects', () => {
    const input = new Date(2024, 5, 15);
    const result = parseLocalDate(input);
    expect(result).toBe(input);
  });

  it('handles invalid date strings', () => {
    const result = parseLocalDate('invalid');
    expect(isNaN(result.getTime())).toBe(true);
  });

  it('parses ISO strings', () => {
    const result = parseLocalDate('2024-06-15T12:00:00');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(5);
  });
});

describe('getMonthKey', () => {
  it('formats Date to YYYY-MM', () => {
    const date = new Date(2024, 0, 15); // January 15, 2024
    expect(getMonthKey(date)).toBe('2024-01');
  });

  it('pads single-digit months', () => {
    const date = new Date(2024, 5, 15); // June
    expect(getMonthKey(date)).toBe('2024-06');
  });

  it('handles December', () => {
    const date = new Date(2024, 11, 25); // December
    expect(getMonthKey(date)).toBe('2024-12');
  });

  it('handles date string input', () => {
    expect(getMonthKey('2024-03-15')).toBe('2024-03');
  });

  it('returns empty for invalid date', () => {
    expect(getMonthKey('invalid')).toBe('');
  });
});

describe('parseMonthKey', () => {
  it('parses YYYY-MM to first day of month', () => {
    const result = parseMonthKey('2024-06');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(1);
  });

  it('handles December correctly', () => {
    const result = parseMonthKey('2024-12');
    expect(result.getMonth()).toBe(11);
  });
});

describe('sanitizeId', () => {
  it('removes dangerous characters', () => {
    expect(sanitizeId('test<script>alert(1)</script>')).toBe('testscriptalert(1)/script');
  });

  it('truncates to 128 characters', () => {
    const longId = 'a'.repeat(200);
    expect(sanitizeId(longId).length).toBe(128);
  });

  it('handles non-string input', () => {
    expect(sanitizeId(12345)).toBe('12345');
    expect(sanitizeId(null)).toBe('null');
  });

  it('removes quotes', () => {
    expect(sanitizeId('test"value\'here')).toBe('testvaluehere');
  });
});

describe('esc (HTML escaping)', () => {
  it('escapes HTML special characters', () => {
    // Real esc() uses DOM-based escaping (div.textContent → div.innerHTML)
    // This escapes <, >, & but NOT quotes
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('<div>test</div>')).toBe('&lt;div&gt;test&lt;/div&gt;');
  });

  it('does not escape quotes (DOM-based escaping)', () => {
    // DOM's textContent/innerHTML doesn't escape quotes in content
    expect(esc('"quoted"')).toBe('"quoted"');
    expect(esc("'single'")).toBe("'single'");
  });

  it('returns empty string for non-strings', () => {
    // Real esc() returns '' for non-string input (type safety)
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(123)).toBe('');
  });

  it('preserves safe text', () => {
    expect(esc('Hello World')).toBe('Hello World');
  });
});

describe('debounce', () => {
  it('delays function execution', async () => {
    let counter = 0;
    const increment = debounce(() => counter++, 50);

    increment();
    increment();
    increment();

    expect(counter).toBe(0);

    await new Promise(r => setTimeout(r, 100));
    expect(counter).toBe(1);
  });

  it('resets timer on subsequent calls', async () => {
    let counter = 0;
    const increment = debounce(() => counter++, 50);

    increment();
    await new Promise(r => setTimeout(r, 30));
    increment(); // Reset timer
    await new Promise(r => setTimeout(r, 30));

    expect(counter).toBe(0); // Still hasn't fired

    await new Promise(r => setTimeout(r, 50));
    expect(counter).toBe(1);
  });
});

describe('sumByType', () => {
  const transactions = [
    { type: 'expense', amount: 100 },
    { type: 'expense', amount: 50 },
    { type: 'income', amount: 1000 },
    { type: 'income', amount: 500 },
    { type: 'expense', amount: '25.50' } // String amount
  ];

  it('sums expense transactions', () => {
    expect(sumByType(transactions, 'expense')).toBe(175.5);
  });

  it('sums income transactions', () => {
    expect(sumByType(transactions, 'income')).toBe(1500);
  });

  it('returns 0 for empty array', () => {
    expect(sumByType([], 'expense')).toBe(0);
  });

  it('returns 0 for non-matching type', () => {
    expect(sumByType(transactions, 'transfer')).toBe(0);
  });
});
