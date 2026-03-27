/**
 * Chaos Testing for Atomic Data Operations
 * Tests rollback capability when operations fail mid-transaction.
 *
 * Exercises DataManager's public API (create, update, delete, createBatch,
 * splitTransaction) which internally use _atomicOperation for mutex-guarded
 * retries and rollback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ==========================================
// MOCK SETUP  (vi.mock calls are hoisted)
// ==========================================

const { mockStorageMap } = vi.hoisted(() => {
  return { mockStorageMap: new Map<string, string>() };
});

vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/state.js')>('../js/modules/core/state.js');
  const lsGet = vi.fn((key: string, fallback: any) => {
    const stored = mockStorageMap.get(key);
    if (stored === undefined) return fallback;
    try {
      return JSON.parse(stored);
    } catch {
      return fallback;
    }
  });
  const lsSet = vi.fn((key: string, value: any) => {
    mockStorageMap.set(key, JSON.stringify(value));
    return true;
  });

  return {
    ...actual,
    lsGet,
    lsSet,
    getStored: vi.fn((key: string, fallback?: unknown) => lsGet(key, fallback))
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
    BULK_UPDATE: 'data:bulk:update'
  },
  notifyDataSyncComplete: vi.fn(),
  notifyDataSyncError: vi.fn(),
}));

import { DataManager } from '../js/modules/data/data-manager.js';
import { lsGet, lsSet } from '../js/modules/core/state.js';
import type { Transaction, DataHandler } from '../js/types/index.js';

const SK_TX = 'budget_tracker_transactions';

// ==========================================
// HELPERS
// ==========================================

function createTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 50,
    category: 'food',
    description: 'Test',
    date: '2024-01-15',
    currency: 'USD',
    recurring: false,
    reconciled: true,
    splits: false,
    ...overrides,
  };
}

function handler(): DataHandler {
  return { onDataChanged: vi.fn() };
}

// ==========================================
// CHAOS TESTS
// ==========================================

describe('Atomic Rollback Chaos Tests', () => {
  let dataManager: DataManager;

  beforeEach(async () => {
    mockStorageMap.clear();
    vi.clearAllMocks();

    // Seed with 3 initial transactions
    const seed: Transaction[] = [
      createTx({ __backendId: 'tx1', type: 'income', amount: 1000, date: '2024-01-01', category: 'salary' }),
      createTx({ __backendId: 'tx2', type: 'expense', amount: 100, date: '2024-01-02', category: 'food' }),
      createTx({ __backendId: 'tx3', type: 'expense', amount: 200, date: '2024-01-03', category: 'transport' }),
    ];
    mockStorageMap.set(SK_TX, JSON.stringify(seed));

    dataManager = new DataManager();
    await dataManager.init(handler());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================
  // CHAOS TEST: FAILURE AT DIFFERENT POINTS
  // ==========================================

  it('rolls back all changes when storage write fails on create', async () => {
    const initialStored = lsGet(SK_TX, []) as Transaction[];
    expect(initialStored).toHaveLength(3);

    const realImpl = vi.mocked(lsSet).getMockImplementation();
    vi.mocked(lsSet).mockImplementation(() => false);

    try {
      const result = await dataManager.create(
        createTx({ category: 'test1', amount: 50, date: '2024-01-04' })
      );

      expect(result.isOk).toBe(false);
      expect(result.error).toBe('Storage write failed');

      // Verify state hasn't changed (storage was never written)
      const finalStored = lsGet(SK_TX, []) as Transaction[];
      expect(finalStored).toHaveLength(3);
    } finally {
      if (realImpl) {
        vi.mocked(lsSet).mockImplementation(realImpl);
      }
    }
  });

  it('rolls back all changes when middle batch operation fails', async () => {
    const initialStored = lsGet(SK_TX, []) as Transaction[];
    expect(initialStored).toHaveLength(3);

    // Fail all retry attempts for createBatch
    vi.mocked(lsSet)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const batch = [
      createTx({ category: 'test1', amount: 50 }),
      createTx({ category: 'test2', amount: 60 }),
      createTx({ category: 'test3', amount: 70 }),
    ];

    const result = await dataManager.createBatch(batch);

    expect(result.isOk).toBe(false);

    // Verify original data is intact
    const finalStored = lsGet(SK_TX, []) as Transaction[];
    expect(finalStored).toHaveLength(3);
    expect(finalStored[1].amount).toBe(100); // Unchanged
  });

  it('rolls back all changes when last operation in sequence fails', async () => {
    // First create succeeds
    const tx1 = createTx({ category: 'test1', amount: 50 });
    const r1 = await dataManager.create(tx1);
    expect(r1.isOk).toBe(true);

    // Second create fails all retries
    vi.mocked(lsSet)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const tx2 = createTx({ category: 'test2', amount: 60 });
    const r2 = await dataManager.create(tx2);
    expect(r2.isOk).toBe(false);

    // Only the first create should have persisted (4 total = 3 seed + 1)
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(4);
    expect(stored.some((t: Transaction) => t.category === 'test1')).toBe(true);
    expect(stored.some((t: Transaction) => t.category === 'test2')).toBe(false);
  });

  // ==========================================
  // CHAOS TEST: CONCURRENT MODIFICATIONS
  // ==========================================

  it('handles concurrent modification during atomic operation', async () => {
    // Start two create operations simultaneously
    const tx1 = createTx({ category: 'concurrent1', amount: 50 });
    const tx2 = createTx({ category: 'concurrent2', amount: 60 });

    const [r1, r2] = await Promise.all([
      dataManager.create(tx1),
      dataManager.create(tx2),
    ]);

    // Both should succeed thanks to mutex serialisation
    expect(r1.isOk).toBe(true);
    expect(r2.isOk).toBe(true);

    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(5); // 3 seed + 2 new
  });

  // ==========================================
  // CHAOS TEST: PARTIAL STATE CORRUPTION
  // ==========================================

  it('recovers from partial state corruption', async () => {
    // Corrupt the storage
    mockStorageMap.set(SK_TX, 'CORRUPTED_NOT_JSON');

    // The data manager keeps using its cached ledger for hot mutations, so the
    // corrupt on-disk value should be overwritten by a valid ledger on write.
    const tx = createTx({ category: 'test1', amount: 50 });
    const result = await dataManager.create(tx);

    // Create should succeed and repair the stored snapshot.
    expect(result.isOk).toBe(true);

    // Storage should now have valid data
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(4);
  });

  // ==========================================
  // CHAOS TEST: OUT OF MEMORY SIMULATION
  // ==========================================

  it('handles out of memory/quota exceeded errors', async () => {
    // Make lsSet always fail (simulating quota exceeded)
    vi.mocked(lsSet).mockReturnValue(false);

    const hugeBatch = Array.from({ length: 100 }, (_, i) =>
      createTx({
        amount: Math.random() * 1000,
        date: '2024-01-15',
        category: 'test',
        description: 'x'.repeat(100),
      })
    );

    const result = await dataManager.createBatch(hugeBatch);

    expect(result.isOk).toBe(false);

    // Restore lsSet to verify original data
    vi.mocked(lsSet).mockImplementation((key: string, value: any) => {
      mockStorageMap.set(key, JSON.stringify(value));
      return true;
    });

    // Original data should be intact (lsSet never succeeded)
    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(3); // Only original 3
  });

  // ==========================================
  // CHAOS TEST: RANDOM FAILURE INJECTION
  // ==========================================

  it('survives random failure injection across many operations', { timeout: 15000 }, async () => {
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < 50; i++) {
      // Randomly inject failures (30% chance)
      if (Math.random() < 0.3) {
        // Fail all 3 retry attempts
        vi.mocked(lsSet)
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(false);
      }

      const tx = createTx({
        category: `chaos-${i}`,
        amount: Math.floor(Math.random() * 100) + 1, // Whole numbers to pass validation
        date: '2024-01-15',
      });

      const result = await dataManager.create(tx);

      if (result.isOk) {
        successCount++;
      } else {
        failCount++;
      }
    }

    // Should have processed all operations without crashing
    expect(successCount + failCount).toBe(50);

    // Final data should be structurally valid
    const finalData = lsGet(SK_TX, []) as Transaction[];
    expect(Array.isArray(finalData)).toBe(true);

    // Each stored transaction should have required fields
    finalData.forEach((tx: Transaction) => {
      expect(tx).toHaveProperty('__backendId');
      expect(tx).toHaveProperty('type');
      expect(tx).toHaveProperty('amount');
      expect(typeof tx.amount).toBe('number');
    });

    // Should have at least the seed data plus some successes
    expect(finalData.length).toBeGreaterThanOrEqual(3);
  });
});
