import { expect, type Page } from '@playwright/test';

interface AppStatusSnapshot {
  initialized: string | null;
  shellReady: string | null;
  interactiveReady: string | null;
  backgroundReady: string | null;
  backgroundFailed: string | null;
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

type AppReadyPhase = 'shell' | 'interactive' | 'background';
type ImportMode = 'overwrite' | 'merge';

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

  const [initialized, shellReady, interactiveReady, backgroundReady, backgroundFailed, error, monthLabel, transactionsTabSelected] = await Promise.all([
    root.getAttribute('data-app-initialized'),
    root.getAttribute('data-app-shell-ready'),
    root.getAttribute('data-app-interactive-ready'),
    root.getAttribute('data-app-background-ready'),
    root.getAttribute('data-app-background-failed'),
    root.getAttribute('data-app-error'),
    monthLabelLocator.textContent(),
    transactionsTabButton.getAttribute('aria-selected'),
  ]);

  return {
    initialized,
    shellReady,
    interactiveReady,
    backgroundReady,
    backgroundFailed,
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

export async function resetAppState(page: Page, skipOnboarding: boolean): Promise<void> {
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

async function openFreshApp(page: Page): Promise<void> {
  await page.goto('/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
}

export async function installPlaywrightBootstrap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__PW_TEST__ = true;
  });
}

async function getRuntimeFlags(page: Page): Promise<{
  shellReady: boolean;
  interactiveReady: boolean;
  backgroundReady: boolean;
  backgroundFailed: boolean;
  initialized: boolean;
  startupProgress: string | null;
}> {
  return await page.evaluate(() => ({
    shellReady: (window as any).__APP_SHELL_READY__ === true,
    interactiveReady: (window as any).__APP_INTERACTIVE_READY__ === true,
    backgroundReady: (window as any).__APP_BACKGROUND_READY__ === true,
    backgroundFailed: (window as any).__APP_BACKGROUND_FAILED__ === true,
    initialized: (window as any).__APP_INITIALIZED__ === true,
    startupProgress: (window as any).__APP_STARTUP_PROGRESS__ || null,
  }));
}

export async function waitForAppPhase(page: Page, phase: AppReadyPhase, timeout = 50000): Promise<void> {
  installPageDiagnostics(page);

  try {
    const start = Date.now();
    let delayMs = 100;
    let lastState = `waiting:${phase}`;

    while (Date.now() - start < timeout) {
      const status = await getAppStatus(page);
      const runtime = await getRuntimeFlags(page);

      if (status.error === 'true') {
        throw new Error(`App entered startup error state: ${runtime.startupProgress || 'unknown'}`);
      }

      if (phase === 'background' && runtime.backgroundFailed) {
        throw new Error(`App entered terminal background failure state: ${runtime.startupProgress || 'unknown'}`);
      }

      if (phase === 'shell' && runtime.shellReady) {
        return;
      }

      if (phase === 'interactive' && runtime.interactiveReady) {
        return;
      }

      if (phase === 'background' && runtime.backgroundReady) {
        return;
      }

      lastState = `waiting:${runtime.startupProgress || 'unknown'}`;
      await page.waitForTimeout(delayMs);
      delayMs = Math.min(delayMs < 250 ? 250 : delayMs * 2, 1000);
    }

    throw new Error(`App did not reach ${phase} readiness: ${lastState}`);
  } catch (error) {
    const appStatus = await safeGetAppStatus(page);
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        formatDiagnostics(page, appStatus),
      ].join('\n')
    );
  }
}

/**
 * Clean all app state before a test.
 * Resets browser/app state, installs the Playwright bootstrap, then boots once.
 */
export async function cleanAppState(page: Page): Promise<void> {
  installPageDiagnostics(page);
  await resetAppState(page, true);
  await installPlaywrightBootstrap(page);
  await bootFreshApp(page, 'interactive');
}

/**
 * Wait for the app to become interactive.
 */
