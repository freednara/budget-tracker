import { test, expect, devices, type Page } from '@playwright/test';
import { cleanAppState, loadSampleDataFromSettings, waitForAppPhase } from './test-helpers.js';

async function enableStandaloneLikeMode(page: Page): Promise<void> {
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
}

async function expectPhoneTransactionFormFits(page: Page): Promise<void> {
  const metrics = await page.locator('#form-section').evaluate((section) => {
    const viewportWidth = document.documentElement.clientWidth;
    const form = section.querySelector('#transaction-form') as HTMLElement | null;
    const typeToggle = section.querySelector('.transactions-type-toggle') as HTMLElement | null;
    const formRows = form
      ? Array.from(form.querySelectorAll<HTMLElement>(':scope > .grid'))
      : [];
    const detailRows = form
      ? Array.from(form.querySelectorAll<HTMLElement>('details .grid')).filter((row) => {
          const rect = row.getBoundingClientRect();
          const style = window.getComputedStyle(row);
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
      : [];

    const visibleNodes = Array.from(section.querySelectorAll<HTMLElement>('*')).filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });

    return {
      viewportWidth,
      sectionRight: section.getBoundingClientRect().right,
      formRight: form?.getBoundingClientRect().right ?? 0,
      toggleColumns: typeToggle ? window.getComputedStyle(typeToggle).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      rowColumns: formRows.map((row) => window.getComputedStyle(row).gridTemplateColumns.split(' ').filter(Boolean).length),
      detailRowColumns: detailRows.map((row) => window.getComputedStyle(row).gridTemplateColumns.split(' ').filter(Boolean).length),
      overflowingNodes: visibleNodes
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            id: node.id,
            className: node.className,
            tagName: node.tagName.toLowerCase(),
            left: rect.left,
            right: rect.right,
          };
        })
        .filter((node) => node.left < -1 || node.right > viewportWidth + 1)
        .slice(0, 12),
    };
  });

  expect(metrics.sectionRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.formRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.toggleColumns).toBe(2);
  expect(metrics.rowColumns.length).toBeGreaterThan(0);
  expect(metrics.rowColumns.every((count) => count === 1)).toBe(true);
  expect(metrics.detailRowColumns.every((count) => count === 1)).toBe(true);
  expect(metrics.overflowingNodes).toEqual([]);
  await expectNoHorizontalOverflow(page);
}

