/**
 * debt-planner — `getDebtPaymentCategoryId` existence guard
 * (CR-Apr22-B slice 3, Finding #2).
 *
 * The prior implementation was a simple preset → hardcoded-id map that
 * never consulted the live category config. Three failure modes produced
 * phantom category ids on newly-recorded debt payments (transactions
 * rendering as "Unknown ❓"):
 *
 *   1. User deletes `debt_payment` via category-manager. Slice 1's
 *      `deleteCategoryWithCleanup` remapped EXISTING transactions to the
 *      fallback, but `recordPayment` kept routing new transactions to the
 *      now-phantom id because the resolver didn't re-check existence.
 *   2. `userCategoryConfig.presetId` is something not in `DEBT_PAYMENT_IDS`
 *      (future preset, or corrupted value). The hardcoded fallback
 *      `'debt_payment'` is the personal-preset id, so on
 *      business/household/freelance configs the fallback itself is phantom.
 *   3. Cross-preset leakage: the in-config debt_payment id doesn't match
 *      the preset name (e.g. `debt_payment_hh` under `presetId: 'personal'`
 *      following a failed switch).
 *
 * This file locks down the new multi-tier resolver:
 *   A. Preset-mapped id present  → return it (hidden OK — data integrity
 *      is preserved; visibility is orthogonal).
 *   B. Cross-preset debt_payment* → use the id that IS in config.
 *   C. Visible `other*` fallback  → parity with `pickFallbackCategoryId`.
 *   D. First visible expense cat  → last reasonable visible choice.
 *   E. All hidden, expense non-empty → first expense cat regardless.
 *   F. Zero expense cats          → return preset-mapped id (upstream will
 *      explicit-fail on category-not-found).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SK, persist } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import {
  deleteCategoryWithCleanup,
  userCategoryConfig,
} from '../js/modules/core/category-store.js';
import { getDebtPaymentCategoryId } from '../js/modules/features/financial/debt-planner.js';
import type {
  RolloverSettings,
  Transaction,
  UserCategoryConfig,
} from '../js/types/index.js';

// ---------------------------------------------------------------------------
// data-manager stub — only `replaceAllTransactions` is exercised, by the one
// integration test at the bottom of this file that runs the full
// delete-then-record flow.
// ---------------------------------------------------------------------------
const mockReplace = vi.fn();

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    replaceAllTransactions: (...args: unknown[]) => mockReplace(...args),
  },
}));

// Spread vi.importActual so SK.RECURRING writes inside
// deleteCategoryWithCleanup don't crash on `loadRecurringTemplates`
// (memory: feedback_test_mock_drift).
vi.mock('../js/modules/data/recurring-templates.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/data/recurring-templates.js')>(
    '../js/modules/data/recurring-templates.js'
  );
  return {
    ...actual,
    loadRecurringTemplates: () => {
      actual.loadRecurringTemplates();
    }
  };
});

// ---------------------------------------------------------------------------
// Config fixtures — one per preset, plus helpers for targeted
// deletion/mutation to drive the tier fall-through behavior.
// ---------------------------------------------------------------------------
function seedPersonal(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#b', type: 'expense', order: 1 },
      { id: 'other', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 },
      { id: 'debt_payment', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense', order: 3 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
      { id: 'other_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
    ]
  };
  userCategoryConfig.value = cfg;
  persist(SK.USER_CATS, cfg);
  return cfg;
}

function seedHousehold(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'household',
    version: 1,
    expense: [
      { id: 'groceries_hh', name: 'Groceries', emoji: '🛒', color: '#a', type: 'expense', order: 0 },
      { id: 'rent_hh', name: 'Rent', emoji: '🏠', color: '#b', type: 'expense', order: 1 },
      { id: 'other_hh', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 },
      { id: 'debt_payment_hh', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense', order: 3 }
    ],
    income: [
      { id: 'salary_hh', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
      { id: 'other_hh_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
    ]
  };
  userCategoryConfig.value = cfg;
  persist(SK.USER_CATS, cfg);
  return cfg;
}

function seedBusiness(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'business',
    version: 1,
    expense: [
      { id: 'payroll', name: 'Payroll', emoji: '👥', color: '#a', type: 'expense', order: 0 },
      { id: 'other_biz', name: 'Other', emoji: '📦', color: '#b', type: 'expense', order: 1 },
      { id: 'debt_payment_biz', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense', order: 2 }
    ],
    income: [
      { id: 'revenue', name: 'Revenue', emoji: '💰', color: '#e', type: 'income', order: 0 }
    ]
  };
  userCategoryConfig.value = cfg;
  persist(SK.USER_CATS, cfg);
  return cfg;
}

function seedFreelancer(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'freelancer',
    version: 1,
    expense: [
      { id: 'taxes_fl', name: 'Taxes', emoji: '🏛️', color: '#a', type: 'expense', order: 0 },
      { id: 'other_fl', name: 'Other', emoji: '📦', color: '#b', type: 'expense', order: 1 },
      { id: 'debt_payment_fl', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense', order: 2 }
    ],
    income: [
      { id: 'gigs_fl', name: 'Gigs', emoji: '💰', color: '#e', type: 'income', order: 0 }
    ]
  };
  userCategoryConfig.value = cfg;
  persist(SK.USER_CATS, cfg);
  return cfg;
}

function dropExpenseCategory(targetId: string): void {
  const cfg = userCategoryConfig.value;
  if (!cfg) return;
  const next: UserCategoryConfig = {
    ...cfg,
    expense: cfg.expense.filter(c => c.id !== targetId)
  };
  userCategoryConfig.value = next;
  persist(SK.USER_CATS, next);
}

function hideExpenseCategory(targetId: string): void {
  const cfg = userCategoryConfig.value;
  if (!cfg) return;
  const next: UserCategoryConfig = {
    ...cfg,
    expense: cfg.expense.map(c => c.id === targetId ? { ...c, hidden: true } : c)
  };
  userCategoryConfig.value = next;
  persist(SK.USER_CATS, next);
}

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
  } as RolloverSettings;
  signals.transactions.value = [];
  mockReplace.mockReset();
  mockReplace.mockResolvedValue({ isOk: true, data: [] });
}

beforeEach(() => resetState());
afterEach(() => {
  vi.restoreAllMocks();
  resetState();
});

// ---------------------------------------------------------------------------
// Tier A — preset-mapped id present (happy path)
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — Tier A (preset-mapped id present)', () => {
  it('returns `debt_payment` for the personal preset', () => {
    seedPersonal();
    expect(getDebtPaymentCategoryId()).toBe('debt_payment');
  });

  it('returns `debt_payment_hh` for the household preset', () => {
    seedHousehold();
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_hh');
  });

  it('returns `debt_payment_biz` for the business preset', () => {
    seedBusiness();
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_biz');
  });

  it('returns `debt_payment_fl` for the freelancer preset', () => {
    seedFreelancer();
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_fl');
  });

  it('returns the id even when hidden — visibility is orthogonal to data integrity', () => {
    seedPersonal();
    hideExpenseCategory('debt_payment');

    // The id is still the correct routing target. A hidden category just
    // means the UI filters it out of lists; the transaction record itself
    // remains sound and will re-surface the moment the user unhides it.
    expect(getDebtPaymentCategoryId()).toBe('debt_payment');
  });
});

// ---------------------------------------------------------------------------
// Tier B — cross-preset debt_payment* salvage
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — Tier B (cross-preset debt_payment* salvage)', () => {
  it('uses the available debt_payment* id when preset-mapped id is missing', () => {
    // User is on household, but somehow the personal-preset debt_payment
    // crept in instead of debt_payment_hh (common after a failed/partial
    // applyPreset or a hand-edited import).
    seedHousehold();
    const cfg = userCategoryConfig.value!;
    const swapped: UserCategoryConfig = {
      ...cfg,
      expense: cfg.expense.map(c =>
        c.id === 'debt_payment_hh'
          ? { id: 'debt_payment', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense' as const, order: c.order }
          : c
      )
    };
    userCategoryConfig.value = swapped;

    expect(getDebtPaymentCategoryId()).toBe('debt_payment');
  });

  it('picks the first debt_payment* id when multiple alternates exist', () => {
    seedPersonal();
    const cfg = userCategoryConfig.value!;
    const next: UserCategoryConfig = {
      ...cfg,
      expense: [
        ...cfg.expense.filter(c => c.id !== 'debt_payment'),
        { id: 'debt_payment_hh', name: 'Debt Payments HH', emoji: '💳', color: '#ef4444', type: 'expense', order: 99 },
        { id: 'debt_payment_biz', name: 'Debt Payments BIZ', emoji: '💳', color: '#ef4444', type: 'expense', order: 100 }
      ]
    };
    userCategoryConfig.value = next;

    // Implementation uses `Array.find`, which returns the first match in
    // insertion order. `debt_payment_hh` comes first in our expense list.
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_hh');
  });

  it('handles an unknown preset id by falling back to debt_payment* scan', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'custom_preset_name_that_is_not_mapped',
      version: 1,
      expense: [
        { id: 'coffee', name: 'Coffee', emoji: '☕', color: '#a', type: 'expense', order: 0 },
        { id: 'debt_payment_biz', name: 'Debt Payments', emoji: '💳', color: '#ef4444', type: 'expense', order: 1 }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;

    // DEBT_PAYMENT_IDS has no `custom_preset_name_that_is_not_mapped` entry,
    // so the hardcoded fallback `'debt_payment'` is used — that isn't in the
    // config either, so Tier B kicks in and finds `debt_payment_biz`.
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_biz');
  });
});

// ---------------------------------------------------------------------------
// Tier C — visible `other*` fallback
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — Tier C (visible other* fallback)', () => {
  it('routes to visible `other` after all debt_payment* categories are gone', () => {
    seedPersonal();
    dropExpenseCategory('debt_payment');
    expect(getDebtPaymentCategoryId()).toBe('other');
  });

  it('routes to the preset-specific `other_hh` on household preset', () => {
    seedHousehold();
    dropExpenseCategory('debt_payment_hh');
    expect(getDebtPaymentCategoryId()).toBe('other_hh');
  });

  it('skips hidden `other*` and falls through to next visible cat', () => {
    seedPersonal();
    dropExpenseCategory('debt_payment');
    hideExpenseCategory('other');
    // `other` exists but hidden → Tier C passes, Tier D picks first visible.
    expect(getDebtPaymentCategoryId()).toBe('food');
  });
});

// ---------------------------------------------------------------------------
// Tier D/E — generic visible / first-expense-cat fallback
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — Tier D/E (first-expense fallback)', () => {
  it('routes to first visible expense cat when no debt_payment* or other* exists', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [
        { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
        { id: 'transport', name: 'Transport', emoji: '🚗', color: '#b', type: 'expense', order: 1 }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;
    expect(getDebtPaymentCategoryId()).toBe('food');
  });

  it('returns first hidden expense cat when every expense cat is hidden', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'personal',
      version: 1,
      expense: [
        { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0, hidden: true },
        { id: 'transport', name: 'Transport', emoji: '🚗', color: '#b', type: 'expense', order: 1, hidden: true }
      ],
      income: []
    };
    userCategoryConfig.value = cfg;
    expect(getDebtPaymentCategoryId()).toBe('food');
  });
});

// ---------------------------------------------------------------------------
// Tier F — degenerate cases
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — Tier F (degenerate configs)', () => {
  it('returns the preset-mapped id when config is null (uninitialized)', () => {
    userCategoryConfig.value = null;
    // presetId defaults to 'personal' in the resolver.
    expect(getDebtPaymentCategoryId()).toBe('debt_payment');
  });

  it('returns the preset-mapped id when expense list is empty', () => {
    const cfg: UserCategoryConfig = {
      presetId: 'household',
      version: 1,
      expense: [],
      income: [{ id: 'salary_hh', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 }]
    };
    userCategoryConfig.value = cfg;
    // Nothing exists to resolve to; surface the preset-mapped id so the
    // upstream `dataSdk.create` call fails with an explicit
    // category-not-found rather than silently mis-assigning.
    expect(getDebtPaymentCategoryId()).toBe('debt_payment_hh');
  });

  it('returns `debt_payment` when presetId is missing and config has nothing useful', () => {
    // Cast through `unknown` — the UserCategoryConfig type requires
    // `presetId: string`, but on legacy/corrupted data the field may be
    // undefined. The resolver guards with `?? 'personal'`, so this test
    // exercises that guard.
    const cfg = {
      presetId: undefined,
      version: 1,
      expense: [],
      income: []
    } as unknown as UserCategoryConfig;
    userCategoryConfig.value = cfg;
    expect(getDebtPaymentCategoryId()).toBe('debt_payment');
  });
});

// ---------------------------------------------------------------------------
// Integration — after deleteCategoryWithCleanup, the resolver picks the
// same fallback id that the cleanup swept existing transactions into.
// ---------------------------------------------------------------------------
describe('getDebtPaymentCategoryId — integration with deleteCategoryWithCleanup', () => {
  it('after deleting debt_payment_hh on household, routes future payments to `other_hh`', async () => {
    seedHousehold();

    // Seed one existing debt-payment transaction so the cleanup sweep has
    // something to remap — mirrors real-world state where the user has
    // already recorded payments before deleting the category.
    const existingTx: Transaction = {
      __backendId: 'tx_existing_1',
      type: 'expense',
      category: 'debt_payment_hh',
      amount: 250,
      description: 'Mortgage payment',
      date: '2026-04-01',
      currency: 'USD',
      tags: 'debt,payment',
      recurring: false
    } as Transaction;
    signals.transactions.value = [existingTx];

    const outcome = await deleteCategoryWithCleanup('debt_payment_hh');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('cleanup bailed');
    expect(outcome.fallbackCatId).toBe('other_hh');
    expect(outcome.txMigrated).toBe(1);

    // Resolver now sees no `debt_payment_hh` → Tier C picks `other_hh`,
    // matching the fallback that the cleanup used for existing rows.
    expect(getDebtPaymentCategoryId()).toBe('other_hh');
  });

  it('after deleting debt_payment on personal, routes future payments to `other`', async () => {
    seedPersonal();
    signals.transactions.value = [];

    const outcome = await deleteCategoryWithCleanup('debt_payment');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('cleanup bailed');
    expect(outcome.fallbackCatId).toBe('other');

    expect(getDebtPaymentCategoryId()).toBe('other');
  });
});
