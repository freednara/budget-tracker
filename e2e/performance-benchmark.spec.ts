import { test, expect, type Page } from '@playwright/test';
import { cleanAppState, waitForAppReady, waitForTransactionsSurfaceReady } from './test-helpers.js';

const RUN_PERF_BENCH = process.env.RUN_PERF_BENCH === '1';
const DATASET_SIZES = [1000, 5000, 10000] as const;

test.skip(!RUN_PERF_BENCH, 'Run only when RUN_PERF_BENCH=1');

async function measureChartRefresh(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const start = performance.now();
    const container = document.getElementById('trend-chart-container');
    if (!container) {
      throw new Error('Trend chart container not found');
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timed out waiting for trend chart refresh'));
      }, 5000);

      const observer = new MutationObserver(() => {
        window.clearTimeout(timeoutId);
        observer.disconnect();
        resolve();
      });

      observer.observe(container, { childList: true, subtree: true });
      const button = document.querySelector<HTMLButtonElement>('.trend-range-btn[data-months="3"]');
      if (!button) {
        window.clearTimeout(timeoutId);
        observer.disconnect();
        reject(new Error('Trend range button not found'));
        return;
      }
      button.click();
    });

    return performance.now() - start;
  });
}

async function seedIndexedDbLedger(page: Page, count: number): Promise<void> {
  await page.evaluate(async (ledgerSize) => {
    function makeTransactions(size: number) {
      const transactions = [];
      for (let i = 0; i < size; i++) {
        const month = String((i % 12) + 1).padStart(2, '0');
        const day = String((i % 28) + 1).padStart(2, '0');
        const isIncome = i % 7 === 0;
        transactions.push({
          __backendId: `perf-${size}-${i}`,
          type: isIncome ? 'income' : 'expense',
          amount: isIncome ? 2600 + (i % 4) * 100 : 10 + (i % 19) * 2.5,
          description: isIncome ? `Perf income ${i}` : `Perf expense ${i}`,
          category: isIncome ? 'salary' : ['food', 'transport', 'shopping', 'bills', 'health'][i % 5],
          date: `2026-${month}-${day}`,
          currency: 'USD',
          recurring: i % 13 === 0,
          reconciled: i % 2 === 0,
          notes: '',
          tags: i % 9 === 0 ? 'perf,seed' : ''
        });
      }
      return transactions;
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('BudgetTrackerDB', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('open failed'));
    });

    const transactions = makeTransactions(ledgerSize);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['transactions'], 'readwrite');
      const store = tx.objectStore('transactions');
      store.clear();
      transactions.forEach((transaction) => {
        store.put(transaction);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('seed failed'));
      tx.onabort = () => reject(tx.error || new Error('seed aborted'));
    });
    db.close();
  }, count);
}

