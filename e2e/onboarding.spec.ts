import { test, expect } from '@playwright/test';
import { cleanAppStateRaw } from './test-helpers.js';

test.describe('Onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppStateRaw(page);
  });

  test('shows onboarding on first visit', async ({ page }) => {
    // Wait for onboarding overlay to appear (use ID selector)
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Verify welcome message is shown
    await expect(page.locator('#onboarding-title')).toContainText('Welcome');
  });

  test('can navigate through onboarding steps', async ({ page }) => {
    // Wait for onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    const nextBtn = page.locator('#onboard-next');
    const title = page.locator('#onboarding-title');

    await expect(title).toContainText('Welcome');
    await expect(nextBtn).toBeVisible({ timeout: 5000 });

    await nextBtn.click();

    await expect(title).not.toContainText('Welcome', { timeout: 5000 });
    await expect(title).toContainText(/Plan Your Month|Track Your Spending|Categorize Everything|Use Calendar to Plan Timing|Watch the Dashboard|You're All Set!/, { timeout: 5000 });
  });

  test('can skip onboarding with skip button', async ({ page }) => {
    // Wait for onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Find and click skip button (button ID is onboard-skip)
    const skipBtn = page.locator('#onboard-skip');
    await expect(skipBtn).toBeVisible({ timeout: 5000 });
    await skipBtn.click();

    // Onboarding should be dismissed (overlay loses 'active' class)
    await expect(overlay).not.toBeVisible({ timeout: 5000 });
  });

  test('persists completion state', async ({ page }) => {
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    const skipBtn = page.locator('#onboard-skip');
    await expect(skipBtn).toBeVisible({ timeout: 5000 });
    await skipBtn.click();
    await expect(overlay).not.toBeVisible({ timeout: 5000 });

    await expect
      .poll(async () => page.evaluate(() => {
        const data = localStorage.getItem('budget_tracker_onboarding');
        return data ? JSON.parse(data) : null;
      }))
      .toMatchObject({ completed: true, active: false, step: 0 });
  });

  test('shows progress dots during onboarding', async ({ page }) => {
    // Wait for onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Check for progress dots (element ID is onboard-progress)
    const progressDots = page.locator('#onboard-progress');
    await expect(progressDots).toBeVisible({ timeout: 5000 });

    // Verify there are multiple progress indicator dots (rendered as plain divs)
    const dots = page.locator('#onboard-progress > div');
    const dotCount = await dots.count();
    expect(dotCount).toBeGreaterThanOrEqual(2);
  });
});
