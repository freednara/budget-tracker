/**
 * Tests for import-export and duplicate-detection modules
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==========================================
// MOCKS (hoisted above imports)
// ==========================================

vi.mock('../js/modules/core/state.js', () => ({
  SK: {
    TX: 'bt_transactions',
    SAVINGS: 'bt_savings',
    SAVINGS_CONTRIB: 'bt_savings_contrib',
    CURRENCY: 'bt_currency',
    ACHIEVE: 'bt_achievements',
    STREAK: 'bt_streak',
    SECTIONS: 'bt_sections',
    INSIGHT_PERS: 'bt_insight_personality',
    FILTER_PRESETS: 'bt_filter_presets',
    TX_TEMPLATES: 'bt_tx_templates',
    LAST_BACKUP: 'bt_last_backup',
    ALERTS: 'bt_alerts',
    CUSTOM_CAT: 'bt_custom_categories',
    ALLOC: 'bt_allocations',
    DEBTS: 'bt_debts',
    ROLLOVER_SETTINGS: 'bt_rollover_settings',
    THEME: 'bt_theme',
  },
  lsGet: vi.fn((_key: string, fallback: unknown) => fallback),
  lsSet: vi.fn(() => true),
}));

vi.mock('../js/modules/core/safe-storage.js', () => ({
  safeStorage: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    getJSON: vi.fn((_key: string, fallback: unknown) => fallback),
    setJSON: vi.fn(() => true),
  },
}));

vi.mock('../js/modules/core/signals.js', () => ({
  transactions: { value: [] },
  savingsGoals: { value: {} },
  savingsContribs: { value: [] },
  currency: { value: { home: 'USD', symbol: '$' } },
  achievements: { value: {} },
  streak: { value: { current: 0, longest: 0, lastDate: null } },
  sections: { value: { envelope: true } },
  insightPers: { value: 'serious' },
  filterPresets: { value: [] },
  txTemplates: { value: [] },
  lastBackup: { value: null },
  alerts: { value: { budgetThreshold: 0.8 } },
  customCats: { value: [] },
  monthlyAlloc: { value: {} },
  debts: { value: [] },
  rolloverSettings: { value: null },
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  default: { get: vi.fn(() => null) },
}));

vi.mock('../js/modules/ui/core/ui.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../js/modules/core/categories.js', () => ({
  DEFAULT_CATEGORY_COLOR: '#6b7280',
}));

// ==========================================
// IMPORTS (after mocks)
// ==========================================

import {
  sanitizeImportedTransactions,
  buildCsvContent,
  buildExportData,
  findContentDuplicates as findContentDuplicatesImportExport,
  MAX_IMPORT_TRANSACTIONS,
} from '../js/modules/features/import-export/import-export.js';

import {
  findContentDuplicates,
  findFuzzyDuplicates,
  deduplicateExact,
  excludeDuplicates,
} from '../js/modules/features/import-export/duplicate-detection.js';

import {
  createTransaction,
  createExpenseTransaction,
  createIncomeTransaction,
  resetIdCounter,
} from './test-data-factory.js';

import type { Transaction } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return createTransaction({
    date: '2024-06-15',
    amount: 50,
    category: 'food',
    type: 'expense',
    description: 'Groceries',
    ...overrides,
  });
}

// ==========================================
// sanitizeImportedTransactions
// ==========================================

describe('sanitizeImportedTransactions', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('passes through valid transaction data', () => {
    const incoming = [
      { type: 'expense', amount: 42.5, date: '2024-06-15', category: 'food', description: 'lunch' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(42.5);
    expect(result[0].date).toBe('2024-06-15');
    expect(result[0].category).toBe('food');
    expect(result[0].type).toBe('expense');
  });

  it('assigns __backendId to items that lack one', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(1);
    expect(result[0].__backendId).toBeDefined();
    expect(typeof result[0].__backendId).toBe('string');
    expect(result[0].__backendId.length).toBeGreaterThan(0);
  });

  it('generates a new __backendId when the incoming one collides with existingIds', () => {
    const incoming = [
      { __backendId: 'existing1', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming, new Set(['existing1']));
    expect(result).toHaveLength(1);
    expect(result[0].__backendId).not.toBe('existing1');
  });

  it('passes through extra fields via spread (validator does not strip unknown keys)', () => {
    const incoming = [
      {
        type: 'expense',
        amount: 10,
        date: '2024-01-01',
        category: 'food',
        extraField: 999,
      },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(1);
    // The validator uses spread ({...transaction}) so extra keys are preserved
    // This is expected behavior - sanitization focuses on validating required fields
    expect(result[0].type).toBe('expense');
    expect(result[0].amount).toBe(10);
  });

  it('rejects records with missing required fields', () => {
    const incoming = [
      { type: 'expense' }, // missing amount, date, category
      { amount: 10 },      // missing type, date, category
      {},                   // missing everything
    ];

    const result = sanitizeImportedTransactions(incoming);
    // All should be rejected by the validator
    expect(result).toHaveLength(0);
  });

  it('rejects records with invalid type', () => {
    const incoming = [
      { type: 'transfer', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(0);
  });

  it('preserves valid __backendId when not colliding', () => {
    const incoming = [
      { __backendId: 'myid123', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(1);
    expect(result[0].__backendId).toBe('myid123');
  });

  it('rejects __backendId values with prototype pollution patterns', () => {
    const incoming = [
      { __backendId: '__proto__', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
      { __backendId: 'constructor', type: 'expense', amount: 20, date: '2024-01-02', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(2);
    // Sanitized IDs should NOT be the dangerous values
    expect(result[0].__backendId).not.toBe('__proto__');
    expect(result[1].__backendId).not.toBe('constructor');
  });

  it('handles a mix of valid and invalid records', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' }, // valid
      { type: 'invalid', amount: -5, date: 'bad' },                          // invalid
      { type: 'income', amount: 100, date: '2024-02-01', category: 'salary' }, // valid
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('expense');
    expect(result[1].type).toBe('income');
  });
});

// ==========================================
// buildCsvContent
// ==========================================

describe('buildCsvContent', () => {
  it('produces correct CSV header', () => {
    const csv = buildCsvContent([]);
    expect(csv).toBe('Date,Type,Category,Amount,Description,Tags,Notes,Recurring\n');
  });

  it('outputs transaction fields in correct order', () => {
    const tx = makeTx({
      date: '2024-06-15',
      type: 'expense',
      category: 'food',
      amount: 42.5,
      description: 'lunch',
      tags: 'daily',
      notes: 'quick bite',
      recurring: false,
    });

    const csv = buildCsvContent([tx]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    const row = lines[1];
    expect(row).toContain('"2024-06-15"');
    expect(row).toContain('"expense"');
    expect(row).toContain('"food"');
    expect(row).toContain('"42.5"');
    expect(row).toContain('"lunch"');
  });

  it('escapes commas in descriptions', () => {
    const tx = makeTx({ description: 'Coffee, tea, and snacks' });
    const csv = buildCsvContent([tx]);
    // Commas inside double quotes are safe CSV
    expect(csv).toContain('"Coffee, tea, and snacks"');
  });

  it('escapes double quotes by doubling them', () => {
    const tx = makeTx({ description: 'Said "hello" to vendor' });
    const csv = buildCsvContent([tx]);
    expect(csv).toContain('"Said ""hello"" to vendor"');
  });

  it('protects against formula injection with = prefix', () => {
    const tx = makeTx({ description: '=SUM(A1:A10)' });
    const csv = buildCsvContent([tx]);
    // Should prefix with single quote to neutralize the formula
    expect(csv).toContain("'=SUM(A1:A10)");
  });

  it('protects against formula injection with + prefix', () => {
    const tx = makeTx({ description: '+cmd|stuff' });
    const csv = buildCsvContent([tx]);
    expect(csv).toContain("'+cmd|stuff");
  });

  it('protects against formula injection with - prefix', () => {
    const tx = makeTx({ description: '-cmd|stuff' });
    const csv = buildCsvContent([tx]);
    expect(csv).toContain("'-cmd|stuff");
  });

  it('protects against formula injection with @ prefix', () => {
    const tx = makeTx({ description: '@SUM(A1)' });
    const csv = buildCsvContent([tx]);
    expect(csv).toContain("'@SUM(A1)");
  });

  it('handles recurring transactions', () => {
    const tx = makeTx({ recurring: true, recurring_type: 'monthly' });
    const csv = buildCsvContent([tx]);
    expect(csv).toContain('"monthly"');
  });

  it('outputs empty string for non-recurring transactions in recurring column', () => {
    const tx = makeTx({ recurring: false });
    const csv = buildCsvContent([tx]);
    // Last field should be empty string wrapped in quotes
    const lines = csv.split('\n');
    const lastField = lines[1].split(',').pop();
    expect(lastField).toBe('""');
  });

  it('handles multiple transactions', () => {
    const txs = [
      makeTx({ description: 'First' }),
      makeTx({ description: 'Second' }),
      makeTx({ description: 'Third' }),
    ];
    const csv = buildCsvContent(txs);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(4); // header + 3 rows
  });
});

// ==========================================
// buildExportData
// ==========================================

describe('buildExportData', () => {
  it('includes all required top-level sections', () => {
    const data = buildExportData();

    expect(data).toHaveProperty('transactions');
    expect(data).toHaveProperty('savingsGoals');
    expect(data).toHaveProperty('savingsContributions');
    expect(data).toHaveProperty('monthlyAllocations');
    expect(data).toHaveProperty('customCategories');
    expect(data).toHaveProperty('currency');
    expect(data).toHaveProperty('achievements');
    expect(data).toHaveProperty('streak');
    expect(data).toHaveProperty('sections');
    expect(data).toHaveProperty('theme');
    expect(data).toHaveProperty('alertPrefs');
    expect(data).toHaveProperty('insightPersonality');
    expect(data).toHaveProperty('debts');
    expect(data).toHaveProperty('rolloverSettings');
    expect(data).toHaveProperty('filterPresets');
    expect(data).toHaveProperty('txTemplates');
    expect(data).toHaveProperty('exportedAt');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('lastBackup');
  });

  it('includes version string', () => {
    const data = buildExportData();
    expect(data.version).toBe('2.6');
  });

  it('includes exportedAt as ISO string', () => {
    const data = buildExportData();
    expect(data.exportedAt).toBeDefined();
    // Should be a valid ISO date string
    expect(() => new Date(data.exportedAt)).not.toThrow();
    expect(new Date(data.exportedAt).toISOString()).toBe(data.exportedAt);
  });

  it('defaults theme to dark when no theme is stored', () => {
    const data = buildExportData();
    expect(data.theme).toBe('dark');
  });
});

// ==========================================
// duplicate-detection.ts: findContentDuplicates
// ==========================================

describe('findContentDuplicates (duplicate-detection module)', () => {
  it('detects exact duplicates by date+amount+category+type+description', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(1);
    expect(result.unique).toHaveLength(0);
  });

  it('does not produce false positives for different amounts', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 75, category: 'food', type: 'expense', description: 'Groceries' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('does not produce false positives for different dates', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-16', amount: 50, category: 'food', type: 'expense' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('does not produce false positives for different categories', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'transport', type: 'expense' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('does not produce false positives for different types', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'income' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('classifies unique items correctly when no match exists', () => {
    const existing = [
      makeTx({ date: '2024-01-01', amount: 100, category: 'bills' }),
    ];
    const incoming = [
      makeTx({ date: '2024-07-01', amount: 200, category: 'entertainment' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.similar).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('flags same-day same-amount records with overlapping description tokens as similar', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 42, category: 'food', type: 'expense', description: 'Coffee Shop Purchase' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 42, category: 'food', type: 'expense', description: 'Coffee Shop Morning' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(0);
    expect(result.similar).toHaveLength(1);
    expect(result.unique).toHaveLength(0);
  });

  it('handles empty existing array', () => {
    const incoming = [makeTx()];
    const result = findContentDuplicates(incoming, []);
    expect(result.exact).toHaveLength(0);
    expect(result.unique).toHaveLength(1);
  });

  it('handles empty incoming array', () => {
    const existing = [makeTx()];
    const result = findContentDuplicates([], existing);
    expect(result.exact).toHaveLength(0);
    expect(result.similar).toHaveLength(0);
    expect(result.unique).toHaveLength(0);
  });

  it('detects multiple exact duplicates in a batch', () => {
    const existing = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'A' }),
      makeTx({ date: '2024-06-16', amount: 30, category: 'transport', description: 'B' }),
    ];
    const incoming = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'A' }),
      makeTx({ date: '2024-06-16', amount: 30, category: 'transport', description: 'B' }),
      makeTx({ date: '2024-06-17', amount: 10, category: 'bills', description: 'C' }),
    ];

    const result = findContentDuplicates(incoming, existing);
    expect(result.exact).toHaveLength(2);
    expect(result.unique).toHaveLength(1);
  });
});

// ==========================================
// duplicate-detection.ts: findFuzzyDuplicates
// ==========================================

describe('findFuzzyDuplicates', () => {
  it('groups transactions with the same fuzzy key (same month, type, category, amount, similar desc)', () => {
    const txs = [
      makeTx({ date: '2024-06-10', amount: 50, category: 'food', type: 'expense', description: 'Groceries from store' }),
      makeTx({ date: '2024-06-20', amount: 50, category: 'food', type: 'expense', description: 'Groceries from store' }),
    ];

    const result = findFuzzyDuplicates(txs);
    // Both should be grouped under the same fuzzy key (same month, same amount, same desc prefix)
    expect(result.size).toBeGreaterThanOrEqual(1);
    const groups = Array.from(result.values());
    const matchingGroup = groups.find(g => g.length === 2);
    expect(matchingGroup).toBeDefined();
  });

  it('does not group transactions with different amounts', () => {
    const txs = [
      makeTx({ date: '2024-06-01', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
      makeTx({ date: '2024-06-15', amount: 100, category: 'food', type: 'expense', description: 'Groceries' }),
    ];

    const result = findFuzzyDuplicates(txs);
    // Different amounts -> different fuzzy keys -> no group with length > 1
    const groups = Array.from(result.values());
    const multiGroup = groups.find(g => g.length > 1);
    expect(multiGroup).toBeUndefined();
  });

  it('does not group transactions in different months', () => {
    const txs = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
      makeTx({ date: '2024-08-15', amount: 50, category: 'food', type: 'expense', description: 'Groceries' }),
    ];

    const result = findFuzzyDuplicates(txs);
    const groups = Array.from(result.values());
    const multiGroup = groups.find(g => g.length > 1);
    expect(multiGroup).toBeUndefined();
  });

  it('returns empty map for single transactions (no duplicates possible)', () => {
    const txs = [makeTx()];
    const result = findFuzzyDuplicates(txs);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    const result = findFuzzyDuplicates([]);
    expect(result.size).toBe(0);
  });
});

// ==========================================
// duplicate-detection.ts: deduplicateExact
// ==========================================

describe('deduplicateExact', () => {
  it('removes exact duplicates and keeps the first occurrence', () => {
    const tx1 = makeTx({ __backendId: 'a', date: '2024-06-15', amount: 50, category: 'food', description: 'Groceries' });
    const tx2 = makeTx({ __backendId: 'b', date: '2024-06-15', amount: 50, category: 'food', description: 'Groceries' });

    const result = deduplicateExact([tx1, tx2]);
    expect(result).toHaveLength(1);
    expect(result[0].__backendId).toBe('a'); // first occurrence kept
  });

  it('preserves unique items', () => {
    const txs = [
      makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'A' }),
      makeTx({ date: '2024-06-16', amount: 30, category: 'transport', description: 'B' }),
      makeTx({ date: '2024-06-17', amount: 20, category: 'bills', description: 'C' }),
    ];

    const result = deduplicateExact(txs);
    expect(result).toHaveLength(3);
  });

  it('handles empty array', () => {
    const result = deduplicateExact([]);
    expect(result).toHaveLength(0);
  });

  it('removes multiple copies of the same transaction', () => {
    const base = makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'Same' });
    const txs = [
      { ...base, __backendId: 'id1' },
      { ...base, __backendId: 'id2' },
      { ...base, __backendId: 'id3' },
    ];

    const result = deduplicateExact(txs);
    expect(result).toHaveLength(1);
  });

  it('correctly distinguishes transactions that differ only in amount', () => {
    const txs = [
      makeTx({ date: '2024-06-15', amount: 50.00, category: 'food', description: 'Lunch' }),
      makeTx({ date: '2024-06-15', amount: 50.01, category: 'food', description: 'Lunch' }),
    ];

    const result = deduplicateExact(txs);
    expect(result).toHaveLength(2);
  });
});

// ==========================================
// duplicate-detection.ts: excludeDuplicates
// ==========================================

describe('excludeDuplicates', () => {
  it('filters out items that match the duplicates list', () => {
    const dup = makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'Groceries' });
    const unique = makeTx({ date: '2024-06-16', amount: 30, category: 'transport', description: 'Bus' });

    const all = [dup, unique];
    const duplicates = [dup];

    const result = excludeDuplicates(all, duplicates);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Bus');
  });

  it('returns all transactions when duplicates list is empty', () => {
    const txs = [makeTx({ description: 'A' }), makeTx({ description: 'B' })];
    const result = excludeDuplicates(txs, []);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when all transactions are duplicates', () => {
    const tx = makeTx({ date: '2024-06-15', amount: 50, category: 'food', description: 'Same' });
    const result = excludeDuplicates([tx], [tx]);
    expect(result).toHaveLength(0);
  });

  it('matches by content, not by reference or __backendId', () => {
    const tx1 = makeTx({ __backendId: 'id1', date: '2024-06-15', amount: 50, category: 'food', description: 'X' });
    const tx2 = makeTx({ __backendId: 'id2', date: '2024-06-15', amount: 50, category: 'food', description: 'X' });

    // tx2 has same content as tx1 but different __backendId
    // excludeDuplicates uses getExactKey which is based on content fields, not __backendId
    const result = excludeDuplicates([tx1], [tx2]);
    expect(result).toHaveLength(0);
  });

  it('handles empty source array', () => {
    const duplicates = [makeTx()];
    const result = excludeDuplicates([], duplicates);
    expect(result).toHaveLength(0);
  });
});