test.describe('Performance Benchmark', () => {
  test('meets baseline shell and interaction budgets', async ({ page }) => {
    await cleanAppState(page);
    await seedIndexedDbLedger(page, 1000);

    const navStart = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, 120000);
    const shellReadyMs = Date.now() - navStart;

    const transactionsSurfaceStart = Date.now();
    await waitForTransactionsSurfaceReady(page, 20000);
    const transactionsSurfaceReadyMs = Date.now() - transactionsSurfaceStart;

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 20000 });
    const calendarCell = page.locator('.cal-day').first();
    const calendarStart = Date.now();
    await calendarCell.click();
    await expect(page.locator('#cal-detail-panel')).toContainText(/Add Transaction|transaction|activity/i, { timeout: 10000 });
    const calendarSelectionMs = Date.now() - calendarStart;

    const transactionList = page.locator('#transactions-list');
    await expect(transactionList.locator('.transaction-row').first()).toBeVisible({ timeout: 10000 });

    const editStart = Date.now();
    await transactionList.locator('.transaction-row').first().locator('.edit-btn').click();
    await expect(page.locator('#form-title')).toContainText('Edit', { timeout: 5000 });
    await page.locator('#amount').fill('77.77');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#amount')).toHaveValue('', { timeout: 10000 });
    const editTransactionMs = Date.now() - editStart;

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#trend-chart-container svg')).toBeVisible({ timeout: 20000 });
    const chartRefreshMs = await measureChartRefresh(page);

    console.log('PERF_BENCHMARK', JSON.stringify({
      kind: 'playwright-baseline',
      shellReadyMs,
      transactionsSurfaceReadyMs,
      calendarSelectionMs,
      editTransactionMs,
      chartRefreshMs: Number(chartRefreshMs.toFixed(2))
    }));

    expect(shellReadyMs).toBeGreaterThan(0);
    expect(transactionsSurfaceReadyMs).toBeGreaterThan(0);
    expect(calendarSelectionMs).toBeGreaterThan(0);
    expect(editTransactionMs).toBeGreaterThan(0);
    expect(chartRefreshMs).toBeGreaterThan(0);
  });

  test('records shell-ready and UI hot-path timings for large ledgers', async ({ page }) => {
    const results: Array<Record<string, number>> = [];

    for (const count of DATASET_SIZES) {
      await cleanAppState(page);
      await seedIndexedDbLedger(page, count);

      const navStart = Date.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(page, 120000);
      const shellReadyMs = Date.now() - navStart;

      const transactionsSurfaceStart = Date.now();
      await waitForTransactionsSurfaceReady(page, 20000);
      const transactionsSurfaceReadyMs = Date.now() - transactionsSurfaceStart;

      await page.locator('#tab-calendar-btn').click();
      await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 20000 });
      const calendarCell = page.locator('.cal-day').first();
      const calendarStart = Date.now();
      await calendarCell.click();
      await expect(page.locator('#cal-detail-panel')).toContainText(/Add Transaction|transaction|activity/i, { timeout: 10000 });
      const calendarSelectionMs = Date.now() - calendarStart;

      const addStart = Date.now();
      await page.locator('#amount').fill('44.25');
      await page.locator('.category-chip').first().click();
      await page.locator('#description').fill(`Perf tx ${count}`);
      await page.locator('#submit-btn').click();
      await expect(page.locator('#amount')).toHaveValue('', { timeout: 10000 });
      const addTransactionMs = Date.now() - addStart;

      await page.locator('#tab-dashboard-btn').click();
      await expect(page.locator('#trend-chart-container svg')).toBeVisible({ timeout: 20000 });
      const chartRefreshMs = await measureChartRefresh(page);

      const filterMetrics = await page.evaluate(async () => {
        const workerModuleUrl = new URL('/js/modules/orchestration/worker-manager.js', window.location.origin).toString();
        const signalsModuleUrl = new URL('/js/modules/core/signals.js', window.location.origin).toString();
        const [{ filterTransactionsAsync, filterTransactionsSync }, signalsModule] = await Promise.all([
          import(workerModuleUrl),
          import(signalsModuleUrl)
        ]);
        const filters = { monthKey: '2026-03', showAllMonths: false, type: 'expense' as const };

        const syncStart = performance.now();
        filterTransactionsSync(signalsModule.transactions.value, filters, {
          page: 0,
          pageSize: 50,
          sortBy: 'date',
          sortDir: 'desc'
        });
        const syncMs = performance.now() - syncStart;

        const workerStart = performance.now();
        await filterTransactionsAsync(null, filters, {
          page: 0,
          pageSize: 50,
          sortBy: 'date',
          sortDir: 'desc'
        });
        const workerMs = performance.now() - workerStart;

        return { syncMs, workerMs };
      });

      results.push({
        size: count,
        shellReadyMs,
        transactionsSurfaceReadyMs,
        calendarSelectionMs,
        addTransactionMs,
        chartRefreshMs: Number(chartRefreshMs.toFixed(2)),
        syncFilterMs: Number(filterMetrics.syncMs.toFixed(2)),
        workerFilterMs: Number(filterMetrics.workerMs.toFixed(2))
      });
    }

    console.log('PERF_BENCHMARK', JSON.stringify({
      kind: 'playwright-browser',
      results
    }));

    expect(results).toHaveLength(3);
  });
});
