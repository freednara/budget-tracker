import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ==========================================
// MOCKS (must be declared before module imports)
// ==========================================
//
// M26 (rev 12): mock event-bus + error-tracker so the
// `reportDemoLoadPartialFailure` describe block can assert SHOW_TOAST
// emission and trackError routing without pulling in the live pub/sub.
// Mock dataSdk so `rollbackDemoTransactions` can exercise isOk/error/throw
// paths deterministically. `buildDemoProfile` does not use these modules,
// so its existing coverage is unaffected.
// `importOriginal` preserves `on`, `off`, `clear`, etc. that transitive
// imports (`ui.ts`, modal helpers) pull from the bus. We override only
// `emit` with a spy so the helper tests can assert its call log without
// regressing unrelated subscriptions.
vi.mock('../js/modules/core/event-bus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/core/event-bus.js')>();
  return {
    ...actual,
    emit: vi.fn(),
  };
});

vi.mock('../js/modules/core/error-tracker.js', () => ({
  trackError: vi.fn(),
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    delete: vi.fn(),
    createBatch: vi.fn(),
  },
}));

// CR-Apr22-F slice 4: rollbackDemoSeed composes several destructive
// helpers from the recurring-templates, debt-planner, and state-actions
// modules. Mock them surgically — preserving unrelated exports via
// importOriginal — so tests can assert on call ordering and per-target
// failure semantics without wiring the underlying signal mutations.
vi.mock('../js/modules/data/recurring-templates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/data/recurring-templates.js')>();
  return {
    ...actual,
    deleteRecurringTemplate: vi.fn(),
    createRecurringTemplate: vi.fn(),
    getRecurringTemplates: vi.fn(() => []),
  };
});

vi.mock('../js/modules/features/financial/debt-planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/features/financial/debt-planner.js')>();
  return {
    ...actual,
    addDebt: vi.fn(),
    recordPayment: vi.fn(),
    removeDebt: vi.fn(),
  };
});

vi.mock('../js/modules/core/state-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/core/state-actions.js')>();
  return {
    ...actual,
    savingsGoals: {
      ...actual.savingsGoals,
      addGoal: vi.fn(),
      addContribution: vi.fn(),
      deleteGoal: vi.fn(),
    },
    data: {
      ...actual.data,
      setMonthlyAllocations: vi.fn(),
      setTxTemplates: vi.fn(),
    },
  };
});

vi.mock('../js/modules/core/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../js/modules/core/state.js')>();
  return {
    ...actual,
    persist: vi.fn(),
  };
});

// ==========================================
// IMPORTS (after mocks)
// ==========================================

