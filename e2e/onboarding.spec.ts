import { test, expect } from '@playwright/test';

test.describe('Onboarding', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to simulate first visit
    await page.addInitScript(() => {
      localStorage.clear();
    });
  });

  test('shows onboarding on first visit', async ({ page }) => {
    await page.goto('/');

    // Wait for onboarding overlay to appear (use ID selector)
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Verify welcome message is shown
    await expect(page.locator('#onboarding-title')).toContainText('Welcome');
  });

  test('can navigate through onboarding steps', async ({ page }) => {
    await page.goto('/');

    // Wait for onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Click Next button to proceed through steps (button ID is onboard-next)
    const nextBtn = page.locator('#onboard-next');

    // Try to go through a few steps
    for (let i = 0; i < 3; i++) {
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(300); // Wait for animation
      }
    }

    // Should still have onboarding content or have completed
    const stillOnboarding = await overlay.isVisible();
    if (stillOnboarding) {
      await expect(page.locator('#onboarding-tooltip')).toBeVisible();
    }
  });

  test('can skip onboarding with skip button', async ({ page }) => {
    await page.goto('/');

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
    // For this test, we need to NOT use addInitScript since it clears on reload
    // Instead, we'll check that after skipping, the localStorage is set correctly
    await page.goto('/');

    // Wait for and skip onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    const skipBtn = page.locator('#onboard-skip');
    await expect(skipBtn).toBeVisible({ timeout: 5000 });
    await skipBtn.click();
    await expect(overlay).not.toBeVisible({ timeout: 5000 });

    // Verify localStorage was set correctly after skipping
    const onboardingState = await page.evaluate(() => {
      const data = localStorage.getItem('budget_tracker_onboarding');
      return data ? JSON.parse(data) : null;
    });

    // The onboarding should be marked as completed
    expect(onboardingState).not.toBeNull();
    expect(onboardingState.completed).toBe(true);
  });

  test('shows progress dots during onboarding', async ({ page }) => {
    await page.goto('/');

    // Wait for onboarding
    const overlay = page.locator('#onboarding-overlay.active');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Check for progress dots (element ID is onboard-progress)
    const progressDots = page.locator('#onboard-progress');
    await expect(progressDots).toBeVisible({ timeout: 5000 });

    // Verify there are multiple dots (6 steps)
    const dots = page.locator('#onboard-progress .onboard-dot');
    const dotCount = await dots.count();
    expect(dotCount).toBe(6);
  });
});
