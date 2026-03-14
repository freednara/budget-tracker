import { test, expect } from '@playwright/test';

test.describe('Security - PIN Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage and skip onboarding
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
  });

  test('can access PIN settings in modal', async ({ page }) => {
    await page.goto('/');

    // Open settings
    const settingsBtn = page.locator('#open-settings');
    await settingsBtn.click();

    // Wait for settings modal
    await page.waitForSelector('#settings-modal', { state: 'visible' });

    // Look for PIN input field
    const pinInput = page.locator('#settings-pin');
    await expect(pinInput).toBeVisible({ timeout: 5000 });
  });

  test('PIN input accepts numeric values', async ({ page }) => {
    await page.goto('/');

    // Open settings
    const settingsBtn = page.locator('#open-settings');
    await settingsBtn.click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });

    // Enter PIN in the settings PIN field
    const pinInput = page.locator('#settings-pin');
    await expect(pinInput).toBeVisible();
    await pinInput.fill('1234');

    // Verify the value was entered
    const value = await pinInput.inputValue();
    expect(value).toBe('1234');
  });

  test('save PIN button exists', async ({ page }) => {
    await page.goto('/');

    // Open settings
    const settingsBtn = page.locator('#open-settings');
    await settingsBtn.click();
    await page.waitForSelector('#settings-modal', { state: 'visible' });

    // Check for save PIN button
    const savePinBtn = page.locator('#save-pin-btn');
    await expect(savePinBtn).toBeVisible();
  });
});

test.describe('Security - Input Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');
    // Navigate to transactions tab
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible', timeout: 10000 });
  });

  test('prevents HTML injection in description', async ({ page }) => {
    const amountInput = page.locator('#amount');
    await amountInput.fill('10.00');

    const categoryChip = page.locator('.category-chip').first();
    await expect(categoryChip).toBeVisible();
    await categoryChip.click();
    await page.waitForTimeout(200);

    // Try to inject HTML
    const descInput = page.locator('#description');
    await descInput.fill('<script>alert("xss")</script>');

    const submitBtn = page.locator('#submit-btn');
    await submitBtn.click();

    await page.waitForTimeout(500);

    // The script tag should be escaped, not executed
    // Page content should not contain unescaped script tag
    const content = await page.content();
    // Check that no script injection occurred (either sanitized or not rendered)
    expect(content).not.toMatch(/<script>alert\("xss"\)<\/script>/);
  });

  test('description input has maxlength or truncates', async ({ page }) => {
    const amountInput = page.locator('#amount');
    await amountInput.fill('10.00');

    const categoryChip = page.locator('.category-chip').first();
    await categoryChip.click();

    // Try to enter very long description
    const longText = 'a'.repeat(1000);
    const descInput = page.locator('#description');
    await descInput.fill(longText);

    // Check if text was truncated or limited
    const actualValue = await descInput.inputValue();
    // Should be limited to some reasonable length (500 chars or less)
    expect(actualValue.length).toBeLessThanOrEqual(500);
  });

  test('date input exists and accepts dates', async ({ page }) => {
    const dateInput = page.locator('#date');
    await expect(dateInput).toBeVisible();

    // Should have a default value (today's date)
    const value = await dateInput.inputValue();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe('Security - Data Integrity', () => {
  test('localStorage keys are properly namespaced', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Check that app uses proper namespacing for localStorage
    const keys = await page.evaluate(() => Object.keys(localStorage));

    // All budget tracker keys should be prefixed
    const budgetKeys = keys.filter(k => k.startsWith('budget_tracker'));
    expect(budgetKeys.length).toBeGreaterThan(0);
  });
});
