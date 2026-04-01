import { test, expect } from '@playwright/test';
import {
  bootFreshApp,
  cleanAppStateRaw,
  installPlaywrightBootstrap,
  loadSampleDataFromSettings,
  resetAppState
} from './test-helpers.js';

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

const FROZEN_TIME_MS = Date.parse('2026-03-15T12:00:00-04:00');

test.use({ timezoneId: 'America/New_York' });

async function installDeterministicAppBootstrap(
  page: import('@playwright/test').Page,
  theme: 'dark' | 'light',
  options: { alertThreshold?: number; completeOnboarding?: boolean } = {}
) {
  await page.addInitScript(({ fixedNow, nextTheme, alertThreshold, completeOnboarding }) => {
    const NativeDate = Date;

    class MockDate extends NativeDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixedNow);
          return;
        }
        if (args.length === 1) {
          super(args[0]);
          return;
        }
        if (args.length === 2) {
          super(args[0], args[1]);
          return;
        }
        if (args.length === 3) {
          super(args[0], args[1], args[2]);
          return;
        }
        if (args.length === 4) {
          super(args[0], args[1], args[2], args[3]);
          return;
        }
        if (args.length === 5) {
          super(args[0], args[1], args[2], args[3], args[4]);
          return;
        }
        if (args.length === 6) {
          super(args[0], args[1], args[2], args[3], args[4], args[5]);
          return;
        }
        super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
      }

      static now(): number {
        return fixedNow;
      }
    }

    Object.defineProperty(window, 'Date', {
      configurable: true,
      writable: true,
      value: MockDate,
    });

    if (completeOnboarding) {
      localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, active: false, step: 0 }));
    }
    localStorage.setItem('budget_tracker_migration_status', JSON.stringify({ completed: true, timestamp: fixedNow, version: '2.7', itemCount: 0 }));
    localStorage.setItem('budget_tracker_theme', JSON.stringify(nextTheme));
    if (typeof alertThreshold === 'number') {
      localStorage.setItem('budget_tracker_alert_prefs', JSON.stringify({
        budgetThreshold: alertThreshold,
        browserNotificationsEnabled: false,
        lastNotifiedAlertKeys: [],
      }));
    }
    document.documentElement.setAttribute('data-theme', nextTheme);
  }, {
    fixedNow: FROZEN_TIME_MS,
    nextTheme: theme,
    alertThreshold: options.alertThreshold ?? null,
    completeOnboarding: options.completeOnboarding !== false
  });
}

