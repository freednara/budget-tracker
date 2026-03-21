import { test, expect } from '@playwright/test';
import { cleanAppState } from './test-helpers.js';

/**
 * Complex Financial Flows E2E Tests
 * Covers: Transaction Splitting, Debt Management, and Strategy Comparison
 */

test.describe('Complex Financial Flows', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
  });

  test('can split a transaction into multiple categories', async ({ page }) => {
    // Wait for app to load first
    await page.waitForSelector('#total-expenses', { state: 'visible' });

    // 1. Add a base transaction to split
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });
    await page.locator('#amount').fill('100.00');
    await page.locator('#description').fill('Grocery and Home split');
    
    // Wait for and click first category chip (e.g., Food)
    const firstCat = page.locator('.category-chip').first();
    await expect(firstCat).toBeVisible();
    await firstCat.click();
    
    await page.locator('#submit-btn').click();
    await page.waitForTimeout(500);

    // 2. Find the transaction and click split button
    const txRow = page.locator('.transaction-row').first();
    await expect(txRow).toBeVisible();
    
    // Click the split button (scissors icon)
    await txRow.locator('.split-btn').click();
    
    // 3. Configure the split in the modal
    await page.waitForSelector('#split-modal', { state: 'visible' });
    
    // Check original amount is shown
    await expect(page.locator('#split-original-amount')).toContainText('100.00');
    
    // Add a second split row
    await page.locator('#add-split-row').click();
    
    // Fill in split amounts (e.g., 60 and 40)
    const splitAmounts = page.locator('.split-row input[type="number"]');
    await splitAmounts.nth(0).fill('60.00');
    await splitAmounts.nth(1).fill('40.00');
    
    // Verify the split is balanced
    await expect(page.locator('#split-remaining')).toContainText('Balanced');
    
    // Save the split
    await page.locator('#save-split').click();
    
    // 4. Verify toast and list update
    await expect(page.locator('.toast').filter({ hasText: 'Transaction split successfully' }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#split-modal')).not.toBeVisible();
    
    // The original row should now be marked as split
    await expect(txRow.locator('.tx-description')).toContainText('Split:');
  });

  test('can manage debt and compare payoff strategies', async ({ page }) => {
    // Wait for app to load first
    await page.waitForSelector('#total-expenses', { state: 'visible' });

    // 1. Navigate to Budget tab (where Debt Planner lives)
    await page.locator('#tab-budget-btn').click();
    await page.waitForSelector('#debt-planner-section', { state: 'visible' });

    // 2. Add two different debts to enable comparison
    // Debt 1: High interest, low balance
    await page.locator('#add-debt-btn').click();
    await page.waitForSelector('#debt-modal', { state: 'visible' });
    await page.locator('#debt-name').fill('Credit Card A');
    await page.locator('#debt-balance').fill('1000.00');
    await page.locator('#debt-interest').fill('24.99');
    await page.locator('#debt-minimum').fill('50.00');
    await page.locator('#save-debt').click();
    await page.waitForTimeout(300);

    // Debt 2: Low interest, high balance
    await page.locator('#add-debt-btn').click();
    await page.waitForSelector('#debt-modal', { state: 'visible' });
    await page.locator('#debt-name').fill('Personal Loan B');
    await page.locator('#debt-balance').fill('5000.00');
    await page.locator('#debt-interest').fill('7.5');
    await page.locator('#debt-minimum').fill('150.00');
    await page.locator('#save-debt').click();
    await page.waitForTimeout(300);

    // 3. Verify Summary updated
    await expect(page.locator('#total-debt')).toContainText('6,000.00');

    // 4. Record a payment on one debt
    const firstDebt = page.locator('.debt-item').first();
    await firstDebt.locator('.debt-payment-btn').click();
    await page.waitForSelector('#debt-payment-modal', { state: 'visible' });
    await page.locator('#debt-payment-amount').fill('100.00');
    await page.locator('#confirm-debt-payment').click();
    
    // Verify list updated (balance should decrease)
    await expect(firstDebt).toContainText('920.83');

    // 5. Compare Strategies
    const compareBtn = page.locator('#compare-strategies-btn');
    await expect(compareBtn).toBeVisible();
    await compareBtn.click();
    
    await page.waitForSelector('#debt-strategy-modal', { state: 'visible' });
    
    // Check that both methods are calculated
    await expect(page.locator('#snowball-months')).not.toContainText('--');
    await expect(page.locator('#avalanche-months')).not.toContainText('--');
    
    // Check for recommendation text
    await expect(page.locator('#strategy-rec-text')).not.toContainText('--');
    
    await page.locator('#close-strategy-modal').click();
  });

  test('can set up a savings goal and contribute to it', async ({ page }) => {
    // Wait for app to load first
    await page.waitForSelector('#total-expenses', { state: 'visible' });

    // 1. Navigate to Budget tab
    await page.locator('#tab-budget-btn').click();
    
    // 2. Create a new goal
    await page.locator('#add-savings-goal-btn').click();
    await page.waitForSelector('#savings-goal-modal', { state: 'visible' });
    await page.locator('#savings-goal-name').fill('New Car');
    await page.locator('#savings-goal-amount').fill('20000.00');
    await page.locator('#save-savings-goal').click();
    
    // 3. Verify goal appears in list
    const goalItem = page.locator('#savings-goals-list > div').first();
    await expect(goalItem).toBeVisible({ timeout: 5000 });
    await expect(goalItem).toContainText('New Car');

    // 4. Contribute to the goal (click the + button inside the goal card)
    await goalItem.locator('button').first().click();
    await page.waitForSelector('#add-savings-modal', { state: 'visible' });
    await page.locator('#add-savings-amount').fill('500.00');
    await page.locator('#confirm-add-savings').click();
    
    // 5. Verify progress updated and transaction created
    await expect(page.locator('.toast').filter({ hasText: 'Added $500.00 to New Car' }).last()).toBeVisible({ timeout: 5000 });
    await expect(goalItem).toContainText('500.00');
    
    // Verify transaction was created in main ledger
    await page.locator('#tab-transactions-btn').click();
    const txRow = page.locator('.transaction-row').first();
    await expect(txRow).toContainText('Transfer to New Car');
    await expect(txRow).toContainText('Savings Transfer');
    await expect(txRow).toContainText('500.00');

    // Dashboard copy should explain that savings transfers affect current month cash
    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#hero-motivation')).toContainText('moved $500.00 to savings');
  });
});