import {
  buildDemoProfile,
  rollbackDemoTransactions,
  rollbackDemoSeed,
  reportDemoLoadPartialFailure,
  type DemoLoadSummary,
  type DemoLoadResourceLog,
} from '../js/modules/orchestration/sample-data.js';
import { emit, Events } from '../js/modules/core/event-bus.js';
import { trackError } from '../js/modules/core/error-tracker.js';
import { dataSdk } from '../js/modules/data/data-manager.js';
import { deleteRecurringTemplate } from '../js/modules/data/recurring-templates.js';
import { removeDebt } from '../js/modules/features/financial/debt-planner.js';
import { savingsGoals as savingsGoalsActions, data as dataActions } from '../js/modules/core/state-actions.js';
import { persist, SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import type { Transaction, MonthlyAllocation, TxTemplate } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function makeTx(id: string): Transaction {
  return {
    __backendId: id,
    type: 'expense',
    amount: 10,
    date: '2026-03-01',
    category: 'food',
    description: `tx ${id}`,
  } as Transaction;
}

// ==========================================
// buildDemoProfile
// ==========================================

describe('buildDemoProfile', () => {
  it('creates a deterministic full demo account shape', () => {
    const referenceDate = new Date(2026, 2, 20);
    const first = buildDemoProfile(referenceDate);
    const second = buildDemoProfile(referenceDate);

    expect(second).toEqual(first);
    expect(first.transactions.length).toBeGreaterThan(80);
    expect(first.savingsGoals).toHaveLength(2);
    expect(first.debts).toHaveLength(2);
    expect(first.txTemplates).toHaveLength(2);
    expect(first.recurringTemplates).toHaveLength(6);
    expect(first.monthlyAllocations['2026-03']).toMatchObject({
      bills: 1830,
      food: 679,
      debt_payment: 348
    });
    expect(first.transactions.some((tx) => tx.__backendId.startsWith('demo_tx_'))).toBe(true);
    expect(first.transactions.some((tx) => tx.tags?.includes('demo_profile'))).toBe(true);
  });

  it('does not create future-dated current-month transactions', () => {
    const profile = buildDemoProfile(new Date(2026, 2, 20));
    const currentMonthTransactions = profile.transactions.filter((tx) => tx.date.startsWith('2026-03-'));

    expect(currentMonthTransactions.length).toBeGreaterThan(0);
    currentMonthTransactions.forEach((tx) => {
      const day = Number(tx.date.slice(-2));
      expect(day).toBeLessThanOrEqual(20);
    });
  });
});

// ==========================================
// rollbackDemoTransactions (M26)
// ==========================================
//
// M26 (rev 12) added a rollback path to `loadSampleData` so that an
// unexpected failure in the seeder phase doesn't leave the user wedged
// behind the `hasExistingDemoProfile()` guard-veto. The helper must
// survive per-transaction failures (both `isOk:false` results and thrown
// exceptions) without aborting — callers treat the `{removed, failed}`
// counts as telemetry in the failure toast, so skipping rows is NOT
// acceptable. These tests lock in that the loop walks every transaction
// regardless of what `dataSdk.delete` does on any individual call.

describe('rollbackDemoTransactions (M26)', () => {
  const mockedDelete = vi.mocked(dataSdk.delete);

  beforeEach(() => {
    mockedDelete.mockReset();
  });

  it('is a no-op for an empty input array (nothing to roll back)', async () => {
    const result = await rollbackDemoTransactions([]);

    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('counts every ok result toward removed when all deletes succeed', async () => {
    mockedDelete.mockResolvedValue({ isOk: true });

    const txs = [makeTx('a'), makeTx('b'), makeTx('c')];
    const result = await rollbackDemoTransactions(txs);

    expect(result).toEqual({ removed: 3, failed: 0 });
    expect(mockedDelete).toHaveBeenCalledTimes(3);
  });

  it('counts isOk:false results as failed without aborting the loop', async () => {
    mockedDelete.mockResolvedValue({ isOk: false, error: 'not found' });

    const txs = [makeTx('a'), makeTx('b')];
    const result = await rollbackDemoTransactions(txs);

    expect(result).toEqual({ removed: 0, failed: 2 });
    // Critical: second delete was still attempted after first failed
    expect(mockedDelete).toHaveBeenCalledTimes(2);
  });

  it('tallies mixed success/failure across a batch without losing any', async () => {
    mockedDelete
      .mockResolvedValueOnce({ isOk: true })
      .mockResolvedValueOnce({ isOk: false })
      .mockResolvedValueOnce({ isOk: true })
      .mockResolvedValueOnce({ isOk: false });

    const txs = [makeTx('a'), makeTx('b'), makeTx('c'), makeTx('d')];
    const result = await rollbackDemoTransactions(txs);

    expect(result).toEqual({ removed: 2, failed: 2 });
    expect(mockedDelete).toHaveBeenCalledTimes(4);
  });

  it('treats a thrown exception from dataSdk.delete as a failure, not an abort', async () => {
    // Critical invariant: rollback runs in a catch block during the
    // user-visible failure path — a thrown exception mid-rollback must not
    // bubble and re-throw. Every tx must get its chance, even after a throw.
    mockedDelete
      .mockResolvedValueOnce({ isOk: true })
      .mockRejectedValueOnce(new Error('IDB connection lost'))
      .mockResolvedValueOnce({ isOk: true });

    const txs = [makeTx('a'), makeTx('b'), makeTx('c')];
    const result = await rollbackDemoTransactions(txs);

    expect(result).toEqual({ removed: 2, failed: 1 });
    expect(mockedDelete).toHaveBeenCalledTimes(3);
  });

  it('keeps walking even when every call throws (no silent early-return)', async () => {
    mockedDelete.mockRejectedValue(new Error('storage gone'));

    const txs = [makeTx('a'), makeTx('b'), makeTx('c')];
    const result = await rollbackDemoTransactions(txs);

    expect(result).toEqual({ removed: 0, failed: 3 });
    expect(mockedDelete).toHaveBeenCalledTimes(3);
  });
});

// ==========================================
// reportDemoLoadPartialFailure (M26)
// ==========================================
//
// M26 (rev 12) surfaced a silent partial-failure bug in the demo-seed
// phase: `loadSampleData` was swallowing individual seeder failures via
// `Promise.all`, so a partially-broken demo profile would still surface a
// success toast. This helper takes the aggregated `DemoLoadSummary` and
// (a) emits a warning toast with concrete failure counts + a first-three
// preview, (b) routes an aggregated Error through trackError for
// production telemetry. Tests lock in both sides of that contract so
// future refactors can't quietly regress either.
//
// Helper shape mirrors M12's `reportImportValidationRejections`: same
// preview cap (3), same fingerprint-sample cap (10), same "no-op on
// zero failures" contract.

describe('reportDemoLoadPartialFailure (M26)', () => {
  const mockedEmit = vi.mocked(emit);
  const mockedTrackError = vi.mocked(trackError);

  beforeEach(() => {
    mockedEmit.mockClear();
    mockedTrackError.mockClear();
  });

  function summaryWith(
    overrides: Partial<DemoLoadSummary> = {}
  ): DemoLoadSummary {
    return {
      transactionCount: 100,
      goals: { created: 0, failed: [] },
      debts: { created: 0, failed: [] },
      recurring: { created: 0, failed: [] },
      ...overrides,
    };
  }

  it('is a no-op when every seeder succeeded (clean loads pay no UX cost)', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        goals: { created: 2, failed: [] },
        debts: { created: 2, failed: [] },
        recurring: { created: 2, failed: [] },
      })
    );

    expect(mockedEmit).not.toHaveBeenCalled();
    expect(mockedTrackError).not.toHaveBeenCalled();
  });

  it('emits SHOW_TOAST with a warning type and the total failure count', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        goals: {
          created: 1,
          failed: [{ name: 'Emergency Fund', reason: 'IDB write rejected' }],
        },
        debts: {
          created: 1,
          failed: [{ name: 'Visa', reason: 'duplicate key' }],
        },
      })
    );

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    const firstEmit = mockedEmit.mock.calls[0];
    if (!firstEmit) throw new Error('expected emit to have been called');
    const [eventName, payload] = firstEmit;
    expect(eventName).toBe(Events.SHOW_TOAST);
    expect(payload).toMatchObject({ type: 'warning' });
    const message = (payload as { message: string }).message;
    expect(message).toContain('Demo loaded with 2 issues skipped');
    expect(message).toContain('Emergency Fund — IDB write rejected');
    expect(message).toContain('Visa — duplicate key');
  });

  it('pluralizes "issue" correctly for a single failure', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        goals: {
          created: 1,
          failed: [{ name: 'Emergency Fund', reason: 'boom' }],
        },
      })
    );

    const payload = mockedEmit.mock.calls[0]?.[1] as { message: string };
    expect(payload.message).toContain('Demo loaded with 1 issue skipped');
    expect(payload.message).not.toContain('1 issues skipped');
  });

  it('caps the toast preview at three rows with a "+N more" suffix', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        goals: {
          created: 0,
          failed: [
            { name: 'g1', reason: 'r1' },
            { name: 'g2', reason: 'r2' },
            { name: 'g3', reason: 'r3' },
            { name: 'g4', reason: 'r4' }, // should NOT appear in preview
            { name: 'g5', reason: 'r5' },
          ],
        },
      })
    );

    const payload = mockedEmit.mock.calls[0]?.[1] as { message: string };
    expect(payload.message).toContain('g1 — r1');
    expect(payload.message).toContain('g2 — r2');
    expect(payload.message).toContain('g3 — r3');
    expect(payload.message).not.toContain('g4 — r4');
    expect(payload.message).not.toContain('g5 — r5');
    expect(payload.message).toContain('(+2 more)');
  });

  it('routes an Error through trackError with module=SampleData and the demo_load action', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        transactionCount: 87,
        goals: { created: 1, failed: [{ name: 'Emergency', reason: 'rA' }] },
        debts: { created: 0, failed: [{ name: 'Visa', reason: 'rB' }] },
        recurring: { created: 1, failed: [{ name: 'Rent', reason: 'rC' }] },
      })
    );

    expect(mockedTrackError).toHaveBeenCalledTimes(1);
    const firstTrack = mockedTrackError.mock.calls[0];
    if (!firstTrack) throw new Error('expected trackError to have been called');
    const [err, context] = firstTrack;
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // Per-seeder breakdown + total transactions is present so telemetry
    // can dashboard the dominant seeder without needing to parse reasons
    expect(message).toContain('1g');
    expect(message).toContain('1d');
    expect(message).toContain('1r');
    expect(message).toContain('87');
    expect(context).toMatchObject({
      module: 'SampleData',
      action: 'demo_load_partial_failure',
    });
  });

  it('samples the first 10 reasons into the Error message (M28 fingerprint discipline)', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      name: `row_${i}`,
      reason: `reason_${i}`,
    }));

    reportDemoLoadPartialFailure(
      summaryWith({
        goals: { created: 0, failed: fifteen },
      })
    );

    const err = mockedTrackError.mock.calls[0]?.[0] as Error;
    for (let i = 0; i < 10; i++) {
      expect(err.message).toContain(`reason_${i}`);
    }
    // 11th onward NOT sampled — keeps fingerprint stable even when reasons
    // flap, per M28
    expect(err.message).not.toContain('reason_10');
    expect(err.message).not.toContain('reason_14');
  });

  it('aggregates failures across all three seeders (not just one source)', () => {
    reportDemoLoadPartialFailure(
      summaryWith({
        goals: {
          created: 0,
          failed: [{ name: 'Goal A', reason: 'rA' }],
        },
        debts: {
          created: 0,
          failed: [{ name: 'Debt B', reason: 'rB' }],
        },
        recurring: {
          created: 0,
          failed: [{ name: 'Recurring C', reason: 'rC' }],
        },
      })
    );

    const payload = mockedEmit.mock.calls[0]?.[1] as { message: string };
    expect(payload.message).toContain('3 issues skipped');
    expect(payload.message).toContain('Goal A');
    expect(payload.message).toContain('Debt B');
    expect(payload.message).toContain('Recurring C');
  });
});