// Helper to set up app state
async function setupApp(
  page: import('@playwright/test').Page,
  theme: 'dark' | 'light',
  options: { alertThreshold?: number } = {}
) {
  await resetAppState(page, true);
  await installDeterministicAppBootstrap(page, theme, options);
  await installPlaywrightBootstrap(page);
  await bootFreshApp(page, 'background');

  await page.evaluate((t: string) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function waitForToastQueueToClear(
  page: import('@playwright/test').Page,
  timeout = 15000
): Promise<void> {
  await expect(page.locator('#toast-container .toast')).toHaveCount(0, { timeout });
}

async function waitForSampleImportToSettle(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.transaction-row').first()).toBeVisible({ timeout: 15000 });
  await waitForToastQueueToClear(page);
}

async function getShellAlertClip(page: import('@playwright/test').Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('Viewport size unavailable');
  }

  return await page.evaluate((viewportWidth) => {
    const shell = document.querySelector('.app-shell') as HTMLElement | null;
    const alertBanner = document.getElementById('alert-banner') as HTMLElement | null;

    if (!shell || !alertBanner) {
      throw new Error('Shell or alert banner host missing');
    }

    const shellRect = shell.getBoundingClientRect();
    const alertsRect = alertBanner.getBoundingClientRect();
    const top = Math.max(0, Math.floor(shellRect.top + window.scrollY));
    const bottom = Math.ceil(alertsRect.bottom + window.scrollY);

    return {
      x: 0,
      y: top,
      width: viewportWidth,
      height: Math.max(1, bottom - top)
    };
  }, viewport.width);
}

async function prepareShellBudgetAlert(page: import('@playwright/test').Page) {
  await setupApp(page, 'dark', { alertThreshold: 0.01 });
  await loadSampleDataFromSettings(page);
  await waitForSampleImportToSettle(page);
  await page.locator('#tab-dashboard-btn').click();
  await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#dashboard-alerts .inline-alert-card')).toHaveCount(0);
  await expect(page.locator('#budget-alerts .inline-alert-card')).toHaveCount(0);
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
        await loadSampleDataFromSettings(page);
        await waitForSampleImportToSettle(page);
        await page.locator('#tab-dashboard-btn').click();

        // Wait for dashboard to be fully rendered
        await page.waitForSelector('#dashboard-income-card', { state: 'visible' });
        await page.waitForSelector('#budget-gauge-section', { state: 'visible' });
        await page.waitForTimeout(500); // Allow animations to settle

        await expect(page).toHaveScreenshot(`dashboard-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.03,
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
        await loadSampleDataFromSettings(page);
        await waitForSampleImportToSettle(page);

        // Navigate to transactions tab
        await page.locator('#tab-transactions-btn').click();
        await page.waitForSelector('#amount', { state: 'visible' });
        await expect(page.locator('.transaction-row').first()).toBeVisible({ timeout: 10000 });
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`transactions-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.03,
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
        await loadSampleDataFromSettings(page);
        await waitForSampleImportToSettle(page);

        // Navigate to budget tab
        await page.locator('#tab-budget-btn').click();
        await page.waitForSelector('#envelope-section', { state: 'visible' });
        await page.waitForSelector('#savings-goals-section', { state: 'visible' });
        await page.waitForSelector('#debt-planner-section', { state: 'visible' });
        await page.waitForTimeout(500);

        await expect(page).toHaveScreenshot(`budget-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.03,
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
        await loadSampleDataFromSettings(page);
        await waitForSampleImportToSettle(page);

        await page.locator('#tab-calendar-btn').click();
        await page.waitForSelector('#cal-detail-panel', { state: 'visible' });
        await page.waitForSelector('.calendar-tab-grid', { state: 'visible' });
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`calendar-${theme}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.03,
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
    await waitForSampleImportToSettle(page);
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
    await waitForSampleImportToSettle(page);
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#form-section', { state: 'visible' });
    await page.waitForTimeout(300);

    await expect(page.locator('#form-section')).toHaveScreenshot('transactions-mobile-form-critical.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('transactions mobile list cards default state', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await waitForSampleImportToSettle(page);
    await page.locator('#tab-transactions-btn').click();
    const list = page.locator('#transactions-list');
    await list.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);

    await expect(list).toHaveScreenshot('transactions-mobile-list-cards.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('transactions mobile left-swipe actions', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await waitForSampleImportToSettle(page);
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
    await waitForSampleImportToSettle(page);
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
    await waitForSampleImportToSettle(page);
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
    await prepareShellBudgetAlert(page);
    await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#dashboard-alerts .inline-alert-card')).toHaveCount(0);
    await page.waitForTimeout(250);
    const clip = await getShellAlertClip(page);

    await expect(page).toHaveScreenshot('mobile-shell-alert-stack.png', {
      clip,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('settings modal mobile sheet', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await waitForSampleImportToSettle(page);
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
    await waitForSampleImportToSettle(page);
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
      await loadSampleDataFromSettings(page);
      await waitForSampleImportToSettle(page);

      // Navigate to transactions to see category chips
      await page.locator('#tab-transactions-btn').click();
      await page.waitForSelector('.category-chip', { state: 'visible' });

      // Capture just the category section
      const categorySection = page.locator('#category-chips').first();
      await expect(categorySection).toBeVisible();
      await expect(categorySection).toHaveScreenshot(`category-chips-${theme}.png`, {
        maxDiffPixelRatio: 0.02,
      });
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
      await installDeterministicAppBootstrap(page, theme, { completeOnboarding: false });
      await cleanAppStateRaw(page);

      // Wait for onboarding to appear
      await page.waitForSelector('#onboarding-overlay.active', { timeout: 10000 });
      await page.waitForTimeout(500);

      await expect(page).toHaveScreenshot(`onboarding-${theme}.png`, {
        maxDiffPixelRatio: 0.03,
      });
    });
  }
});

test.describe('Visual Regression - Toast Notifications', () => {
  test('toast notification - dark', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await setupApp(page, 'dark');

    // Navigate to transactions and submit a form to trigger toast
    await page.locator('#tab-transactions-btn').click();
    await page.waitForSelector('#amount', { state: 'visible' });

    await page.locator('#amount').fill('50.00');
    await page.locator('.category-chip').first().click();
    await page.locator('#submit-btn').click();

    const toast = page.locator('#toast-container .toast').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(250);

    await expect(toast).toHaveScreenshot('toast-notification.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});

test.describe('Accessibility - Focus States', () => {
  test('button focus states visible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await setupApp(page, 'dark');

    // Tab to navigation buttons
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    // Check that focus is visible (the outline should be present)
    const focusedElement = page.locator(':focus-visible');
    await expect(focusedElement).toBeVisible();
  });

  test('input focus states visible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await setupApp(page, 'dark');

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
    await setupApp(page, 'dark');

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
    await setupApp(page, 'dark');

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
    await setupApp(page, 'dark');

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
    await setupApp(page, 'light');

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
    await setupApp(page, 'dark');

    // The hero grid should be single column on mobile
    const heroGrid = page.locator('#tab-dashboard > section.hero-dashboard-grid').first();
    const gridStyles = await heroGrid.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });

    // Should be single column - only one value (e.g., "343px" not "900px 450px")
    const columnCount = gridStyles.split(' ').filter(s => s.includes('px')).length;
    expect(columnCount).toBe(1);
  });

  test('support cards stay on one square row on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await setupApp(page, 'dark');
    await loadSampleDataFromSettings(page);
    await waitForSampleImportToSettle(page);
    await page.locator('#tab-dashboard-btn').click();

    const metrics = await page.locator('.hero-sidebar--compact').evaluate((rail) => {
      const cards = Array.from(rail.querySelectorAll<HTMLElement>('.dashboard-support-card'));
      const railRect = rail.getBoundingClientRect();

      return {
        railRight: railRect.right,
        viewportWidth: document.documentElement.clientWidth,
        cards: cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return {
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
          };
        }),
      };
    });

    expect(metrics.cards).toHaveLength(3);
    const baselineTop = metrics.cards[0]?.top ?? 0;
    for (const card of metrics.cards) {
      expect(Math.abs(card.top - baselineTop)).toBeLessThan(4);
      expect(Math.abs(card.width - card.height)).toBeLessThan(4);
      expect(card.right).toBeLessThanOrEqual(metrics.railRight + 1);
    }
    expect(metrics.railRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  });

  test('hero card uses 2-column layout on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupApp(page, 'dark');

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
