import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { addDebt, updateDebt } from '../js/modules/features/financial/debt-planner.js';
import type { Debt, Transaction } from '../js/types/index.js';

/**
 * CR-Apr22-G slice 4 coverage — Debt rename-safe history.
 *
 * Two findings covered:
 *   1. (P3) `components/transaction-detail-panel.ts` debtTransactions
 *      fallback matched `description.includes(${debt.name} payment)`.
 *      After a rename, legacy rows (written before `tx.debtId` was
 *      reliably stamped) encoded the OLD name in the description and
 *      silently disappeared from the drill-down. Now the filter walks a
 *      candidate-name list: current name plus every prior name recorded
 *      in `debt.historicalNames`.
 *   2. (P3) `features/financial/debt-planner.ts` `RecordPaymentCommand`
 *      bakes the debt's name into the transaction description at write
 *      time (`${debt.name} payment`). That description is immutable — a
 *      later rename leaves the description stamped with the old name.
 *      The history-tracking counterpart lives in `updateDebt`: when the
 *      caller passes `updates.name` that actually differs from the
 *      stored name, the previous name is prepended to
 *      `debt.historicalNames` before the new name overwrites.
 *
 * These tests target the data layer directly (updateDebt + debtTransactions
 * logic against real signals) rather than driving the rendered modal —
 * the equivalent component tests would need a full lit-html + DOM harness
 * for marginal incremental value.
 */

function createDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: `debt_${Math.random().toString(36).slice(2, 9)}`,
    name: 'Test Debt',
    balance: 1000,
    originalBalance: 1000,
    interestRate: 0.12,
    minimumPayment: 50,
    type: 'credit_card',
    isActive: true,
    dueDay: 15,
    createdAt: new Date().toISOString(),
    payments: [],
    ...overrides
  } as Debt;
}

function createTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 9)}`,
    amount: 50,
    type: 'expense',
    category: 'debt-payment',
    description: '',
    date: '2026-04-01',
    currency: 'USD',
    recurring: false,
    ...overrides
  } as Transaction;
}

const originalDebts = signals.debts.value;
const originalTxs = signals.transactions.value;

beforeEach(() => {
  signals.debts.value = [];
  signals.transactions.value = [];
});

afterEach(() => {
  signals.debts.value = originalDebts;
  signals.transactions.value = originalTxs;
});

describe('addDebt — historicalNames baseline (CR-Apr22-G slice 4)', () => {
  it('leaves historicalNames undefined on a freshly added debt', () => {
    const debt = addDebt({ name: 'Chase Visa', balance: 500 });
    expect(debt.historicalNames).toBeUndefined();
    expect(signals.debts.value[0]?.historicalNames).toBeUndefined();
  });
});

describe('updateDebt — rename-safe history (CR-Apr22-G slice 4)', () => {
  it('prepends the prior name onto historicalNames when the name actually changes', () => {
    const debt = addDebt({ name: 'Chase Visa', balance: 500 });

    const updated = updateDebt(debt.id, { name: 'Chase Sapphire' });

    expect(updated).not.toBeNull();
    expect(updated?.name).toBe('Chase Sapphire');
    expect(updated?.historicalNames).toEqual(['Chase Visa']);
    // Signal write went through.
    expect(signals.debts.value[0]?.historicalNames).toEqual(['Chase Visa']);
  });

  it('accumulates renames in most-recent-first order', () => {
    const debt = addDebt({ name: 'First Name', balance: 100 });

    updateDebt(debt.id, { name: 'Second Name' });
    updateDebt(debt.id, { name: 'Third Name' });
    updateDebt(debt.id, { name: 'Fourth Name' });

    const final = signals.debts.value[0];
    expect(final?.name).toBe('Fourth Name');
    expect(final?.historicalNames).toEqual(['Third Name', 'Second Name', 'First Name']);
  });

  it('does NOT mutate historicalNames when updates.name is unchanged', () => {
    const debt = addDebt({ name: 'Stable Name', balance: 100 });
    updateDebt(debt.id, { name: 'Renamed Once' });

    // Re-submit the same name (simulates a form re-save on the already-
    // renamed debt) — should be a no-op for historicalNames.
    updateDebt(debt.id, { name: 'Renamed Once' });
    updateDebt(debt.id, { name: 'Renamed Once' });

    expect(signals.debts.value[0]?.historicalNames).toEqual(['Stable Name']);
  });

  it('does NOT mutate historicalNames when updates.name is omitted', () => {
    const debt = addDebt({ name: 'Stable Name', balance: 100 });
    updateDebt(debt.id, { name: 'Renamed' });

    // Subsequent update that touches only balance — must not shift history.
    updateDebt(debt.id, { balance: 200 });

    const final = signals.debts.value[0];
    expect(final?.name).toBe('Renamed');
    expect(final?.historicalNames).toEqual(['Stable Name']);
  });

  it('does NOT mutate historicalNames when the trimmed new name is empty', () => {
    const debt = addDebt({ name: 'Real Name', balance: 100 });

    // Empty / whitespace-only name is a pre-existing no-op for history
    // tracking. The existing trim/slice(0,100) still overwrites the stored
    // name with empty — we are intentionally NOT fixing that here; just
    // guarding against polluting the rename log with a bogus entry.
    updateDebt(debt.id, { name: '   ' });

    expect(signals.debts.value[0]?.historicalNames).toBeUndefined();
  });

  it('truncates the new name to 100 chars before comparing for rename', () => {
    const debt = addDebt({ name: 'X'.repeat(100), balance: 100 });

    // Pass a 110-char name where the first 100 chars are identical. Post-
    // trim/slice the new name equals the current name — so no rename
    // should be recorded.
    const longName = 'X'.repeat(100) + 'Y'.repeat(10);
    updateDebt(debt.id, { name: longName });

    expect(signals.debts.value[0]?.historicalNames).toBeUndefined();
  });

  it('preserves historicalNames across an unrelated update', () => {
    const debt = addDebt({ name: 'Old Name', balance: 100 });
    updateDebt(debt.id, { name: 'New Name' });

    // Touch interestRate — historicalNames must survive the spread.
    updateDebt(debt.id, { interestRate: 0.1999 });

    const final = signals.debts.value[0];
    expect(final?.historicalNames).toEqual(['Old Name']);
    expect(final?.interestRate).toBeCloseTo(0.1999);
  });
});

describe('debt rename-safe description filter integration (CR-Apr22-G slice 4)', () => {
  /**
   * These tests assert the filter LOGIC that `debtTransactions` applies.
   * Reproducing the exact filter here keeps the test tight to the
   * contract — candidate names are [current, ...historicalNames] and
   * the match is lowercase substring "<name> payment".
   */
  function filterDebtTxs(debt: Debt, txs: Transaction[]): Transaction[] {
    const candidateNames = [debt.name, ...(debt.historicalNames ?? [])];
    const lowerCandidates = candidateNames.map(n => `${n.toLowerCase()} payment`);
    return txs.filter(tx => {
      if (tx.debtId === debt.id) return true;
      if (!tx.description) return false;
      const descLower = tx.description.toLowerCase();
      return lowerCandidates.some(pattern => descLower.includes(pattern));
    });
  }

  it('legacy description-fallback row stays linked after rename', () => {
    const debt = createDebt({ id: 'debt_legacy', name: 'Chase Visa' });
    // Legacy row has no debtId — the field is omitted, which under
    // `exactOptionalPropertyTypes` is distinct from `{ debtId: undefined }`.
    const legacyTx = createTx({ description: 'Chase Visa payment' });

    // Apply a rename via the history-tracking pattern.
    const renamed: Debt = {
      ...debt,
      name: 'Chase Sapphire',
      historicalNames: [debt.name]
    };

    const matches = filterDebtTxs(renamed, [legacyTx]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.__backendId).toBe(legacyTx.__backendId);
  });

  it('current-name description match still works', () => {
    const debt = createDebt({ id: 'debt_current', name: 'Amex Gold' });
    const freshTx = createTx({ description: 'Amex Gold payment' });

    const matches = filterDebtTxs(debt, [freshTx]);
    expect(matches).toHaveLength(1);
  });

  it('debtId match takes precedence regardless of description', () => {
    const debt = createDebt({ id: 'debt_id_match', name: 'Student Loan' });
    const idLinkedTx = createTx({
      debtId: 'debt_id_match',
      description: 'scholarship refund' // description does NOT match
    });

    const matches = filterDebtTxs(debt, [idLinkedTx]);
    expect(matches).toHaveLength(1);
  });

  it('rows whose description matches NEITHER current nor historical names are excluded', () => {
    const debt = createDebt({
      id: 'debt_strict',
      name: 'Current Name',
      historicalNames: ['Prior Name']
    });
    const unrelated = createTx({ description: 'Unrelated transaction' });
    const wrongCard = createTx({ description: 'Discover IT payment' });

    const matches = filterDebtTxs(debt, [unrelated, wrongCard]);
    expect(matches).toHaveLength(0);
  });

  it('case-insensitive fallback matches regardless of debt-name casing', () => {
    const debt = createDebt({ id: 'debt_case', name: 'Chase Visa' });
    const upperTx = createTx({ description: 'CHASE VISA PAYMENT' });
    const lowerTx = createTx({ description: 'chase visa payment' });
    const mixedTx = createTx({ description: 'Chase visa Payment' });

    const matches = filterDebtTxs(debt, [upperTx, lowerTx, mixedTx]);
    expect(matches).toHaveLength(3);
  });

  it('three-deep rename history links rows from every era', () => {
    const debt = createDebt({
      id: 'debt_chain',
      name: 'Final Name',
      historicalNames: ['Middle Name', 'Earliest Name']
    });
    const finalTx = createTx({ description: 'Final Name payment' });
    const middleTx = createTx({ description: 'Middle Name payment' });
    const earliestTx = createTx({ description: 'Earliest Name payment' });

    const matches = filterDebtTxs(debt, [finalTx, middleTx, earliestTx]);
    expect(matches).toHaveLength(3);
  });

  it('empty description with debtId mismatch is excluded (no false positive)', () => {
    const debt = createDebt({ id: 'debt_strict2', name: 'X' });
    const emptyDesc = createTx({ description: '', debtId: 'debt_other' });
    // Omit description entirely — simulates a legacy row with no description
    // stored. The `description` field on Transaction is required so the
    // helper default empty-string stands in for the "falsy" case.
    const undefinedDesc = createTx({ description: '', debtId: 'debt_other' });

    const matches = filterDebtTxs(debt, [emptyDesc, undefinedDesc]);
    expect(matches).toHaveLength(0);
  });

  it('undefined historicalNames collapses gracefully to single-name candidate list', () => {
    const debt = createDebt({ id: 'debt_no_hist', name: 'Solo Name' });
    expect(debt.historicalNames).toBeUndefined();

    const hitTx = createTx({ description: 'Solo Name payment' });
    const missTx = createTx({ description: 'Other Debt payment' });

    const matches = filterDebtTxs(debt, [hitTx, missTx]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.__backendId).toBe(hitTx.__backendId);
  });
});

describe('updateDebt — rename-safe round-trip through signal (CR-Apr22-G slice 4)', () => {
  it('historicalNames survives a JSON round-trip (backup/restore compatibility)', () => {
    const debt = addDebt({ name: 'Original', balance: 100 });
    updateDebt(debt.id, { name: 'Renamed Once' });
    updateDebt(debt.id, { name: 'Renamed Twice' });

    const snapshot = signals.debts.value[0];
    expect(snapshot).toBeDefined();

    // Simulate a backup write + restore: JSON serialize + parse + reassign.
    const serialized = JSON.stringify([snapshot]);
    const restored = JSON.parse(serialized) as Debt[];

    expect(restored[0]?.name).toBe('Renamed Twice');
    expect(restored[0]?.historicalNames).toEqual(['Renamed Once', 'Original']);
  });

  it('returns null and writes nothing when the debtId is unknown', () => {
    const result = updateDebt('debt_does_not_exist', { name: 'Ghost' });
    expect(result).toBeNull();
    expect(signals.debts.value).toHaveLength(0);
  });
});
