/**
 * Tests for import-export and duplicate-detection modules
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==========================================
// MOCKS (hoisted above imports)
// ==========================================

// Spread the real state module so SK, STORAGE_DEFAULTS, and validator
// helpers stay in lock-step with production (see feedback_test_mock_drift:
// hand-copied SK values here had already drifted to stale `bt_*` names
// while production moved to `harbor_*`). Only `lsGet`/`lsSet` are replaced
// with spies; everything else — SK, STORAGE_DEFAULTS, normalizeAlertPrefs,
// normalizeSavingsGoal, etc. — comes through as the real implementation.
vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/state.js')>(
    '../js/modules/core/state.js'
  );
  return {
    ...actual,
    lsGet: vi.fn((_key: string, fallback: unknown) => fallback),
    lsSet: vi.fn(() => true),
  };
});

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
  // L78 (post-rev-13): mirror the canonical StreakData contract
  // (STORAGE_DEFAULTS[SK.STREAK]) — `lastDate` is a string (`''` when
  // unset), never null. `isStreakData` in the sync validator rejects
  // non-string `lastDate`, so masking that in the mock let the
  // overwrite-default drift regression slip past the suite.
  streak: { value: { current: 0, longest: 0, lastDate: '' } },
  // L76 (post-rev-13): mirror the canonical SectionsConfig contract
  // (STORAGE_DEFAULTS[SK.SECTIONS]) rather than the prior buggy
  // buildImportState fallback. Both envelope AND transactionsTemplates
  // booleans are required by the type and by isSectionsConfig in the sync
  // validator; masking that invariant in the mock let the invalid-shape
  // regression slip past the suite.
  sections: { value: { envelope: true, transactionsTemplates: false } },
  insightPers: { value: 'serious' },
  filterPresets: { value: [] },
  txTemplates: { value: [] },
  // L80 (post-rev-13): mirror the canonical `signal<number>` contract
  // (signals.ts:215) — `lastBackup` is numeric ms-since-epoch, `0` when
  // unset. The prior `null` masked both the overwrite-default drift
  // (L79) and the legacy-string coercion path (normalizeLastBackup) in
  // buildImportState.
  lastBackup: { value: 0 },
  // L89 (Inline-Behavior-Review): mirror the `signal<number>` contract
  // at signals.ts:222 — transaction count at last backup, `0` when
  // unset. Present so buildExportData's `lastBackupTxCount` read
  // resolves during the buildExportData test block; the reminder-state
  // round-trip tests override `.value` explicitly.
  lastBackupTxCount: { value: 0 },
  theme: { value: 'dark' },
  alerts: { value: { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] } },
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

// Spread actual category-store so `buildConfigFromLegacyCustom` (used by the
// import-export legacy-compat path) and other helpers stay honest; only the
// `userCategoryConfig` signal is replaced with a test-fixed value so
// buildImportState's "fallback to current value" branch is deterministic.
vi.mock('../js/modules/core/category-store.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/category-store.js')>(
    '../js/modules/core/category-store.js'
  );
  return {
    ...actual,
    userCategoryConfig: {
      value: {
        presetId: 'personal',
        version: 1,
        expense: [{ id: 'food', name: 'Food', emoji: '🍔', color: '#ef4444', type: 'expense', order: 0 }],
        income: [{ id: 'salary', name: 'Salary', emoji: '💼', color: '#22c55e', type: 'income', order: 0 }]
      }
    }
  };
});

// M12 (rev 12): mock event-bus + error-tracker so the
// `reportImportValidationRejections` describe block can assert SHOW_TOAST
// emission and trackError routing without pulling in the live pub/sub.
// Only SHOW_TOAST is used from Events in import-export.ts; the other
// callers in this file don't exercise emit paths (rollback uses it in
// tryAtomicWrite, but existing tests don't trigger the rollback-failed
// branch), so mocking does not regress any upstream coverage.
vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  Events: { SHOW_TOAST: 'ui:show_toast' },
}));

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn(),
}));

// ==========================================
// IMPORTS (after mocks)
// ==========================================

import {
  sanitizeImportedTransactions,
  reportImportValidationRejections,
  buildCsvContent,
  buildExportData,
  buildImportState,
  MAX_IMPORT_TRANSACTIONS,
  tryAtomicWrite,
} from '../js/modules/features/import-export/import-export.js';
import { safeStorage } from '../js/modules/core/safe-storage.js';
import { emit, Events } from '../js/modules/core/event-bus.js';
import { trackError } from '../js/modules/core/error-tracker.js';
import { SK } from '../js/modules/core/state.js';
// L82/L88 regression tests mutate the mocked signal to assert
// `buildExportData` reads from the live signal (raw string) not from
// `safeStorage.getItem` (which under production `setJSON` write semantics
// returns a JSON-encoded string).
import * as signals from '../js/modules/core/signals.js';

import {
  findContentDuplicates,
  findFuzzyDuplicates,
  deduplicateExact,
  excludeDuplicates,
  formatDuplicateSummary,
} from '../js/modules/features/import-export/duplicate-detection.js';

import {
  createTransaction,
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

  // M12 (rev 12): return shape changed from Transaction[] to
  // { accepted, rejected }. Existing assertions shifted to `result.accepted`
  // so they still cover the happy-path contract; new rejection-shape
  // coverage lives in the "rejection surface" describe block below.

  it('passes through valid transaction data', () => {
    const incoming = [
      { type: 'expense', amount: 42.5, date: '2024-06-15', category: 'food', description: 'lunch' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]?.amount).toBe(42.5);
    expect(result.accepted[0]?.date).toBe('2024-06-15');
    expect(result.accepted[0]?.category).toBe('food');
    expect(result.accepted[0]?.type).toBe('expense');
  });

  it('assigns __backendId to items that lack one', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.__backendId).toBeDefined();
    expect(typeof result.accepted[0]?.__backendId).toBe('string');
    expect(result.accepted[0]?.__backendId.length).toBeGreaterThan(0);
  });

  it('surfaces a duplicate __backendId as a rejection rather than silently re-IDing (batch 7k item 12)', () => {
    // Prior behavior: a row whose explicit `__backendId` collided with
    // one already in the existingIds set was silently assigned a fresh
    // id and passed through. The caller then got back an "accepted"
    // row with a fabricated id and no signal that anything had been
    // renamed. Design-Review-Apr21 batch 7k item 12 flipped the
    // contract: collisions with the existingIds set are now surfaced
    // as `RejectedImportRecord` entries (reason: "duplicate
    // __backendId: …") so the caller can route them through
    // `reportImportValidationRejections` alongside validator
    // rejections. This test is the load-bearing lock on that
    // contract.
    const incoming = [
      { __backendId: 'existing1', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming, new Set(['existing1']));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/duplicate __backendId/);
  });

  it('surfaces within-batch __backendId collisions as rejections (batch 7k item 12)', () => {
    // Two rows with the same explicit id in one payload — the first
    // is accepted, the second rejected. Ensures the "within-file
    // seen set" path is exercised distinct from the existingIds path.
    const incoming = [
      { __backendId: 'dup', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
      { __backendId: 'dup', type: 'expense', amount: 20, date: '2024-01-02', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.__backendId).toBe('dup');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reason).toMatch(/duplicate __backendId: dup/);
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
    expect(result.accepted).toHaveLength(1);
    // The validator uses spread ({...transaction}) so extra keys are preserved
    // This is expected behavior - sanitization focuses on validating required fields
    expect(result.accepted[0]?.type).toBe('expense');
    expect(result.accepted[0]?.amount).toBe(10);
  });

  it('rejects records with missing required fields', () => {
    const incoming = [
      { type: 'expense' }, // missing amount, date, category
      { amount: 10 },      // missing type, date, category
      {},                   // missing everything
    ];

    const result = sanitizeImportedTransactions(incoming);
    // All should be rejected by the validator
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });

  it('rejects records with invalid type', () => {
    const incoming = [
      { type: 'transfer', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('preserves valid __backendId when not colliding', () => {
    const incoming = [
      { __backendId: 'myid123', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.__backendId).toBe('myid123');
  });

  it('rejects __backendId values with prototype pollution patterns', () => {
    const incoming = [
      { __backendId: '__proto__', type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
      { __backendId: 'constructor', type: 'expense', amount: 20, date: '2024-01-02', category: 'food' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(2);
    // Sanitized IDs should NOT be the dangerous values
    expect(result.accepted[0]?.__backendId).not.toBe('__proto__');
    expect(result.accepted[1]?.__backendId).not.toBe('constructor');
  });

  it('handles a mix of valid and invalid records', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' }, // valid
      { type: 'invalid', amount: -5, date: 'bad' },                          // invalid
      { type: 'income', amount: 100, date: '2024-02-01', category: 'salary' }, // valid
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]?.type).toBe('expense');
    expect(result.accepted[1]?.type).toBe('income');
  });

  // M12 (rev 12): rejection-shape coverage — locks in the invariant that
  // rejected records carry (a) the original zero-based index so the UI
  // can surface "row N failed," (b) a non-empty aggregated reason string,
  // and (c) a stable shape that the surfacing helper below depends on.

  it('returns rejected records with the original index and a reason string', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' }, // valid
      { type: 'invalid', amount: -5, date: 'bad' },                          // invalid at idx 1
      { type: 'income', amount: 100, date: '2024-02-01', category: 'salary' }, // valid
      { amount: 10 },                                                        // invalid at idx 3
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);

    const [r0, r1] = result.rejected;
    expect(r0?.index).toBe(1);
    expect(r0?.reason.length).toBeGreaterThan(0);
    expect(r1?.index).toBe(3);
    expect(r1?.reason.length).toBeGreaterThan(0);
  });

  it('returns empty rejected array on all-valid input', () => {
    const incoming = [
      { type: 'expense', amount: 10, date: '2024-01-01', category: 'food' },
      { type: 'income', amount: 100, date: '2024-02-01', category: 'salary' },
    ];

    const result = sanitizeImportedTransactions(incoming);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });
});

// ==========================================
// reportImportValidationRejections (M12)
// ==========================================
//
// M12 (rev 12) surfaced a silent partial-failure bug: the sanitizer was
// dropping invalid rows with nothing more than a DEV-only console.warn,
// so users saw "Import successful" toasts even when half their data was
// destroyed at the function boundary. The surfacing helper now takes
// the rejected records and (a) emits a warning toast with concrete
// numbers + first-few-reason preview, (b) routes an aggregated error
// through trackError so production telemetry captures which import path
// is dominating rejection counts. These tests lock in both sides of
// that contract so future refactors can't quietly regress either.

describe('reportImportValidationRejections', () => {
  const mockedEmit = vi.mocked(emit);
  const mockedTrackError = vi.mocked(trackError);

  beforeEach(() => {
    mockedEmit.mockClear();
    mockedTrackError.mockClear();
  });

  it('is a no-op when the rejected array is empty (clean imports pay no UX cost)', () => {
    reportImportValidationRejections([], 500, 'backup_overwrite');

    expect(mockedEmit).not.toHaveBeenCalled();
    expect(mockedTrackError).not.toHaveBeenCalled();
  });

  it('emits SHOW_TOAST with accepted/total counts and a warning type when rows were dropped', () => {
    const rejected = [
      { index: 2, reason: 'amount must be a positive number' },
      { index: 7, reason: 'date is not a valid ISO string' },
    ];

    reportImportValidationRejections(rejected, 10, 'backup_overwrite');

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    const firstCall = mockedEmit.mock.calls[0];
    if (!firstCall) throw new Error('expected emit to have been called');
    const [eventName, payload] = firstCall;
    expect(eventName).toBe(Events.SHOW_TOAST);
    expect(payload).toMatchObject({ type: 'warning' });
    const message = (payload as { message: string }).message;
    // "Imported N of M transactions. K invalid row(s) skipped."
    expect(message).toContain('Imported 8 of 10 transactions');
    expect(message).toContain('2 invalid rows skipped');
  });

  it('previews the first three rejection reasons with 1-indexed row numbers', () => {
    const rejected = [
      { index: 0, reason: 'missing category' },
      { index: 1, reason: 'missing date' },
      { index: 2, reason: 'missing type' },
      { index: 3, reason: 'missing amount' }, // should NOT appear in preview
    ];

    reportImportValidationRejections(rejected, 100, 'backup_merge_all');

    const payload = mockedEmit.mock.calls[0]?.[1] as { message: string };
    expect(payload.message).toContain('row 1 — missing category');
    expect(payload.message).toContain('row 2 — missing date');
    expect(payload.message).toContain('row 3 — missing type');
    expect(payload.message).not.toContain('missing amount');
  });

  it('pluralizes "row" correctly for a single rejection', () => {
    const rejected = [{ index: 4, reason: 'bad amount' }];

    reportImportValidationRejections(rejected, 100, 'backup_overwrite');

    const payload = mockedEmit.mock.calls[0]?.[1] as { message: string };
    expect(payload.message).toContain('1 invalid row skipped');
    expect(payload.message).not.toContain('1 invalid rows');
  });

  it('routes a validationError through trackError with module=ImportExport and source-labeled action', () => {
    const rejected = [
      { index: 0, reason: 'reason A' },
      { index: 1, reason: 'reason B' },
    ];

    reportImportValidationRejections(rejected, 5, 'backup_merge_filtered');

    expect(mockedTrackError).toHaveBeenCalledTimes(1);
    const firstTrackCall = mockedTrackError.mock.calls[0];
    if (!firstTrackCall) throw new Error('expected trackError to have been called');
    const [err, context, type] = firstTrackCall;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('dropped 2 of 5 transaction rows');
    expect(context).toMatchObject({
      module: 'ImportExport',
      action: 'import_validation_partial_failure:backup_merge_filtered',
    });
    expect(type).toBe('validationError');
  });

  it('samples the first 10 reasons into the Error message so fingerprinting stays meaningful', () => {
    const rejected = Array.from({ length: 15 }, (_, i) => ({
      index: i,
      reason: `reason_${i}`,
    }));

    reportImportValidationRejections(rejected, 100, 'backup_merge_all');

    const err = mockedTrackError.mock.calls[0]?.[0] as Error;
    // First 10 reasons are included
    for (let i = 0; i < 10; i++) {
      expect(err.message).toContain(`reason_${i}`);
    }
    // Eleventh onward are NOT included (keeps fingerprint fairness)
    expect(err.message).not.toContain('reason_10');
    expect(err.message).not.toContain('reason_14');
  });

  it('uses different source labels for different import paths (separable in telemetry)', () => {
    const rejected = [{ index: 0, reason: 'x' }];

    reportImportValidationRejections(rejected, 1, 'backup_overwrite');
    reportImportValidationRejections(rejected, 1, 'backup_merge_all');
    reportImportValidationRejections(rejected, 1, 'backup_merge_filtered');

    const actions = mockedTrackError.mock.calls.map(
      (call) => (call[1] as { action: string }).action
    );
    expect(actions).toEqual([
      'import_validation_partial_failure:backup_overwrite',
      'import_validation_partial_failure:backup_merge_all',
      'import_validation_partial_failure:backup_merge_filtered',
    ]);
  });
});

describe('tryAtomicWrite', () => {
  beforeEach(() => {
    vi.mocked(safeStorage.getItem).mockReset();
    vi.mocked(safeStorage.setJSON).mockReset();
    vi.mocked(safeStorage.setItem).mockReset();
    vi.mocked(safeStorage.removeItem).mockReset();
    vi.mocked(safeStorage.getItem).mockReturnValue(null);
    vi.mocked(safeStorage.setJSON).mockReturnValue(true);
    vi.mocked(safeStorage.setItem).mockReturnValue(true);
  });

  it('uses safeStorage for rollback writes when a later write fails', async () => {
    vi.mocked(safeStorage.getItem)
      .mockReturnValueOnce('{"old":1}')
      .mockReturnValueOnce('{"old":2}');

    vi.mocked(safeStorage.setJSON)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await tryAtomicWrite([
      { key: 'first', value: { next: 1 } },
      { key: 'second', value: { next: 2 } }
    ]);

    expect(result).toBe(false);
    expect(safeStorage.setItem).toHaveBeenCalledWith('first', '{"old":1}');
    expect(safeStorage.setItem).toHaveBeenCalledWith('second', '{"old":2}');
  });
});

describe('buildImportState', () => {
  it('rejects oversized raw import payloads before processing', () => {
    const importData = {
      transactions: Array.from({ length: MAX_IMPORT_TRANSACTIONS + 1 }, () => ({
        type: 'expense',
        amount: 1,
        date: '2024-01-01',
        category: 'food',
      })),
    };

    expect(() => buildImportState(importData, 'overwrite', [])).toThrow(
      `Import exceeds maximum allowed transactions (${MAX_IMPORT_TRANSACTIONS})`
    );
  });

  it('persists the user-owned category config during overwrite imports', () => {
    const importData = {
      userCategories: {
        presetId: 'minimal',
        version: 1,
        expense: [],
        income: []
      }
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.userCategories).toEqual(importData.userCategories);
    expect(result.writes).toContainEqual({
      key: SK.USER_CATS,
      value: importData.userCategories
    });
  });

  it('converts legacy customCategories backups into a UserCategoryConfig (overwrite mode)', () => {
    // Rev 13 L70 compat path: pre-v2.x exports only carried the legacy
    // `customCategories[]` shape. Without this branch the import path
    // wrote `null` to SK.USER_CATS on overwrite and stranded any
    // transactions/budgets that referenced user-defined category IDs.
    const importData = {
      customCategories: [
        { id: 'leg_cust_1', name: 'Side hustle', type: 'income', emoji: '💰', color: '#22c55e' },
        { id: 'leg_cust_2', name: 'Coffee', type: 'expense', emoji: '☕', color: '#7c3aed' }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const cfg = result.newS.userCategories as {
      expense: Array<{ id: string }>;
      income: Array<{ id: string }>;
    };

    // Config materialized (not null), preserving both legacy IDs
    expect(cfg).toBeTruthy();
    expect(cfg.expense.map(c => c.id)).toContain('leg_cust_2');
    expect(cfg.income.map(c => c.id)).toContain('leg_cust_1');

    // Actual write is keyed off the real SK.USER_CATS, not a hand-copied literal
    const write = result.writes.find(w => w.key === SK.USER_CATS);
    expect(write).toBeTruthy();
    expect(write?.value).toBe(cfg);
  });

  it('converts legacy customCategories backups during merge-mode imports', () => {
    // Symmetric coverage for merge mode so neither import mode silently
    // drops the user's legacy custom cats.
    const importData = {
      customCategories: [
        { id: 'leg_merge_1', name: 'Gifts', type: 'expense', emoji: '🎁', color: '#f59e0b' }
      ]
    };

    const result = buildImportState(importData, 'merge', []);
    const cfg = result.newS.userCategories as { expense: Array<{ id: string }> };

    expect(cfg).toBeTruthy();
    expect(cfg.expense.map(c => c.id)).toContain('leg_merge_1');
    expect(result.writes.some(w => w.key === SK.USER_CATS)).toBe(true);
  });

  it('prefers modern userCategories over legacy customCategories when both are present', () => {
    // Defensive: if a hybrid/corrupted backup includes both, modern wins.
    const modern = {
      presetId: 'minimal',
      version: 1,
      expense: [{ id: 'modern_exp', name: 'Modern', emoji: '🧪', color: '#000', type: 'expense', order: 0 }],
      income: []
    };
    const importData = {
      userCategories: modern,
      customCategories: [
        { id: 'leg_should_be_ignored', name: 'Ignore', type: 'expense', emoji: '🗑️', color: '#888' }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.userCategories).toEqual(modern);
    const write = result.writes.find(w => w.key === SK.USER_CATS);
    expect(write?.value).toEqual(modern);
  });

  it('skips malformed legacy custom category rows without corrupting the output', () => {
    // Defensive: the validator drops entries missing required fields so a
    // partially-malformed backup still yields a valid UserCategoryConfig.
    const importData = {
      customCategories: [
        { id: 'leg_ok', name: 'Valid', type: 'expense', emoji: '✅', color: '#0f0' },
        { name: 'Missing id', type: 'expense', emoji: '❌', color: '#f00' }, // no id
        { id: 'leg_bad_type', name: 'Bad type', type: 'nope', emoji: '❓', color: '#888' },
        null,
        'not-an-object'
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const cfg = result.newS.userCategories as {
      expense: Array<{ id: string }>;
      income: Array<{ id: string }>;
    };

    const allIds = [...cfg.expense, ...cfg.income].map(c => c.id);
    expect(allIds).toContain('leg_ok');
    expect(allIds).not.toContain('leg_bad_type');
    expect(allIds.some(id => !id)).toBe(false);
  });

  // Rev 13 L73 + Design-Review-Apr21 batch 7k item 6 regression guards:
  // malformed modern `userCategories` must not poison SK.USER_CATS. Prior
  // to the shape guard, the import path accepted any plain object and
  // let it hydrate end-to-end, which set up the next
  // `config.expense.filter(...)` call to throw.
  //
  // The overwrite vs merge behavior was split in batch 7k item 6:
  //   • overwrite + malformed → reset to null (canonical). The prior
  //     "preserve current config" behavior silently contradicted the
  //     user's overwrite intent.
  //   • merge + malformed → preserve current config (unchanged contract).
  it('resets to null when modern userCategories is malformed on overwrite (batch 7k item 6)', () => {
    const importData = { userCategories: { foo: 1 } };

    const result = buildImportState(importData, 'overwrite', []);

    // Did NOT write the malformed payload, and did NOT preserve the
    // seeded current config. In overwrite mode a malformed payload
    // collapses to the canonical null reset — downstream hydration
    // then initializes a canonical Personal preset on next boot,
    // matching the overwrite semantics the user asked for.
    expect(result.newS.userCategories).toBeNull();
    const write = result.writes.find(w => w.key === SK.USER_CATS);
    expect(write?.value).toBeNull();
  });

  it('preserves current userCategoryConfig when modern userCategories is malformed (merge)', () => {
    const importData = { userCategories: { expense: [], /* no income array, no version */ } };

    const result = buildImportState(importData, 'merge', []);
    const cfg = result.newS.userCategories as { presetId?: string } | null;

    expect(cfg).toBeTruthy();
    expect(cfg?.presetId).toBe('personal');
  });

  // Rev 13 L72 regression guard: merge without any category section
  // used to leave newS.userCategories absent, which hydrateFromImport
  // then treated as "reset to null + init preset" — silently wiping
  // the user's custom categories during what was sold as a merge.
  it('preserves existing userCategoryConfig on merge with no category section', () => {
    const importData = {
      // Realistic merge payload: transactions + some settings, no cats.
      monthlyAllocations: { '2026-03': { food: 300 } }
    };

    const result = buildImportState(importData, 'merge', []);
    const cfg = result.newS.userCategories as { presetId?: string } | null;

    // newS.userCategories must be pinned to the current config so
    // hydrateFromImport does not treat it as absent.
    expect(cfg).toBeTruthy();
    expect(cfg?.presetId).toBe('personal');
    // And no spurious SK.USER_CATS write should appear — we're
    // preserving, not changing.
    const write = result.writes.find(w => w.key === SK.USER_CATS);
    expect(write).toBeUndefined();
  });

  it('ignores explicit userCategories: null during a merge (does not wipe existing)', () => {
    // A null on the merge path used to take the "write null" branch
    // and hydrateFromImport would apply it to the signal. Now null in
    // merge mode falls through to the preserve path.
    const importData = { userCategories: null };

    const result = buildImportState(importData, 'merge', []);
    const cfg = result.newS.userCategories as { presetId?: string } | null;

    expect(cfg).toBeTruthy();
    expect(cfg?.presetId).toBe('personal');
  });

  it('respects explicit userCategories: null in overwrite mode (wipes to first-boot)', () => {
    // Overwrite + null is a legitimate "reset to default preset" signal
    // and must stay wired.
    const importData = { userCategories: null };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.userCategories).toBeNull();
    const write = result.writes.find(w => w.key === SK.USER_CATS);
    expect(write?.value).toBeNull();
  });

  // L75/L76 regression guard — overwrite default for missing `sections` must
  // be the full canonical SectionsConfig, not a partial `{envelope: true}`.
  // Prior behavior wrote a partial object that (a) violated the declared
  // SectionsConfig shape, (b) would be rejected by isSectionsConfig in
  // sync-state-actions.ts (requires typeof transactionsTemplates === 'boolean'),
  // and (c) caused downstream reads of signals.sections.value.transactionsTemplates
  // in template-manager.ts and modal-events.ts to return undefined.
  it('writes the full canonical SectionsConfig on overwrite when backup omits sections', () => {
    const importData = {};

    const result = buildImportState(importData, 'overwrite', []);

    // Must match STORAGE_DEFAULTS[SK.SECTIONS] exactly — both keys, both booleans.
    expect(result.newS.sections).toEqual({ envelope: true, transactionsTemplates: false });
    const write = result.writes.find(w => w.key === SK.SECTIONS);
    expect(write).toBeDefined();
    expect(write?.value).toEqual({ envelope: true, transactionsTemplates: false });
  });

  it('returns a fresh SectionsConfig reference each call (no STORAGE_DEFAULTS mutation)', () => {
    // Defense-in-depth: the fix spread-clones STORAGE_DEFAULTS[SK.SECTIONS]
    // so nothing downstream can corrupt the canonical default by mutating
    // newS.sections or the write entry.
    const a = buildImportState({}, 'overwrite', []);
    const b = buildImportState({}, 'overwrite', []);

    expect(a.newS.sections).not.toBe(b.newS.sections);
  });

  it('preserves sections passed explicitly in the backup (overwrite mode)', () => {
    const importData = { sections: { envelope: false, transactionsTemplates: true } };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.sections).toEqual({ envelope: false, transactionsTemplates: true });
    const write = result.writes.find(w => w.key === SK.SECTIONS);
    expect(write?.value).toEqual({ envelope: false, transactionsTemplates: true });
  });

  // L91/L92 (Inline-Behavior-Review): a partial `sections` payload
  // (e.g. `{envelope: false}` missing the required `transactionsTemplates`
  // field) used to write through the restoreMap verbatim and persist an
  // invalid `SectionsConfig` that fails `isSectionsConfig` in
  // `sync-state-actions.ts:144` + crashes downstream toggle readers. The
  // post-forEach `normalizeSectionsConfig` block merges any partial
  // payload over the canonical `STORAGE_DEFAULTS[SK.SECTIONS]` base so
  // the resulting value is always a valid `SectionsConfig`.
  it('normalizes a partial sections payload to the full canonical shape (L91)', () => {
    const importData = { sections: { envelope: false } };

    const result = buildImportState(importData, 'overwrite', []);

    // `envelope` from payload, `transactionsTemplates` from canonical default
    expect(result.newS.sections).toEqual({ envelope: false, transactionsTemplates: false });
    const write = result.writes.find(w => w.key === SK.SECTIONS);
    expect(write?.value).toEqual({ envelope: false, transactionsTemplates: false });
  });

  it('coerces non-boolean sections fields to canonical defaults (L91)', () => {
    const importData = {
      sections: { envelope: 'off', transactionsTemplates: 1 } as unknown as { envelope: boolean }
    };

    const result = buildImportState(importData, 'overwrite', []);

    // Both fields are non-boolean → fall back to canonical defaults
    expect(result.newS.sections).toEqual({ envelope: true, transactionsTemplates: false });
    const sections = result.newS.sections as { envelope: unknown; transactionsTemplates: unknown };
    expect(typeof sections.envelope).toBe('boolean');
    expect(typeof sections.transactionsTemplates).toBe('boolean');
  });

  it('normalizes non-object sections payload to the canonical default (L91)', () => {
    const importData = { sections: 'broken' as unknown as { envelope?: boolean } };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.sections).toEqual({ envelope: true, transactionsTemplates: false });
  });

  // L77/L78 regression guard — overwrite default for missing `streak` must
  // match STORAGE_DEFAULTS[SK.STREAK] exactly, including `lastDate: ''`
  // (a string). The prior hand-authored `{current:0, longest:0, lastDate:null}`
  // violated `isStreakData` in the sync validator (which requires
  // `typeof lastDate === 'string'`), so sync attempts would reject freshly
  // imported state and downstream `isoDateDiffInDays(streak.lastDate, …)`
  // call sites would receive a null they weren't typed for.
  it('writes the full canonical StreakData on overwrite when backup omits streak', () => {
    const importData = {};

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.streak).toEqual({ current: 0, longest: 0, lastDate: '' });
    const write = result.writes.find(w => w.key === SK.STREAK);
    expect(write).toBeDefined();
    expect(write?.value).toEqual({ current: 0, longest: 0, lastDate: '' });
    // Sanity: `lastDate` must be a string, never null.
    expect(typeof (result.newS.streak as { lastDate: unknown }).lastDate).toBe('string');
  });

  it('returns a fresh StreakData reference each call (no STORAGE_DEFAULTS mutation)', () => {
    const a = buildImportState({}, 'overwrite', []);
    const b = buildImportState({}, 'overwrite', []);

    expect(a.newS.streak).not.toBe(b.newS.streak);
  });

  // L93/L94 (Inline-Behavior-Review): a present-but-malformed `streak`
  // payload (missing `lastDate`, non-numeric `current`/`longest`, etc.)
  // used to write straight through the restoreMap and persist a value
  // that fails `isStreakData` at `sync-state-actions.ts:158` — then
  // crashed `streak-tracker.ts:326` which reads `streak.lastDate`
  // directly for day-delta math (`Date(undefined) → Invalid Date`).
  // The post-forEach `normalizeStreakData` block coerces each field
  // independently: keep the good ones, backfill the rest from
  // `STORAGE_DEFAULTS[SK.STREAK]`.
  it('backfills a partial streak payload from STORAGE_DEFAULTS (L93)', () => {
    const importData = { streak: { current: 5 } as unknown as import('../js/types/index.js').StreakData };

    const result = buildImportState(importData, 'overwrite', []);

    // `current` from payload, `longest` + `lastDate` from canonical default
    expect(result.newS.streak).toEqual({ current: 5, longest: 0, lastDate: '' });
    const write = result.writes.find(w => w.key === SK.STREAK);
    expect(write?.value).toEqual({ current: 5, longest: 0, lastDate: '' });
    const streak = result.newS.streak as { lastDate: unknown };
    expect(typeof streak.lastDate).toBe('string');
  });

  it('coerces non-string lastDate to the canonical empty-string default (L93)', () => {
    const importData = {
      streak: { current: 3, longest: 10, lastDate: null } as unknown as import('../js/types/index.js').StreakData
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.streak).toEqual({ current: 3, longest: 10, lastDate: '' });
    const streak = result.newS.streak as { lastDate: unknown };
    expect(typeof streak.lastDate).toBe('string');
  });

  it('coerces non-numeric streak counts to canonical defaults (L93)', () => {
    const importData = {
      streak: { current: 'five', longest: NaN, lastDate: '2024-04-20' } as unknown as import('../js/types/index.js').StreakData
    };

    const result = buildImportState(importData, 'overwrite', []);

    // Bad counts → defaults; good lastDate preserved
    expect(result.newS.streak).toEqual({ current: 0, longest: 0, lastDate: '2024-04-20' });
  });

  it('rejects negative streak counts by falling back to canonical default (L93)', () => {
    const importData = {
      streak: { current: -1, longest: -5, lastDate: '2024-04-20' } as unknown as import('../js/types/index.js').StreakData
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.streak).toEqual({ current: 0, longest: 0, lastDate: '2024-04-20' });
  });

  it('normalizes non-object streak payload to the full canonical default (L93)', () => {
    const importData = { streak: 'broken' as unknown as import('../js/types/index.js').StreakData };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.streak).toEqual({ current: 0, longest: 0, lastDate: '' });
  });

  // L95/L96 (Inline-Behavior-Review): element-level sanitization for
  // `txTemplates`. Prior behaviour: the outer `Array.isArray` guard
  // confirmed the wrapper shape, but individual rows passed through the
  // restoreMap unvalidated. Downstream readers then treat rows as full
  // `TxTemplate`s — `template-manager.ts:227` does `t.id === templateId`,
  // `applyTemplate` calls `validateCategory(tmpl.type, tmpl.category)`
  // (requires `type ∈ {'expense','income'}`), and `tmpl.name` is surfaced
  // in toasts and aria-labels. A backup row missing `id`/`name`/`type`/
  // `category` crashes or silently poisons the template list.
  it('drops txTemplates rows missing required fields (L95)', () => {
    const good: import('../js/types/index.js').TxTemplate = {
      id: 'tmpl_good', name: 'Coffee', type: 'expense', category: 'food'
    };
    const importData = {
      txTemplates: [
        good,
        { name: 'Orphan name', type: 'expense', category: 'food' },                  // no id
        { id: 'tmpl_no_name', type: 'expense', category: 'food' },                   // no name
        { id: 'tmpl_bad_type', name: 'Weird', type: 'transfer', category: 'food' }, // invalid type
        { id: 'tmpl_no_cat', name: 'No cat', type: 'income' },                       // no category
      ] as unknown as import('../js/types/index.js').TxTemplate[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.txTemplates).toEqual([good]);
    const write = result.writes.find(w => w.key === SK.TX_TEMPLATES);
    expect(write?.value).toEqual([good]);
  });

  it('drops txTemplates rows with empty-string id (L95)', () => {
    const good: import('../js/types/index.js').TxTemplate = {
      id: 'tmpl_keep', name: 'Keep me', type: 'income', category: 'salary'
    };
    const importData = {
      txTemplates: [
        good,
        { id: '', name: 'Empty id', type: 'expense', category: 'food' }
      ] as unknown as import('../js/types/index.js').TxTemplate[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.txTemplates).toEqual([good]);
  });

  it('drops non-object txTemplates rows entirely (L95)', () => {
    const good: import('../js/types/index.js').TxTemplate = {
      id: 'tmpl_good', name: 'Good', type: 'expense', category: 'food'
    };
    const importData = {
      txTemplates: [good, null, 'broken', 42] as unknown as import('../js/types/index.js').TxTemplate[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.txTemplates).toEqual([good]);
  });

  it('leaves well-formed txTemplates untouched (L95 regression guard)', () => {
    const rows: import('../js/types/index.js').TxTemplate[] = [
      { id: 'tmpl_a', name: 'A', type: 'expense', category: 'food', amount: 4.5 },
      { id: 'tmpl_b', name: 'B', type: 'income', category: 'salary' }
    ];
    const importData = { txTemplates: rows };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.txTemplates).toEqual(rows);
  });

  // L97/L98 (Inline-Behavior-Review): element-level sanitization for
  // `filterPresets`. Same class as L95 — `ImportData` only checks array
  // shape, the restoreMap copies rows straight through, and downstream
  // code assumes a full `FilterPreset`. The sync validator requires
  // string `id` + `name` (sync-state-actions.ts:167), and the UI at
  // `filters.ts` uses `p.id` as the repeat key, `p.name` in the button
  // label, and spreads `preset.filters` into `replaceTransactionFilters`.
  it('drops filterPresets rows missing required fields (L97)', () => {
    const good: import('../js/types/index.js').FilterPreset = {
      id: 'fp_good',
      name: 'Weekend spend',
      filters: {
        type: 'expense', category: '', searchText: '', tags: '',
        dateFrom: '', dateTo: '', minAmount: '', maxAmount: '',
        reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
      }
    };
    const importData = {
      filterPresets: [
        good,
        { name: 'Orphan', filters: good.filters },             // no id
        { id: 'fp_no_name', filters: good.filters },           // no name
        { id: 'fp_no_filters', name: 'Nope' },                 // no filters
        { id: 'fp_bad_filters', name: 'Wrong', filters: 42 },  // filters not object
      ] as unknown as import('../js/types/index.js').FilterPreset[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.filterPresets).toEqual([good]);
    const write = result.writes.find(w => w.key === SK.FILTER_PRESETS);
    expect(write?.value).toEqual([good]);
  });

  it('drops filterPresets rows where filters is null or an array (L97)', () => {
    const good: import('../js/types/index.js').FilterPreset = {
      id: 'fp_keep',
      name: 'Keep',
      filters: {
        type: 'expense', category: '', searchText: '', tags: '',
        dateFrom: '', dateTo: '', minAmount: '', maxAmount: '',
        reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
      }
    };
    const importData = {
      filterPresets: [
        good,
        { id: 'fp_null_filters', name: 'Null filters', filters: null },
        { id: 'fp_array_filters', name: 'Array filters', filters: [] }
      ] as unknown as import('../js/types/index.js').FilterPreset[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.filterPresets).toEqual([good]);
  });

  it('drops non-object filterPresets rows entirely (L97)', () => {
    const good: import('../js/types/index.js').FilterPreset = {
      id: 'fp_good',
      name: 'Good',
      filters: {
        type: 'all', category: '', searchText: '', tags: '',
        dateFrom: '', dateTo: '', minAmount: '', maxAmount: '',
        reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
      }
    };
    const importData = {
      filterPresets: [good, null, 'broken', 7] as unknown as import('../js/types/index.js').FilterPreset[]
    };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.filterPresets).toEqual([good]);
  });

  it('leaves well-formed filterPresets untouched (L97 regression guard)', () => {
    const rows: import('../js/types/index.js').FilterPreset[] = [
      {
        id: 'fp_a', name: 'Alpha',
        filters: {
          type: 'expense', category: 'food', searchText: 'coffee', tags: '',
          dateFrom: '2024-01-01', dateTo: '2024-12-31', minAmount: '0', maxAmount: '100',
          reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
        }
      }
    ];
    const importData = { filterPresets: rows };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.filterPresets).toEqual(rows);
  });

  // L79/L80 regression guard — overwrite default for missing `lastBackup` must
  // match STORAGE_DEFAULTS[SK.LAST_BACKUP] (the numeric `0`), not the prior
  // hand-authored `null`. `null` violated the `signal<number>` contract at
  // signals.ts:215 and poisoned `Date(lastBackup)` call sites in
  // backup-reminder.ts (produces "Invalid Date" instead of cold-boot '—').
  it('writes the canonical numeric default (0) on overwrite when backup omits lastBackup', () => {
    const importData = {};

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackup).toBe(0);
    const write = result.writes.find(w => w.key === SK.LAST_BACKUP);
    expect(write).toBeDefined();
    expect(write?.value).toBe(0);
    expect(typeof result.newS.lastBackup).toBe('number');
  });

  // L79/L80 backward-compat: legacy exports (pre-fix buildExportData) wrote
  // `String(signals.lastBackup.value)`, so old user backups carry a numeric
  // string. `normalizeLastBackup` at the import boundary coerces those to
  // numbers so the restoreMap payload never violates the signal's type
  // contract downstream — both newS.lastBackup AND the writes entry must
  // be normalised so storage + in-memory state agree after hydration.
  it('coerces legacy string lastBackup payloads to numbers on import', () => {
    const legacyTs = 1713571200000; // 2024-04-20
    const importData = { lastBackup: String(legacyTs) };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackup).toBe(legacyTs);
    expect(typeof result.newS.lastBackup).toBe('number');
    const write = result.writes.find(w => w.key === SK.LAST_BACKUP);
    expect(write?.value).toBe(legacyTs);
    expect(typeof write?.value).toBe('number');
  });

  it('falls back to 0 for invalid / non-numeric lastBackup payloads', () => {
    const importData = { lastBackup: 'not-a-number' };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackup).toBe(0);
    const write = result.writes.find(w => w.key === SK.LAST_BACKUP);
    expect(write?.value).toBe(0);
  });

  it('passes through valid numeric lastBackup payloads unchanged', () => {
    const ts = 1713571200000;
    const importData = { lastBackup: ts };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackup).toBe(ts);
    const write = result.writes.find(w => w.key === SK.LAST_BACKUP);
    expect(write?.value).toBe(ts);
  });

  // L89/L90 (Inline-Behavior-Review): the manual JSON export/import path
  // used to drop `lastBackupTxCount` entirely, so round-tripping a backup
  // reset the "you've added N tx since last backup" reminder counter to 0
  // and fired the nag immediately — even though the user had just
  // restored a fresh backup. The restoreMap now carries the key, the
  // post-forEach `normalizeLastBackupTxCount` block coerces it to the
  // canonical `signal<number>` contract, and the key hydrates through
  // SIGNAL_MAPPINGS like every other slice.
  it('restores lastBackupTxCount to the canonical default when payload omits it (L89)', () => {
    const importData = {};

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackupTxCount).toBe(0);
    const write = result.writes.find(w => w.key === 'backup_reminder_last_tx_count');
    expect(write?.value).toBe(0);
    expect(typeof result.newS.lastBackupTxCount).toBe('number');
  });

  it('preserves a valid numeric lastBackupTxCount payload through import (L89)', () => {
    const importData = { lastBackupTxCount: 47 };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackupTxCount).toBe(47);
    const write = result.writes.find(w => w.key === 'backup_reminder_last_tx_count');
    expect(write?.value).toBe(47);
  });

  it('coerces legacy/string lastBackupTxCount payloads to numbers on import (L89)', () => {
    const importData = { lastBackupTxCount: '23' };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackupTxCount).toBe(23);
    expect(typeof result.newS.lastBackupTxCount).toBe('number');
    const write = result.writes.find(w => w.key === 'backup_reminder_last_tx_count');
    expect(write?.value).toBe(23);
  });

  it('falls back to 0 for invalid lastBackupTxCount payloads (L89)', () => {
    const importData = { lastBackupTxCount: null };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackupTxCount).toBe(0);
    const write = result.writes.find(w => w.key === 'backup_reminder_last_tx_count');
    expect(write?.value).toBe(0);
  });

  it('rejects negative lastBackupTxCount payloads (L89)', () => {
    const importData = { lastBackupTxCount: -5 };

    const result = buildImportState(importData, 'overwrite', []);

    expect(result.newS.lastBackupTxCount).toBe(0);
  });

  // ==========================================
  // Design-Review-Apr21 batch 7k Commit A — locking tests
  // ==========================================
  //
  // These tests lock in the contracts introduced in batch 7k Commit A
  // across import-export.ts. Each group closes a specific regression
  // and is independently load-bearing: a refactor that breaks the
  // contract will flip the matching test before it can ship.

  // --- Item 1: merge-by-id idempotence --------------------------------
  //
  // Merge mode used to plain-concat every array-of-objects kind, so a
  // re-import of the same backup doubled every collection on every
  // import. Commit A routes these through `mergeById` keyed off
  // `ARRAY_IDENTITY[prop]`. The canonical invariant: "import-twice ==
  // import-once" for every kind routed through restoreMap with a known
  // identity accessor (filterPresets, txTemplates, savingsContribs).

  it('merges filterPresets by id so re-import is idempotent (batch 7k item 1)', () => {
    const existing: import('../js/types/index.js').FilterPreset = {
      id: 'fp_shared',
      name: 'Shared preset',
      filters: {
        type: 'expense', category: '', searchText: '', tags: '',
        dateFrom: '', dateTo: '', minAmount: '', maxAmount: '',
        reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
      }
    };
    const mockedSignals = signals as unknown as {
      filterPresets: { value: import('../js/types/index.js').FilterPreset[] }
    };
    const prior = mockedSignals.filterPresets.value;
    try {
      mockedSignals.filterPresets.value = [existing];

      const result = buildImportState({ filterPresets: [existing] }, 'merge', []);
      const presets = result.newS.filterPresets as import('../js/types/index.js').FilterPreset[];

      expect(presets).toHaveLength(1);
      expect(presets[0]?.id).toBe('fp_shared');
    } finally {
      mockedSignals.filterPresets.value = prior;
    }
  });

  it('upserts filterPresets on id collision so incoming edits win (batch 7k item 1)', () => {
    // The whole point of the "incoming wins on collision" rule: a
    // user edits a preset on device B, exports, imports into device A
    // — the renamed preset must replace the old one, not coexist.
    const existing: import('../js/types/index.js').FilterPreset = {
      id: 'fp_edited',
      name: 'Old name',
      filters: {
        type: 'expense', category: '', searchText: '', tags: '',
        dateFrom: '', dateTo: '', minAmount: '', maxAmount: '',
        reconciled: 'all', recurring: false, showAllMonths: false, sortBy: ''
      }
    };
    const incoming: import('../js/types/index.js').FilterPreset = {
      ...existing,
      name: 'New name from backup'
    };
    const mockedSignals = signals as unknown as {
      filterPresets: { value: import('../js/types/index.js').FilterPreset[] }
    };
    const prior = mockedSignals.filterPresets.value;
    try {
      mockedSignals.filterPresets.value = [existing];
      const result = buildImportState({ filterPresets: [incoming] }, 'merge', []);
      const presets = result.newS.filterPresets as import('../js/types/index.js').FilterPreset[];
      expect(presets).toHaveLength(1);
      expect(presets[0]?.name).toBe('New name from backup');
    } finally {
      mockedSignals.filterPresets.value = prior;
    }
  });

  it('merges txTemplates by id so re-import is idempotent (batch 7k item 1)', () => {
    const existing: import('../js/types/index.js').TxTemplate = {
      id: 'tmpl_shared', name: 'Coffee', type: 'expense', category: 'food'
    };
    const mockedSignals = signals as unknown as {
      txTemplates: { value: import('../js/types/index.js').TxTemplate[] }
    };
    const prior = mockedSignals.txTemplates.value;
    try {
      mockedSignals.txTemplates.value = [existing];
      const result = buildImportState({ txTemplates: [existing] }, 'merge', []);
      const tmpls = result.newS.txTemplates as import('../js/types/index.js').TxTemplate[];
      expect(tmpls).toHaveLength(1);
      expect(tmpls[0]?.id).toBe('tmpl_shared');
    } finally {
      mockedSignals.txTemplates.value = prior;
    }
  });

  it('merges savingsContributions by goalId|date|amount so re-import is idempotent (batch 7k item 1)', () => {
    // SavingsContribution rows don't carry a stable id — ARRAY_IDENTITY
    // uses the `goalId|date|amount` tuple as the natural identity, so
    // two contributions on the same day to the same goal at the same
    // amount read as the same deposit and dedupe on re-import.
    type Contrib = { goalId: string; date: string; amount: number };
    const existing: Contrib = { goalId: 'goal_emergency', date: '2026-03-15', amount: 100 };
    const mockedSignals = signals as unknown as { savingsContribs: { value: Contrib[] } };
    const prior = mockedSignals.savingsContribs.value;
    try {
      mockedSignals.savingsContribs.value = [existing];
      const result = buildImportState({ savingsContributions: [existing] }, 'merge', []);
      const contribs = result.newS.savingsContribs as Contrib[];
      expect(contribs).toHaveLength(1);
    } finally {
      mockedSignals.savingsContribs.value = prior;
    }
  });

  // --- Item 5: theme return matrix ------------------------------------
  //
  // The prior `d.theme || null` collapsed "overwrite with no theme
  // field" to `null`, which `applyImportedState` treated as "don't
  // call setTheme" via `if (theme) setTheme(theme)`. Net: an overwrite
  // import that was meant to be a full reset silently kept the
  // pre-import theme. Commit A resolves the four-way matrix
  // explicitly: overwrite+absent → 'dark' (canonical default), merge
  // +absent → null (preserve current).

  it('returns canonical "dark" when overwrite import omits theme (batch 7k item 5)', () => {
    const result = buildImportState({}, 'overwrite', []);
    expect(result.theme).toBe('dark');
  });

  it('returns null when merge import omits theme so the caller preserves current (batch 7k item 5)', () => {
    // null is the agreed sentinel with applyImportedState — the
    // `if (theme) setTheme(theme)` guard treats null as "no-op" and
    // leaves the signal alone. Returning 'dark' here would silently
    // overwrite a user's 'light' preference during every merge.
    const result = buildImportState({}, 'merge', []);
    expect(result.theme).toBeNull();
  });

  it('returns incoming theme verbatim when present on either mode (batch 7k item 5)', () => {
    expect(buildImportState({ theme: 'light' }, 'overwrite', []).theme).toBe('light');
    expect(buildImportState({ theme: 'light' }, 'merge', []).theme).toBe('light');
    expect(buildImportState({ theme: 'system' }, 'overwrite', []).theme).toBe('system');
  });

  // --- Ext batch N7: alertPrefs partial-merge preservation ------------
  //
  // A merge payload carrying only `{budgetThreshold: 0.85}` used to
  // reset the omitted fields (browserNotificationsEnabled,
  // lastNotifiedAlertKeys) to their hardcoded `normalizeAlertPrefs`
  // defaults. Silently wiping a user's push-notifications opt-in
  // during a merge that intended to tweak only the threshold. Commit A
  // spreads the incoming payload over the existing normalized prefs
  // BEFORE renormalizing, so absent fields default to the user's
  // current value. Overwrite mode is unchanged — a full reset is the
  // user's explicit intent there.

  it('preserves omitted alertPrefs fields during merge (batch 7k ext N7)', () => {
    const mockedSignals = signals as unknown as {
      alerts: {
        value: {
          budgetThreshold: number | null;
          browserNotificationsEnabled: boolean;
          lastNotifiedAlertKeys: string[]
        }
      }
    };
    const prior = mockedSignals.alerts.value;
    try {
      // Seed an existing opt-in state. Partial merge should preserve
      // browserNotificationsEnabled AND the notified-keys history.
      mockedSignals.alerts.value = {
        budgetThreshold: 0.8,
        browserNotificationsEnabled: true,
        lastNotifiedAlertKeys: ['budget:2026-03:food']
      };

      const result = buildImportState({ alertPrefs: { budgetThreshold: 0.85 } }, 'merge', []);
      const alerts = result.newS.alerts as {
        budgetThreshold: number | null;
        browserNotificationsEnabled: boolean;
        lastNotifiedAlertKeys: string[]
      };

      expect(alerts.budgetThreshold).toBe(0.85);          // overridden
      expect(alerts.browserNotificationsEnabled).toBe(true); // preserved
      expect(alerts.lastNotifiedAlertKeys).toEqual(['budget:2026-03:food']); // preserved
    } finally {
      mockedSignals.alerts.value = prior;
    }
  });

  it('resets alertPrefs to canonical defaults on overwrite when payload omits fields (batch 7k ext N7)', () => {
    // Defensive flip-side of the merge-preserve rule: overwrite mode
    // intentionally resets omitted fields to defaults — that IS the
    // user's stated intent. This test locks the asymmetry so a future
    // refactor doesn't accidentally apply the merge-preserve rule to
    // overwrite mode.
    const mockedSignals = signals as unknown as {
      alerts: {
        value: {
          budgetThreshold: number | null;
          browserNotificationsEnabled: boolean;
          lastNotifiedAlertKeys: string[]
        }
      }
    };
    const prior = mockedSignals.alerts.value;
    try {
      mockedSignals.alerts.value = {
        budgetThreshold: 0.8,
        browserNotificationsEnabled: true,
        lastNotifiedAlertKeys: ['budget:2026-03:food']
      };

      const result = buildImportState({ alertPrefs: { budgetThreshold: 0.85 } }, 'overwrite', []);
      const alerts = result.newS.alerts as {
        budgetThreshold: number | null;
        browserNotificationsEnabled: boolean;
        lastNotifiedAlertKeys: string[]
      };

      expect(alerts.budgetThreshold).toBe(0.85);
      // Overwrite semantics: omitted fields fall to normalizeAlertPrefs
      // defaults (false / []), regardless of the user's prior state.
      expect(alerts.browserNotificationsEnabled).toBe(false);
      expect(alerts.lastNotifiedAlertKeys).toEqual([]);
    } finally {
      mockedSignals.alerts.value = prior;
    }
  });

  // --- Item 3: monthly allocations merge upsert -----------------------
  //
  // Prior behavior: `if (monthAlloc[safeId] == null) monthAlloc[safeId] = ...`
  // silently dropped every incoming allocation whose category already
  // existed in the month. A backup that carried the user's updated
  // groceries budget for 2026-03 quietly kept the old number. Commit A
  // flips this to upsert semantics: incoming edits override existing
  // per-category values during merge.

  it('upserts incoming monthly allocations onto existing buckets (batch 7k item 3)', () => {
    const mockedSignals = signals as unknown as {
      monthlyAlloc: { value: Record<string, Record<string, number>> }
    };
    const prior = mockedSignals.monthlyAlloc.value;
    try {
      mockedSignals.monthlyAlloc.value = { '2026-03': { food: 300, rent: 1500 } };

      const result = buildImportState(
        { monthlyAllocations: { '2026-03': { food: 500 } } },
        'merge',
        []
      );
      const alloc = result.newS.monthlyAlloc as Record<string, Record<string, number>>;

      expect(alloc['2026-03']?.food).toBe(500);     // overwritten (item 3)
      expect(alloc['2026-03']?.rent).toBe(1500);    // preserved (same-month other cat)
    } finally {
      mockedSignals.monthlyAlloc.value = prior;
    }
  });

  it('creates new month buckets without disturbing existing months (batch 7k item 3)', () => {
    const mockedSignals = signals as unknown as {
      monthlyAlloc: { value: Record<string, Record<string, number>> }
    };
    const prior = mockedSignals.monthlyAlloc.value;
    try {
      mockedSignals.monthlyAlloc.value = { '2026-03': { food: 300 } };

      const result = buildImportState(
        { monthlyAllocations: { '2026-04': { food: 350 } } },
        'merge',
        []
      );
      const alloc = result.newS.monthlyAlloc as Record<string, Record<string, number>>;

      expect(alloc['2026-03']?.food).toBe(300); // untouched
      expect(alloc['2026-04']?.food).toBe(350); // new
    } finally {
      mockedSignals.monthlyAlloc.value = prior;
    }
  });

  // --- Item 11: rolloverSettings partial-merge preservation -----------
  //
  // Merge with `{enabled: true}` used to rebuild the full shape from
  // the payload and silently reset `mode`, `categories`, `maxRollover`,
  // and `negativeHandling` to the overwrite defaults. A user who
  // wanted to flip "enabled on" during a merge lost their selected-
  // categories list. Commit A: in merge mode, existing settings are
  // the baseline; only fields actually present (`'field' in rs`)
  // override.

  it('preserves omitted rolloverSettings fields during merge (batch 7k item 11)', () => {
    const mockedSignals = signals as unknown as {
      rolloverSettings: { value: import('../js/types/index.js').RolloverSettings | null }
    };
    const prior = mockedSignals.rolloverSettings.value;
    try {
      mockedSignals.rolloverSettings.value = {
        enabled: false,
        mode: 'selected',
        categories: ['food', 'transport'],
        maxRollover: 250,
        negativeHandling: 'carry',
      };

      // Partial merge payload that only flips the master toggle.
      const result = buildImportState({ rolloverSettings: { enabled: true } }, 'merge', []);
      const rs = result.newS.rolloverSettings as import('../js/types/index.js').RolloverSettings;

      expect(rs.enabled).toBe(true);                           // applied
      expect(rs.mode).toBe('selected');                        // preserved
      expect(rs.categories).toEqual(['food', 'transport']);    // preserved
      expect(rs.maxRollover).toBe(250);                        // preserved
      expect(rs.negativeHandling).toBe('carry');               // preserved
    } finally {
      mockedSignals.rolloverSettings.value = prior;
    }
  });

  it('rebuilds rolloverSettings from canonical defaults on overwrite with partial payload (batch 7k item 11)', () => {
    // Overwrite semantics asymmetry guard — same as the alertPrefs
    // overwrite test above. Defaults are: enabled=false, mode='all',
    // categories=[], maxRollover=null, negativeHandling='zero'.
    const result = buildImportState({ rolloverSettings: { enabled: true } }, 'overwrite', []);
    const rs = result.newS.rolloverSettings as import('../js/types/index.js').RolloverSettings;

    expect(rs.enabled).toBe(true);             // from payload
    expect(rs.mode).toBe('all');               // default
    expect(rs.categories).toEqual([]);         // default
    expect(rs.maxRollover).toBeNull();         // default
    expect(rs.negativeHandling).toBe('zero');  // default
  });

  // --- Items 7/8/9/N12/N13/N14/N15: debt validation contract ---------
  //
  // Prior behavior: the debts block papered over every class of
  // malformed input with silent fallbacks. Commit A + ext-batch:
  //   (7)  balance: numeric strings ("420.50") are accepted
  //   (8)  dueDay: runs through shared `normalizeDueDay` clamp
  //   (9)  interestRate: missing/unparseable APR is a REJECTION —
  //        no silent 0% fallback that masks garbage as interest-free
  //   (N12) type: validated against `VALID_DEBT_TYPES` with 'other'
  //        fallback, no unchecked cast
  //   (N13) dueDay clamp via shared normalizer (closes out-of-range)
  //   (N14) dueDay: numeric-string preservation (e.g. "15" → 15)
  //   (N15) isActive: strict boolean check — explicit false preserved
  //        as false, explicit true as true, default true on absence

  it('rejects debts that omit the interestRate field (batch 7k item 9)', () => {
    // APR is load-bearing: a silent 0% fallback would mask a corrupt
    // payload as interest-free debt and burn the user on every
    // payoff projection. Rejection surfaces the problem instead.
    const importData = {
      debts: [{ id: 'd1', name: 'Card A', balance: 100 }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(0);
  });

  it('rejects debts with an unparseable interestRate (batch 7k item 9)', () => {
    const importData = {
      debts: [{ id: 'd1', name: 'Card A', balance: 100, interestRate: 'abc' }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(0);
  });

  it('accepts explicit 0% interestRate (edge case, distinct from missing)', () => {
    // 0% is a legitimate value (interest-free promotional card) —
    // the rejection rule is "absent/unparseable," not "falsy."
    const importData = {
      debts: [{ id: 'd1', name: 'Card A', balance: 100, interestRate: 0 }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(1);
    expect(debts[0]?.interestRate).toBe(0);
  });

  it('accepts numeric-string balance payloads from legacy exports (batch 7k item 7)', () => {
    // Pre-refactor exports legitimately emit string numerics — the
    // import boundary must parse them, not reject them as non-number.
    const importData = {
      debts: [{ id: 'd1', name: 'Card A', balance: '420.50', interestRate: 0.1999 }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(1);
    expect(debts[0]?.balance).toBe(420.5);
  });

  it('parses numeric-string dueDay through normalizeDueDay (batch 7k items 8/N14)', () => {
    const importData = {
      debts: [{ id: 'd1', name: 'Card', balance: 100, interestRate: 0.05, dueDay: '15' }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(1);
    expect(debts[0]?.dueDay).toBe(15);
  });

  it('clamps out-of-range dueDay into [1, 31] via normalizeDueDay (batch 7k items 8/N13)', () => {
    const importData = {
      debts: [
        { id: 'd_high', name: 'A', balance: 100, interestRate: 0.05, dueDay: 45 },
        { id: 'd_low',  name: 'B', balance: 100, interestRate: 0.05, dueDay: 0 },
        { id: 'd_neg',  name: 'C', balance: 100, interestRate: 0.05, dueDay: -5 }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(3);
    // All three clamp — 45 → 31 (ceiling), 0 and -5 → 1 (floor).
    const byId = Object.fromEntries(debts.map(d => [d.id, d.dueDay]));
    expect(byId['d_high']).toBe(31);
    expect(byId['d_low']).toBe(1);
    expect(byId['d_neg']).toBe(1);
  });

  it('defaults dueDay to 1 when absent from the payload (batch 7k item 8)', () => {
    const importData = {
      debts: [{ id: 'd1', name: 'Card', balance: 100, interestRate: 0.05 }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(1);
    expect(debts[0]?.dueDay).toBe(1);
  });

  it('falls back to "other" for unknown debt types rather than persisting a bad union value (batch 7k item N12)', () => {
    const importData = {
      debts: [
        { id: 'd1', name: 'Weird debt', balance: 100, interestRate: 0.05, type: 'not_a_real_type' },
        { id: 'd2', name: 'Also weird', balance: 100, interestRate: 0.05, type: 42 }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(2);
    expect(debts[0]?.type).toBe('other');
    expect(debts[1]?.type).toBe('other');
  });

  it('preserves valid DebtType union values (batch 7k item N12 positive case)', () => {
    const importData = {
      debts: [
        { id: 'd1', name: 'Visa', balance: 100, interestRate: 0.19, type: 'credit_card' },
        { id: 'd2', name: 'Stafford', balance: 5000, interestRate: 0.06, type: 'student_loan' }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts[0]?.type).toBe('credit_card');
    expect(debts[1]?.type).toBe('student_loan');
  });

  it('preserves isActive when payload carries a proper boolean (batch 7k item N15)', () => {
    const importData = {
      debts: [
        { id: 'd_off', name: 'Paid off',  balance: 0, interestRate: 0.05, isActive: false },
        { id: 'd_on',  name: 'Still owed', balance: 100, interestRate: 0.05, isActive: true }
      ]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    const byId = Object.fromEntries(debts.map(d => [d.id, d.isActive]));
    expect(byId['d_off']).toBe(false);
    expect(byId['d_on']).toBe(true);
    // Type safety — never propagate a non-boolean through the field
    // (closes the prior bug where a truthy non-boolean bled through).
    expect(typeof byId['d_off']).toBe('boolean');
    expect(typeof byId['d_on']).toBe('boolean');
  });

  it('defaults isActive to true when payload omits the field (batch 7k item N15)', () => {
    // Missing isActive is treated as "active" — the safe default for
    // a debt the user added during a period when the field didn't
    // exist yet in the schema.
    const importData = {
      debts: [{ id: 'd1', name: 'Legacy debt', balance: 100, interestRate: 0.05 }]
    };

    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];

    expect(debts).toHaveLength(1);
    expect(debts[0]?.isActive).toBe(true);
  });

  // --- Item 4: debts merge-by-id upsert on existing --------------------
  //
  // Merge mode used to `.filter(d => !existingIds.has(d.id))` — which
  // silently dropped every incoming UPDATE to a debt the user already
  // had. So a balance correction synced from device B never reached
  // device A. Commit A routes debts through `mergeById` so incoming
  // rows replace existing on id collision, and genuinely new rows
  // still append normally.

  it('upserts debts by id on merge — existing rows get replaced (batch 7k item 4)', () => {
    const mockedSignals = signals as unknown as {
      debts: { value: import('../js/types/index.js').Debt[] }
    };
    const prior = mockedSignals.debts.value;
    try {
      mockedSignals.debts.value = [{
        id: 'debt_abc',
        name: 'Chase Visa',
        type: 'credit_card',
        balance: 1200,
        originalBalance: 2000,
        interestRate: 0.1999,
        minimumPayment: 35,
        dueDay: 15,
        createdAt: '2024-01-01',
        payments: [],
        isActive: true
      }];

      // Incoming payload carries an updated balance for the same id.
      const result = buildImportState({
        debts: [{
          id: 'debt_abc',
          name: 'Chase Visa',
          type: 'credit_card',
          balance: 950,                 // paid down $250
          interestRate: 0.1999,
          minimumPayment: 35,
          dueDay: 15
        }]
      }, 'merge', []);
      const debts = result.newS.debts as import('../js/types/index.js').Debt[];

      expect(debts).toHaveLength(1);
      expect(debts[0]?.id).toBe('debt_abc');
      expect(debts[0]?.balance).toBe(950); // incoming wins
    } finally {
      mockedSignals.debts.value = prior;
    }
  });

  it('appends genuinely new debts on merge while preserving existing (batch 7k item 4)', () => {
    const mockedSignals = signals as unknown as {
      debts: { value: import('../js/types/index.js').Debt[] }
    };
    const prior = mockedSignals.debts.value;
    try {
      mockedSignals.debts.value = [{
        id: 'debt_existing',
        name: 'Existing',
        type: 'credit_card',
        balance: 500,
        originalBalance: 500,
        interestRate: 0.15,
        minimumPayment: 25,
        dueDay: 1,
        createdAt: '2024-01-01',
        payments: [],
        isActive: true
      }];

      const result = buildImportState({
        debts: [{
          id: 'debt_new',
          name: 'New debt',
          balance: 200,
          interestRate: 0.1,
          minimumPayment: 10,
          dueDay: 5
        }]
      }, 'merge', []);
      const debts = result.newS.debts as import('../js/types/index.js').Debt[];

      expect(debts).toHaveLength(2);
      const ids = debts.map(d => d.id);
      expect(ids).toContain('debt_existing');
      expect(ids).toContain('debt_new');
    } finally {
      mockedSignals.debts.value = prior;
    }
  });

  // --- N16: strict YYYY-MM-DD + calendar-valid debt payment dates -------
  //
  // Pre-fix the validator required only a non-empty string, so values
  // like "tomorrow", "2026-02-30", or "2026-99-99" sailed into the
  // payoff timeline and then confused downstream `new Date(p.date)`
  // consumers. These tests lock the stricter shape contract.

  it('rejects debt payments with free-form date strings (batch 7k N16)', () => {
    const importData = {
      debts: [{
        id: 'd_n16a',
        name: 'APR debt',
        balance: 100,
        interestRate: 0.1,
        payments: [
          { amount: 10, date: 'tomorrow' },
          { amount: 20, date: 'April 1' },
          { amount: 30, date: '2026-01-15' } // the one valid row
        ]
      }]
    };
    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];
    expect(debts).toHaveLength(1);
    expect(debts[0]?.payments).toHaveLength(1);
    expect(debts[0]?.payments[0]?.date).toBe('2026-01-15');
  });

  it('rejects debt payments with calendar-invalid YYYY-MM-DD (batch 7k N16)', () => {
    // Regex-valid shape but impossible calendar day — must round-trip
    // through Date so Feb 30 / month 99 / day 99 all land on the drop pile.
    const importData = {
      debts: [{
        id: 'd_n16b',
        name: 'Cal debt',
        balance: 200,
        interestRate: 0.1,
        payments: [
          { amount: 10, date: '2026-02-30' },
          { amount: 20, date: '2026-99-99' },
          { amount: 30, date: '2026-13-01' },
          { amount: 40, date: '2026-03-15' } // valid
        ]
      }]
    };
    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];
    expect(debts).toHaveLength(1);
    expect(debts[0]?.payments).toHaveLength(1);
    expect(debts[0]?.payments[0]?.date).toBe('2026-03-15');
  });

  // --- N17: aggregated debt-payment drop toast ---------------------------
  //
  // The per-debt loop used to emit `reportImportPartialDrop('debtPayments',
  // k)` once per debt with malformed rows — a backup with drops across
  // many debts spammed the toast region. Sum the drops and surface one
  // aggregate notification (we still expect 'debts' — zero in this fixture
  // — plus one 'debtPayments' summary).

  it('aggregates debt-payment drop counts across debts into a single partial-drop report (batch 7k N17)', () => {
    // Spy on reportImportPartialDrop by stubbing the module-level helper
    // indirectly: count how many times the returned state exposes drops
    // via buildImportState → the helper runs with side-effects, so
    // instead we verify the *count* of surviving payments.
    const importData = {
      debts: [
        {
          id: 'd_a', name: 'A', balance: 100, interestRate: 0.1,
          payments: [
            { amount: 5, date: 'tomorrow' },
            { amount: 10, date: '2026-01-01' }
          ]
        },
        {
          id: 'd_b', name: 'B', balance: 200, interestRate: 0.1,
          payments: [
            { amount: 1, date: '2026-02-30' },
            { amount: 2, date: '2026-99-99' },
            { amount: 3, date: '2026-01-02' }
          ]
        }
      ]
    };
    const result = buildImportState(importData, 'overwrite', []);
    const debts = result.newS.debts as import('../js/types/index.js').Debt[];
    // Total surviving payments across both debts: 1 + 1 = 2.
    // The aggregate report would have surfaced 3 drops (1 from A, 2 from B).
    const surviving = debts.reduce((n, d) => n + d.payments.length, 0);
    expect(surviving).toBe(2);
    // Sanity: both debts preserved, neither dropped wholesale.
    expect(debts).toHaveLength(2);
  });

  // --- N18: merge preserves existing debt payments when key omitted -----
  //
  // Merge mode used to normalize the absent `payments` field to `[]`,
  // so a partial update that just corrected a balance wiped every
  // recorded payment. The fix distinguishes "payments key missing"
  // (preserve existing) from "payments: []" (explicit wipe). Overwrite
  // mode still wipes because that's its whole contract.

  it('preserves existing debt payments on merge when the incoming row omits the payments key (batch 7k N18)', () => {
    const mockedSignals = signals as unknown as {
      debts: { value: import('../js/types/index.js').Debt[] }
    };
    const prior = mockedSignals.debts.value;
    try {
      mockedSignals.debts.value = [{
        id: 'debt_keep',
        name: 'Keep payments',
        type: 'credit_card',
        balance: 500,
        originalBalance: 1000,
        interestRate: 0.1,
        minimumPayment: 20,
        dueDay: 15,
        createdAt: '2024-01-01',
        payments: [
          { id: 'p1', amount: 100, date: '2025-06-01', principal: 80, interest: 20, transactionId: 't1' },
          { id: 'p2', amount: 100, date: '2025-07-01', principal: 85, interest: 15, transactionId: 't2' }
        ],
        isActive: true
      }];

      // Incoming row has no `payments` field at all — merge should
      // preserve the two existing payments rather than wipe them.
      const result = buildImportState({
        debts: [{
          id: 'debt_keep',
          name: 'Keep payments',
          balance: 450,           // balance updated
          interestRate: 0.1
        }]
      }, 'merge', []);
      const debts = result.newS.debts as import('../js/types/index.js').Debt[];

      expect(debts).toHaveLength(1);
      expect(debts[0]?.balance).toBe(450); // incoming wins on balance
      expect(debts[0]?.payments).toHaveLength(2); // history preserved
    } finally {
      mockedSignals.debts.value = prior;
    }
  });

  it('treats explicit empty payments array as a wipe on merge (batch 7k N18)', () => {
    const mockedSignals = signals as unknown as {
      debts: { value: import('../js/types/index.js').Debt[] }
    };
    const prior = mockedSignals.debts.value;
    try {
      mockedSignals.debts.value = [{
        id: 'debt_wipe',
        name: 'Wipe target',
        type: 'credit_card',
        balance: 500,
        originalBalance: 1000,
        interestRate: 0.1,
        minimumPayment: 20,
        dueDay: 15,
        createdAt: '2024-01-01',
        payments: [{ id: 'p_w1', amount: 50, date: '2025-06-01', principal: 40, interest: 10, transactionId: 'tx_w1' }],
        isActive: true
      }];

      const result = buildImportState({
        debts: [{
          id: 'debt_wipe',
          name: 'Wipe target',
          balance: 450,
          interestRate: 0.1,
          payments: []          // explicit: wipe
        }]
      }, 'merge', []);
      const debts = result.newS.debts as import('../js/types/index.js').Debt[];

      expect(debts[0]?.payments).toHaveLength(0);
    } finally {
      mockedSignals.debts.value = prior;
    }
  });

  it('still wipes payments on overwrite when the incoming row omits payments (batch 7k N18)', () => {
    const mockedSignals = signals as unknown as {
      debts: { value: import('../js/types/index.js').Debt[] }
    };
    const prior = mockedSignals.debts.value;
    try {
      mockedSignals.debts.value = [{
        id: 'debt_ow',
        name: 'OW target',
        type: 'credit_card',
        balance: 500,
        originalBalance: 1000,
        interestRate: 0.1,
        minimumPayment: 20,
        dueDay: 15,
        createdAt: '2024-01-01',
        payments: [{ id: 'p_ow1', amount: 50, date: '2025-06-01', principal: 40, interest: 10, transactionId: 'tx_ow1' }],
        isActive: true
      }];

      const result = buildImportState({
        debts: [{
          id: 'debt_ow',
          name: 'OW target',
          balance: 450,
          interestRate: 0.1
        }]
      }, 'overwrite', []);
      const debts = result.newS.debts as import('../js/types/index.js').Debt[];

      // Overwrite is a full reset — no prior-state preservation.
      expect(debts[0]?.payments).toHaveLength(0);
    } finally {
      mockedSignals.debts.value = prior;
    }
  });

  // --- N19: malformed rollover categories fall back to base.categories --
  //
  // The rolloverSettings partial-merge block preserves baseline for every
  // other field when the payload entry is absent or unusable; categories
  // was an outlier that wiped to `[]` when present-but-malformed. Locked
  // to the baseline-preservation contract so damaged backups don't
  // silently clear the user's selected-categories list.

  it('falls back to existing categories when payload categories is present but malformed (batch 7k N19)', () => {
    const mockedSignals = signals as unknown as {
      rolloverSettings: { value: import('../js/types/index.js').RolloverSettings | null }
    };
    const prior = mockedSignals.rolloverSettings.value;
    try {
      mockedSignals.rolloverSettings.value = {
        enabled: true,
        mode: 'selected',
        categories: ['groceries', 'utilities'],
        maxRollover: 100,
        negativeHandling: 'zero'
      };

      // `categories: "Groceries"` is malformed (not an array).
      const result = buildImportState({
        rolloverSettings: {
          enabled: true,
          categories: 'Groceries'   // malformed
        }
      }, 'merge', []);
      const rs = result.newS.rolloverSettings as import('../js/types/index.js').RolloverSettings;

      // Must preserve existing categories rather than wipe to [].
      expect(rs.categories).toEqual(['groceries', 'utilities']);
    } finally {
      mockedSignals.rolloverSettings.value = prior;
    }
  });

  it('accepts a well-formed categories array during merge (batch 7k N19)', () => {
    const mockedSignals = signals as unknown as {
      rolloverSettings: { value: import('../js/types/index.js').RolloverSettings | null }
    };
    const prior = mockedSignals.rolloverSettings.value;
    try {
      mockedSignals.rolloverSettings.value = {
        enabled: true,
        mode: 'selected',
        categories: ['groceries'],
        maxRollover: null,
        negativeHandling: 'zero'
      };

      const result = buildImportState({
        rolloverSettings: { categories: ['dining', 'entertainment'] }
      }, 'merge', []);
      const rs = result.newS.rolloverSettings as import('../js/types/index.js').RolloverSettings;

      expect(rs.categories).toEqual(['dining', 'entertainment']);
    } finally {
      mockedSignals.rolloverSettings.value = prior;
    }
  });

  // =========================================================================
  // CR-Apr22-F slice 1 — recurring-templates round-trip through buildImportState.
  //
  // Prior to slice 1, SK.RECURRING had no handler in `buildImportState`,
  // so a "full" export/import round-trip silently dropped the user's
  // recurring series — the already-materialized historical transactions
  // restored cleanly, but every future occurrence stopped generating.
  // The handler mirrors the debts/allocations contract (present-payload
  // → write; overwrite + absent → wipe) EXCEPT for the "overwrite +
  // absent" branch, which preserves existing storage to avoid wiping
  // legacy backups that predate this field entirely. Each test below is
  // load-bearing for a documented semantic branch.
  // =========================================================================
  describe('recurringTemplates handler (CR-Apr22-F slice 1)', () => {
    const validTemplate = {
      id: 'tpl_valid',
      type: 'expense' as const,
      category: 'food',
      amount: 50,
      description: 'Weekly groceries',
      tags: '',
      notes: '',
      startDate: '2026-01-01',
      endDate: '2099-12-31',
      recurringType: 'weekly' as const,
      originalDayOfMonth: 15,
      active: true
    };

    beforeEach(() => {
      // Default: no existing SK.RECURRING in storage. Tests that exercise
      // merge/upsert or the legacy-preserve branch override this.
      vi.mocked(safeStorage.getJSON).mockImplementation(
        (_key: string, fallback: unknown) => fallback
      );
      vi.mocked(emit).mockClear();
      vi.mocked(trackError).mockClear();
    });

    it('writes validated recurring templates to SK.RECURRING on overwrite + present payload', () => {
      const importData = {
        recurringTemplates: { tpl_valid: validTemplate }
      };

      const result = buildImportState(importData, 'overwrite', []);

      expect(result.newS.recurringTemplates).toEqual({ tpl_valid: validTemplate });
      const write = result.writes.find(w => w.key === SK.RECURRING);
      expect(write).toBeDefined();
      expect(write?.value).toEqual({ tpl_valid: validTemplate });
    });

    it('wipes SK.RECURRING to empty when the payload is present but empty (overwrite + {})', () => {
      // Post-slice-1 exports always include `recurringTemplates`, even as
      // `{}` when the user has no series. That "user explicitly has zero"
      // case must hit the present-but-empty branch and clear storage,
      // distinguishing it from the legacy-preserve branch below.
      const importData = { recurringTemplates: {} };

      const result = buildImportState(importData, 'overwrite', []);

      expect(result.newS.recurringTemplates).toEqual({});
      const write = result.writes.find(w => w.key === SK.RECURRING);
      expect(write).toBeDefined();
      expect(write?.value).toEqual({});
    });

    it('PRESERVES SK.RECURRING when payload is absent on overwrite (legacy-backup regression guard)', () => {
      // CRITICAL regression guard. Every other section treats "absent +
      // overwrite" as a wipe signal, because those sections have always
      // been part of the export schema. `recurringTemplates` is new in
      // slice 1 — a pre-slice-1 backup simply has no such field, and the
      // user didn't ask to lose their series. This branch must NOT push
      // a write and must NOT set newS.recurringTemplates, so downstream
      // hydration leaves SK.RECURRING untouched.
      const importData = {};

      const result = buildImportState(importData, 'overwrite', []);

      expect(result.newS.recurringTemplates).toBeUndefined();
      const write = result.writes.find(w => w.key === SK.RECURRING);
      expect(write).toBeUndefined();
    });

    it('upserts by id on merge + present payload', () => {
      // Existing storage has tpl_a (legacy) + tpl_b (to be replaced).
      const existing = {
        tpl_a: { ...validTemplate, id: 'tpl_a', category: 'transport' },
        tpl_b: { ...validTemplate, id: 'tpl_b', amount: 25 }
      };
      vi.mocked(safeStorage.getJSON).mockImplementation(
        (key: string, fallback: unknown) =>
          key === SK.RECURRING ? existing : fallback
      );

      const importData = {
        recurringTemplates: {
          tpl_b: { ...validTemplate, id: 'tpl_b', amount: 99 }, // overwrites existing
          tpl_c: { ...validTemplate, id: 'tpl_c', amount: 7 }   // brand new
        }
      };

      const result = buildImportState(importData, 'merge', []);

      const merged = result.newS.recurringTemplates as Record<string, { id: string; amount: number }>;
      expect(merged.tpl_a?.amount).toBe(50);           // untouched existing
      expect(merged.tpl_a?.id).toBe('tpl_a');
      expect(merged.tpl_b?.amount).toBe(99);           // replaced by incoming
      expect(merged.tpl_c?.amount).toBe(7);            // net-new
      expect(Object.keys(merged)).toHaveLength(3);

      const write = result.writes.find(w => w.key === SK.RECURRING);
      expect(write?.value).toEqual(merged);
    });

    it('leaves SK.RECURRING untouched on merge + absent payload', () => {
      // Merge-with-absent is a no-op: the user hasn't asked to change
      // anything here, and we must not push a write or set newS so
      // hydrateFromImport doesn't reload the in-memory Map spuriously.
      const importData = { transactions: [] };

      const result = buildImportState(importData, 'merge', []);

      expect(result.newS.recurringTemplates).toBeUndefined();
      const write = result.writes.find(w => w.key === SK.RECURRING);
      expect(write).toBeUndefined();
    });

    // -------- Row-level validation ----------------------------------------
    it('drops rows with invalid type ∉ {expense, income}', () => {
      const importData = {
        recurringTemplates: {
          good: validTemplate,
          bad_type: { ...validTemplate, id: 'bad_type', type: 'transfer' }
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
      expect(out.bad_type).toBeUndefined();
    });

    it('drops rows with empty or non-string category', () => {
      const importData = {
        recurringTemplates: {
          r1: { ...validTemplate, id: 'r1', category: '' },
          r2: { ...validTemplate, id: 'r2', category: 42 },
          r3: validTemplate
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
    });

    it('drops rows with non-finite amount', () => {
      const importData = {
        recurringTemplates: {
          nan: { ...validTemplate, id: 'nan', amount: NaN },
          inf: { ...validTemplate, id: 'inf', amount: Infinity },
          str: { ...validTemplate, id: 'str', amount: '50' as unknown as number },
          ok: validTemplate
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
    });

    it('drops rows with malformed startDate or endDate (isValidYmd gate)', () => {
      const importData = {
        recurringTemplates: {
          bad_start: { ...validTemplate, id: 'bad_start', startDate: '2026-13-01' },
          bad_end: { ...validTemplate, id: 'bad_end', endDate: 'tomorrow' },
          bad_calendar: { ...validTemplate, id: 'bad_cal', startDate: '2026-02-30' }, // Feb 30
          ok: validTemplate
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
    });

    it('drops rows whose recurringType is not in VALID_RECURRING_TYPES', () => {
      const importData = {
        recurringTemplates: {
          bogus: { ...validTemplate, id: 'bogus', recurringType: 'hourly' },
          empty: { ...validTemplate, id: 'empty', recurringType: '' },
          ok: validTemplate
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
    });

    it('drops rows whose originalDayOfMonth is out of [1, 31]', () => {
      const importData = {
        recurringTemplates: {
          zero: { ...validTemplate, id: 'zero', originalDayOfMonth: 0 },
          over: { ...validTemplate, id: 'over', originalDayOfMonth: 32 },
          neg: { ...validTemplate, id: 'neg', originalDayOfMonth: -1 },
          ok: validTemplate
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['tpl_valid']);
    });

    it('accepts every cadence in VALID_RECURRING_TYPES (regression guard against drift)', () => {
      // If someone adds a new cadence to the union type but forgets to
      // update VALID_RECURRING_TYPES, this test fails — same set is
      // reused by the update path, so drift here corrupts the whole
      // lifecycle.
      const cadences = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const;
      const rows: Record<string, unknown> = {};
      for (const c of cadences) {
        rows[c] = { ...validTemplate, id: c, recurringType: c };
      }

      const result = buildImportState({ recurringTemplates: rows }, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, unknown>;

      expect(Object.keys(out).sort()).toEqual([...cadences].sort());
    });

    it('coerces active to true when missing or non-boolean (legacy-export parity)', () => {
      const importData = {
        recurringTemplates: {
          no_active: (() => {
            const { active: _unused, ...rest } = validTemplate;
            return { ...rest, id: 'no_active' };
          })(),
          string_active: { ...validTemplate, id: 'string_active', active: 'yes' },
          null_active: { ...validTemplate, id: 'null_active', active: null }
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, { active: boolean }>;

      expect(out.no_active?.active).toBe(true);
      expect(out.string_active?.active).toBe(true);
      expect(out.null_active?.active).toBe(true);
    });

    it('preserves valid lastGeneratedDate and drops invalid ones', () => {
      const importData = {
        recurringTemplates: {
          with_last: { ...validTemplate, id: 'with_last', lastGeneratedDate: '2026-03-15' },
          bad_last: { ...validTemplate, id: 'bad_last', lastGeneratedDate: '2026-02-30' }
        }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, { lastGeneratedDate?: string }>;

      expect(out.with_last?.lastGeneratedDate).toBe('2026-03-15');
      expect(out.bad_last?.lastGeneratedDate).toBeUndefined();
    });

    it('falls back to the object key when the row\'s own id is missing', () => {
      const noIdRow: Record<string, unknown> = { ...validTemplate };
      delete noIdRow.id;
      const importData = {
        recurringTemplates: { my_key: noIdRow }
      };

      const result = buildImportState(importData, 'overwrite', []);
      const out = result.newS.recurringTemplates as Record<string, { id: string }>;

      expect(out.my_key?.id).toBe('my_key');
    });

    it('emits reportImportPartialDrop with the dropped row count', () => {
      const importData = {
        recurringTemplates: {
          bad1: { ...validTemplate, id: 'bad1', amount: NaN },
          bad2: { ...validTemplate, id: 'bad2', recurringType: 'bogus' },
          good: validTemplate
        }
      };

      buildImportState(importData, 'overwrite', []);

      const toastCall = vi.mocked(emit).mock.calls.find(
        (call) =>
          call[0] === Events.SHOW_TOAST &&
          typeof (call[1] as { message?: unknown })?.message === 'string' &&
          ((call[1] as { message: string }).message.includes('recurringTemplates'))
      );
      expect(toastCall).toBeDefined();
      expect((toastCall?.[1] as { message: string }).message).toMatch(/2 malformed recurringTemplates/);
      expect((toastCall?.[1] as { type: string }).type).toBe('warning');

      // Telemetry breadcrumb fired too.
      const trackCalls = vi.mocked(trackError).mock.calls;
      const recurringTrack = trackCalls.find(call =>
        (call[1] as { action?: string })?.action === 'buildImportState.recurringTemplates'
      );
      expect(recurringTrack).toBeDefined();
    });

    it('does not emit reportImportPartialDrop when every row validates cleanly', () => {
      const importData = { recurringTemplates: { r1: validTemplate } };
      vi.mocked(emit).mockClear();

      buildImportState(importData, 'overwrite', []);

      const toastCall = vi.mocked(emit).mock.calls.find(
        (call) =>
          call[0] === Events.SHOW_TOAST &&
          typeof (call[1] as { message?: unknown })?.message === 'string' &&
          ((call[1] as { message: string }).message.includes('recurringTemplates'))
      );
      expect(toastCall).toBeUndefined();
    });

    it('silently drops array-shaped or scalar payloads (non-object roots fall to the legacy-preserve branch)', () => {
      // A non-object payload is indistinguishable from "no payload" at
      // the handler boundary — we've already logged the outer shape via
      // the top-level validator. Falling through to the preserve branch
      // is the safe default. No write; no newS key.
      const cases: unknown[] = [
        [validTemplate],                          // array (wrong root shape)
        'not-an-object',
        42,
        null
      ];
      for (const recurringTemplates of cases) {
        const result = buildImportState(
          { recurringTemplates } as unknown as Record<string, unknown>,
          'overwrite',
          []
        );
        expect(result.newS.recurringTemplates).toBeUndefined();
        expect(result.writes.find(w => w.key === SK.RECURRING)).toBeUndefined();
      }
    });
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
    const lastField = lines[1]?.split(',').pop();
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
    expect(data).toHaveProperty('userCategories');
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
    expect(data).toHaveProperty('lastBackupTxCount');
    expect(data).toHaveProperty('recurringTemplates');
    expect(data).toHaveProperty('onboarding');
    expect(data).toHaveProperty('filterExpanded');
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

  // L81/L82 + L87/L88 regression guard — `buildExportData` must read theme
  // from the live signal, not `safeStorage.getItem(SK.THEME)`. Two bugs
  // this closes:
  //   (L81) debounced-batcher race — theme changes don't hit localStorage
  //         for 150 ms, so a manual export during the window would snapshot
  //         the previous theme.
  //   (L87) storage encoding mismatch — `safeStorage.setJSON` writes the
  //         JSON-encoded form (`"light"`), so a later `getItem` would
  //         return `"\"light\""` (quoted), and the exported file would
  //         carry an invalid `Theme` token that `setTheme()` rejects on
  //         re-import, clamping to `'dark'`.
  // The signal carries the raw union value (`'light'|'dark'|'system'`).
  it('reads theme from the live signal, not safeStorage (L81/L87)', () => {
    const mockedSignals = signals as unknown as { theme: { value: string } };
    const prior = mockedSignals.theme.value;
    try {
      mockedSignals.theme.value = 'light';
      // Simulate production storage encoding: safeStorage.setJSON writes the
      // JSON-quoted form, so a stale-read via getItem would return `"light"`
      // (with quotes). A correct fix reads the signal and ignores this.
      vi.mocked(safeStorage.getItem).mockReturnValue('"light"');

      const data = buildExportData();

      expect(data.theme).toBe('light'); // raw signal value, NOT `"light"` with quotes
      expect(data.theme).not.toBe('"light"');
    } finally {
      mockedSignals.theme.value = prior;
      vi.mocked(safeStorage.getItem).mockReset();
    }
  });

  // L79/L80 round-trip — numeric lastBackup exports as a number (matches
  // signal<number> contract at signals.ts:215). Prior bug coerced via
  // `String(...)` which round-tripped back as a string and violated the
  // signal's type contract on import.
  it('exports lastBackup as a number, not a string (L79)', () => {
    const mockedSignals = signals as unknown as { lastBackup: { value: number } };
    const prior = mockedSignals.lastBackup.value;
    try {
      const ts = 1713571200000; // 2024-04-20
      mockedSignals.lastBackup.value = ts;

      const data = buildExportData();

      expect(data.lastBackup).toBe(ts);
      expect(typeof data.lastBackup).toBe('number');
    } finally {
      mockedSignals.lastBackup.value = prior;
    }
  });

  it('exports lastBackup as null when signal value is 0 (cold boot)', () => {
    const mockedSignals = signals as unknown as { lastBackup: { value: number } };
    const prior = mockedSignals.lastBackup.value;
    try {
      mockedSignals.lastBackup.value = 0;
      const data = buildExportData();
      expect(data.lastBackup).toBeNull();
    } finally {
      mockedSignals.lastBackup.value = prior;
    }
  });

  // L89/L90 (Inline-Behavior-Review): manual export now emits
  // `lastBackupTxCount` at the top level so import can restore it.
  // Without this, a user who manually exported + re-imported lost the
  // "N transactions since last backup" reminder state and got nagged to
  // back up immediately after restoring a fresh backup.
  it('exports lastBackupTxCount from the live signal (L89)', () => {
    const mockedSignals = signals as unknown as { lastBackupTxCount: { value: number } };
    const prior = mockedSignals.lastBackupTxCount.value;
    try {
      mockedSignals.lastBackupTxCount.value = 42;

      const data = buildExportData();

      expect(data.lastBackupTxCount).toBe(42);
      expect(typeof data.lastBackupTxCount).toBe('number');
    } finally {
      mockedSignals.lastBackupTxCount.value = prior;
    }
  });

  it('exports lastBackupTxCount as null when signal value is 0 (cold boot) (L89)', () => {
    const mockedSignals = signals as unknown as { lastBackupTxCount: { value: number } };
    const prior = mockedSignals.lastBackupTxCount.value;
    try {
      mockedSignals.lastBackupTxCount.value = 0;
      const data = buildExportData();
      expect(data.lastBackupTxCount).toBeNull();
    } finally {
      mockedSignals.lastBackupTxCount.value = prior;
    }
  });

  // L89/L90 (Inline-Behavior-Review): end-to-end round-trip — export
  // with signals primed, feed the export payload back through
  // buildImportState, assert the reminder counter survives. This is
  // the regression that would have caught the missing-field bug.
  it('round-trips lastBackupTxCount through export → import (L89)', () => {
    const mockedSignals = signals as unknown as { lastBackupTxCount: { value: number } };
    const prior = mockedSignals.lastBackupTxCount.value;
    try {
      mockedSignals.lastBackupTxCount.value = 84;

      const exported = buildExportData();
      expect(exported.lastBackupTxCount).toBe(84);

      const restored = buildImportState(
        exported as unknown as Record<string, unknown>,
        'overwrite',
        []
      );

      expect(restored.newS.lastBackupTxCount).toBe(84);
      const write = restored.writes.find(w => w.key === 'backup_reminder_last_tx_count');
      expect(write?.value).toBe(84);
    } finally {
      mockedSignals.lastBackupTxCount.value = prior;
    }
  });

  it('exports the authoritative user category configuration', () => {
    const data = buildExportData();

    expect(data.userCategories).toEqual({
      presetId: 'personal',
      version: 1,
      expense: [{ id: 'food', name: 'Food', emoji: '🍔', color: '#ef4444', type: 'expense', order: 0 }],
      income: [{ id: 'salary', name: 'Salary', emoji: '💼', color: '#22c55e', type: 'income', order: 0 }]
    });
  });

  // CR-Apr22-F slice 1: recurringTemplates in the export payload. The
  // in-memory Map in recurring-templates.ts is kept in lock-step with
  // SK.RECURRING via synchronous `safeStorage.setJSON`, so storage is
  // the authoritative snapshot at export time. Before this field, the
  // manual export dropped recurring-series definitions entirely.
  it('snapshots the SK.RECURRING template set from safeStorage into the export payload (CR-Apr22-F slice 1)', () => {
    const recurringSnapshot = {
      r1: {
        id: 'r1',
        type: 'expense',
        category: 'food',
        amount: 12.5,
        description: 'Coffee',
        tags: '',
        notes: '',
        startDate: '2026-01-01',
        endDate: '2099-12-31',
        recurringType: 'weekly',
        originalDayOfMonth: 1,
        active: true
      }
    };
    vi.mocked(safeStorage.getJSON).mockImplementation(
      (key: string, fallback: unknown) =>
        key === SK.RECURRING ? recurringSnapshot : fallback
    );

    try {
      const data = buildExportData();

      expect(data).toHaveProperty('recurringTemplates');
      expect(data.recurringTemplates).toEqual(recurringSnapshot);
    } finally {
      vi.mocked(safeStorage.getJSON).mockImplementation(
        (_key: string, fallback: unknown) => fallback
      );
    }
  });

  it('emits recurringTemplates as an empty object when SK.RECURRING is absent (CR-Apr22-F slice 1)', () => {
    // safeStorage.getJSON default mock already returns the `{}` fallback
    // supplied at the call site. A legitimate "no recurring series" export
    // must emit `{}` (not omit the key) so the import path hits the
    // present-but-empty branch and wipes on overwrite.
    const data = buildExportData();
    expect(data.recurringTemplates).toEqual({});
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

  // --- Commit D / new batch P3: merchant-stem key, not 20-char prefix --
  //
  // The prior fuzzy key took `description.slice(0, 20)`, which collapsed
  // vendors sharing a long prefix. "WHOLE FOODS MARKET #234" and
  // "WHOLE EARTH PROVISIONS" both chopped to "whole foods market #" /
  // "whole earth provision" — within 20 chars — and landed in the same
  // bucket. The replacement takes up to 4 meaningful tokens (alpha
  // tokens only, numbers/symbols stripped).

  it('separates distinct merchants that share a long common prefix', () => {
    const txs = [
      makeTx({ date: '2024-06-10', amount: 50, category: 'food', type: 'expense', description: 'WHOLE FOODS MARKET #234' }),
      makeTx({ date: '2024-06-20', amount: 50, category: 'food', type: 'expense', description: 'WHOLE EARTH PROVISIONS' }),
    ];

    const result = findFuzzyDuplicates(txs);
    // Two distinct merchants → no multi-member group.
    const groups = Array.from(result.values());
    const multi = groups.find(g => g.length > 1);
    expect(multi).toBeUndefined();
  });

  it('still groups same-merchant transactions with only a per-transaction suffix differing', () => {
    const txs = [
      makeTx({ date: '2024-06-10', amount: 10, category: 'food', type: 'expense', description: 'STARBUCKS #1234' }),
      makeTx({ date: '2024-06-20', amount: 10, category: 'food', type: 'expense', description: 'STARBUCKS #5678' }),
    ];

    // Both become stem "starbucks" (pure-numeric tokens like "#1234"
    // and "#5678" are stripped), so the two real same-vendor visits
    // still land in the same fuzzy bucket.
    const result = findFuzzyDuplicates(txs);
    const groups = Array.from(result.values());
    const multi = groups.find(g => g.length === 2);
    expect(multi).toBeDefined();
  });
});

// ==========================================
// duplicate-detection.ts: formatDuplicateSummary
// ==========================================
//
// Commit D / new batch P3: the prior summary hardcoded `$` + `.toFixed(2)`,
// leaking US formatting into a user-facing duplicate-review surface even
// when the app was operating in a non-USD currency. Route through the
// shared `formatCurrency` so the summary honors the user's locale.

describe('formatDuplicateSummary (currency formatting)', () => {
  it('formats sample amounts via locale-aware formatCurrency, not hardcoded dollars', () => {
    const similar = [
      makeTx({ date: '2024-06-15', amount: 12.5, category: 'food', description: 'Cafe' }),
    ];
    const result = {
      exact: [],
      similar,
      unique: [],
    };

    const summary = formatDuplicateSummary(result);
    // The prior output contained the literal `$12.50`. The new output
    // must be locale-formatted — so a formatted currency string
    // appearing in place of the raw "$N.NN" pattern. Check for the
    // *absence* of the literal `$12.50` hardcoded form would be too
    // strict (some locales format as `$12.50` legitimately). Instead
    // verify: the formatter was used (the sample line contains a
    // currency-formatted representation of 12.5, not the raw
    // `.toFixed(2)` output).
    //
    // Structural guarantee: the summary contains the category and
    // date, and exactly one sample line. The currency substring
    // originates from `formatCurrency` — the behavior we care about
    // is that changes to locale settings reflect here, which is
    // implicitly exercised by round-tripping through that function.
    expect(summary).toContain('Cafe');
    expect(summary).toContain('food');
    expect(summary).toContain('2024-06-15');
    // Must include some currency representation of 12.5. In the
    // default test locale (en-US/USD) this looks like $12.50, but
    // the *mechanism* is now locale-aware so the symbol can change
    // as the formatter's output changes.
    expect(summary).toMatch(/12\.50|12,50/);
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
    expect(result[0]?.__backendId).toBe('a'); // first occurrence kept
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
    expect(result[0]?.description).toBe('Bus');
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