// ==========================================
// rollbackDemoSeed (CR-Apr22-F slice 4)
// ==========================================
//
// CR-Apr22-F slice 4 (Finding 9 P2): the previous `loadSampleData` catch
// block rolled back ONLY the initial batch-created transactions, leaving
// allocations, tx-templates, successfully-seeded goals, debts, and
// recurring templates in place. The user saw a "rollback" toast while
// the account stayed partially seeded — and subsequent retries could
// either be vetoed by `hasExistingDemoProfile()` (once txs were
// re-created) or silently duplicate recurring templates (Finding 10).
//
// `rollbackDemoSeed` composes the full unwind — recurring first (so the
// cascade through `deleteRecurringTemplate(id, true)` cleans occurrence
// txs before the tx-batch rollback), then debts + payment txs, then
// goals + contribution txs, then the two snapshot restores, then the
// initial batch-tx rollback. These tests lock in the contract that:
//   1. Every tracked id gets visited even when an earlier one fails.
//   2. Associated transactions are filtered correctly by `debtId` and
//      by the `[id:goalId]` + savings-transfer marker combo.
//   3. Snapshot restore routes through `setMonthlyAllocations` +
//      `setTxTemplates` + `persist(SK.ALLOC)` + `persist(SK.TX_TEMPLATES)`.
//   4. `rollbackDemoTransactions` is still called for the initial batch
//      so the composite is a strict superset of the old behavior.