async function expectPhoneCalendarStack(page: Page): Promise<void> {
  const metrics = await page.locator('#tab-calendar').evaluate((tab) => {
    const viewportWidth = document.documentElement.clientWidth;
    const mainCard = tab.querySelector('.calendar-main-card') as HTMLElement | null;
    const detailCard = tab.querySelector('.calendar-detail-card') as HTMLElement | null;
    const heatmap = tab.querySelector('#spending-heatmap') as HTMLElement | null;
    const grid = heatmap?.querySelector('.cal-grid') as HTMLElement | null;

    const mainRect = mainCard?.getBoundingClientRect();
    const detailRect = detailCard?.getBoundingClientRect();
    const heatmapRect = heatmap?.getBoundingClientRect();
    const gridRect = grid?.getBoundingClientRect();

    return {
      viewportWidth,
      mainRect: mainRect ? { x: mainRect.x, y: mainRect.y, width: mainRect.width, height: mainRect.height, right: mainRect.right } : null,
      detailRect: detailRect ? { x: detailRect.x, y: detailRect.y, width: detailRect.width, height: detailRect.height, right: detailRect.right } : null,
      heatmapRight: heatmapRect?.right ?? 0,
      gridRight: gridRect?.right ?? 0,
      gridClassName: grid?.className ?? '',
    };
  });

  expect(metrics.mainRect).not.toBeNull();
  expect(metrics.detailRect).not.toBeNull();
  expect(Math.abs((metrics.mainRect?.x ?? 0) - (metrics.detailRect?.x ?? 0))).toBeLessThan(4);
  expect((metrics.detailRect?.y ?? 0)).toBeGreaterThan((metrics.mainRect?.y ?? 0) + (metrics.mainRect?.height ?? 0) - 2);
  expect((metrics.mainRect?.width ?? 0)).toBeGreaterThan(metrics.viewportWidth * 0.78);
  expect((metrics.detailRect?.width ?? 0)).toBeGreaterThan(metrics.viewportWidth * 0.78);
  expect(metrics.heatmapRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  if (metrics.gridClassName) {
    expect(metrics.gridRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  }
  await expectNoHorizontalOverflow(page);
}

async function expectPhoneSupportCardsCompactRail(page: Page): Promise<void> {
  const metrics = await page.locator('.hero-sidebar--compact').evaluate((rail) => {
    const viewportWidth = document.documentElement.clientWidth;
    const railRect = rail.getBoundingClientRect();
    const cards = Array.from(rail.querySelectorAll<HTMLElement>('.dashboard-support-card'));

    return {
      viewportWidth,
      rail: {
        left: railRect.left,
        right: railRect.right,
        width: railRect.width,
      },
      cards: cards.map((card) => {
        const rect = card.getBoundingClientRect();
        const styles = window.getComputedStyle(card);
        const metaNodes = Array.from(card.querySelectorAll<HTMLElement>('.dashboard-support-card__meta'));
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          aspectRatio: styles.aspectRatio,
          hiddenMetaCount: metaNodes.filter((node) => window.getComputedStyle(node).display === 'none').length,
        };
      }),
    };
  });

  expect(metrics.cards).toHaveLength(3);
  const baselineTop = metrics.cards[0]?.top ?? 0;
  const baselineWidth = metrics.cards[0]?.width ?? 0;
  const baselineHeight = metrics.cards[0]?.height ?? 0;

  for (const card of metrics.cards) {
    expect(Math.abs(card.top - baselineTop)).toBeLessThan(4);
    expect(card.left).toBeGreaterThanOrEqual(metrics.rail.left - 1);
    expect(card.right).toBeLessThanOrEqual(metrics.rail.right + 1);
    expect(Math.abs(card.width - baselineWidth)).toBeLessThan(3);
    expect(Math.abs(card.height - baselineHeight)).toBeLessThan(3);
    expect(Math.abs(card.width - card.height)).toBeLessThan(4);
    expect(card.aspectRatio).toBe('1 / 1');
    expect(card.hiddenMetaCount).toBeGreaterThan(0);
  }

  expect(metrics.rail.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  await expectNoHorizontalOverflow(page);
}

async function prepareShellBudgetAlert(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('budget_tracker_alert_prefs', JSON.stringify({
      budgetThreshold: 0.01,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: [],
    }));
  });

  await cleanAppState(page);
  await loadSampleDataFromSettings(page);
  await expect(page.locator('.transaction-row').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#toast-container .toast')).toHaveCount(0, { timeout: 15000 });
  await page.locator('#tab-dashboard-btn').click();
  await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#dashboard-alerts .inline-alert-card')).toHaveCount(0);
  await expect(page.locator('#budget-alerts .inline-alert-card')).toHaveCount(0);
}

async function swipeTransactionRow(page: Page, rowLocator: import('@playwright/test').Locator, direction: 'left' | 'right'): Promise<void> {
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

test.describe('Dashboard Layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
  });

  test('prioritizes allowance and keeps deeper analysis in analytics', async ({ page }) => {
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-dashboard-btn').click();

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
    await expect(page.locator('#insights-dashboard .insight-card')).toHaveCount(3);
    await expect(page.locator('#insights-dashboard .insight-action-btn')).toHaveCount(3);
    await expect(page.locator('#hero-guidance .hero-guidance__label')).toHaveText('Next Best Move');
    await expect(page.locator('#hero-primary-action')).toHaveClass(/hero-action-btn--primary/);
    await expect(page.locator('#hero-secondary-action')).toHaveClass(/hero-action-btn--secondary/);
    await expect(page.locator('#tab-dashboard').locator('#spending-heatmap')).toHaveCount(0);
    await expect(page.locator('#tab-dashboard').locator('#month-comparison')).toHaveCount(0);
    await expect(page.locator('#tab-dashboard').locator('#budget-vs-actual-section')).toHaveCount(0);

    const [heroTop, gaugeTop, analyticsTop, insightsTop] = await Promise.all([
      page.locator('#hero-dashboard-card').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#budget-gauge-section').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#analytics-section').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#insights-dashboard').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
    ]);
    expect(heroTop).toBeLessThan(gaugeTop);
    expect(gaugeTop).toBeLessThan(analyticsTop);
    expect(analyticsTop).toBeLessThan(insightsTop);

    await page.locator('#open-analytics').click();
    await expect(page.locator('#analytics-modal')).toBeVisible();
    await expect(page.locator('#analytics-trend-section')).toBeVisible();
    await expect(page.locator('#analytics-category-trends')).toBeVisible();
    await expect(page.locator('#analytics-month-comparison-section')).toBeVisible();
    await expect(page.locator('#analytics-calendar-section')).toHaveCount(0);
  });

  test('uses section-scoped empty states instead of shell or onboarding messaging', async ({ page }) => {
    await page.locator('#tab-dashboard-btn').click();

    await expect(page.locator('#alert-banner')).toBeHidden();
    await expect(page.locator('#budget-gauge-section')).toBeVisible();
    await expect(page.locator('#budget-gauge-section')).toContainText('No budget set yet');
    await expect(page.locator('#trend-chart-container')).toContainText('Add transactions to explain how income and spending are shaping the month.');
    await expect(page.locator('#donut-chart-container')).toContainText('Add expense activity to see which categories are creating the most pressure.');

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#transactions-list')).toContainText('No transactions yet');
    await expect(page.locator('#transactions-list')).toContainText('Add your first transaction to start tracking this month.');
    await expect(page.locator('#transactions-list')).not.toContainText('Welcome to Harbor Ledger');
    await page.locator('#transactions-list [data-action="add-transaction"]').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#amount')).toBeFocused({ timeout: 2000 });

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#spending-heatmap')).toContainText('No calendar activity yet');
    await expect(page.locator('#cal-detail-panel')).toContainText('No day details yet');
    await expect(page.locator('#cal-detail-panel')).not.toContainText('Select a day');
    const expectedCalendarDate = await page.locator('#current-month-label').evaluate((label) => {
      const monthLabel = label.textContent?.trim() || '';
      const [monthName = '', year = ''] = monthLabel.split(/\s+/);
      const monthByName: Record<string, string> = {
        January: '01',
        February: '02',
        March: '03',
        April: '04',
        May: '05',
        June: '06',
        July: '07',
        August: '08',
        September: '09',
        October: '10',
        November: '11',
        December: '12'
      };
      return `${year}-${monthByName[monthName] || '01'}-01`;
    });
    await page.locator('#spending-heatmap [data-action="add-transaction-for-date"]').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#date')).toHaveValue(expectedCalendarDate, { timeout: 5000 });
  });

  test('keeps budget focused on planning, transactions on ledger work, and calendar on time-based planning', async ({ page }) => {
    await page.locator('#tab-budget-btn').click();
    await waitForAppPhase(page, 'background');
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

  test('keeps calendar day buttons tabbable before and after a selection', async ({ page }) => {
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 10000 });

    const dayButtons = page.locator('.cal-day');
    await expect(dayButtons.first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.cal-day.cal-selected')).toHaveCount(0);

    const initialTabIndexes = await dayButtons.evaluateAll((buttons) =>
      buttons.map((button) => (button as HTMLElement).tabIndex)
    );
    expect(initialTabIndexes.length).toBeGreaterThan(0);
    expect(initialTabIndexes.every((tabIndex) => tabIndex === 0)).toBe(true);

    await dayButtons.nth(10).click();

    const selectedTabState = await dayButtons.evaluateAll((buttons) =>
      buttons.map((button) => ({
        tabIndex: (button as HTMLElement).tabIndex,
        selected: button.classList.contains('cal-selected'),
      }))
    );
    expect(selectedTabState.filter((button) => button.selected)).toHaveLength(1);
    expect(selectedTabState.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(selectedTabState.find((button) => button.selected)?.tabIndex).toBe(0);
  });

  test('mounts the dashboard budget gauge on its real shell anchor', async ({ page }) => {
    await loadSampleDataFromSettings(page);
    await waitForAppPhase(page, 'background');

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#budget-gauge-section')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#budget-gauge-container svg')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#budget-gauge-section .budget-health-status')).toHaveText(/Healthy|Caution|Over/);
    await expect(page.locator('#budget-gauge-section').locator('button')).toHaveCount(0);
    await expect(page.locator('#income-badge')).toHaveText(/Healthy|Caution|New/);
    await expect(page.locator('#expense-badge')).toHaveText(/On Track|Caution|Over|New/);
  });

  test('renders and dismisses shell budget alerts from real app state', async ({ page }) => {
    await prepareShellBudgetAlert(page);

    const alertCard = page.locator('#alert-banner .inline-alert-card');
    const dismissButton = alertCard.locator('.inline-alert-card__dismiss');
    const alertId = await alertCard.getAttribute('data-alert-id');
    const shellAlertHost = page.locator('#alert-banner');

    await expect(alertCard).toBeVisible();
    await expect(dismissButton).toHaveAttribute('aria-label', /Dismiss alert:/);
    expect(alertId).not.toBeNull();

    await dismissButton.click();
    await page.waitForTimeout(250);

    await expect(shellAlertHost.locator(`[data-alert-id="${alertId}"]`)).toHaveCount(0);
    await expect(page.locator('#dashboard-alerts .inline-alert-card')).toHaveCount(0);
    await expect(page.locator('#budget-alerts .inline-alert-card')).toHaveCount(0);
  });

  test('keeps dismissed budget alerts hidden as spending changes within the same month', async ({ page }) => {
    await prepareShellBudgetAlert(page);

    const alertCard = page.locator('#alert-banner .inline-alert-card');
    const alertText = (await alertCard.locator('.inline-alert-card__text').textContent())?.trim() || '';
    const alertId = await alertCard.getAttribute('data-alert-id');
    const categoryName = alertText.match(/^\S+\s+(.+?):/)?.[1] || '';
    expect(categoryName).not.toBe('');
    expect(alertId).not.toBeNull();

    await alertCard.locator('.inline-alert-card__dismiss').click();
    await page.waitForTimeout(250);

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await page.locator('#amount').fill('1.00');
    const categoryChip = page.locator('.category-chip', { hasText: categoryName }).first();
    await categoryChip.scrollIntoViewIfNeeded();
    await categoryChip.evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await page.locator('#submit-btn').click();
    await expect(page.locator('#toast-container .toast').first()).toBeVisible({ timeout: 5000 });

    await page.locator('#tab-dashboard-btn').click();
    await page.waitForTimeout(400);
    await expect(page.locator(`#alert-banner [data-alert-id="${alertId}"]`)).toHaveCount(0);
  });

  test('keeps the global budget alert visible outside dashboard-specific sections', async ({ page }) => {
    await prepareShellBudgetAlert(page);

    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#dashboard-alerts .inline-alert-card')).toHaveCount(0);

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#budget-alerts .inline-alert-card')).toHaveCount(0);
  });

  test('income, expense, and balance support cards drill into month-scoped ledger views', async ({ page }) => {
    await loadSampleDataFromSettings(page);

    await page.locator('#tab-dashboard-btn').click();

    await page.locator('#dashboard-income-card').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#filter-type')).toHaveValue('income');
    await expect(page.locator('#filter-date-quick')).toHaveValue('');
    await expect(page.locator('#tx-show-all-months')).not.toBeChecked();
    await expect(page.locator('.transactions-ledger-card')).toBeFocused();

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#tab-dashboard')).toBeVisible({ timeout: 10000 });

    await page.locator('#dashboard-expense-card').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#filter-type')).toHaveValue('expense');
    await expect(page.locator('#filter-date-quick')).toHaveValue('');
    await expect(page.locator('#tx-show-all-months')).not.toBeChecked();
    await expect(page.locator('.transactions-ledger-card')).toBeFocused();

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#tab-dashboard')).toBeVisible({ timeout: 10000 });

    await page.locator('#dashboard-balance-card').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#filter-type')).toHaveValue('all');
    await expect(page.locator('#filter-date-quick')).toHaveValue('');
    await expect(page.locator('#tx-show-all-months')).not.toBeChecked();
    await expect(page.locator('.transactions-ledger-card')).toBeFocused();
  });

  test('hero CTA buttons navigate to their intended surfaces', async ({ page }) => {
    const primaryAction = page.locator('#hero-primary-action');
    const secondaryAction = page.locator('#hero-secondary-action');

    const primaryTarget = await primaryAction.getAttribute('data-action');
    await primaryAction.click();

    if (primaryTarget === 'budget') {
      await expect(page.locator('#tab-budget')).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    }

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#tab-dashboard')).toBeVisible({ timeout: 10000 });

    const secondaryTarget = await secondaryAction.getAttribute('data-action');
    await secondaryAction.click();

    if (secondaryTarget === 'budget') {
      await expect(page.locator('#tab-budget')).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    }
  });

  test('explains category breakdown percentages and shows interpretation cues', async ({ page }) => {
    await loadSampleDataFromSettings(page);

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#donut-chart-container')).toBeVisible({ timeout: 10000 });

    const helpToggle = page.locator('#category-breakdown-help-toggle');
    await expect(helpToggle).toBeVisible();
    await helpToggle.focus();
    await page.keyboard.press('Enter');

    const helpPopover = page.locator('#category-breakdown-help[open] .dashboard-breakdown-help__popover');
    await expect(helpPopover).toBeVisible();
    await expect(helpPopover).toContainText('Share %');
    await expect(helpPopover).toContainText('MoM %');
    await expect(helpPopover).toContainText('rising spend in a large category is usually a caution signal');

    const statuses = page.locator('.dashboard-category-breakdown__status');
    expect(await statuses.count()).toBeGreaterThan(0);
    await expect(statuses.first()).toHaveText(/Healthy|Caution/);

    await page.keyboard.press('Enter');
    await expect(helpPopover).toHaveCount(0);
  });

  test('keeps insight hosts stretched so CTA buttons render at equal widths', async ({ page }) => {
    await loadSampleDataFromSettings(page);

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#insights-dashboard .insight-action-btn')).toHaveCount(3);

    const insightMetrics = await page.locator('#insights-dashboard .insight-card').evaluateAll((cards) => {
      return cards.map((card) => {
        const host = card.querySelector('[id^="insight-"]') as HTMLDivElement | null;
        const copy = card.querySelector('.dashboard-insight-copy') as HTMLDivElement | null;
        const text = card.querySelector('.dashboard-insight-text') as HTMLParagraphElement | null;
        const button = card.querySelector('.insight-action-btn') as HTMLButtonElement | null;

        return {
          hostWidth: host?.getBoundingClientRect().width ?? 0,
          copyWidth: copy?.getBoundingClientRect().width ?? 0,
          buttonWidth: button?.getBoundingClientRect().width ?? 0,
          textAlign: text ? getComputedStyle(text).textAlign : '',
          buttonJustify: button ? getComputedStyle(button).justifyContent : '',
        };
      });
    });

    expect(insightMetrics).toHaveLength(3);
    const baselineHostWidth = insightMetrics[0]?.hostWidth ?? 0;
    const baselineButtonWidth = insightMetrics[0]?.buttonWidth ?? 0;

    for (const metric of insightMetrics) {
      expect(Math.abs(metric.hostWidth - baselineHostWidth)).toBeLessThan(1);
      expect(Math.abs(metric.copyWidth - baselineHostWidth)).toBeLessThan(1);
      expect(Math.abs(metric.buttonWidth - baselineButtonWidth)).toBeLessThan(1);
      expect(Math.abs(metric.buttonWidth - metric.hostWidth)).toBeLessThan(1);
      expect(['left', 'start']).toContain(metric.textAlign);
      expect(metric.buttonJustify).toBe('center');
    }
  });
});

test.describe('Dashboard Layout Mobile', () => {
  test.use({ viewport: { width: 400, height: 993 } });

  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
  });

  test('opens the category breakdown explainer on mobile without clipping the legend rows', async ({ page }) => {
    await loadSampleDataFromSettings(page);

    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('#donut-chart-container')).toBeVisible({ timeout: 10000 });

    await page.locator('#category-breakdown-help-toggle').click();
    const helpPopover = page.locator('#category-breakdown-help[open] .dashboard-breakdown-help__popover');
    await expect(helpPopover).toBeVisible();
    await expect(helpPopover).toContainText('Share %');
    await expect(helpPopover).toContainText('MoM %');

    const firstLegendRow = page.locator('.dashboard-category-breakdown__row').first();
    await expect(firstLegendRow).toBeVisible();
    await expect(firstLegendRow.locator('.dashboard-category-breakdown__share')).toBeVisible();
    await expect(page.locator('.dashboard-category-breakdown__mom').first()).toHaveCount(1);
    await expect
      .poll(async () => page.locator('#donut-chart-container').evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);

    const [heroTop, gaugeTop, analyticsTop, insightsTop] = await Promise.all([
      page.locator('#hero-dashboard-card').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#budget-gauge-section').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#analytics-section').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      page.locator('#insights-dashboard').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
    ]);
    expect(heroTop).toBeLessThan(gaugeTop);
    expect(gaugeTop).toBeLessThan(analyticsTop);
    expect(analyticsTop).toBeLessThan(insightsTop);
  });

  test('keeps shell controls touch-safe on mobile', async ({ page }) => {
    const selectors = ['#open-analytics', '#open-settings', '#prev-month', '#next-month'];

    for (const selector of selectors) {
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('stacks transactions and calendar surfaces cleanly on phone widths', async ({ page }) => {
    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
    await expectPhoneTransactionFormFits(page);

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 10000 });
    await expectPhoneCalendarStack(page);
  });

  test('keeps income, expense, and balance cards on one compact square row on phone widths', async ({ page }) => {
    await loadSampleDataFromSettings(page);
    await page.locator('#tab-dashboard-btn').click();
    await expect(page.locator('.hero-sidebar .dashboard-support-card')).toHaveCount(3);
    await expectPhoneSupportCardsCompactRail(page);
  });

  test('uses icon-only main tabs on very small phones', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('#tab-dashboard-btn').click();

    const metrics = await page.locator('.app-shell-tabs').evaluate((tabs) => {
      const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('.main-tab'));
      return buttons.map((button) => {
        const label = button.querySelector<HTMLElement>('.main-tab__label');
        const icon = button.querySelector<HTMLElement>('.main-tab__icon');
        return {
          ariaLabel: button.getAttribute('aria-label') || '',
          height: button.getBoundingClientRect().height,
          labelDisplay: label ? window.getComputedStyle(label).display : '',
          iconDisplay: icon ? window.getComputedStyle(icon).display : '',
        };
      });
    });

    expect(metrics).toHaveLength(4);
    for (const metric of metrics) {
      expect(metric.ariaLabel).not.toBe('');
      expect(metric.height).toBeGreaterThanOrEqual(44);
      expect(metric.labelDisplay).toBe('none');
      expect(metric.iconDisplay).not.toBe('none');
    }
  });
});

