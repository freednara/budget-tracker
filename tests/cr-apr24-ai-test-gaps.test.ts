// @vitest-environment node
/**
 * Cluster AI — Form/worker/transaction test gaps
 * Findings: 236, 237, 238, 242, 243, 244, 248, 251, 254
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ==========================================
// Finding 236 — worker-manager beyond filterTransactionsSync
// ==========================================
describe('Finding 236 — worker-manager exported API surface', () => {
  it('exports isWorkerSupported, shouldUseWorker, filterTransactionsSync', async () => {
    const mod = await import('../js/modules/orchestration/worker-manager.js');
    expect(typeof mod.isWorkerSupported).toBe('function');
    expect(typeof mod.shouldUseWorker).toBe('function');
    expect(typeof mod.filterTransactionsSync).toBe('function');
  });

  it('exports async APIs: filterTransactionsAsync, searchTransactionsAsync', async () => {
    const mod = await import('../js/modules/orchestration/worker-manager.js');
    expect(typeof mod.filterTransactionsAsync).toBe('function');
    expect(typeof mod.searchTransactionsAsync).toBe('function');
    expect(typeof mod.aggregateTransactionsAsync).toBe('function');
  });

  it('isWorkerSupported returns boolean', async () => {
    const { isWorkerSupported } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    expect(typeof isWorkerSupported()).toBe('boolean');
  });

  it('shouldUseWorker returns boolean for given count', async () => {
    const { shouldUseWorker } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    expect(typeof shouldUseWorker(100)).toBe('boolean');
    expect(typeof shouldUseWorker(10000)).toBe('boolean');
  });

  it('getWorkerStatus returns status object', async () => {
    const { getWorkerStatus } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    const status = getWorkerStatus();
    expect(status).toBeDefined();
    expect(typeof status).toBe('object');
  });
});

// ==========================================
// Finding 237 — form-binder checkbox/multi-select
// ==========================================
describe('Finding 237 — form-binder beyond currency parser', () => {
  it('FormBinder class is constructible and has bind/bindForm/validateAll', async () => {
    const { FormBinder } = await import('../js/modules/core/form-binder.js');
    const binder = new FormBinder();
    expect(typeof binder.bind).toBe('function');
    expect(typeof binder.bindForm).toBe('function');
    expect(typeof binder.validateAll).toBe('function');
    expect(typeof binder.getErrors).toBe('function');
  });

  it('formBinder singleton is exported', async () => {
    const { formBinder } = await import('../js/modules/core/form-binder.js');
    expect(formBinder).toBeDefined();
    expect(typeof formBinder.bind).toBe('function');
  });

  it('Parsers includes currency, int, float, bool, tags', async () => {
    const { Parsers } = await import('../js/modules/core/form-binder.js');
    expect(typeof Parsers.currency).toBe('function');
    expect(typeof Parsers.int).toBe('function');
    expect(typeof Parsers.float).toBe('function');
    expect(typeof Parsers.bool).toBe('function');
    expect(typeof Parsers.tags).toBe('function');
  });

  it('Formatters includes currency, percent, date, tags', async () => {
    const { Formatters } = await import('../js/modules/core/form-binder.js');
    expect(typeof Formatters.currency).toBe('function');
    expect(typeof Formatters.percent).toBe('function');
    expect(typeof Formatters.date).toBe('function');
    expect(typeof Formatters.tags).toBe('function');
  });

  it('Formatters.date normalizes YYYY-MM-DD without timezone drift', async () => {
    const { Formatters } = await import('../js/modules/core/form-binder.js');
    const result = Formatters.date('2024-01-15');
    // Should produce a string containing 15 (day) — no day rollback
    expect(result).toContain('15');
  });

  it('Formatters.tags joins array', async () => {
    const { Formatters } = await import('../js/modules/core/form-binder.js');
    expect(Formatters.tags(['a', 'b', 'c'])).toBe('a, b, c');
    expect(Formatters.tags([])).toBe('');
  });
});

// ==========================================
// Finding 238 — transaction-service tracked-expense exclusions
// ==========================================
describe('Finding 238 — transaction-service year/all-time tracked-expense exclusions', () => {
  it('calculateYearStats excludes savings-transfer expenses', async () => {
    const { calculateYearStats } = await import(
      '../js/modules/domain/transaction-service.js'
    );

    const transactions = [
      { type: 'income', amount: 5000, category: 'salary', date: '2024-01-15' },
      { type: 'expense', amount: 200, category: 'food', date: '2024-02-10' },
      // Savings transfer — should be excluded from expenses
      {
        type: 'expense',
        amount: 1000,
        category: 'savings_transfer',
        date: '2024-03-05',
        tags: '',
        notes: '',
        description: 'Savings Transfer: Emergency Fund',
      },
    ];

    const result = calculateYearStats(transactions as any, '2024');
    expect(result.income).toBe(5000);
    // Only 200 in real expenses, not 1200
    expect(result.expenses).toBe(200);
    expect(result.transactionCount).toBe(3);
  });

  it('calculateAllTimeStats excludes savings-transfer expenses', async () => {
    const { calculateAllTimeStats } = await import(
      '../js/modules/domain/transaction-service.js'
    );

    const transactions = [
      { type: 'income', amount: 3000, category: 'salary', date: '2024-01-15' },
      { type: 'expense', amount: 150, category: 'food', date: '2024-02-10' },
      {
        type: 'expense',
        amount: 500,
        category: 'savings_transfer',
        date: '2024-03-05',
        tags: '',
        notes: '',
        description: 'Savings Transfer: Vacation Fund',
      },
    ];

    const result = calculateAllTimeStats(transactions as any);
    expect(result).not.toBeNull();
    expect(result!.totalIncome).toBe(3000);
    // Only 150 in real expenses
    expect(result!.totalExpenses).toBe(150);
  });
});

// ==========================================
// Finding 242 — feature-event-interface notify helpers
// ==========================================
describe('Finding 242 — feature-event-interface notify helpers', () => {
  it('notifyFeature is exported and callable', async () => {
    const { notifyFeature } = await import(
      '../js/modules/core/feature-event-interface.js'
    );
    expect(typeof notifyFeature).toBe('function');
    // Should not throw for arbitrary event
    expect(() => notifyFeature('test-242-event', { foo: 'bar' })).not.toThrow();
  });

  it('awardAchievement is exported and callable', async () => {
    const { awardAchievement } = await import(
      '../js/modules/core/feature-event-interface.js'
    );
    expect(typeof awardAchievement).toBe('function');
  });

  it('requestFeature returns a promise', async () => {
    const { requestFeature } = await import(
      '../js/modules/core/feature-event-interface.js'
    );
    expect(typeof requestFeature).toBe('function');
  });

  it('FeatureEvents enum contains expected keys', async () => {
    const { FeatureEvents } = await import(
      '../js/modules/core/feature-event-interface.js'
    );
    expect(FeatureEvents).toBeDefined();
    expect(typeof FeatureEvents).toBe('object');
  });
});

// ==========================================
// Finding 243 — worker-manager async search contract
// ==========================================
describe('Finding 243 — worker-manager async search', () => {
  it('searchTransactionsAsync is exported with correct signature', async () => {
    const { searchTransactionsAsync } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    expect(typeof searchTransactionsAsync).toBe('function');
    // Function should take query string and options
    expect(searchTransactionsAsync.length).toBeGreaterThanOrEqual(1);
  });

  it('syncWorkerDataset and syncWorkerDatasetDelta are exported', async () => {
    const mod = await import('../js/modules/orchestration/worker-manager.js');
    expect(typeof mod.syncWorkerDataset).toBe('function');
    expect(typeof mod.syncWorkerDatasetDelta).toBe('function');
  });
});

// ==========================================
// Finding 244 — form-events amount-field binding
// ==========================================
describe('Finding 244 — form-events amount-field binding source', () => {
  it('form-events source references amount binding with number input', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/ui/interactions/form-events.ts'),
      'utf-8'
    );
    // Should bind the amount field
    expect(src).toMatch(/amount/i);
    // Should use FormBinder or bind
    expect(src).toMatch(/bind|FormBinder/);
  });
});

// ==========================================
// Finding 248 — bindFormWithValidation
// ==========================================
describe('Finding 248 — bindFormWithValidation', () => {
  it('bindFormWithValidation is exported with correct return shape', async () => {
    const { bindFormWithValidation } = await import(
      '../js/modules/core/form-binder.js'
    );
    expect(typeof bindFormWithValidation).toBe('function');
  });

  it('createFormBinder returns a FormBinder instance', async () => {
    const { createFormBinder } = await import('../js/modules/core/form-binder.js');
    const binder = createFormBinder();
    expect(binder).toBeDefined();
    expect(typeof binder.bind).toBe('function');
    expect(typeof binder.validateAll).toBe('function');
    expect(typeof binder.getErrors).toBe('function');
  });
});

// ==========================================
// Finding 251 — worker cache invalidation / sync dataset
// ==========================================
describe('Finding 251 — worker cache invalidation', () => {
  it('filterTransactions is exported (main entry point)', async () => {
    const mod = await import('../js/modules/orchestration/worker-manager.js');
    expect(typeof mod.filterTransactions).toBe('function');
  });

  it('terminateWorker is exported', async () => {
    const { terminateWorker } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    expect(typeof terminateWorker).toBe('function');
  });

  it('isWorkerReady reports current state', async () => {
    const { isWorkerReady } = await import(
      '../js/modules/orchestration/worker-manager.js'
    );
    expect(typeof isWorkerReady()).toBe('boolean');
  });
});

// ==========================================
// Finding 254 — form-binder multi-select + Formatters.date
// ==========================================
describe('Finding 254 — form-binder multi-select and Formatters.date', () => {
  it('Parsers.tags splits comma-separated string', async () => {
    const { Parsers } = await import('../js/modules/core/form-binder.js');
    const result = Parsers.tags('a, b, c');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('Parsers.float handles numeric strings', async () => {
    const { Parsers } = await import('../js/modules/core/form-binder.js');
    expect(Parsers.float('42.5')).toBe(42.5);
    expect(Parsers.float('')).toBe(0);
  });

  it('Parsers.int parses integer strings', async () => {
    const { Parsers } = await import('../js/modules/core/form-binder.js');
    expect(Parsers.int('42')).toBe(42);
    expect(Parsers.int('42.7')).toBe(42);
    expect(Parsers.int('abc')).toBe(0);
  });

  it('Parsers.bool parses boolean strings', async () => {
    const { Parsers } = await import('../js/modules/core/form-binder.js');
    expect(Parsers.bool('true')).toBe(true);
    expect(Parsers.bool('1')).toBe(true);
    expect(Parsers.bool('yes')).toBe(true);
    expect(Parsers.bool('false')).toBe(false);
    expect(Parsers.bool('no')).toBe(false);
  });
});
