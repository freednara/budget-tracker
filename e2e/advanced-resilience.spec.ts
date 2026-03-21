import { test, expect } from '@playwright/test';
import { cleanAppState } from './test-helpers.js';

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

    await page.waitForSelector('#total-expenses', { state: 'visible' });
    await page.locator('#open-settings').click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });
    await page.locator('#load-sample-data').click();

    await page.waitForSelector('#async-confirm-modal', { state: 'visible' });
    await expect(page.locator('#confirm-title')).toHaveText('Load Demo Account');
    await expect(page.locator('#confirm-message')).toContainText('Load demo data');
    await expect(page.locator('#confirm-details')).toContainText('deterministic demo account');
    expect(dialogSeen).toBeFalsy();

    await page.locator('#confirm-ok').click();
    await expect(page.locator('.toast').filter({ hasText: 'Loaded demo account' }).last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#settings-modal')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-dashboard-btn')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#hero-daily-amount')).not.toHaveText('—', { timeout: 10000 });
    await expect(page.locator('#hero-amount-caption')).not.toContainText('no budget', { timeout: 10000 });
    await expect(page.locator('#hero-left-to-spend')).not.toHaveText('$0.00', { timeout: 10000 });
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
    await page1.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page2.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });

    await page1.goto('/');
    await page2.goto('/');

    // Wait for apps to load
    await page1.waitForSelector('#total-expenses');
    await page2.waitForSelector('#total-expenses');

    // Page 1: Add a transaction
    await page1.locator('#tab-transactions-btn').click();
    await page1.waitForSelector('#amount', { state: 'visible' });
    await page1.locator('#amount').fill('75.50');
    await page1.locator('#description').fill('Multi-tab sync test');
    
    // Select first category chip
    const catChip = page1.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    
    // Submit
    await page1.locator('#submit-btn').click();
    await page1.waitForTimeout(500); // Wait for transaction to process

    // Page 2: Verify the dashboard updated automatically
    // The total expenses should now reflect the 75.50 added in Tab 1
    const totalExpensesP2 = page2.locator('#total-expenses');
    await expect(totalExpensesP2).toContainText('75.50', { timeout: 10000 });
  });

  test('fuzzy duplicate detection warns on similar transactions', async ({ page }) => {
    // Wait for app to load first
    await page.waitForSelector('#total-expenses', { state: 'visible' });
    
    // 1. Add an initial transaction
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });
    await page.locator('#amount').fill('42.00');
    await page.locator('#description').fill('Coffee Shop Purchase');
    const catChip = page.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    await page.locator('#submit-btn').click();
    await page.waitForTimeout(500);

    // 2. Prepare a backup file with a fuzzy duplicate (same date, amount, but slightly different description)
    // First, let's create the JSON structure
    const date = new Date().toISOString().split('T')[0];
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
    await page.locator('#import-file').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: buffer
    });

    // 4. Wait for import options and select Merge
    await page.waitForSelector('#import-options-modal', { state: 'visible' });
    await page.locator('#import-merge').click();

    // 5. Verify the fuzzy duplicate warning modal appears
    await page.waitForSelector('#async-confirm-modal', { state: 'visible' });
    await expect(page.locator('#confirm-message')).toContainText('similar transaction');
    
    // Choose to skip duplicates (Cancel)
    await page.locator('#confirm-cancel').click();

    // 6. Verify toast confirms skipping
    await expect(page.locator('.toast').filter({ hasText: 'skipped' }).last()).toBeVisible({ timeout: 5000 });
  });

  test('backup and restore integrity', async ({ page }) => {
    // Wait for app to load first
    await page.waitForSelector('#total-expenses', { state: 'visible' });

    // 1. Add some specific data to backup
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });
    await page.locator('#amount').fill('123.45');
    await page.locator('#description').fill('Important Backup Data');
    const catChip = page.locator('.category-chip').first();
    await expect(catChip).toBeVisible();
    await catChip.click();
    await page.locator('#submit-btn').click();
    await page.waitForTimeout(500);

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
    await page.locator('#open-settings').click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });
    await page.locator('#clear-all-data').click();
    await page.waitForSelector('#reset-app-data-modal', { state: 'visible' });
    await page.locator('#confirm-reset-keep-backups').click();

    // Verify it's empty
    await expect(page.locator('#total-expenses')).toContainText('$0.00');

    // 4. Restore the data
    const restoreBuffer = Buffer.from(backupContent);
    await page.locator('#tab-transactions-btn').click();
    await page.locator('#import-file').setInputFiles({
      name: 'restore.json',
      mimeType: 'application/json',
      buffer: restoreBuffer
    });

    await page.waitForSelector('#import-options-modal', { state: 'visible' });
    await page.locator('#import-overwrite').click();

    // Wait for the restore to complete
    await expect(page.locator('.toast').last()).toContainText('Data replaced successfully', { timeout: 10000 });

    // 5. Verify the data is back
    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#total-expenses')).toContainText('123.45', { timeout: 5000 });
  });

  test('clear app data offers both backup paths and preserves stored backups by default', async ({ page }) => {
    await page.waitForSelector('#total-expenses', { state: 'visible' });
    await seedStoredBackupPayloads(page);

    await page.locator('#open-settings').click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });
    await page.locator('#clear-all-data').click();

    await page.waitForSelector('#reset-app-data-modal', { state: 'visible' });
    await expect(page.locator('#reset-app-data-title')).toContainText('Clear App Data');
    await expect(page.locator('#confirm-reset-keep-backups')).toBeVisible();
    await expect(page.locator('#confirm-reset-clear-backups')).toBeVisible();

    await page.locator('#confirm-reset-keep-backups').click();
    await expect(page.locator('.toast').last()).toContainText('Stored backups were kept', { timeout: 10000 });

    const localBackups = await page.evaluate(() => localStorage.getItem('budget_tracker_auto_backups'));
    expect(localBackups).not.toBeNull();
    expect(await countIndexedDbBackups(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('budget_tracker_backup_schedule'))).toBeNull();
    await expect(page.locator('#total-expenses')).toContainText('$0.00');
    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tx-display-count')).toContainText('0');
    await expect(page.locator('.transaction-row')).toHaveCount(0);
  });

  test('clear app data and backups removes stored backups from all backup stores', async ({ page }) => {
    await page.waitForSelector('#total-expenses', { state: 'visible' });
    await seedStoredBackupPayloads(page);

    await page.locator('#open-settings').click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });
    await page.locator('#clear-all-data').click();
    await page.waitForSelector('#reset-app-data-modal', { state: 'visible' });
    await page.locator('#confirm-reset-clear-backups').click();

    await expect(page.locator('.toast').last()).toContainText('App data and backups cleared', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('budget_tracker_auto_backups'))).toBeNull();
    expect(await countIndexedDbBackups(page)).toBe(0);
  });
});
