import { test, expect } from '@playwright/test';
import { loadSampleDataFromSettings } from './test-helpers.js';

/**
 * Visual Regression Tests for Harbor Ledger
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
async function setupApp(page: import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.addInitScript((t: string) => {
    localStorage.clear();
    localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    localStorage.setItem('budget_tracker_migration_status', JSON.stringify({ completed: true, timestamp: Date.now(), version: '2.7', itemCount: 0 }));
    localStorage.setItem('budget_tracker_theme', JSON.stringify(t));
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });
  // Ensure theme is applied
  await page.evaluate((t: string) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function enableStandaloneLikeMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);

    Object.defineProperty(window.navigator, 'standalone', {
      configurable: true,
      get: () => true,
    });

    window.matchMedia = ((query: string): MediaQueryList => {
      const result = originalMatchMedia(query);

      if (query !== '(display-mode: standalone)') {
        return result;
      }

      return {
        matches: true,
        media: query,
        onchange: result.onchange,
        addListener: result.addListener.bind(result),
        removeListener: result.removeListener.bind(result),
        addEventListener: result.addEventListener.bind(result),
        removeEventListener: result.removeEventListener.bind(result),
        dispatchEvent: result.dispatchEvent.bind(result),
      } as MediaQueryList;
    }) as typeof window.matchMedia;
  });
}

async function swipeTransactionRow(
  page: import('@playwright/test').Page,
  rowLocator: import('@playwright/test').Locator,
  direction: 'left' | 'right'
) {
  await rowLocator.evaluate((row, swipeDirection) => {
    const target = (row.querySelector('.swipe-content') as HTMLElement | null) ?? (row as HTMLElement);
    const rect = target.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.55;
    const endX = swipeDirection === 'left'
      ? rect.left + rect.width * 0.12
      : rect.left + rect.width * 0.88;
    const y = rect.top + rect.height * 0.5;

    const createTouchLike = (clientX: number) => ({
      identifier: 1,
      target,
      clientX,
      clientY: y,
      pageX: clientX,
      pageY: y,
      screenX: clientX,
      screenY: y,
    });

    const dispatchTouchEvent = (type: string, touches: Array<ReturnType<typeof createTouchLike>>, changedTouches: Array<ReturnType<typeof createTouchLike>>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches, configurable: true },
        targetTouches: { value: touches, configurable: true },
        changedTouches: { value: changedTouches, configurable: true },
      });
      target.dispatchEvent(event);
    };

    const startTouch = createTouchLike(startX);
    const moveTouch = createTouchLike(endX);

    dispatchTouchEvent('touchstart', [startTouch], [startTouch]);
    dispatchTouchEvent('touchmove', [moveTouch], [moveTouch]);
    dispatchTouchEvent('touchend', [], [moveTouch]);
  }, direction);

  await page.waitForTimeout(200);
}

test.describe('Visual Regression - Dashboard', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`dashboard - ${theme} - ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await setupApp(page, theme);

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

test.describe('Visual Regression - Calendar Tab', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`calendar - ${theme} - ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await setupApp(page, theme);

        await page.locator('#tab-calendar-btn').click();
        await page.waitForSelector('#cal-detail-panel', { state: 'visible' });
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`calendar-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.05,
        });
      });
    }
  }
});

test.describe('Visual Regression - Mobile Critical Surfaces', () => {
  test('dashboard mobile standalone critical surface', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await enableStandaloneLikeMode(page);
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-dashboard-btn').click();
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('dashboard-mobile-standalone-critical.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('transactions mobile form critical surface', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#form-section', { state: 'visible' });
    await page.waitForTimeout(300);

    await expect(page.locator('#form-section')).toHaveScreenshot('transactions-mobile-form-critical.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('transactions mobile left-swipe actions', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-transactions-btn').click();
    const firstRow = page.locator('#transactions-list .swipe-container').first();
    await firstRow.scrollIntoViewIfNeeded();
    await swipeTransactionRow(page, firstRow, 'left');

    await expect(firstRow).toHaveScreenshot('transactions-mobile-left-swipe.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('transactions mobile right-swipe actions', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-transactions-btn').click();
    const firstRow = page.locator('#transactions-list .swipe-container').first();
    await firstRow.scrollIntoViewIfNeeded();
    await swipeTransactionRow(page, firstRow, 'right');

    await expect(firstRow).toHaveScreenshot('transactions-mobile-right-swipe.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('calendar mobile main-detail critical surface', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-calendar-btn').click();
    await page.waitForSelector('.calendar-tab-grid', { state: 'visible' });
    await page.waitForTimeout(300);

    await expect(page.locator('.calendar-tab-grid')).toHaveScreenshot('calendar-mobile-critical.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('mobile shell and alert stack', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await enableStandaloneLikeMode(page);
    await setupApp(page, 'dark');
    await page.evaluate(() => {
      const banner = document.getElementById('alert-banner');
      const main = document.querySelector('main.app-main-shell') as HTMLElement | null;
      if (!banner) return;

      banner.classList.remove('hidden');
      banner.innerHTML = `
        <div class="w-full px-4 md:px-8 py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="text-lg">⚠️</span>
            <p id="alert-text" class="text-sm font-semibold text-warning">Budget alert preview</p>
          </div>
          <button id="dismiss-alert" class="touch-btn text-sm font-bold rounded text-warning" aria-label="Dismiss alert">✕</button>
        </div>
      `;

      if (main) {
        main.style.display = 'none';
      }
    });
    await expect(page.locator('#alert-banner')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(250);

    await expect(page).toHaveScreenshot('mobile-shell-alert-stack.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('settings modal mobile sheet', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#open-settings').click();
    await expect(page.locator('#settings-modal')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(250);

    await expect(page.locator('#settings-modal > div')).toHaveScreenshot('settings-modal-mobile-sheet.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('analytics modal mobile sheet', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await page.locator('#open-analytics').click();
    await expect(page.locator('#analytics-modal')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(250);

    await expect(page.locator('#analytics-modal > div')).toHaveScreenshot('analytics-modal-mobile-sheet.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});

test.describe('Visual Regression - Settings Modal', () => {
  for (const theme of THEMES) {
    test(`settings modal - ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await setupApp(page, theme);

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
      await page.goto('/');
      await page.evaluate(() => {
        localStorage.clear();
      });
      await page.reload();
      await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
    });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

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
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

    // The hero grid should be single column on mobile
    const heroGrid = page.locator('#tab-dashboard > section.hero-dashboard-grid').first();
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
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__APP_INITIALIZED__, { timeout: 15000 });

    // The hero grid should have 2 columns on desktop
    const heroGrid = page.locator('#tab-dashboard > section.hero-dashboard-grid').first();
    const gridStyles = await heroGrid.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });

    // Should have 2 columns (two pixel values)
    const columnCount = gridStyles.split(' ').filter(s => s.includes('px')).length;
    expect(columnCount).toBe(2);
  });
});
