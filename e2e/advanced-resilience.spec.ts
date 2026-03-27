import { test, expect } from '@playwright/test';
import {
  assertDashboardEmpty,
  assertDashboardPopulated,
  assertDashboardTotal,
  assertLedgerHasRows,
  assertLedgerEmpty,
  assertModalClosedAndInteractive,
  assertTransactionVisible,
  bootSecondaryPage,
  cleanAppState,
  importJsonData,
  submitJsonDataImport,
  loadSampleDataFromSettings,
  openResetAppDataModal,
  openSettingsModal,
  resetAppDataFromModal,
  waitForAppReady,
  waitForTransactionsSurfaceReady
} from './test-helpers.js';

/**
 * Advanced Resilience E2E Tests
 * Covers: Multi-Tab Synchronization, Backup/Restore Integrity, and Fuzzy Duplicate Detection
 */

test.describe('Advanced Resilience', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
  });

  test('load sample data uses the app confirm modal instead of a browser dialog', async ({ page }) => {
    let dialogSeen = false;
    page.on('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });

    await openSettingsModal(page);
    await page.locator('#load-sample-data').click();

    await expect(page.locator('#async-confirm-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#confirm-title')).toHaveText('Load Demo Account');
    await expect(page.locator('#confirm-message')).toContainText('Load demo data');
    await expect(page.locator('#confirm-details')).toContainText('deterministic demo account');
    expect(dialogSeen).toBeFalsy();

    await page.locator('#confirm-ok').click();
    await assertModalClosedAndInteractive(page, 10000);
    await assertDashboardPopulated(page, 10000);
  });

  test('settings and analytics open on the first click after cold startup', async ({ page }) => {
    await openSettingsModal(page);
    await page.locator('#close-settings').click();
    await assertModalClosedAndInteractive(page, 10000);

    await page.locator('#open-analytics').click();
    await expect(page.locator('#analytics-modal')).toBeVisible({ timeout: 10000 });
  });

  async function seedStoredBackupPayloads(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(async () => {
      localStorage.setItem('budget_tracker_auto_backups', JSON.stringify([{ metadata: { id: 'backup-1' }, data: {} }]));
      localStorage.setItem('budget_tracker_backup_schedule', JSON.stringify({ enabled: true, frequency: 'daily' }));
      localStorage.setItem('budget_tracker_backup_status', JSON.stringify({ totalBackups: 1 }));

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('BudgetTrackerBackups', 1);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('backups')) {
            const store = db.createObjectStore('backups', { keyPath: 'metadata.id' });
            store.createIndex('timestamp', 'metadata.timestamp', { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['backups'], 'readwrite');
          tx.objectStore('backups').put({
            metadata: {
              id: 'backup-1',
              timestamp: Date.now(),
              version: '2.0',
              deviceId: 'test-device',
              transactionCount: 1,
              compressed: false,
              size: 42
            },
            data: {}
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
      });
    });
  }

  async function countIndexedDbBackups(page: import('@playwright/test').Page): Promise<number> {
    return await page.evaluate(async () => {
      return await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('BudgetTrackerBackups', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['backups'], 'readonly');
          const countReq = tx.objectStore('backups').count();
          countReq.onsuccess = () => {
            const count = countReq.result;
            db.close();
            resolve(count);
          };
          countReq.onerror = () => reject(countReq.error);
        };
      });
    });
  }

  test('multi-tab synchronization updates state across pages', async ({ context }) => {
    // Open two pages in the same context (simulating tabs)
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    // Setup skip onboarding on both pages
    await bootSecondaryPage(page1, { clearStorage: true, skipOnboarding: true });
    await bootSecondaryPage(page2, { clearStorage: false, skipOnboarding: true });

    // Page 1: Add a transaction
    await page1.bringToFront();
    await waitForTransactionsSurfaceReady(page1);
    await page1.locator('#amount').fill('75.50');
    await page1.locator('#description').fill('Multi-tab sync test');
    
    // Select first category chip
    const catChip = page1.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    
    // Submit
    await page1.locator('#submit-btn').click();
    await expect(page1.locator('#amount')).toHaveValue('', { timeout: 5000 });

    // Page 2: Verify the dashboard updated automatically
    // The total expenses should now reflect the 75.50 added in Tab 1
    const totalExpensesP2 = page2.locator('#total-expenses');
    await expect(totalExpensesP2).toContainText('75.50', { timeout: 10000 });
  });

  test('fuzzy duplicate detection warns on similar transactions', async ({ page }) => {
    await waitForTransactionsSurfaceReady(page);

    // 1. Add an initial transaction
    await page.locator('#amount').fill('42.00');
    await page.locator('#description').fill('Coffee Shop Purchase');
    const catChip = page.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    await page.locator('#submit-btn').click();
    await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });
    await assertLedgerHasRows(page, 1, 5000);
    await assertTransactionVisible(page, 'Coffee Shop Purchase', 5000);

    // 2. Prepare a backup file with a fuzzy duplicate (same date, amount, but slightly different description)
    // First, let's create the JSON structure
    const date = await page.locator('#date').inputValue();
    const importData = {
      version: 1,
      timestamp: Date.now(),
      transactions: [
        {
          __backendId: 'tx_fuzzy1',
          date: date,
          amount: 42.00, // Dollars (app stores amounts in dollars)
          type: 'expense',
          category: 'food',
          description: 'Coffee Shop - Morning', // Slightly different description
          currency: 'USD',
          recurring: false,
          tags: '',
          notes: ''
        }
      ]
    };

    // 3. Trigger import with the JSON
    // We mock the file chooser
    const buffer = Buffer.from(JSON.stringify(importData));
    
    // Bypass the browser file chooser UI and write directly to the hidden input.
    // This keeps the test focused on the import pipeline rather than chooser quirks.
    await submitJsonDataImport(page, {
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: buffer
    }, 'merge');

    // 5. Verify the fuzzy duplicate warning modal appears
    await expect(page.locator('#async-confirm-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#confirm-message')).toContainText('similar transaction');
    
    // Choose to skip duplicates (Cancel)
    await page.locator('#confirm-cancel').click();
    await assertModalClosedAndInteractive(page, 10000);

    // 6. Verify the duplicate candidate was not imported
    await assertTransactionVisible(page, 'Coffee Shop Purchase', 5000);
    await expect(page.locator('#transactions-list')).not.toContainText('Coffee Shop - Morning', { timeout: 5000 });
  });

  test('backup and restore integrity', async ({ page }) => {
    test.setTimeout(120000);
    await waitForTransactionsSurfaceReady(page);

    // 1. Add some specific data to backup
    await page.locator('#amount').fill('123.45');
    await page.locator('#description').fill('Important Backup Data');
    const catChip = page.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    await page.locator('#submit-btn').click();
    await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });
    await assertLedgerHasRows(page, 1, 5000);
    await assertTransactionVisible(page, 'Important Backup Data', 5000);

    // 2. Perform the backup (intercept the download)
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-json-btn').click();
    const download = await downloadPromise;
    
    // Read the downloaded file content
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const backupContent = Buffer.concat(chunks).toString('utf-8');
    const backupData = JSON.parse(backupContent);

    // Verify backup contains our transaction
    expect(backupData.transactions.length).toBeGreaterThan(0);
    const hasImportantData = backupData.transactions.some((t: any) => t.description === 'Important Backup Data');
    expect(hasImportantData).toBeTruthy();

    // 3. Clear data via UI to simulate a fresh start
    await resetAppDataFromModal(page, { clearBackups: false });

    // 4. Restore the data
    const restoreBuffer = Buffer.from(backupContent);
    await importJsonData(page, {
      name: 'restore.json',
      mimeType: 'application/json',
      buffer: restoreBuffer
    }, 'overwrite');

    // 5. Verify the data is back
    await assertDashboardPopulated(page, 15000);
    await assertLedgerHasRows(page, 1, 15000);
    await assertTransactionVisible(page, 'Important Backup Data', 10000);
    await assertDashboardTotal(page, '#total-expenses', '123.45', 5000);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await assertDashboardPopulated(page, 15000);
    await assertLedgerHasRows(page, 1, 15000);
    await assertTransactionVisible(page, 'Important Backup Data', 10000);
    await assertDashboardTotal(page, '#total-expenses', '123.45', 10000);
  });

  test('clear app data offers both backup paths and preserves stored backups by default', async ({ page }) => {
    await waitForAppReady(page);
    await seedStoredBackupPayloads(page);

    await openResetAppDataModal(page);
    await expect(page.locator('#reset-app-data-title')).toContainText('Clear App Data');
    await page.locator('#confirm-reset-keep-backups').click();
    await assertModalClosedAndInteractive(page, 20000);

    const localBackups = await page.evaluate(() => localStorage.getItem('budget_tracker_auto_backups'));
    expect(localBackups).not.toBeNull();
    expect(await countIndexedDbBackups(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('budget_tracker_backup_schedule'))).toBeNull();
    await assertDashboardEmpty(page);
    await assertLedgerEmpty(page);
  });

  test('clear app data and backups removes stored backups from all backup stores', async ({ page }) => {
    await waitForAppReady(page);
    await seedStoredBackupPayloads(page);

    await resetAppDataFromModal(page, { clearBackups: true });
    expect(await page.evaluate(() => localStorage.getItem('budget_tracker_auto_backups'))).toBeNull();
    expect(await countIndexedDbBackups(page)).toBe(0);
    await assertLedgerEmpty(page);
  });

  test('sample data helper drives durable dashboard state without relying on toast timing', async ({ page }) => {
    await loadSampleDataFromSettings(page);
    await expect(page.locator('#hero-amount-caption')).not.toContainText('no budget', { timeout: 10000 });
  });
});