test.describe('Latest Mobile Layout Guards', () => {
  test('keeps latest iPhone Safari layout stable', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit');

    const context = await browser.newContext({ ...devices['iPhone 15 Pro'] });
    const page = await context.newPage();

    try {
      await prepareShellBudgetAlert(page);
      await expect(page.locator('#alert-banner .inline-alert-card')).toBeVisible({ timeout: 10000 });
      const shellAndAlertMetrics = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell') as HTMLElement | null;
        const alert = document.getElementById('alert-banner') as HTMLElement | null;
        if (!shell || !alert) {
          return null;
        }

        const shellRect = shell.getBoundingClientRect();
        const alertRect = alert.getBoundingClientRect();
        return {
          shellTop: shellRect.top,
          shellBottom: shellRect.bottom,
          alertTop: alertRect.top,
          alertBottom: alertRect.bottom,
          alertRight: alertRect.right,
          viewportWidth: document.documentElement.clientWidth,
        };
      });

      expect(shellAndAlertMetrics).not.toBeNull();
      expect((shellAndAlertMetrics?.alertBottom ?? 0)).toBeGreaterThan((shellAndAlertMetrics?.shellTop ?? 0));
      expect((shellAndAlertMetrics?.alertBottom ?? 0)).toBeGreaterThan((shellAndAlertMetrics?.alertTop ?? 0));
      expect((shellAndAlertMetrics?.alertRight ?? 0)).toBeLessThanOrEqual((shellAndAlertMetrics?.viewportWidth ?? 0) + 1);
      await expectNoHorizontalOverflow(page);
      await expectPhoneSupportCardsCompactRail(page);

      const shellSelectors = ['#open-analytics', '#open-settings', '#prev-month', '#next-month'];
      for (const selector of shellSelectors) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      const [heroTop, insightsTop] = await Promise.all([
        page.locator('#hero-dashboard-card').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
        page.locator('#insights-dashboard').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      ]);
      expect(heroTop).toBeLessThanOrEqual(insightsTop);

      await page.locator('#open-settings').click();
      await expect(page.locator('#settings-modal')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(250);
      const settingsFocus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          id: active?.id ?? '',
          tagName: active?.tagName ?? '',
        };
      });
      expect(settingsFocus.id).not.toBe('settings-currency');
      expect(settingsFocus.tagName).not.toBe('SELECT');
      await page.locator('#close-settings').click();
      await expect(page.locator('#settings-modal')).toBeHidden({ timeout: 10000 });

      await page.locator('#open-analytics').click();
      await expect(page.locator('#analytics-modal')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(250);
      const analyticsFocus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          id: active?.id ?? '',
          tagName: active?.tagName ?? '',
        };
      });
      expect(['yoy-year1', 'yoy-year2', 'trend-period-select']).not.toContain(analyticsFocus.id);
      expect(analyticsFocus.tagName).not.toBe('SELECT');
      await page.locator('#close-analytics').click();
      await expect(page.locator('#analytics-modal')).toBeHidden({ timeout: 10000 });

      await page.locator('#tab-transactions-btn').click();
      await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });
      const templateToggle = page.locator('#toggle-templates-mobile');
      if (await templateToggle.isVisible()) {
        await expect(templateToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.transactions-templates-panel')).toHaveClass(/transactions-templates-panel--collapsed/);
        await expect(page.locator('#templates-list .template-collapsed-summary')).toBeVisible();
        await expect(page.locator('#templates-list .template-btn')).toHaveCount(0);
      }
      await expect(page.locator('#toggle-advanced-filters')).toHaveAttribute('aria-expanded', 'false');
      await expectPhoneTransactionFormFits(page);

      if (await templateToggle.isVisible()) {
        await templateToggle.click();
        await expect(templateToggle).toHaveAttribute('aria-expanded', 'true');
        expect(await page.locator('#templates-list .template-btn').count()).toBeGreaterThan(0);
      }

      await page.locator('#tab-calendar-btn').click();
      await expectPhoneCalendarStack(page);
    } finally {
      await context.close();
    }
  });

  test('reveals left-swipe transaction actions on latest iPhone Safari', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit');

    const context = await browser.newContext({ ...devices['iPhone 15 Pro'] });
    const page = await context.newPage();

    try {
      await cleanAppState(page);
      await loadSampleDataFromSettings(page);
      await page.locator('#tab-transactions-btn').click();
      await expect(page.locator('#transactions-list .swipe-container').first()).toBeVisible({ timeout: 10000 });

      const firstRow = page.locator('#transactions-list .swipe-container').first();
      await expect(firstRow.locator('.desktop-actions')).toBeHidden();
      const rowLayout = await firstRow.evaluate((row) => {
        const description = row.querySelector('.tx-description') as HTMLElement | null;
        const amount = row.querySelector('.tx-amount') as HTMLElement | null;
        const meta = row.querySelector('.tx-meta') as HTMLElement | null;
        const rowRect = row.getBoundingClientRect();
        const descriptionRect = description?.getBoundingClientRect();
        const amountRect = amount?.getBoundingClientRect();
        const metaRect = meta?.getBoundingClientRect();

        return {
          rowLeft: rowRect.left,
          rowWidth: rowRect.width,
          descriptionRight: descriptionRect?.right ?? 0,
          amountLeft: amountRect?.left ?? 0,
          amountBottom: amountRect?.bottom ?? 0,
          metaTop: metaRect?.top ?? 0,
          metaRight: metaRect?.right ?? 0,
        };
      });
      expect(rowLayout.amountLeft).toBeGreaterThanOrEqual(rowLayout.descriptionRight - 1);
      expect(rowLayout.metaTop).toBeGreaterThanOrEqual(rowLayout.amountBottom - 2);
      expect(rowLayout.metaRight).toBeLessThanOrEqual(rowLayout.rowLeft + rowLayout.rowWidth + 1);

      await swipeTransactionRow(page, firstRow, 'left');
      await expect(firstRow).toHaveClass(/revealed-left/);
      await expect(firstRow.locator('.edit-swipe-btn')).toBeVisible();
      await expect(firstRow.locator('.delete-swipe-btn')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });

  test('reveals right-swipe transaction actions on latest iPhone Safari', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit');

    const context = await browser.newContext({ ...devices['iPhone 15 Pro'] });
    const page = await context.newPage();

    try {
      await cleanAppState(page);
      await loadSampleDataFromSettings(page);
      await page.locator('#tab-transactions-btn').click();
      await expect(page.locator('#transactions-list .swipe-container').first()).toBeVisible({ timeout: 10000 });

      const firstRow = page.locator('#transactions-list .swipe-container').first();
      await swipeTransactionRow(page, firstRow, 'right');
      await expect(firstRow).toHaveClass(/revealed-right/);
      await expect(firstRow.locator('.reconcile-swipe-btn')).toBeVisible();
      await expect(firstRow.locator('.split-swipe-btn')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });

  test('keeps latest Android Chromium layout stable', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium');

    const context = await browser.newContext({ ...devices['Galaxy S24'] });
    const page = await context.newPage();

    try {
      await cleanAppState(page);

      for (const selector of ['#open-analytics', '#open-settings', '#prev-month', '#next-month']) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      await page.locator('#tab-dashboard-btn').click();
      const [heroTop, insightsTop] = await Promise.all([
        page.locator('#hero-dashboard-card').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
        page.locator('#insights-dashboard').evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
      ]);
      expect(heroTop).toBeLessThan(insightsTop);

      await page.locator('#tab-transactions-btn').click();
      await expectPhoneTransactionFormFits(page);

      await page.locator('#tab-calendar-btn').click();
      await expectPhoneCalendarStack(page);
    } finally {
      await context.close();
    }
  });

  test('keeps standalone-like iPhone Safari layout and runtime diagnostics stable after reset', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit');

    const context = await browser.newContext({ ...devices['iPhone 15 Pro'] });
    const page = await context.newPage();

    try {
      await enableStandaloneLikeMode(page);
      await cleanAppState(page);
      await loadSampleDataFromSettings(page);

      await expect(page.locator('html')).toHaveAttribute('data-app-runtime', 'standalone');
      await expect(page.locator('html')).toHaveAttribute('data-app-version', /.+/);

      await page.locator('#open-settings').click();
      await expect(page.locator('#settings-modal')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#settings-modal')).toContainText('Installed PWA');
      await expect(page.locator('#settings-modal')).toContainText('Version:');
      await page.locator('#close-settings').click();

      await page.locator('#tab-transactions-btn').click();
      await expectPhoneTransactionFormFits(page);

      await page.locator('#tab-calendar-btn').click();
      await expectPhoneCalendarStack(page);
    } finally {
      await context.close();
    }
  });
});
