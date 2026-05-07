/**
 * Analytics Modal — Period Persistence Across Close/Reopen
 *
 * Regression tests for 7a (Inline-Behavior-Review, Period/scope coherence):
 * the analytics-modal open handler must preserve whatever year tab the user
 * last selected, rather than wiping it back to 'all-time' on every open.
 *
 * Pre-fix behavior:
 *   - `openAnalyticsModalHandler` in `modal-events.ts` called
 *     `setAnalyticsCurrentPeriod('all-time')` synchronously after awaiting
 *     `loadAnalyticsModule()`. Clicking "2024" in the period tabs, closing
 *     the modal, and reopening it would reset the selection to All-Time
 *     with no user warning — the year-tab switcher looked like durable
 *     state but wasn't.
 *
 * Post-fix behavior (locked in by this suite):
 *   - Opening the modal loads the analytics module (to ensure the lazy
 *     import has completed before the render step) but does NOT touch the
 *     stored period. The prior selection survives close/reopen for the
 *     life of the page session. If the underlying data changes such that
 *     the stored period is no longer valid (e.g. user deleted every 2024
 *     transaction), `renderAnalyticsPeriodTabs`'s internal validity check
 *     self-heals to the first available year or 'all-time'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { initModalEvents, cleanupModalEvents } from '../js/modules/ui/interactions/modal-events.js';
import {
  setAnalyticsCurrentPeriod,
  getAnalyticsCurrentPeriod,
} from '../js/modules/features/analytics/analytics-ui.js';
import type { Transaction } from '../js/types/index.js';

/**
 * Seed the real `signals.transactions` with representative data in the
 * years we care about. `renderAnalyticsPeriodTabs` has a post-fix validity
 * check that self-heals the stored period to `'all-time'` if the year is
 * no longer present in the data — so tests that want to lock in period
 * persistence for a year must ensure that year actually has transactions,
 * otherwise the self-heal is legitimately invoked and this test would be
 * measuring the wrong thing.
 */
function seedTransactionsForYears(years: string[]): void {
  signals.transactions.value = years.map((year, i) => ({
    id: `tx-${i}`,
    date: `${year}-06-15`,
    amount: 100,
    category: 'food',
    type: 'expense',
    description: '',
    account: '',
    recurring: null,
  })) as unknown as Transaction[];
}

/**
 * Wait long enough for the async click handler (which awaits a dynamic
 * `import('../../orchestration/analytics.js')` and then schedules a
 * setTimeout) to finish its synchronous-after-await period-state
 * manipulation. A single `await Promise.resolve()` is insufficient
 * because the handler awaits an `import()` call that takes many
 * microtasks to resolve under vitest; real timer tick buys enough
 * settle for both the await chain AND the internal setTimeout to run.
 */
async function waitForHandler(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));
}

function setupAnalyticsDom(): void {
  document.body.innerHTML = `
    <div id="analytics-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
      <div id="analytics-period-tabs"></div>
      <button id="open-analytics"></button>
      <button id="close-analytics"></button>
    </div>
  `;
}

describe('analytics modal period persistence (7a)', () => {
  beforeEach(() => {
    setupAnalyticsDom();
    DOM.clearAll();
    // Reset the module-scope period to a known baseline so each test is
    // independent of its siblings.
    setAnalyticsCurrentPeriod('all-time');
    // Default seed — 2024 + 2025 both carry data so the period-tab validity
    // check in `renderAnalyticsPeriodTabs` doesn't self-heal away our stored
    // selection. Tests that need a specific data shape override in-body.
    seedTransactionsForYears(['2024', '2025']);
  });

  afterEach(() => {
    cleanupModalEvents();
    DOM.clearAll();
    document.body.innerHTML = '';
    setAnalyticsCurrentPeriod('all-time');
    signals.transactions.value = [];
  });

  it('open handler preserves a previously-selected year (does not reset to all-time)', async () => {
    initModalEvents({});

    // Simulate the user having clicked the 2024 period tab earlier in the
    // session — the handler's job is to preserve this across close/reopen.
    setAnalyticsCurrentPeriod('2024');
    expect(getAnalyticsCurrentPeriod()).toBe('2024');

    // Dispatch the open click — the handler awaits a dynamic import so
    // give microtasks a chance to settle before we assert.
    const btn = document.getElementById('open-analytics') as HTMLButtonElement;
    btn.click();
    await waitForHandler();

    // Pre-fix this would have been 'all-time'; post-fix the year selection
    // survives the open.
    expect(getAnalyticsCurrentPeriod()).toBe('2024');
  });

  it('first-open default remains all-time when nothing was previously selected', async () => {
    initModalEvents({});

    // Module-scope state starts at 'all-time' (via the beforeEach reset).
    expect(getAnalyticsCurrentPeriod()).toBe('all-time');

    const btn = document.getElementById('open-analytics') as HTMLButtonElement;
    btn.click();
    await waitForHandler();

    // Open on a fresh state leaves the default in place — no accidental
    // side-effects from removing the explicit reset.
    expect(getAnalyticsCurrentPeriod()).toBe('all-time');
  });

  it('close + reopen preserves the user selection across both events', async () => {
    initModalEvents({});

    setAnalyticsCurrentPeriod('2025');

    const openBtn = document.getElementById('open-analytics') as HTMLButtonElement;
    const closeBtn = document.getElementById('close-analytics') as HTMLButtonElement;

    openBtn.click();
    await waitForHandler();
    expect(getAnalyticsCurrentPeriod()).toBe('2025');

    closeBtn.click();
    await waitForHandler();
    expect(getAnalyticsCurrentPeriod()).toBe('2025'); // close is a pure hide

    openBtn.click();
    await waitForHandler();
    // The key regression case — a subsequent open must not re-wipe the
    // selection on its second invocation either.
    expect(getAnalyticsCurrentPeriod()).toBe('2025');
  });
});
