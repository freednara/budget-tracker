import { expect, test } from '@playwright/test';
import { cleanAppState, waitForInteractiveAppReady } from './test-helpers.js';

async function reinitializeApp(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const moduleUrl = new URL('/js/modules/orchestration/app-init-di.js', window.location.origin).toString();
    const app = await import(/* @vite-ignore */ moduleUrl);
    app.cleanupApp();
    await app.initializeApp();
  });
}

test.describe('Re-init lifecycle', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
  });

  test('cleanup and re-init keep filters and emoji picker single-fire', async ({ page }) => {
    await reinitializeApp(page);
    await waitForInteractiveAppReady(page);

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });

    const advancedToggle = page.locator('#toggle-advanced-filters');
    await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
    await advancedToggle.click();
    await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
    await advancedToggle.click();
    await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');

    await page.locator('#tab-budget-btn').click();
    await expect(page.locator('#tab-budget')).toBeVisible({ timeout: 10000 });

    await page.locator('#open-plan-budget').click();
    await expect(page.locator('#plan-budget-modal')).toBeVisible({ timeout: 10000 });
    await page.locator('#add-cat-from-budget').click();
    await expect(page.locator('#category-modal')).toBeVisible({ timeout: 10000 });

    const emojiTrigger = page.locator('#emoji-picker-trigger');
    const emojiDropdown = page.locator('#emoji-picker-dropdown');
    await emojiTrigger.click();
    await expect(emojiDropdown).toBeVisible({ timeout: 5000 });
  });

  test('month swipe navigation works after normal startup', async ({ page }) => {
    const initialMonth = await page.locator('#current-month-label').textContent();

    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) {
        throw new Error('Main content not found');
      }

      const startEvent = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(startEvent, 'touches', {
        configurable: true,
        value: [{ clientX: 260, clientY: 120 }],
      });
      main.dispatchEvent(startEvent);

      const endEvent = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(endEvent, 'changedTouches', {
        configurable: true,
        value: [{ clientX: 80, clientY: 126 }],
      });
      main.dispatchEvent(endEvent);
    });

    await expect(page.locator('#current-month-label')).not.toHaveText(initialMonth || '', { timeout: 5000 });
  });
});
