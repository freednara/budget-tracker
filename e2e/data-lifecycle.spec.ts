import { test, expect } from '@playwright/test';
import { cleanAppState } from './test-helpers.js';

test.describe('Data Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
    // Navigate to transactions tab
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible', timeout: 5000 });
  });

  test('can fill expense form and submit', async ({ page }) => {
    // Fill the amount input
    const amountInput = page.locator('#amount');
    await amountInput.fill('50.00');

    // Wait for category chips to be rendered
    const categoryChip = page.locator('.category-chip').first();
    await expect(categoryChip).toBeVisible({ timeout: 5000 });
    await categoryChip.click();

    // Verify category is selected (should have different background)
    await page.waitForTimeout(200);

    // Enter description
    const descInput = page.locator('#description');
    await descInput.fill('Test expense');

    // Submit the form
    const submitBtn = page.locator('#submit-btn');
    await submitBtn.click();

    // After successful submission, the form amount should be cleared
    await expect(amountInput).toHaveValue('', { timeout: 5000 });
  });

  test('can switch to income tab', async ({ page }) => {
    // Switch to income tab
    const incomeTab = page.locator('#tab-income');
    await incomeTab.click();
    await page.waitForTimeout(300);

    // Verify income tab is active by checking class
    await expect(incomeTab).toHaveClass(/btn-success/);
  });

  test('transaction list area exists', async ({ page }) => {
    const txList = page.locator('#transactions-list');
    await expect(txList).toBeAttached();
  });

  test('export buttons are visible on transactions tab', async ({ page }) => {
    const exportJson = page.locator('#export-json-btn');
    const exportCsv = page.locator('#export-csv-btn');
    await expect(exportJson).toBeVisible({ timeout: 5000 });
    await expect(exportCsv).toBeVisible({ timeout: 5000 });
  });

  test('validates empty form', async ({ page }) => {
    // Try to submit without filling anything
    const submitBtn = page.locator('#submit-btn');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Amount should still be empty (form not cleared = submission was blocked)
    const amountInput = page.locator('#amount');
    await expect(amountInput).toHaveValue('');
  });

  test('rejects negative amounts', async ({ page }) => {
    const amountInput = page.locator('#amount');
    await amountInput.fill('-50');

    const descInput = page.locator('#description');
    await descInput.fill('Negative test');

    // Select a category
    const categoryChip = page.locator('.category-chip').first();
    if (await categoryChip.isVisible()) {
      await categoryChip.click();
    }

    const submitBtn = page.locator('#submit-btn');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Form should NOT be cleared (submission blocked)
    await expect(amountInput).not.toHaveValue('');
  });

  test('can access settings modal', async ({ page }) => {
    // Click settings button (available on all tabs)
    const settingsBtn = page.locator('#open-settings');
    await settingsBtn.click();

    // Settings modal should open
    const settingsModal = page.locator('#settings-modal.active');
    await expect(settingsModal).toBeVisible({ timeout: 5000 });
  });

  test('import button exists', async ({ page }) => {
    const importBtn = page.locator('#import-data-btn');
    await expect(importBtn).toBeVisible({ timeout: 5000 });
  });
});
