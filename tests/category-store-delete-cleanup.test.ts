/**
 * category-store — `deleteCategoryWithCleanup` regression guard
 * (CR-Apr22-B slice 1).
 *
 * The prior world had two delete paths:
 *   1. `components/category-manager` → raw `deleteCategory(catId)` → nothing
 *      else. Every cross-store reference (allocations, templates,
 *      recurring, rollover, transactions) was stranded; the UI rendered
 *      "Unknown ❓" everywhere.
 *   2. `ui/core/ui-render.handleDeleteCustomCat` → partial cleanup, but
 *      it hardcoded the fallback id to `'other'` / `'other_income'`
 *      which only exist on the Personal preset (so under Household /
 *      Freelancer / Business the fallback itself was a phantom id),
 *      AND the sweep was non-atomic — if
 *      `dataSdk.replaceAllTransactions` threw after allocations had been
 *      stripped, the category was gone but transaction rows were still
 *      dangling.
 *
 * This file locks down the centralized `deleteCategoryWithCleanup` that
 * replaces both paths:
 *   - Strips every referencing store (allocations, templates, rollover,
 *     recurring, transactions) before returning `ok: true`.
 *   - Picks the fallback at runtime via `pickFallbackCategoryId`, so
 *     non-Personal presets stop corrupting their ledger on delete.
 *   - Runs the transaction rewrite FIRST so a `replaceAllTransactions`
 *     failure leaves every other store untouched (true atomic rollback
 *     of the visible state).
 *   - Refuses to delete the last remaining category of a type.
 *   - Returns a summary result so the UI can render a single toast
 *     without a second storage scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SK, persist, getStored } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import {
  deleteCategoryWithCleanup,
  pickFallbackCategoryId,
  userCategoryConfig,
} from '../js/modules/core/category-store.js';
import type {
  RolloverSettings,
  Transaction,
  TxTemplate,
  UserCategoryConfig,
} from '../js/types/index.js';

// ---------------------------------------------------------------------------
// data-manager stub — replaceAllTransactions is the single async/fallible step
// inside deleteCategoryWithCleanup. Tests override mockReplace per-case so we
// can assert ordering (did cleanup bail before touching other stores?).
// ---------------------------------------------------------------------------
const mockReplace = vi.fn();

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    replaceAllTransactions: (...args: unknown[]) => mockReplace(...args),
  },
}));

// Partial mock of recurring-templates — we keep the real implementation for
// everything except `loadRecurringTemplates`, which we wrap in a spy so the
// "in-memory scheduler refresh" regression test can observe whether the
// cleanup sweep called it. Tests should `mockLoadRecurring.mockClear()` in
// beforeEach; without spreading `vi.importActual`, the SK.RECURRING persist
// path would lose access to the real helpers (see memory:
// feedback_test_mock_drift).
const mockLoadRecurring = vi.fn();

vi.mock('../js/modules/data/recurring-templates.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/data/recurring-templates.js')>(
    '../js/modules/data/recurring-templates.js'
  );
  return {
    ...actual,
    loadRecurringTemplates: () => {
      mockLoadRecurring();
      actual.loadRecurringTemplates();
    }
  };
});

function seedConfig(presetId: 'personal' | 'household' = 'personal'): UserCategoryConfig {
  if (presetId === 'household') {
    const cfg: UserCategoryConfig = {
      presetId: 'household',
      version: 1,
      expense: [
        { id: 'groceries_hh', name: 'Groceries', emoji: '🛒', color: '#a', type: 'expense', order: 0 },
        { id: 'rent_hh', name: 'Rent', emoji: '🏠', color: '#b', type: 'expense', order: 1 },
        { id: 'other_hh', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 },
        { id: 'user_custom_abc', name: 'Piano Lessons', emoji: '🎹', color: '#d', type: 'expense', order: 3 }
      ],
      income: [
        { id: 'salary_hh', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
        { id: 'other_hh_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
      ]
    };
    userCategoryConfig.value = cfg;
    return cfg;
  }
  const cfg: UserCategoryConfig = {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#b', type: 'expense', order: 1 },
      { id: 'other', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 },
      { id: 'user_custom_xyz', name: 'Piano Lessons', emoji: '🎹', color: '#d', type: 'expense', order: 3 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
      { id: 'other_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
    ]
  };
  userCategoryConfig.value = cfg;
  return cfg;
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
    type: 'expense',
    category: 'food',
    amount: 10,
    description: 'Seed',
    date: '2026-01-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

function makeTemplate(overrides: Partial<TxTemplate> = {}): TxTemplate {
  return {
    id: `tpl_${Math.random().toString(36).slice(2, 10)}`,
    name: 'Seed template',
    type: 'expense',
    category: 'food',
    ...overrides
  };
}

// Reset every module-level signal + localStorage between tests so the 4
// signal reads inside deleteCategoryWithCleanup (monthlyAlloc, txTemplates,
// rolloverSettings, transactions) start from a known state.
function resetState(): void {
  localStorage.clear();
  userCategoryConfig.value = null;
  signals.monthlyAlloc.value = {};
  signals.txTemplates.value = [];
  signals.rolloverSettings.value = {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero'
  };
  signals.transactions.value = [];
  mockReplace.mockReset();
  mockReplace.mockResolvedValue({ isOk: true, data: [] });
  mockLoadRecurring.mockClear();
}

describe('pickFallbackCategoryId', () => {
  it('prefers an "other*" id when one remains', () => {
    const cfg = seedConfig('household');
    const pick = pickFallbackCategoryId(cfg, 'expense', 'user_custom_abc');
    expect(pick?.id).toBe('other_hh');
  });

  it('falls through to the first remaining category when no "other*" exists', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [
        { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
        { id: 'user_a', name: 'Custom A', emoji: '🎹', color: '#b', type: 'expense', order: 1 }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;
    const pick = pickFallbackCategoryId(cfg, 'expense', 'user_a');
    expect(pick?.id).toBe('food');
  });

  it('returns null when deleting the only remaining category of its type', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [{ id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 }],
      income: [{ id: 'salary', name: 'Salary', emoji: '💰', color: '#b', type: 'income', order: 0 }]
    };
    userCategoryConfig.value = cfg;
    expect(pickFallbackCategoryId(cfg, 'expense', 'food')).toBeNull();
    expect(pickFallbackCategoryId(cfg, 'income', 'salary')).toBeNull();
  });

  it('scopes its candidate list to the matching type', () => {
    const cfg = seedConfig();
    // Removing an expense never falls back to an income cat and vice-versa.
    const expensePick = pickFallbackCategoryId(cfg, 'expense', 'user_custom_xyz');
    expect(expensePick?.type).toBe('expense');
    const incomePick = pickFallbackCategoryId(cfg, 'income', 'salary');
    expect(incomePick?.id).toBe('other_income');
    expect(incomePick?.type).toBe('income');
  });

  // CR-Apr22-E finding: hidden-aware traversal. The "Other" slot is the
  // natural first-choice fallback, but if the user has hidden it, remapping
  // into it would bury migrated data behind the visibility filter.
  it('skips a hidden "other*" category in favor of the first VISIBLE remaining category', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [
        { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
        { id: 'other', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 1, hidden: true },
        { id: 'user_custom_xyz', name: 'Piano Lessons', emoji: '🎹', color: '#d', type: 'expense', order: 2 }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;
    const pick = pickFallbackCategoryId(cfg, 'expense', 'user_custom_xyz');
    // Hidden `other` is skipped in favor of the first visible candidate.
    expect(pick?.id).toBe('food');
    expect(pick?.hidden).toBeFalsy();
  });

  it('falls through to a hidden category only when every remaining candidate is hidden', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [
        { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0, hidden: true },
        { id: 'other', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 1, hidden: true },
        { id: 'user_custom_xyz', name: 'Piano Lessons', emoji: '🎹', color: '#d', type: 'expense', order: 2 }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;
    // Only `user_custom_xyz` is visible, but that's what we're deleting —
    // so the picker has nothing visible to fall back to. It must still
    // return something (deleting the last visible cat is otherwise
    // blocked for the user), tier 3 surfaces a hidden one.
    const pick = pickFallbackCategoryId(cfg, 'expense', 'user_custom_xyz');
    expect(pick).not.toBeNull();
    expect(pick?.hidden).toBe(true);
  });
});

describe('deleteCategoryWithCleanup', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
    vi.useRealTimers();
  });

  it('returns not_found when the config is empty', async () => {
    userCategoryConfig.value = null;
    const outcome = await deleteCategoryWithCleanup('food');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe('not_found');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('returns not_found when the catId is missing from the current config', async () => {
    seedConfig();
    const outcome = await deleteCategoryWithCleanup('nonexistent_id');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe('not_found');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('refuses to delete the only remaining category of its type', async () => {
    userCategoryConfig.value = {
      presetId: 'personal',
      version: 1,
      expense: [{ id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 }],
      income: []
    };
    const outcome = await deleteCategoryWithCleanup('food');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe('last_category_of_type');
    // Nothing should have been touched.
    expect(userCategoryConfig.value?.expense).toHaveLength(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ----- Fallback correctness (CR-Apr22-D finding #3 subsumed) ------------
  it('uses a household-preset fallback (not hardcoded "other") when deleting under Household', async () => {
    seedConfig('household');
    signals.transactions.value = [
      makeTx({ __backendId: 'tx_a', category: 'user_custom_abc', amount: 5 })
    ];

    const outcome = await deleteCategoryWithCleanup('user_custom_abc');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.fallbackCatId).toBe('other_hh');
    }

    // Transactions should have been rewritten to other_hh, NOT to 'other'
    // (which would be a phantom id on Household).
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [rewrittenTx] = mockReplace.mock.calls[0] as [Transaction[]];
    expect(rewrittenTx[0]?.category).toBe('other_hh');
  });

  // ----- Allocations ------------------------------------------------------
  it('strips the deleted category from every month\'s allocation bucket and persists', async () => {
    seedConfig();
    signals.monthlyAlloc.value = {
      '2026-01': { user_custom_xyz: 100, food: 200 },
      '2026-02': { user_custom_xyz: 120, transport: 80 },
      '2026-03': { food: 50 } // no reference — should pass through untouched
    };

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.allocationMonthsStripped).toBe(2);

    // In-memory signal reflects the strip.
    const alloc = signals.monthlyAlloc.value;
    expect(alloc['2026-01']).toEqual({ food: 200 });
    expect(alloc['2026-02']).toEqual({ transport: 80 });
    expect(alloc['2026-03']).toEqual({ food: 50 });

    // Persisted shape matches in-memory shape (round-trip via getStored).
    const persisted = getStored<Record<string, Record<string, number>>>(SK.ALLOC);
    expect(persisted['2026-01']).toEqual({ food: 200 });
    expect(persisted['2026-02']).toEqual({ transport: 80 });
  });

  // ----- Transaction templates -------------------------------------------
  it('remaps referenced transaction templates to the fallback category', async () => {
    seedConfig();
    signals.txTemplates.value = [
      makeTemplate({ id: 'tpl_a', category: 'user_custom_xyz' }),
      makeTemplate({ id: 'tpl_b', category: 'food' }), // unrelated — untouched
      makeTemplate({ id: 'tpl_c', category: 'user_custom_xyz' })
    ];

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.templatesMigrated).toBe(2);

    const updated = signals.txTemplates.value;
    expect(updated.find(t => t.id === 'tpl_a')?.category).toBe('other');
    expect(updated.find(t => t.id === 'tpl_b')?.category).toBe('food');
    expect(updated.find(t => t.id === 'tpl_c')?.category).toBe('other');

    // Persisted to SK.TX_TEMPLATES.
    const persisted = getStored<TxTemplate[]>(SK.TX_TEMPLATES);
    expect(persisted.find(t => t.id === 'tpl_a')?.category).toBe('other');
  });

  // ----- Rollover settings -----------------------------------------------
  it('strips the deleted id from rollover settings categories[]', async () => {
    seedConfig();
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'selected',
      categories: ['food', 'user_custom_xyz', 'transport'],
      maxRollover: null,
      negativeHandling: 'zero'
    };

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rolloverStripped).toBe(true);

    expect(signals.rolloverSettings.value.categories).toEqual(['food', 'transport']);
    // Other rollover fields preserved.
    expect(signals.rolloverSettings.value.enabled).toBe(true);
    expect(signals.rolloverSettings.value.mode).toBe('selected');

    const persisted = getStored<RolloverSettings>(SK.ROLLOVER_SETTINGS);
    expect(persisted.categories).toEqual(['food', 'transport']);
  });

  it('leaves rolloverStripped=false when the deleted id was not in the categories list', async () => {
    seedConfig();
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'selected',
      categories: ['food'],
      maxRollover: null,
      negativeHandling: 'zero'
    };

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rolloverStripped).toBe(false);
    expect(signals.rolloverSettings.value.categories).toEqual(['food']);
  });

  // ----- Recurring templates ---------------------------------------------
  it('remaps recurring-template category fields and persists to SK.RECURRING', async () => {
    seedConfig();
    persist(SK.RECURRING, {
      tpl_r1: { id: 'tpl_r1', category: 'user_custom_xyz', amount: 50 },
      tpl_r2: { id: 'tpl_r2', category: 'food', amount: 25 },
      tpl_r3: { id: 'tpl_r3', category: 'user_custom_xyz', amount: 75 }
    });

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recurringMigrated).toBe(2);

    const persisted = getStored<Record<string, { category?: string }>>(SK.RECURRING);
    expect(persisted.tpl_r1?.category).toBe('other');
    expect(persisted.tpl_r2?.category).toBe('food');
    expect(persisted.tpl_r3?.category).toBe('other');
  });

  // CR-Apr22-E finding: recurring-templates.ts keeps an in-memory Map.
  // Writing SK.RECURRING alone isn't enough — the scheduler reads from
  // that Map, so we must reload after persist.
  it('reloads the in-memory recurring-templates scheduler so generated occurrences stop using the deleted category id', async () => {
    seedConfig();
    // Seed storage with a recurring template under the custom cat.
    persist(SK.RECURRING, {
      r1: {
        id: 'r1',
        type: 'expense',
        category: 'user_custom_xyz',
        amount: 10,
        description: 'Seed',
        tags: '',
        notes: '',
        startDate: '2026-01-01',
        endDate: '2099-12-31',
        recurringType: 'monthly',
        originalDayOfMonth: 1,
        active: true
      }
    });
    mockLoadRecurring.mockClear();

    await deleteCategoryWithCleanup('user_custom_xyz');

    // The persisted store is remapped (covered by the test above). This
    // test's payload is the IN-MEMORY side: `loadRecurringTemplates` must
    // be called inside the cleanup so the scheduler's internal Map is
    // rehydrated from the just-persisted SK.RECURRING shape — otherwise
    // the scheduler keeps emitting under the deleted category id until
    // a page reload.
    expect(mockLoadRecurring).toHaveBeenCalled();

    // Consistency sanity check — the persisted store is remapped so the
    // scheduler will see fallback-id templates when it reads the Map.
    const round = getStored<Record<string, { category?: string }>>(SK.RECURRING);
    expect(round.r1?.category).toBe('other');
  });

  it('does NOT reload the recurring-templates scheduler when no recurring template referenced the deleted category', async () => {
    seedConfig();
    persist(SK.RECURRING, {
      r1: { id: 'r1', category: 'food', amount: 10 }
    });
    mockLoadRecurring.mockClear();

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recurringMigrated).toBe(0);

    // Nothing to remap → no wasted in-memory reload.
    expect(mockLoadRecurring).not.toHaveBeenCalled();
  });

  // ----- Transactions migration + note annotation ------------------------
  it('routes referenced transactions through dataSdk.replaceAllTransactions with the fallback id and appends an audit note', async () => {
    seedConfig();
    signals.transactions.value = [
      makeTx({ __backendId: 'tx_a', category: 'user_custom_xyz', notes: 'bought a keyboard' }),
      makeTx({ __backendId: 'tx_b', category: 'food' }),
      makeTx({ __backendId: 'tx_c', category: 'user_custom_xyz', notes: '' })
    ];

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.txMigrated).toBe(2);
      expect(outcome.deletedCatName).toBe('Piano Lessons');
      expect(outcome.fallbackCatId).toBe('other');
    }

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [rewritten] = mockReplace.mock.calls[0] as [Transaction[]];
    expect(rewritten).toHaveLength(3);
    const byId = Object.fromEntries(rewritten.map(t => [t.__backendId, t]));
    expect(byId.tx_a?.category).toBe('other');
    expect(byId.tx_a?.notes).toMatch(/bought a keyboard/);
    expect(byId.tx_a?.notes).toMatch(/\[Original Category: Piano Lessons\]/);
    expect(byId.tx_b?.category).toBe('food'); // untouched
    expect(byId.tx_c?.category).toBe('other');
    // An empty prior notes doesn't produce a leading newline.
    expect(byId.tx_c?.notes).toBe('[Original Category: Piano Lessons]');
  });

  it('skips the transaction batch entirely when no transaction references the deleted category', async () => {
    seedConfig();
    signals.transactions.value = [makeTx({ __backendId: 'tx_a', category: 'food' })];

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.txMigrated).toBe(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ----- Atomicity (CR-Apr22-D finding #4 subsumed) ----------------------
  it('on replaceAllTransactions failure, leaves ALL side stores (USER_CATS, alloc, templates, rollover, recurring) untouched', async () => {
    seedConfig();
    signals.transactions.value = [makeTx({ __backendId: 'tx_a', category: 'user_custom_xyz' })];
    signals.monthlyAlloc.value = { '2026-01': { user_custom_xyz: 100, food: 50 } };
    signals.txTemplates.value = [makeTemplate({ id: 'tpl_a', category: 'user_custom_xyz' })];
    signals.rolloverSettings.value = {
      enabled: true, mode: 'selected',
      categories: ['user_custom_xyz', 'food'],
      maxRollover: null, negativeHandling: 'zero'
    };
    persist(SK.RECURRING, { r1: { id: 'r1', category: 'user_custom_xyz' } });

    mockReplace.mockResolvedValueOnce({ isOk: false, error: 'Storage write failed' });

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe('tx_persist_failed');

    // USER_CATS — still present.
    expect(userCategoryConfig.value?.expense.find(c => c.id === 'user_custom_xyz')).toBeDefined();
    // Allocations — unchanged.
    expect(signals.monthlyAlloc.value['2026-01']).toEqual({ user_custom_xyz: 100, food: 50 });
    // Templates — unchanged.
    expect(signals.txTemplates.value[0]?.category).toBe('user_custom_xyz');
    // Rollover — unchanged.
    expect(signals.rolloverSettings.value.categories).toEqual(['user_custom_xyz', 'food']);
    // Recurring — unchanged.
    expect(getStored<Record<string, { category?: string }>>(SK.RECURRING).r1?.category).toBe('user_custom_xyz');
  });

  // ----- Composite end-to-end -------------------------------------------
  it('end-to-end: sweeps every referencing store and returns a complete summary', async () => {
    seedConfig();
    signals.transactions.value = [
      makeTx({ __backendId: 'tx_a', category: 'user_custom_xyz' }),
      makeTx({ __backendId: 'tx_b', category: 'user_custom_xyz' }),
      makeTx({ __backendId: 'tx_c', category: 'food' })
    ];
    signals.monthlyAlloc.value = {
      '2026-01': { user_custom_xyz: 100 },
      '2026-02': { user_custom_xyz: 150 },
      '2026-03': { user_custom_xyz: 200 }
    };
    signals.txTemplates.value = [makeTemplate({ category: 'user_custom_xyz' })];
    signals.rolloverSettings.value = {
      enabled: true, mode: 'selected',
      categories: ['user_custom_xyz'],
      maxRollover: null, negativeHandling: 'zero'
    };
    persist(SK.RECURRING, {
      r1: { id: 'r1', category: 'user_custom_xyz' },
      r2: { id: 'r2', category: 'food' }
    });

    const outcome = await deleteCategoryWithCleanup('user_custom_xyz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome).toMatchObject({
        ok: true,
        deletedCatId: 'user_custom_xyz',
        deletedCatName: 'Piano Lessons',
        catType: 'expense',
        fallbackCatId: 'other',
        fallbackCatName: 'Other',
        txMigrated: 2,
        templatesMigrated: 1,
        recurringMigrated: 1,
        allocationMonthsStripped: 3,
        rolloverStripped: true
      });
    }

    // Category gone from USER_CATS.
    expect(userCategoryConfig.value?.expense.find(c => c.id === 'user_custom_xyz')).toBeUndefined();
  });
});
