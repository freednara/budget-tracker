import { test, expect } from '@playwright/test';
import { cleanAppState } from './test-helpers.js';

test.describe('Dashboard Layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
  });

  test('prioritizes allowance and collapses deeper analysis by default', async ({ page }) => {
    await expect(page.locator('#tab-dashboard')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('#today-remaining')).toHaveCount(0);
    await expect(page.locator('.hero-card #pace-bar')).toBeVisible();
    await expect(page.locator('.hero-card')).toContainText('MONTH ELAPSED');
    await expect(page.locator('.hero-card')).toContainText('SPENDING PACE');
    await expect(page.locator('#pace-label')).toContainText('of income spent');
    await expect(page.locator('#hero-primary-action')).toBeVisible();
    await expect(page.locator('#hero-secondary-action')).toBeVisible();
    await expect(page.locator('#hero-primary-action')).toHaveText(/Plan Budget|Add Transaction|Review Budget/);
    await expect(page.locator('.hero-sidebar .dashboard-support-card')).toHaveCount(3);

    const moreAnalysis = page.locator('#dashboard-more-analysis');
    await expect(moreAnalysis).toBeVisible();
    await expect(moreAnalysis).not.toHaveJSProperty('open', true);

    await expect(page.locator('#spending-heatmap')).not.toBeVisible();
    await expect(page.locator('#month-comparison')).not.toBeVisible();
  });

  test('keeps budget focused on planning and transactions focused on ledger work', async ({ page }) => {
    await page.locator('#tab-budget-btn').click();
    await expect(page.locator('#tab-budget')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#envelope-section')).toBeVisible();
    await expect(page.locator('#savings-goals-section')).toBeVisible();
    await expect(page.locator('#debt-planner-section')).toBeVisible();

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.transactions-top-grid')).toBeVisible();
    await expect(page.locator('.transactions-main-grid')).toBeVisible();
    await expect(page.locator('#form-section')).toBeVisible();
    await expect(page.locator('.transactions-ledger-card')).toBeVisible();
    await expect(page.locator('#toggle-advanced-filters')).toHaveAttribute('aria-expanded', 'false');
  });
});
