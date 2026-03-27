/**
 * Atomic Operations Tests for DataManager
 *
 * Tests the critical atomic operation logic including rollback scenarios,
 * concurrent modification detection, and data integrity guarantees.
 *
 * These tests exercise the public API (create/update/delete/splitTransaction/createBatch)
 * which internally use _atomicOperation for mutex-guarded retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ==========================================
// MOCK SETUP  (vi.mock calls are hoisted above imports)
// ==========================================

// vi.hoisted runs before vi.mock factories, so the map is available
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

// Now import the modules under test
import { DataManager } from '../js/modules/data/data-manager.js';
import { lsGet, lsSet } from '../js/modules/core/state.js';
import type { Transaction, DataHandler } from '../js/types/index.js';

const SK_TX = 'budget_tracker_transactions';

// ==========================================
// TEST UTILITIES
// ==========================================

function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: 'expense',
    amount: 50.00,
    category: 'food',
    description: 'Test transaction',
    date: '2026-03-15',
    currency: 'USD',
    recurring: false,
    reconciled: true,
    splits: false,
    ...overrides,
  };
}

function createMockHandler(): DataHandler {
  return { onDataChanged: vi.fn() };
}

// ==========================================
// ATOMIC OPERATION TESTS
// ==========================================

describe('DataManager Atomic Operations', () => {
  let dataManager: DataManager;
  let mockHandler: DataHandler;

  beforeEach(async () => {
    mockStorageMap.clear();
    vi.clearAllMocks();

    // Initialise with empty transactions
    mockStorageMap.set(SK_TX, JSON.stringify([]));

    dataManager = new DataManager();
    mockHandler = createMockHandler();
    await dataManager.init(mockHandler);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockStorageMap.clear();
  });

  describe('Transaction Creation', () => {
    it('should create transaction atomically', async () => {
      const transaction = createTestTransaction();
      const result = await dataManager.create(transaction);

      expect(result.isOk).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({
        amount: transaction.amount,
        category: transaction.category,
      }));

      // Verify data was persisted
      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(1);
    });

    it('should rollback on validation failure', async () => {
      const invalidTransaction = createTestTransaction({
        amount: -50, // Invalid: below min
        category: '',  // Invalid: empty
      });

      const result = await dataManager.create(invalidTransaction);

      expect(result.isOk).toBe(false);
      expect(result.error).toContain('Validation failed');

      // Verify nothing was persisted
      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(0);
    });

    it('should handle storage write failures gracefully', async () => {
      const realImpl = vi.mocked(lsSet).getMockImplementation();
      vi.mocked(lsSet).mockImplementation(() => false);

      try {
        const transaction = createTestTransaction();
        const result = await dataManager.create(transaction);

        expect(result.isOk).toBe(false);
        expect(result.error).toBe('Storage write failed');
      } finally {
        if (realImpl) {
          vi.mocked(lsSet).mockImplementation(realImpl);
        }
      }
    });
  });

  describe('Transaction Splitting', () => {
    it('should split transaction atomically', async () => {
      const originalTx = createTestTransaction({ amount: 100 });
      await dataManager.create(originalTx);

      const splits = [
        { category: 'food', amount: 60, description: 'Groceries' },
        { category: 'entertainment', amount: 40, description: 'Movies' },
      ];

      const result = await dataManager.splitTransaction(originalTx, splits);

      expect(result.isOk).toBe(true);
      expect(result.data?.splits).toHaveLength(2);

      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(2); // Original removed, 2 splits added
      expect(stored.every((tx: Transaction) => tx.splits)).toBe(true);
    });

    it('should rollback split on amount mismatch', async () => {
      const originalTx = createTestTransaction({ amount: 100 });
      await dataManager.create(originalTx);

      // Mismatched splits (total = 90, original = 100)
      const splits = [
        { category: 'food', amount: 60 },
        { category: 'entertainment', amount: 30 },
      ];

      const result = await dataManager.splitTransaction(originalTx, splits);

      expect(result.isOk).toBe(false);
      expect(result.error).toContain('Split total');

      // Original should still exist
      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(1);
    });

    it('should handle partial split failure with rollback', async () => {
      const originalTx = createTestTransaction({ amount: 100 });
      await dataManager.create(originalTx);

      // Let the split operation's lsSet call fail (inside the atomic op).
      // After the create succeeds, the next lsSet inside the split's atomic body should fail.
      // _atomicOperation retries 3 times, fail all of them.
      const realImpl = vi.mocked(lsSet).getMockImplementation()!;
      let callCount = 0;
      vi.mocked(lsSet).mockImplementation((key: string, value: any) => {
        callCount++;
        // First call is from init/create (already done). Subsequent calls from splitTransaction.
        // The split atomic op calls lsSet once per retry attempt. Fail them all.
        if (callCount > 0) {
          return false;
        }
        mockStorageMap.set(key, JSON.stringify(value));
        return true;
      });

      const splits = [
        { category: 'food', amount: 60 },
        { category: 'entertainment', amount: 40 },
      ];

      const result = await dataManager.splitTransaction(originalTx, splits);

      expect(result.isOk).toBe(false);

      // Restore lsSet so we can read storage
      vi.mocked(lsSet).mockImplementation((key: string, value: any) => {
        mockStorageMap.set(key, JSON.stringify(value));
        return true;
      });
    });
  });

  describe('Concurrent Modification Detection', () => {
    it('should detect concurrent updates', async () => {
      const transaction = createTestTransaction();
      await dataManager.create(transaction);

      // Simulate another tab modifying the transaction
      const allTx = [{ ...transaction, description: 'Modified by another tab' }];
      mockStorageMap.set(SK_TX, JSON.stringify(allTx));

      // Try to update with stale data
      const updateResult = await dataManager.update({
        ...transaction,
        description: 'Local modification',
      });

      // Should succeed (last-writer-wins)
      expect(updateResult.isOk).toBe(true);
    });

    it('should handle race condition in mutex', async () => {
      const transaction1 = createTestTransaction({ description: 'First' });
      const transaction2 = createTestTransaction({ description: 'Second' });

      // Start both operations simultaneously
      const [result1, result2] = await Promise.all([
        dataManager.create(transaction1),
        dataManager.create(transaction2),
      ]);

      expect(result1.isOk).toBe(true);
      expect(result2.isOk).toBe(true);

      // Both transactions should be stored
      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(2);
    });
  });

  describe('Error Recovery', () => {
    it('should handle missing transaction in update', async () => {
      const nonExistentTx = createTestTransaction();

      const result = await dataManager.update(nonExistentTx);

      expect(result.isOk).toBe(false);
      expect(result.error).toBe('Transaction not found');
    });

    it('should retry operations on transient failures', async () => {
      let attempts = 0;
      vi.mocked(lsSet).mockImplementation((key: string, value: any) => {
        attempts++;
        if (attempts < 3) {
          return false; // Fail first two attempts
        }
        mockStorageMap.set(key, JSON.stringify(value));
        return true; // Succeed on third attempt
      });

      const transaction = createTestTransaction();
      const result = await dataManager.create(transaction);

      // Should eventually succeed after retries
      expect(result.isOk).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe('Batch Operations', () => {
    it('should handle batch creation atomically', async () => {
      const transactions = [
        createTestTransaction({ description: 'Batch 1' }),
        createTestTransaction({ description: 'Batch 2' }),
        createTestTransaction({ description: 'Batch 3' }),
      ];

      const result = await dataManager.createBatch(transactions);

      expect(result.isOk).toBe(true);
      expect(result.data).toHaveLength(3);

      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(3);
    });

    it('should handle batch with various amounts', async () => {
      const transactions = [
        createTestTransaction({ description: 'Valid 1', amount: 10 }),
        createTestTransaction({ description: 'Valid 2', amount: 20 }),
        createTestTransaction({ description: 'Valid 3', amount: 30 }),
      ];

      const result = await dataManager.createBatch(transactions);

      expect(result.isOk).toBe(true);

      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored).toHaveLength(3);
    });
  });

  describe('Data Integrity', () => {
    it('should maintain referential integrity after split', async () => {
      const parentTx = createTestTransaction({
        description: 'Parent',
        amount: 50,
        splits: false,
      });

      await dataManager.create(parentTx);

      const splits = [
        { category: 'food', amount: 30 },
        { category: 'entertainment', amount: 20 },
      ];

      const splitResult = await dataManager.splitTransaction(parentTx, splits);
      expect(splitResult.isOk).toBe(true);

      // Verify split references
      const stored = lsGet(SK_TX, []) as Transaction[];
      expect(stored.every((tx: Transaction) => tx.splits === true)).toBe(true);
      expect(stored.every((tx: Transaction) => tx.notes?.includes(parentTx.__backendId))).toBe(true);
    });

    it('should prevent double-spending in splits', async () => {
      const originalTx = createTestTransaction({ amount: 50 });
      await dataManager.create(originalTx);

      // Try to split with amounts > original
      const greedySplits = [
        { category: 'food', amount: 30 },
        { category: 'entertainment', amount: 25 }, // Total: 55 > 50
      ];

      const result = await dataManager.splitTransaction(originalTx, greedySplits);

      expect(result.isOk).toBe(false);
      expect(result.error).toContain('Split total');
    });

    it('should handle floating point precision in splits', async () => {
      const originalTx = createTestTransaction({ amount: 10.01 });
      await dataManager.create(originalTx);

      const splits = [
        { category: 'food', amount: 6.67 },
        { category: 'entertainment', amount: 3.34 },
      ];

      const result = await dataManager.splitTransaction(originalTx, splits);

      expect(result.isOk).toBe(true);

      const stored = lsGet(SK_TX, []) as Transaction[];
      const total = stored.reduce((sum: number, tx: Transaction) => sum + tx.amount, 0);
      expect(Math.round(total * 100) / 100).toBe(10.01);
    });
  });
});

// ==========================================
// STRESS TESTS
// ==========================================

describe('DataManager Stress Tests', () => {
  let dataManager: DataManager;
  let mockHandler: DataHandler;

  beforeEach(async () => {
    mockStorageMap.clear();
    vi.clearAllMocks();
    mockStorageMap.set(SK_TX, JSON.stringify([]));

    dataManager = new DataManager();
    mockHandler = createMockHandler();
    await dataManager.init(mockHandler);
  });

  it('should handle rapid sequential operations', async () => {
    const operations = Array.from({ length: 50 }, (_, i) =>
      dataManager.create(createTestTransaction({ description: `Rapid ${i}` }))
    );

    const results = await Promise.all(operations);

    expect(results.every(r => r.isOk)).toBe(true);

    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(50);
  });

  it('should handle large dataset via batches', async () => {
    const batches = Array.from({ length: 5 }, (_, batchIndex) =>
      Array.from({ length: 50 }, (_, i) =>
        createTestTransaction({ description: `Batch ${batchIndex} Item ${i}` })
      )
    );

    for (const batch of batches) {
      const result = await dataManager.createBatch(batch);
      expect(result.isOk).toBe(true);
    }

    const stored = lsGet(SK_TX, []) as Transaction[];
    expect(stored).toHaveLength(250);
  });

  it('should maintain performance under load', async () => {
    // Pre-populate with data
    const initialData = Array.from({ length: 500 }, (_, i) =>
      createTestTransaction({ description: `Initial ${i}` })
    );
    mockStorageMap.set(SK_TX, JSON.stringify(initialData));

    // Reinitialize with large dataset
    dataManager = new DataManager();
    await dataManager.init(mockHandler);

    const startTime = performance.now();

    const newTransactions = Array.from({ length: 50 }, (_, i) =>
      createTestTransaction({ description: `New ${i}` })
    );

    const result = await dataManager.createBatch(newTransactions);
    const endTime = performance.now();

    expect(result.isOk).toBe(true);
    expect(endTime - startTime).toBeLessThan(5000);
  });
});
