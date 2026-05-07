/**
 * Locking tests for `CreateTransactionOperation` and
 * `BulkCreateTransactionsOperation` rollback correctness — new batch P2.
 *
 * Defect: when `dataManager.create()` / `createBatch()` short-circuited
 * on the idempotency guard (a row with the same `__backendId` was
 * already persisted), the operation's rollback path happily called
 * `delete()` on a row that pre-dated the operation, silently destroying
 * data the operation never created.
 *
 * Fix contract — pinned here:
 *   - `dataManager.create()` returns `{ alreadyExisted: true }` on
 *     idempotent hit. `CreateTransactionOperation.rollback()` must be a
 *     no-op in that case.
 *   - `dataManager.createBatch()` returns `data` scoped to the subset
 *     that was *actually persisted* (drafts whose `__backendId` did not
 *     already exist). `BulkCreateTransactionsOperation.rollback()`
 *     deletes only that subset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockStorageMap } = vi.hoisted(() => ({
  mockStorageMap: new Map<string, string>(),
}));

vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/state.js')>(
    '../js/modules/core/state.js'
  );
  const lsGet = vi.fn((key: string, fallback: unknown) => {
    const stored = mockStorageMap.get(key);
    if (stored === undefined) return fallback;
    try {
      return JSON.parse(stored);
    } catch {
      return fallback;
    }
  });
  const lsSet = vi.fn((key: string, value: unknown) => {
    mockStorageMap.set(key, JSON.stringify(value));
    return true;
  });
  return {
    ...actual,
    lsGet,
    lsSet,
    getStored: vi.fn((key: string, fallback?: unknown) => lsGet(key, fallback)),
  };
});

vi.mock('../js/modules/data/storage-manager.js', () => ({
  storageManager: {
    init: vi.fn(async () => ({ isOk: false })),
    isUsingIndexedDB: vi.fn(() => false),
    replaceTransactionWithSplits: vi.fn(async () => true),
  },
  STORES: { TRANSACTIONS: 'transactions' },
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  on: vi.fn(),
  Events: {
    TRANSACTION_ADDED: 'tx:added',
    TRANSACTION_UPDATED: 'tx:updated',
    TRANSACTION_DELETED: 'tx:deleted',
    TRANSACTIONS_BATCH_ADDED: 'tx:batch:added',
    TRANSACTION_ROLLBACK_BATCH: 'tx:rollback:batch',
  },
}));

vi.mock('../js/modules/core/data-sync-interface.js', () => ({
  DataSyncEvents: {
    REQUEST_RELOAD: 'data:request:reload',
    REQUEST_APPLY_DELTA: 'data:request:apply_delta',
    REQUEST_SYNC: 'data:request:sync',
    SYNC_COMPLETE: 'data:sync:complete',
    SYNC_ERROR: 'data:sync:error',
    TRANSACTION_UPDATED: 'data:transaction:updated',
    TRANSACTION_DELTA_APPLIED: 'data:transaction:delta_applied',
    BULK_UPDATE: 'data:bulk:update',
  },
  notifyDataSyncComplete: vi.fn(),
  notifyDataSyncError: vi.fn(),
}));

import { DataManager } from '../js/modules/data/data-manager.js';
import {
  CreateTransactionOperation,
  BulkCreateTransactionsOperation,
} from '../js/modules/data/transaction-operations.js';
import { lsGet } from '../js/modules/core/state.js';
import type { Transaction, DataHandler } from '../js/types/index.js';

const SK_TX = 'harbor_transactions';

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: overrides.__backendId ?? `tx_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 10,
    category: 'food',
    description: 'Test',
    date: '2026-03-15',
    currency: 'USD',
    recurring: false,
    reconciled: true,
    splits: false,
    ...overrides,
  };
}

function makeHandler(): DataHandler {
  return { onDataChanged: vi.fn() };
}

describe('CreateTransactionOperation — idempotent rollback correctness', () => {
  let dm: DataManager;

  beforeEach(async () => {
    mockStorageMap.clear();
    vi.clearAllMocks();
    mockStorageMap.set(SK_TX, JSON.stringify([]));
    dm = new DataManager();
    await dm.init(makeHandler());
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockStorageMap.clear();
  });

  it('returns alreadyExisted=false for a fresh create, and rollback deletes the row', async () => {
    // Drive the operation only — a prior dm.create() would have already
    // persisted the row, and the operation's own create call would then
    // see an idempotent hit and correctly refuse to roll back.
    const tx = makeTx();
    const op = new CreateTransactionOperation(dm, tx);
    const created = await op.execute();

    expect(created.__backendId).toBeTruthy();
    expect((lsGet(SK_TX, []) as Transaction[])).toHaveLength(1);

    await op.rollback();
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(0);
  });

  it('does NOT delete a pre-existing row on rollback when dataManager.create short-circuits idempotently', async () => {
    const fixedId = 'tx_preexisting_123';
    const preexisting = makeTx({ __backendId: fixedId, description: 'PRE-EXISTING' });
    // Row was persisted by something else (e.g. a prior successful attempt)
    mockStorageMap.set(SK_TX, JSON.stringify([preexisting]));

    // Rebuild dm so its cache sees the pre-seeded row.
    dm = new DataManager();
    await dm.init(makeHandler());

    const op = new CreateTransactionOperation(dm, makeTx({
      __backendId: fixedId,
      description: 'RETRY-ATTEMPT',
    }));

    await op.execute();
    await op.rollback();

    // Critical: the pre-existing row must still be there. A naive
    // rollback that deletes the row whose __backendId matches would
    // destroy user data on any outer-transaction abort.
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(expect.objectContaining({
      __backendId: fixedId,
      description: 'PRE-EXISTING',
    }));
  });

  it('surfaces alreadyExisted=true on the dataManager.create() return when idempotency guard triggers', async () => {
    const fixedId = 'tx_idem_456';
    mockStorageMap.set(SK_TX, JSON.stringify([makeTx({ __backendId: fixedId })]));

    dm = new DataManager();
    await dm.init(makeHandler());

    const result = await dm.create(makeTx({ __backendId: fixedId }));
    expect(result.isOk).toBe(true);
    expect(result.alreadyExisted).toBe(true);
  });
});

describe('BulkCreateTransactionsOperation — rollback scoped to persisted subset', () => {
  let dm: DataManager;

  beforeEach(async () => {
    mockStorageMap.clear();
    vi.clearAllMocks();
    mockStorageMap.set(SK_TX, JSON.stringify([]));
    dm = new DataManager();
    await dm.init(makeHandler());
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockStorageMap.clear();
  });

  it('createBatch returns data scoped to the freshly-persisted subset only', async () => {
    const preexistingId = 'tx_bulk_pre_1';
    mockStorageMap.set(SK_TX, JSON.stringify([
      makeTx({ __backendId: preexistingId, description: 'PRE-EXISTING' }),
    ]));

    dm = new DataManager();
    await dm.init(makeHandler());

    const drafts = [
      makeTx({ __backendId: preexistingId, description: 'RETRY' }),   // already persisted
      makeTx({ __backendId: 'tx_bulk_new_a', description: 'NEW-A' }), // fresh
      makeTx({ __backendId: 'tx_bulk_new_b', description: 'NEW-B' }), // fresh
    ];

    const result = await dm.createBatch(drafts);
    expect(result.isOk).toBe(true);
    expect(result.alreadyExisted).toBe(true);
    expect(result.data).toHaveLength(2);
    const ids = (result.data ?? []).map(t => t.__backendId).sort();
    expect(ids).toEqual(['tx_bulk_new_a', 'tx_bulk_new_b']);
  });

  it('rollback deletes only freshly-persisted rows, leaving the pre-existing row intact', async () => {
    const preexistingId = 'tx_bulk_pre_2';
    const preexisting = makeTx({ __backendId: preexistingId, description: 'PRE-EXISTING' });
    mockStorageMap.set(SK_TX, JSON.stringify([preexisting]));

    dm = new DataManager();
    await dm.init(makeHandler());

    const drafts = [
      makeTx({ __backendId: preexistingId, description: 'RETRY' }),
      makeTx({ __backendId: 'tx_bulk_fresh_x', description: 'FRESH-X' }),
      makeTx({ __backendId: 'tx_bulk_fresh_y', description: 'FRESH-Y' }),
    ];

    const op = new BulkCreateTransactionsOperation(dm, drafts);
    await op.execute();

    const afterExecute = lsGet(SK_TX, []) as Transaction[];
    expect(afterExecute).toHaveLength(3);

    await op.rollback();

    const stored = lsGet(SK_TX, []) as Transaction[];
    // Pre-existing row must still be there — only fresh rows get unwound.
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(expect.objectContaining({
      __backendId: preexistingId,
      description: 'PRE-EXISTING',
    }));
  });

  it('createBatch returns alreadyExisted=false when every draft is fresh', async () => {
    const result = await dm.createBatch([
      makeTx({ __backendId: 'tx_fresh_1' }),
      makeTx({ __backendId: 'tx_fresh_2' }),
    ]);
    expect(result.isOk).toBe(true);
    expect(result.alreadyExisted).toBe(false);
    expect(result.data).toHaveLength(2);
  });

  it('createBatch returns empty data (no deletes on rollback) when every draft was already persisted', async () => {
    const ids = ['tx_all_pre_1', 'tx_all_pre_2'];
    mockStorageMap.set(SK_TX, JSON.stringify(ids.map(id => makeTx({ __backendId: id }))));

    dm = new DataManager();
    await dm.init(makeHandler());

    const op = new BulkCreateTransactionsOperation(
      dm,
      ids.map(id => makeTx({ __backendId: id, description: 'RETRY' }))
    );

    await op.execute();
    await op.rollback();

    // All pre-existing rows survive — rollback was a no-op.
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(2);
  });
});