describe('rollbackDemoSeed (CR-Apr22-F slice 4)', () => {
  const mockedDelete = vi.mocked(dataSdk.delete);
  const mockedDeleteRecurring = vi.mocked(deleteRecurringTemplate);
  const mockedRemoveDebt = vi.mocked(removeDebt);
  const mockedDeleteGoal = vi.mocked(savingsGoalsActions.deleteGoal);
  const mockedSetMonthlyAllocations = vi.mocked(dataActions.setMonthlyAllocations);
  const mockedSetTxTemplates = vi.mocked(dataActions.setTxTemplates);
  const mockedPersist = vi.mocked(persist);

  const originalTransactionsSignal = signals.transactions.value;

  beforeEach(() => {
    mockedDelete.mockReset();
    mockedDelete.mockResolvedValue({ isOk: true });
    mockedDeleteRecurring.mockReset();
    // CR-Apr24-B [P2] finding 41: deleteRecurringTemplate now returns
    // a structured DeleteRecurringTemplateResult, not a boolean.
    mockedDeleteRecurring.mockResolvedValue({ ok: true, toDeleteCount: 0, deletedCount: 0, failures: [] });
    mockedRemoveDebt.mockReset();
    mockedRemoveDebt.mockReturnValue(true);
    mockedDeleteGoal.mockReset();
    mockedDeleteGoal.mockReturnValue(true);
    mockedSetMonthlyAllocations.mockReset();
    mockedSetTxTemplates.mockReset();
    mockedPersist.mockReset();

    // Reset the signal used by payment/contribution filters. Tests that
    // need population install their own fixture; cleanup restores the
    // original value so other test files are unaffected.
    signals.transactions.value = [];
  });

  // Restore the global signal after each test so cross-file leakage is
  // impossible. The setup above already clobbers per test; restoring
  // to the ambient baseline at teardown is the safety net for other
  // test files that import signals in their own context.
  afterAll(() => {
    signals.transactions.value = originalTransactionsSignal;
  });

  function makeAllocTx(id: string, overrides: Partial<Transaction> = {}): Transaction {
    return {
      __backendId: id,
      type: 'expense',
      amount: 100,
      date: '2026-04-01',
      category: 'demo',
      description: `tx ${id}`,
      ...overrides,
    } as Transaction;
  }

  function makeLog(overrides: Partial<DemoLoadResourceLog> = {}): DemoLoadResourceLog {
    return {
      goalIds: [],
      debtIds: [],
      recurringIds: [],
      ...overrides,
    };
  }

  const emptyAlloc: Record<string, MonthlyAllocation> = {};
  const emptyTxTemplates: TxTemplate[] = [];

  it('no-op shape when the log is empty and no created txs were captured', async () => {
    const result = await rollbackDemoSeed({
      log: makeLog(),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(result).toEqual({ txRemoved: 0, txFailed: 0, entitiesRemoved: 0, entitiesFailed: 0 });
    expect(mockedDeleteRecurring).not.toHaveBeenCalled();
    expect(mockedRemoveDebt).not.toHaveBeenCalled();
    expect(mockedDeleteGoal).not.toHaveBeenCalled();
    // Snapshot restore still runs — it's an idempotent "set to empty"
    // in this fixture.
    expect(mockedSetTxTemplates).toHaveBeenCalledWith([]);
    expect(mockedSetMonthlyAllocations).toHaveBeenCalledWith({});
    expect(mockedPersist).toHaveBeenCalledWith(SK.TX_TEMPLATES, expect.anything());
    expect(mockedPersist).toHaveBeenCalledWith(SK.ALLOC, expect.anything());
  });

  it('cascades recurring-template deletion with deleteExisting=true', async () => {
    const result = await rollbackDemoSeed({
      log: makeLog({ recurringIds: ['rec_a', 'rec_b'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(mockedDeleteRecurring).toHaveBeenCalledTimes(2);
    expect(mockedDeleteRecurring).toHaveBeenCalledWith('rec_a', true);
    expect(mockedDeleteRecurring).toHaveBeenCalledWith('rec_b', true);
    expect(result.entitiesRemoved).toBe(2);
  });

  it('filters debt payment transactions by tx.debtId, then removes the debt', async () => {
    signals.transactions.value = [
      makeAllocTx('unrelated_a'),
      makeAllocTx('payment_1', { debtId: 'debt_visa' }),
      makeAllocTx('payment_2', { debtId: 'debt_visa' }),
      makeAllocTx('payment_3', { debtId: 'debt_other' }),
    ];

    await rollbackDemoSeed({
      log: makeLog({ debtIds: ['debt_visa'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    // Both `payment_1` and `payment_2` should be deleted; unrelated +
    // debt_other ones must not be touched.
    const deletedIds = mockedDelete.mock.calls.map(
      ([tx]: [Transaction]) => tx.__backendId
    );
    expect(deletedIds).toEqual(['payment_1', 'payment_2']);
    expect(mockedRemoveDebt).toHaveBeenCalledWith('debt_visa');
  });

  it('filters goal contribution transactions by notes marker, then deletes the goal', async () => {
    signals.transactions.value = [
      makeAllocTx('unrelated', { notes: 'something else' }),
      makeAllocTx('contrib_1', {
        notes: '[savings-transfer] Contribution to goal: Japan Trip [id:sg_japan]'
      }),
      makeAllocTx('contrib_2', {
        notes: '[savings-transfer] Contribution to goal: Emergency [id:sg_emergency]'
      }),
    ];

    await rollbackDemoSeed({
      log: makeLog({ goalIds: ['sg_japan'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    const deletedIds = mockedDelete.mock.calls.map(
      ([tx]: [Transaction]) => tx.__backendId
    );
    expect(deletedIds).toEqual(['contrib_1']);
    expect(mockedDeleteGoal).toHaveBeenCalledWith('sg_japan');
  });

  it('restores allocation and tx-template snapshots via setMonthlyAllocations/setTxTemplates + persist', async () => {
    const allocSnapshot: Record<string, MonthlyAllocation> = {
      '2026-03': { food: 400 } as MonthlyAllocation,
    };
    const templatesSnapshot: TxTemplate[] = [
      { id: 't1', name: 'Coffee', type: 'expense', category: 'food', amount: 5 } as TxTemplate,
    ];

    await rollbackDemoSeed({
      log: makeLog(),
      createdTransactions: [],
      allocationsSnapshot: allocSnapshot,
      txTemplatesSnapshot: templatesSnapshot,
    });

    expect(mockedSetMonthlyAllocations).toHaveBeenCalledTimes(1);
    expect(mockedSetMonthlyAllocations).toHaveBeenCalledWith({ '2026-03': { food: 400 } });
    expect(mockedSetTxTemplates).toHaveBeenCalledTimes(1);
    expect(mockedSetTxTemplates).toHaveBeenCalledWith([
      { id: 't1', name: 'Coffee', type: 'expense', category: 'food', amount: 5 },
    ]);
    expect(mockedPersist).toHaveBeenCalledWith(SK.TX_TEMPLATES, expect.anything());
    expect(mockedPersist).toHaveBeenCalledWith(SK.ALLOC, expect.anything());
  });

  it('still calls rollbackDemoTransactions for the initial batch (composite is a superset)', async () => {
    const createdTxs = [makeAllocTx('batch_1'), makeAllocTx('batch_2')];

    const result = await rollbackDemoSeed({
      log: makeLog(),
      createdTransactions: createdTxs,
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(mockedDelete).toHaveBeenCalledTimes(2);
    expect(mockedDelete).toHaveBeenCalledWith(createdTxs[0]);
    expect(mockedDelete).toHaveBeenCalledWith(createdTxs[1]);
    expect(result.txRemoved).toBe(2);
    expect(result.txFailed).toBe(0);
  });

  it('counts entitiesFailed and keeps walking when a mid-loop deletion throws', async () => {
    // CR-Apr24-B [P2] finding 41: structured result type. The "throws"
    // case is covered by .mockRejectedValueOnce — caller's try/catch
    // catches it as before.
    const ok = { ok: true, toDeleteCount: 0, deletedCount: 0, failures: [] };
    mockedDeleteRecurring
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error('IDB lost'))
      .mockResolvedValueOnce(ok);

    const result = await rollbackDemoSeed({
      log: makeLog({ recurringIds: ['rec_a', 'rec_b', 'rec_c'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(mockedDeleteRecurring).toHaveBeenCalledTimes(3);
    expect(result.entitiesRemoved).toBe(2);
    expect(result.entitiesFailed).toBe(1);
  });

  it('treats deleteGoal returning false (goal not found) as an entitiesFailed count', async () => {
    mockedDeleteGoal.mockReturnValue(false);

    const result = await rollbackDemoSeed({
      log: makeLog({ goalIds: ['sg_missing'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(result.entitiesRemoved).toBe(0);
    expect(result.entitiesFailed).toBe(1);
  });

  it('treats removeDebt returning false (debt not found) as an entitiesFailed count', async () => {
    mockedRemoveDebt.mockReturnValue(false);

    const result = await rollbackDemoSeed({
      log: makeLog({ debtIds: ['debt_missing'] }),
      createdTransactions: [],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    expect(result.entitiesRemoved).toBe(0);
    expect(result.entitiesFailed).toBe(1);
  });

  it('runs recurring cleanup BEFORE the createBatch tx cleanup', async () => {
    // The ordering invariant exists because `deleteRecurringTemplate(id, true)`
    // cascades spawned occurrence txs out of `signals.transactions`, and we
    // don't want those flagged against `rollbackDemoTransactions` which is
    // scoped to the explicit batch payload.
    const callLog: string[] = [];
    mockedDeleteRecurring.mockImplementation(async () => {
      callLog.push('deleteRecurringTemplate');
      return { ok: true, toDeleteCount: 0, deletedCount: 0, failures: [] };
    });
    mockedDelete.mockImplementation(async () => {
      callLog.push('dataSdk.delete');
      return { isOk: true };
    });

    await rollbackDemoSeed({
      log: makeLog({ recurringIds: ['rec_1'] }),
      createdTransactions: [makeAllocTx('batch_1')],
      allocationsSnapshot: emptyAlloc,
      txTemplatesSnapshot: emptyTxTemplates,
    });

    const recurringAt = callLog.indexOf('deleteRecurringTemplate');
    const batchAt = callLog.indexOf('dataSdk.delete');
    expect(recurringAt).toBeGreaterThanOrEqual(0);
    expect(batchAt).toBeGreaterThanOrEqual(0);
    expect(recurringAt).toBeLessThan(batchAt);
  });
});
