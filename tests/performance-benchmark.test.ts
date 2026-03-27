import { afterEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { calculateMonthlyTotalsWithCacheSync, invalidateAllCache } from '../js/modules/core/monthly-totals-cache.js';
import { filterTransactionsSync } from '../js/modules/orchestration/worker-manager.js';
import { createDeterministicLedger } from './test-data-factory.js';

const DATASET_SIZES = [1000, 5000, 10000] as const;
const RUN_PERF_BENCH = process.env.RUN_PERF_BENCH === '1';
const describePerf = RUN_PERF_BENCH ? describe : describe.skip;

function measureMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describePerf('performance benchmark baseline', () => {
  afterEach(() => {
    signals.replaceTransactionLedger([]);
    signals.currentMonth.value = '2026-03';
    invalidateAllCache();
  });

  it('records deterministic hot-path timings for 1k, 5k, and 10k ledgers', () => {
    const results = DATASET_SIZES.map((size) => {
      const transactions = createDeterministicLedger(size);
      signals.replaceTransactionLedger(transactions);
      signals.currentMonth.value = '2026-03';
      invalidateAllCache();

      const monthTotalsMs = measureMs(() => {
        void signals.currentMonthTotals.value;
      });

      const monthlyCacheMs = measureMs(() => {
        calculateMonthlyTotalsWithCacheSync('2026-03');
      });

      const filterMs = measureMs(() => {
        filterTransactionsSync(transactions, { monthKey: '2026-03', showAllMonths: false, type: 'expense' }, {
          page: 0,
          pageSize: 50,
          sortBy: 'date',
          sortDir: 'desc'
        });
      });

      return {
        size,
        monthTotalsMs: Number(monthTotalsMs.toFixed(2)),
        monthlyCacheMs: Number(monthlyCacheMs.toFixed(2)),
        filterMs: Number(filterMs.toFixed(2))
      };
    });

    console.info('PERF_BENCHMARK', JSON.stringify({
      kind: 'vitest-hot-paths',
      results
    }));

    expect(results).toHaveLength(3);
    expect(results[0].monthTotalsMs).toBeGreaterThanOrEqual(0);
    expect(results[1].monthlyCacheMs).toBeGreaterThanOrEqual(0);
    expect(results[2].filterMs).toBeGreaterThanOrEqual(0);
  });
});
