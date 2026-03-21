import { expect, type Page } from '@playwright/test';

interface AppStatusSnapshot {
  initialized: string | null;
  error: string | null;
  monthLabel: string;
  transactionsTabSelected: string | null;
  url: string;
}

interface PageDiagnostics {
  console: string[];
  pageErrors: string[];
  crashCount: number;
  closeCount: number;
}

type InstrumentedPage = Page & {
  __budgetTrackerDiagnostics__?: PageDiagnostics;
  __budgetTrackerDiagnosticsInstalled__?: boolean;
};

function getDiagnostics(page: Page): PageDiagnostics {
  const instrumentedPage = page as InstrumentedPage;
  if (!instrumentedPage.__budgetTrackerDiagnostics__) {
    instrumentedPage.__budgetTrackerDiagnostics__ = {
      console: [],
      pageErrors: [],
      crashCount: 0,
      closeCount: 0,
    };
  }
  return instrumentedPage.__budgetTrackerDiagnostics__;
}

function pushDiagnostic(entries: string[], value: string): void {
  entries.push(value);
  if (entries.length > 20) {
    entries.shift();
  }
}

function installPageDiagnostics(page: Page): void {
  const instrumentedPage = page as InstrumentedPage;
  if (instrumentedPage.__budgetTrackerDiagnosticsInstalled__) {
    return;
  }
  instrumentedPage.__budgetTrackerDiagnosticsInstalled__ = true;

  const diagnostics = getDiagnostics(page);

  page.on('console', (message) => {
    const text = message.text().trim();
    if (!text) {
      return;
    }
    pushDiagnostic(diagnostics.console, `[${message.type()}] ${text}`);
  });

  page.on('pageerror', (error) => {
    pushDiagnostic(diagnostics.pageErrors, error instanceof Error ? error.message : String(error));
  });

  page.on('crash', () => {
    diagnostics.crashCount += 1;
  });

  page.on('close', () => {
    diagnostics.closeCount += 1;
  });
}

async function getAppStatus(page: Page): Promise<AppStatusSnapshot> {
  const root = page.locator('html');
  const monthLabelLocator = page.locator('#current-month-label');
  const transactionsTabButton = page.locator('#tab-transactions-btn');

  const [initialized, error, monthLabel, transactionsTabSelected] = await Promise.all([
    root.getAttribute('data-app-initialized'),
    root.getAttribute('data-app-error'),
    monthLabelLocator.textContent(),
    transactionsTabButton.getAttribute('aria-selected'),
  ]);

  return {
    initialized,
    error,
    monthLabel: monthLabel?.trim() || '',
    transactionsTabSelected,
    url: page.url(),
  };
}

async function safeGetAppStatus(page: Page): Promise<AppStatusSnapshot | null> {
  try {
    return await getAppStatus(page);
  } catch {
    return null;
  }
}

function formatDiagnostics(page: Page, appStatus: AppStatusSnapshot | null): string {
  const diagnostics = getDiagnostics(page);
  const sections = [
    `appStatus=${appStatus ? JSON.stringify(appStatus) : 'unavailable'}`,
    diagnostics.pageErrors.length > 0 ? `pageErrors=${diagnostics.pageErrors.join(' | ')}` : 'pageErrors=none',
    diagnostics.console.length > 0 ? `console=${diagnostics.console.slice(-10).join(' | ')}` : 'console=none',
    `crashes=${diagnostics.crashCount}`,
    `closes=${diagnostics.closeCount}`,
  ];
  return sections.join('\n');
}

async function resetBrowserState(page: Page, skipOnboarding: boolean): Promise<void> {
  installPageDiagnostics(page);

  await page.goto(`/e2e-reset.html?skipOnboarding=${skipOnboarding ? '1' : '0'}`, {
    waitUntil: 'load',
    timeout: 30000,
  });

  await expect(page.locator('body')).toHaveAttribute('data-reset', /^(done|error)$/, {
    timeout: 30000,
  });

  const result = await page.locator('#reset-status').textContent();
  const parsed = result ? JSON.parse(result) as {
    ok: boolean;
    error?: string;
    results?: Array<{ name: string; status: string }>;
  } : null;

  if (!parsed?.ok) {
    throw new Error(`Browser reset failed: ${parsed?.error || 'Unknown reset error'}`);
  }

  const blockedResult = (parsed.results || []).find((entry) => entry.status !== 'deleted');
  if (blockedResult) {
    throw new Error(`Browser reset did not fully clear ${blockedResult.name}: ${blockedResult.status}`);
  }
}

/**
 * Clean all app state before a test.
 * Navigates to the app, clears state, then reloads for a clean start.
 */
export async function cleanAppState(page: Page): Promise<void> {
  installPageDiagnostics(page);
  await resetBrowserState(page, true);

  await page.addInitScript(() => {
    (window as any).__PW_TEST__ = true;
  });

  await Promise.all([
    page.waitForURL(/\/$/, { timeout: 30000 }),
    page.evaluate(() => {
      window.location.assign('/');
    }),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await waitForAppReady(page);
}

/**
 * Wait for the app to fully initialize.
 */
export async function waitForAppReady(page: Page, timeout = 50000): Promise<void> {
  installPageDiagnostics(page);

  try {
    await expect
      .poll(
        async () => {
          const status = await getAppStatus(page);
          if (status.error === 'true') {
            return 'error';
          }
          if (status.initialized === 'true' && status.monthLabel.length > 0) {
            return 'ready';
          }
          return `waiting:${status.initialized || 'null'}:${status.error || 'null'}:${status.monthLabel || 'no-month-label'}:${status.url}`;
        },
        {
          timeout,
          intervals: [100, 250, 500, 1000],
          message: 'App did not reach a stable ready state',
        }
      )
      .toBe('ready');
  } catch (error) {
    const appStatus = await safeGetAppStatus(page);
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        formatDiagnostics(page, appStatus),
      ].join('\n')
    );
  }

  await expect(page.locator('#tab-transactions-btn')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#prev-month')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#current-month-label')).not.toHaveText('', { timeout: 10000 });
}

/**
 * Clean state without skipping onboarding (for onboarding tests).
 */
export async function cleanAppStateRaw(page: Page): Promise<void> {
  installPageDiagnostics(page);
  await resetBrowserState(page, false);

  await page.addInitScript(() => {
    (window as any).__PW_TEST__ = true;
  });

  await Promise.all([
    page.waitForURL(/\/$/, { timeout: 30000 }),
    page.evaluate(() => {
      window.location.assign('/');
    }),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await waitForAppReady(page);
}
