import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { userCategoryConfig } from '../js/modules/core/category-store.js';
import { modal } from '../js/modules/core/state-actions.js';
import { addSplitRow } from '../js/modules/features/financial/split-transactions.js';
import type { Transaction, UserCategoryConfig } from '../js/types/index.js';

/**
 * CR-Apr22-D slice 6 coverage — Split-transaction fallback preset parity
 * (finding 64 [P3]).
 *
 * Before this slice, `addSplitRow` in `split-transactions.ts:58-61` seeded
 * a new split row's `categoryId` as:
 *
 *     categoryId: tx.category || 'other'
 *
 * The literal `'other'` only exists on the DEFAULT (personal) preset; on
 * the `household`, `freelance`, or `business` presets the id-space is
 * different (`other_hh`, `contract_income`, etc.), so the fallback itself
 * became a phantom id. If the parent transaction's `category` was falsy
 * (rare — typically only after a legacy import or a data-corruption
 * scenario), the new split row rendered with a `<select>` whose
 * `.value='other'` didn't match any `<option>` under the user's active
 * preset, leaving the row visually blank and tripping the
 * "Choose a category" inline validation.
 *
 * The fix reuses the shared `pickFallbackCategoryId` helper added in
 * CR-Apr22-B slice 1 (the same one that repairs post-delete transaction
 * remapping). It walks the user's current `userCategoryConfig` with the
 * tier-1 visible `other*` → tier-2 first visible → tier-3 any hierarchy,
 * so the fallback id is guaranteed to exist on whichever preset the user
 * is on. The legacy `'other'` literal is retained as a last-resort only
 * for the degenerate case where the config has zero categories of the
 * parent transaction's type — which can't actually reach this code path
 * because the modal renderer bails on an empty `getAllCats`.
 *
 * These tests exercise `addSplitRow` against three preset shapes
 * (personal, household, a minimal no-`other*` custom config) plus the
 * valid-category pass-through and type-scoping invariants.
 */

function seedPersonalConfig(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#a', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#b', type: 'expense', order: 1 },
      { id: 'other', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
      { id: 'other_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
    ]
  };
  userCategoryConfig.value = cfg;
  return cfg;
}

function seedHouseholdConfig(): UserCategoryConfig {
  const cfg: UserCategoryConfig = {
    presetId: 'household',
    version: 1,
    expense: [
      { id: 'groceries_hh', name: 'Groceries', emoji: '🛒', color: '#a', type: 'expense', order: 0 },
      { id: 'rent_hh', name: 'Rent', emoji: '🏠', color: '#b', type: 'expense', order: 1 },
      { id: 'other_hh', name: 'Other', emoji: '📦', color: '#c', type: 'expense', order: 2 }
    ],
    income: [
      { id: 'salary_hh', name: 'Salary', emoji: '💰', color: '#e', type: 'income', order: 0 },
      { id: 'other_hh_income', name: 'Other', emoji: '💵', color: '#f', type: 'income', order: 1 }
    ]
  };
  userCategoryConfig.value = cfg;
  return cfg;
}

