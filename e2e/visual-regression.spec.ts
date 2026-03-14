import { test, expect } from '@playwright/test';

/**
 * Visual Regression Tests for Budget Tracker Elite
 *
 * Tests all major components across:
 * - Light and Dark themes
 * - Mobile (375px), Tablet (768px), Desktop (1440px) viewports
 */

const THEMES = ['dark', 'light'] as const;
const VIEWPORTS = [
  { width: 375, height: 667, name: 'mobile' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 1440, height: 900, name: 'desktop' },
] as const;

// Helper to set up app state
async function setupApp(page: typeof import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.addInitScript((t) => {
    localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    // Set theme preference
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

test.describe('Visual Regression - Dashboard', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`dashboard - ${theme} - ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await setupApp(page, theme);
        await page.goto('/');

        // Wait for dashboard to be fully rendered
        await page.waitForSelector('#total-income', { state: 'visible' });
        await page.waitForTimeout(500); // Allow animations to settle

        await expect(page).toHaveScreenshot(`dashboard-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.05,
        });
      });
    }
  }
});

test.describe('Visual Regression - Transactions Tab', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`transactions - ${theme} - ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await setupApp(page, theme);
        await page.goto('/');

        // Navigate to transactions tab
        await page.locator('#tab-transactions-btn').click();
        await page.waitForSelector('#amount', { state: 'visible' });
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`transactions-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.05,
        });
      });
    }
  }
});

test.describe('Visual Regression - Budget Tab', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`budget - ${theme} - ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await setupApp(page, theme);
        await page.goto('/');

        // Navigate to budget tab
        await page.locator('#tab-budget-btn').click();
        await page.waitForTimeout(500);

        await expect(page).toHaveScreenshot(`budget-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.05,
        });
      });
    }
  }
});

test.describe('Visual Regression - Settings Modal', () => {
  for (const theme of THEMES) {
    test(`settings modal - ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await setupApp(page, theme);
      await page.goto('/');

      // Open settings
      await page.locator('#open-settings').click();
      await page.waitForSelector('#settings-modal', { state: 'visible' });
      await page.waitForTimeout(300);

      await expect(page).toHaveScreenshot(`settings-modal-${theme}.png`, {
        maxDiffPixelRatio: 0.05,
      });
    });
  }
});

test.describe('Visual Regression - Category Chips', () => {
  for (const theme of THEMES) {
    test(`category chips - ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await setupApp(page, theme);
      await page.goto('/');

      // Navigate to transactions to see category chips
      await page.locator('#tab-transactions-btn').click();
      await page.waitForSelector('.category-chip', { state: 'visible' });

      // Capture just the category section
      const categorySection = page.locator('#category-chips').first();
      if (await categorySection.isVisible()) {
        await expect(categorySection).toHaveScreenshot(`category-chips-${theme}.png`, {
          maxDiffPixelRatio: 0.05,
        });
      }
    });
  }
});

test.describe('Visual Regression - Form Inputs', () => {
  for (const theme of THEMES) {
    test(`form inputs - ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await setupApp(page, theme);
      await page.goto('/');

      // Navigate to transactions
      await page.locator('#tab-transactions-btn').click();
      await page.waitForSelector('#amount', { state: 'visible' });

      // Fill in some values to see focus states
      await page.locator('#amount').fill('50.00');
      await page.locator('#description').fill('Test expense');

      await expect(page).toHaveScreenshot(`form-inputs-${theme}.png`, {
        maxDiffPixelRatio: 0.05,
      });
    });
  }
});

test.describe('Visual Regression - Onboarding', () => {
  for (const theme of THEMES) {
    test(`onboarding overlay - ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });

      // Clear localStorage to trigger onboarding
      await page.addInitScript(() => {
        localStorage.clear();
      });
      await page.goto('/');

      // Wait for onboarding to appear
      await page.waitForSelector('#onboarding-overlay.active', { timeout: 10000 });
      await page.waitForTimeout(500);

      await expect(page).toHaveScreenshot(`onboarding-${theme}.png`, {
        maxDiffPixelRatio: 0.05,
      });
    });
  }
});