export async function waitForInteractiveAppReady(page: Page, timeout = 50000): Promise<void> {
  installPageDiagnostics(page);
  await waitForAppPhase(page, 'interactive', timeout);
  await expect(page.locator('#tab-transactions-btn')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#prev-month')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#current-month-label')).not.toHaveText('', { timeout: 10000 });
}

export async function bootFreshApp(
  page: Page,
  phase: AppReadyPhase = 'interactive',
  timeout = 50000
): Promise<void> {
  installPageDiagnostics(page);
  await openFreshApp(page);
  if (phase === 'interactive') {
    await waitForInteractiveAppReady(page, timeout);
    return;
  }
  await waitForAppPhase(page, phase, timeout);
}

async function switchMainTabForTest(page: Page, tab: 'dashboard' | 'transactions' | 'budget' | 'calendar'): Promise<void> {
  const buttonByTab = {
    dashboard: '#tab-dashboard-btn',
    transactions: '#tab-transactions-btn',
    budget: '#tab-budget-btn',
    calendar: '#tab-calendar-btn',
  } as const;
  const panelByTab = {
    dashboard: '#tab-dashboard',
    transactions: '#tab-transactions',
    budget: '#tab-budget',
    calendar: '#tab-calendar',
  } as const;

  const button = page.locator(buttonByTab[tab]);
  const panel = page.locator(panelByTab[tab]);
  await expect(button).toBeVisible({ timeout: 10000 });

  if ((await button.getAttribute('aria-selected')) !== 'true') {
    await button.click({ timeout: 5000 });
  }

  await expect(button).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  await expect(panel).toBeVisible({ timeout: 10000 });
}

export async function waitForTransactionsSurfaceReady(page: Page, timeout = 20000): Promise<void> {
  await waitForAppPhase(page, 'interactive', timeout);
  await switchMainTabForTest(page, 'transactions');
  await expect(page.locator('#amount')).toBeVisible({ timeout });
  await expect(page.locator('#amount')).toBeEditable({ timeout });
  await expect(page.locator('#submit-btn')).toBeVisible({ timeout });
  await expect(page.locator('#submit-btn')).toBeEnabled({ timeout });
  await expect(page.locator('#transactions-list')).toBeVisible({ timeout });
}

export async function bootSecondaryPage(
  page: Page,
  options: { clearStorage?: boolean; skipOnboarding?: boolean; timeout?: number } = {}
): Promise<void> {
  const { clearStorage = false, skipOnboarding = true, timeout = 50000 } = options;
  await page.addInitScript(
    ({ shouldClearStorage, shouldSkipOnboarding }) => {
      (window as any).__PW_TEST__ = true;
      if (shouldClearStorage) {
        localStorage.clear();
      }
      if (shouldSkipOnboarding) {
        localStorage.setItem('budget_tracker_onboarding', JSON.stringify({ completed: true, step: 6 }));
      }
    },
    { shouldClearStorage: clearStorage, shouldSkipOnboarding: skipOnboarding }
  );

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForInteractiveAppReady(page, timeout);
}

export async function openSettingsModal(page: Page, timeout = 15000): Promise<void> {
  await waitForInteractiveAppReady(page, timeout);
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-modal')).toBeVisible({ timeout });
  await expect(page.locator('#close-settings')).toBeVisible({ timeout });
}

export async function openResetAppDataModal(page: Page, timeout = 15000): Promise<void> {
  await openSettingsModal(page, timeout);
  await page.locator('#clear-all-data').click();
  await expect(page.locator('#reset-app-data-modal')).toBeVisible({ timeout });
  await expect(page.locator('#confirm-reset-keep-backups')).toBeVisible({ timeout });
  await expect(page.locator('#confirm-reset-clear-backups')).toBeVisible({ timeout });
}

export async function assertModalClosedAndInteractive(page: Page, timeout = 15000): Promise<void> {
  await expect(page.locator('#settings-modal')).not.toBeVisible({ timeout });
  await expect(page.locator('#reset-app-data-modal')).not.toBeVisible({ timeout });
  await expect(page.locator('#import-options-modal')).not.toBeVisible({ timeout });
  await expect(page.locator('#async-confirm-modal')).not.toBeVisible({ timeout });
  await waitForAppPhase(page, 'interactive', timeout);
}

export async function assertDashboardPopulated(page: Page, timeout = 15000): Promise<void> {
  await switchMainTabForTest(page, 'dashboard');
  await expect(page.locator('#hero-daily-amount')).not.toHaveText('—', { timeout });
  await expect(page.locator('#total-expenses')).not.toHaveText('', { timeout });
  await expect(page.locator('#total-expenses')).not.toContainText('—', { timeout });
}

export async function assertDashboardTotal(
  page: Page,
  selector: string,
  expectedAmount: string,
  timeout = 15000
): Promise<void> {
  await switchMainTabForTest(page, 'dashboard');
  await expect(page.locator(selector)).toContainText(expectedAmount, { timeout });
}

export async function assertDashboardEmpty(page: Page, timeout = 15000): Promise<void> {
  await switchMainTabForTest(page, 'dashboard');
  await expect(page.locator('#total-expenses')).toContainText('$0.00', { timeout });
}

export async function assertLedgerHasRows(page: Page, minimumRows = 1, timeout = 15000): Promise<void> {
  await waitForAppPhase(page, 'interactive', timeout);
  await switchMainTabForTest(page, 'transactions');
  await expect(page.locator('#transactions-list')).toBeVisible({ timeout });
  await expect
    .poll(async () => page.locator('.transaction-row').count(), {
      timeout,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThanOrEqual(minimumRows);
}

export async function assertTransactionVisible(page: Page, description: string, timeout = 15000): Promise<void> {
  await waitForAppPhase(page, 'interactive', timeout);
  await switchMainTabForTest(page, 'transactions');
  await expect(page.locator('#transactions-list')).toContainText(description, { timeout });
}

export async function assertLedgerEmpty(page: Page, timeout = 15000): Promise<void> {
  await waitForAppPhase(page, 'interactive', timeout);
  await switchMainTabForTest(page, 'transactions');
  await expect(page.locator('#transactions-list')).toBeVisible({ timeout });
  await expect(page.locator('#tx-display-count')).toContainText('0', { timeout });
  await expect(page.locator('.transaction-row')).toHaveCount(0, { timeout });
}

export async function resetAppDataFromModal(
  page: Page,
  options: { clearBackups: boolean; timeout?: number }
): Promise<void> {
  const { clearBackups, timeout = 20000 } = options;
  await openResetAppDataModal(page, timeout);
  const actionButton = page.locator(
    clearBackups ? '#confirm-reset-clear-backups' : '#confirm-reset-keep-backups'
  );
  await actionButton.click();
  await assertModalClosedAndInteractive(page, timeout);
  await assertDashboardEmpty(page, timeout);
  await assertLedgerEmpty(page, timeout);
}

export async function submitJsonDataImport(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  mode: ImportMode,
  timeout = 20000
): Promise<void> {
  await waitForTransactionsSurfaceReady(page, timeout);
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('#import-options-modal')).toBeVisible({ timeout });
  await page.locator(mode === 'overwrite' ? '#import-overwrite' : '#import-merge').click();
}

export async function importJsonData(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  mode: ImportMode,
  timeout = 20000
): Promise<void> {
  await submitJsonDataImport(page, file, mode, timeout);
  await assertModalClosedAndInteractive(page, timeout);
}

export async function loadSampleDataFromSettings(page: Page, timeout = 20000): Promise<void> {
  await openSettingsModal(page, timeout);
  await page.locator('#load-sample-data').click();
  await expect(page.locator('#async-confirm-modal')).toBeVisible({ timeout });
  await expect(page.locator('#confirm-title')).toHaveText('Load Demo Account', { timeout });

  await page.locator('#confirm-ok').click();

  await expect(page.locator('#settings-modal')).not.toBeVisible({ timeout: 15000 });
  await assertDashboardPopulated(page, 15000);
  await waitForTransactionsSurfaceReady(page, timeout);
  await expect(page.locator('.transaction-row').first()).toBeVisible({ timeout: 15000 });
}

/**
 * Clean state without skipping onboarding (for onboarding tests).
 */
export async function cleanAppStateRaw(page: Page): Promise<void> {
  installPageDiagnostics(page);
  await resetAppState(page, false);
  await installPlaywrightBootstrap(page);
  await bootFreshApp(page, 'interactive');
}
