import { test, expect } from '@playwright/test';
import { cleanAppState } from './test-helpers.js';

test.describe('Dashboard Layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
  });

  test('prioritizes allowance and keeps deeper analysis in analytics', async ({ page }) => {
    await expect(page.locator('#tab-dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-calendar-btn')).toBeVisible();

    await expect(page.locator('#today-remaining')).toHaveCount(0);
    await expect(page.locator('.hero-card #pace-bar')).toBeVisible();
    await expect(page.locator('.hero-card')).toContainText('MONTH ELAPSED');
    await expect(page.locator('.hero-card')).toContainText('SPENDING PACE');
    await expect(page.locator('#pace-label')).toContainText('of income spent');
    await expect(page.locator('#hero-primary-action')).toBeVisible();
    await expect(page.locator('#hero-secondary-action')).toBeVisible();
    await expect(page.locator('#hero-primary-action')).toHaveText(/Plan Budget|Add Transaction|Review Budget/);
    await expect(page.locator('.hero-sidebar .dashboard-support-card')).toHaveCount(3);
    await expect(page.locator('#tab-dashboard').locator('#spending-heatmap')).toHaveCount(0);
    await expect(page.locator('#tab-dashboard').locator('#month-comparison')).toHaveCount(0);
    await expect(page.locator('#tab-dashboard').locator('#budget-vs-actual-section')).toHaveCount(0);

    await page.locator('#open-analytics').click();
    await expect(page.locator('#analytics-modal')).toBeVisible();
    await expect(page.locator('#analytics-trend-section')).toBeVisible();
    await expect(page.locator('#analytics-category-trends')).toBeVisible();
    await expect(page.locator('#analytics-month-comparison-section')).toBeVisible();
    await expect(page.locator('#analytics-calendar-section')).toHaveCount(0);
  });

  test('keeps budget focused on planning, transactions on ledger work, and calendar on time-based planning', async ({ page }) => {
    await page.locator('#tab-budget-btn').click();
    await expect(page.locator('#tab-budget')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#envelope-section')).toBeVisible();
    await expect(page.locator('#savings-goals-section')).toBeVisible();
    await expect(page.locator('#debt-planner-section')).toBeVisible();

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#form-section')).toBeVisible();
    await expect(page.locator('.transactions-column--ledger')).toBeVisible();
    await expect(page.locator('.transactions-support-grid')).toBeVisible();
    await expect(page.locator('.transactions-ledger-card')).toBeVisible();
    await expect(page.locator('#toggle-advanced-filters')).toHaveAttribute('aria-expanded', 'false');

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#calendar-upcoming-summary')).toBeVisible();
    await expect(page.locator('#spending-heatmap')).toBeVisible();
    await expect(page.locator('#cal-detail-panel')).toBeVisible();
  });
});