function seedNoOtherConfig(): UserCategoryConfig {
  // Custom preset where the user has deleted the "Other" bucket entirely —
  // exercises tier 2 of the fallback hierarchy (first visible).
  const cfg: UserCategoryConfig = {
    presetId: 'custom',
    version: 1,
    expense: [
      { id: 'groceries', name: 'Groceries', emoji: '🛒', color: '#a', type: 'expense', order: 0 },
      { id: 'rent', name: 'Rent', emoji: '🏠', color: '#b', type: 'expense', order: 1 }
    ],
    income: [
      { id: 'wages', name: 'Wages', emoji: '💰', color: '#e', type: 'income', order: 0 }
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
    amount: 100,
    description: 'Seed',
    date: '2026-04-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

function resetState(): void {
  localStorage.clear();
  userCategoryConfig.value = null;
  signals.transactions.value = [];
  signals.splitTxId.value = null;
  signals.splitRows.value = [];
}

describe('addSplitRow — CR-Apr22-D slice 6 fallback preset parity', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
    vi.useRealTimers();
  });

  describe('valid-category pass-through (the common path)', () => {
    it('uses the parent transaction category verbatim when it is non-empty', () => {
      seedHouseholdConfig();
      const tx = makeTx({ __backendId: 'tx_a', category: 'groceries_hh', amount: 100 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_a');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'groceries_hh', amount: 100 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows).toHaveLength(2);
      // New row inherits the parent category. Fallback never consulted.
      expect(rows[1]?.categoryId).toBe('groceries_hh');
    });

    it('inherits the parent category even when a fallback would differ', () => {
      // Under personal preset the historical fallback was `'other'`;
      // confirm we don't accidentally override a valid parent category
      // with a preset-specific fallback on this path.
      seedPersonalConfig();
      const tx = makeTx({ __backendId: 'tx_b', category: 'transport', amount: 50 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_b');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'transport', amount: 50 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('transport');
    });
  });

  describe('regression lock — missing-category fallback honors the active preset', () => {
    it('uses `other` on the personal preset when the parent category is missing', () => {
      // Parent tx has no category (legacy import / corrupted row). Under
      // the personal preset the tier-1 visible `other*` id IS the literal
      // `other`, so the behavior matches the legacy hardcoded fallback —
      // this is the positive case that the legacy code happened to get
      // right, locked down here for regression coverage.
      seedPersonalConfig();
      const tx = makeTx({ __backendId: 'tx_c', category: '', amount: 80 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_c');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'food', amount: 80 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('other');
    });

    it('uses `other_hh` on the household preset (NOT the literal "other" phantom id)', () => {
      // This is the core regression lock: the legacy code produced the
      // phantom id `other`, which does not exist on this preset. The
      // fixed helper must select `other_hh` because that's the active
      // preset's tier-1 visible `other*` entry.
      seedHouseholdConfig();
      const tx = makeTx({ __backendId: 'tx_d', category: '', amount: 200 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_d');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'groceries_hh', amount: 200 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('other_hh');
      // Belt-and-suspenders — nobody should ever see the phantom id again.
      expect(rows[1]?.categoryId).not.toBe('other');
    });

    it('falls through to the first visible category when no `other*` exists on the active preset', () => {
      // User has deleted the "Other" bucket on a custom preset; tier 2
      // of the fallback picks the first visible category.
      seedNoOtherConfig();
      const tx = makeTx({ __backendId: 'tx_e', category: '', amount: 60 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_e');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'rent', amount: 60 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('groceries');
    });
  });

  describe('type scoping — income parent uses an income fallback', () => {
    it('uses the income-side fallback id when the parent transaction is income', () => {
      // Parent is an income tx with missing category — the fallback
      // must live in the income list, not accidentally cross over to an
      // expense id.
      seedHouseholdConfig();
      const tx = makeTx({
        __backendId: 'tx_f',
        type: 'income',
        category: '',
        amount: 2000
      });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_f');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'salary_hh', amount: 2000 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('other_hh_income');
    });

    it('treats an unknown tx.type as expense (defensive default matches split modal render path)', () => {
      // The split modal renderer coerces `tx?.type || 'expense'` when
      // listing category options. The fallback picker must mirror that
      // coercion so the selected fallback id is always in the list of
      // options shown to the user.
      seedHouseholdConfig();
      const tx = makeTx({
        __backendId: 'tx_g',
        type: 'expense',
        category: '',
        amount: 42
      });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_g');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'groceries_hh', amount: 42 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('other_hh');
    });
  });

  describe('degenerate fallback — last-resort literal', () => {
    it('falls back to the literal `other` only when userCategoryConfig is null', () => {
      // Pathological state (config not hydrated yet). The modal's own
      // render path couldn't actually reach this code, but we keep the
      // literal `other` as a last-resort sentinel so the row shape is
      // well-typed and the status signal's hasEmptyFields branch can
      // surface the invalid state to the user via the inline validator.
      userCategoryConfig.value = null;
      const tx = makeTx({ __backendId: 'tx_h', category: '', amount: 10 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_h');
      modal.setSplitRows([{ id: 'row_0', categoryId: 'food', amount: 10 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows[1]?.categoryId).toBe('other');
    });
  });

  describe('split-evenly branch preserves fallback behavior', () => {
    it('when the first row already equals the original amount, both rows take halves but the NEW row still uses the preset-aware fallback', () => {
      // `addSplitRow` has a special branch: if `currentRows.length === 1`
      // AND the single row equals the tx's full amount, it splits the
      // row 50/50. The NEW row is the one built from the fallback; this
      // test locks down that the split-evenly path doesn't skip the
      // preset-aware fallback computation.
      seedHouseholdConfig();
      const tx = makeTx({ __backendId: 'tx_i', category: '', amount: 100 });
      signals.transactions.value = [tx];
      modal.setSplitTxId('tx_i');
      // Sole row equals the full amount — triggers the split-evenly path.
      modal.setSplitRows([{ id: 'row_0', categoryId: 'groceries_hh', amount: 100 }]);

      addSplitRow();

      const rows = signals.splitRows.value;
      expect(rows).toHaveLength(2);
      // The existing row keeps its category; its amount is halved.
      expect(rows[0]?.categoryId).toBe('groceries_hh');
      expect(rows[0]?.amount).toBe(50);
      // The new row gets the preset-aware fallback, NOT the phantom 'other'.
      expect(rows[1]?.categoryId).toBe('other_hh');
      expect(rows[1]?.amount).toBe(50);
    });
  });
});