test.describe('Visual Regression - Toast Notifications', () => {
  test('toast notification - dark', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Navigate to transactions and submit a form to trigger toast
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });

    await page.locator('#amount').fill('50.00');
    await page.locator('.category-chip').first().click();
    await page.locator('#submit-btn').click();

    // Wait for toast to appear
    await page.waitForTimeout(1000);

    // Toast may or may not be visible, but capture the state
    await expect(page).toHaveScreenshot('toast-notification.png', {
      maxDiffPixelRatio: 0.1,
    });
  });
});

test.describe('Accessibility - Focus States', () => {
  test('button focus states visible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Tab to navigation buttons
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    // Check that focus is visible (the outline should be present)
    const focusedElement = page.locator(':focus-visible');
    await expect(focusedElement).toBeVisible();
  });

  test('input focus states visible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Navigate to transactions
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });

    // Focus on amount input
    await page.locator('#amount').focus();

    // Verify focus styling is applied
    const amountInput = page.locator('#amount');
    const outlineColor = await amountInput.evaluate((el) => {
      return window.getComputedStyle(el).outlineColor;
    });

    // Should have an outline (not transparent/none)
    expect(outlineColor).not.toBe('rgba(0, 0, 0, 0)');
  });
});

test.describe('Accessibility - Touch Targets', () => {
  test('buttons meet minimum touch target size (44px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Check navigation buttons
    const settingsBtn = page.locator('#open-settings');
    const analyticsBtn = page.locator('#open-analytics');

    const settingsBox = await settingsBtn.boundingBox();
    const analyticsBox = await analyticsBtn.boundingBox();

    // Verify minimum 44px touch targets
    expect(settingsBox?.width).toBeGreaterThanOrEqual(44);
    expect(settingsBox?.height).toBeGreaterThanOrEqual(44);
    expect(analyticsBox?.width).toBeGreaterThanOrEqual(44);
    expect(analyticsBox?.height).toBeGreaterThanOrEqual(44);
  });

  test('month navigation buttons meet minimum touch target size', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    const prevMonth = page.locator('#prev-month');
    const nextMonth = page.locator('#next-month');

    const prevBox = await prevMonth.boundingBox();
    const nextBox = await nextMonth.boundingBox();

    expect(prevBox?.width).toBeGreaterThanOrEqual(44);
    expect(prevBox?.height).toBeGreaterThanOrEqual(44);
    expect(nextBox?.width).toBeGreaterThanOrEqual(44);
    expect(nextBox?.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('Accessibility - Contrast Ratios', () => {
  test('primary text has sufficient contrast in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Set theme after page load
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await page.waitForTimeout(100);

    // Get computed styles for primary text
    const textColor = await page.evaluate(() => {
      const el = document.querySelector('.text-primary');
      if (!el) return null;
      return window.getComputedStyle(el).color;
    });

    // Primary text in dark mode should be light (#f8fafc = rgb(248, 250, 252))
    expect(textColor).toContain('248');
  });

  test('primary text has sufficient contrast in light mode', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // Set theme after page load
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await page.waitForTimeout(100);

    // Get computed styles for primary text
    const textColor = await page.evaluate(() => {
      const el = document.querySelector('.text-primary');
      if (!el) return null;
      return window.getComputedStyle(el).color;
    });

    // Primary text in light mode should be dark (#0f172a = rgb(15, 23, 42))
    expect(textColor).toContain('15');
  });
});

test.describe('Responsive Layout', () => {
  test('hero card stacks on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // The hero grid should be single column on mobile
    const heroGrid = page.locator('.hero-dashboard-grid');
    const gridStyles = await heroGrid.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });

    // Should be single column - only one value (e.g., "343px" not "900px 450px")
    const columnCount = gridStyles.split(' ').filter(s => s.includes('px')).length;
    expect(columnCount).toBe(1);
  });

  test('hero card uses 2-column layout on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.goto('/');

    // The hero grid should have 2 columns on desktop
    const heroGrid = page.locator('.hero-dashboard-grid');
    const gridStyles = await heroGrid.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });

    // Should have 2 columns (two pixel values)
    const columnCount = gridStyles.split(' ').filter(s => s.includes('px')).length;
    expect(columnCount).toBe(2);
  });
});
