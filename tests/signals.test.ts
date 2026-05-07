import { afterEach, describe, expect, it } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { alerts as alertActions } from '../js/modules/core/actions/filters-actions.js';
import { settings as settingsActions } from '../js/modules/core/actions/data-actions.js';
import { invalidateAllCache } from '../js/modules/core/monthly-totals-cache.js';
import { invalidateRolloverCache } from '../js/modules/features/financial/rollover.js';
import { SAVINGS_TRANSFER_CATEGORY_ID, SAVINGS_TRANSFER_NOTE_MARKER, SAVINGS_TRANSFER_TAG } from '../js/modules/core/transaction-classification.js';
import { getDefaultContainer, Services } from '../js/modules/core/di-container.js';
import { fmtCur } from '../js/modules/core/utils-pure.js';
import type { InsightsPayload, Transaction } from '../js/types/index.js';

function tx(
  overrides: Partial<Transaction> & {
    type: 'expense' | 'income';
    amount: number;
    date: string;
    category: string;
  }
): Transaction {
  return {
    __backendId: `test_${Math.random().toString(36).slice(2)}`,
    description: 'Test',
    currency: 'USD',
    recurring: false,
    ...overrides
  };
}

afterEach(() => {
  signals.replaceTransactionLedger([]);
  // CR-Apr22-F slice 3: rollover calculation reads prior-month spend through
  // `calculateMonthlyTotalsWithCache`, which memoizes per-month totals across
  // tests. Invalidate here so a prior test's transaction ledger does not bleed
  // into a later test's rollover surplus. This is test-infra cleanup, not a
  // production concern — `replaceTransactionLedger` is a test-only utility.
  invalidateAllCache();
  invalidateRolloverCache();
  signals.currentMonth.value = '2026-03';
  signals.monthlyAlloc.value = {};
  signals.dismissedAlerts.value = new Set();
  signals.alerts.value = {
    budgetThreshold: null,
    browserNotificationsEnabled: false,
    lastNotifiedAlertKeys: []
  };
  // CR-Apr22-F slice 3: reset rollover to its disabled-default so a test
  // that toggles it on does not leak into the next test's alert computation,
  // and clear the sessionStorage key behind dismissedAlerts so the next
  // module-level hydration (e.g. if another test imports fresh) starts clean.
  signals.rolloverSettings.value = {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero'
  };
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(signals.DISMISSED_ALERTS_SESSION_KEY);
    } catch { /* ignore — cleanup best-effort */ }
  }
});

describe('currentMonthTotals', () => {
  it('recomputes immediately from live current-month transactions', () => {
    signals.currentMonth.value = '2026-03';
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 10, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.currentMonthTotals.value.expenses).toBe(10);

    signals.replaceTransactionLedger([
      ...signals.transactions.value,
      tx({ type: 'expense', amount: 32.5, date: '2026-03-08', category: 'food' }),
      tx({ type: 'income', amount: 100, date: '2026-03-09', category: 'salary' })
    ]);

    expect(signals.currentMonthTotals.value.income).toBe(100);
    expect(signals.currentMonthTotals.value.expenses).toBe(42.5);
    expect(signals.currentMonthTotals.value.balance).toBe(57.5);
  });

  it('excludes savings transfers from tracked expense totals', () => {
    signals.currentMonth.value = '2026-03';
    signals.replaceTransactionLedger([
      tx({ type: 'income', amount: 1000, date: '2026-03-01', category: 'salary' }),
      tx({ type: 'expense', amount: 120, date: '2026-03-04', category: 'food' }),
      tx({
        type: 'expense',
        amount: 250,
        date: '2026-03-05',
        category: SAVINGS_TRANSFER_CATEGORY_ID,
        description: 'Savings Transfer: Emergency Fund',
        tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
        notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: Emergency Fund [id:goal_1]`
      })
    ]);

    expect(signals.currentMonthTotals.value.income).toBe(1000);
    expect(signals.currentMonthTotals.value.expenses).toBe(120);
    expect(signals.currentMonthTotals.value.balance).toBe(880);
    expect(signals.expensesByCategory.value).toEqual({ food: 120 });
  });
});

describe('month summary signals', () => {
  it('tracks active months from month summaries instead of raw historical scans', () => {
    signals.replaceTransactionLedger([
      tx({ type: 'income', amount: 1000, date: '2026-01-02', category: 'salary' }),
      tx({ type: 'expense', amount: 50, date: '2026-03-03', category: 'food' }),
      tx({
        type: 'expense',
        amount: 200,
        date: '2026-02-03',
        category: SAVINGS_TRANSFER_CATEGORY_ID,
        description: 'Savings Transfer: Vacation',
        tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
        notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: Vacation [id:goal_2]`
      })
    ]);

    expect(signals.activeTransactionMonths.value).toEqual(['2026-01', '2026-03']);
    expect(signals.monthSummaries.value['2026-03']?.expenses).toBe(50);
    expect(signals.monthSummaries.value['2026-02']?.expenses).toBe(0);
  });

  it('updates the current month summary when transactions move between months', () => {
    signals.currentMonth.value = '2026-03';
    const movedTx = tx({ type: 'expense', amount: 80, date: '2026-03-11', category: 'food' });
    signals.replaceTransactionLedger([movedTx]);

    expect(signals.currentMonthSummary.value.expenses).toBe(80);

    signals.replaceTransactionLedger([{ ...movedTx, date: '2026-04-11' }]);

    expect(signals.currentMonthSummary.value.expenses).toBe(0);
    expect(signals.monthSummaries.value['2026-04']?.expenses).toBe(80);
  });
});

describe('activeAlertEntries', () => {
  it('recomputes when an existing category budget amount changes', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-03': {
        food: 100
      }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toHaveLength(1);
    expect(signals.activeAlertEntries.value[0]?.key).toBe('2026-03:food:budget-threshold');

    signals.monthlyAlloc.value = {
      '2026-03': {
        food: 120
      }
    };

    expect(signals.activeAlertEntries.value).toEqual([]);
  });
});

// CR-Apr22-F slice 2: `todayMonthAlertEntries` is a separate computed
// signal keyed to the actual calendar month (derived from `todayStr`)
// rather than the viewed month (`currentMonth`). Browser notifications
// read from this so they only fire for today's month, and navigating to
// a past/future month in the UI does NOT retroactively fire notifications
// or churn the compaction pass.
describe('todayMonthAlertEntries', () => {
  const restoreTodayStr = signals.todayStr.value;
  afterEach(() => {
    signals.todayStr.value = restoreTodayStr;
  });

  it('derives todayMonth by slicing todayStr to YYYY-MM', () => {
    signals.todayStr.value = '2026-04-17';
    expect(signals.todayMonth.value).toBe('2026-04');
  });

  it('keys alerts off todayStr even when currentMonth points elsewhere', () => {
    signals.todayStr.value = '2026-04-17';
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-03': { food: 100 },
      '2026-04': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-04-05', category: 'food' })
    ]);

    // currentMonth = 2026-03 so `activeAlertEntries` sees no 2026-03 spend
    // (and 2026-03 alloc has no overrun either) — empty list.
    expect(signals.activeAlertEntries.value).toEqual([]);
    // todayMonth = 2026-04 → 85/100 > 0.8 threshold → fires.
    expect(signals.todayMonthAlertEntries.value).toHaveLength(1);
    expect(signals.todayMonthAlertEntries.value[0]?.key).toBe('2026-04:food:budget-threshold');
  });

  it('does NOT recompute when only currentMonth changes', () => {
    signals.todayStr.value = '2026-04-17';
    signals.currentMonth.value = '2026-04';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-04': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-04-05', category: 'food' })
    ]);

    const firstResult = signals.todayMonthAlertEntries.value;
    expect(firstResult).toHaveLength(1);

    // Navigate to a different viewed month — the signal must stay bound
    // to today's month and keep returning the same reference (memoization
    // validates that inputs didn't materially change).
    signals.currentMonth.value = '2026-01';
    const secondResult = signals.todayMonthAlertEntries.value;
    expect(secondResult).toBe(firstResult);
  });

  it('recomputes when todayStr rolls over into a new month', () => {
    signals.todayStr.value = '2026-04-30';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-04': { food: 100 },
      '2026-05': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-04-20', category: 'food' }),
      // May intentionally not yet over budget.
      tx({ type: 'expense', amount: 40, date: '2026-05-02', category: 'food' })
    ]);

    expect(signals.todayMonthAlertEntries.value[0]?.key).toBe('2026-04:food:budget-threshold');

    // Midnight roll into May — the April alert must stop firing because
    // May spend is still below threshold.
    signals.todayStr.value = '2026-05-01';
    expect(signals.todayMonthAlertEntries.value).toEqual([]);
  });

  it('returns empty list when today\'s month has no summary yet', () => {
    signals.todayStr.value = '2026-07-15';
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-03': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    // No monthSummary entry for 2026-07 and no 2026-07 alloc — empty.
    expect(signals.todayMonthAlertEntries.value).toEqual([]);
  });
});

// CR-Apr22-F slice 3: the threshold alert must compare spend against the
// rollover-adjusted effective budget (base allocation + carryover from prior
// months), mirroring what the envelope-budget view shows. Previously the
// alert fired against the raw allocation, surfacing "over budget" warnings
// for categories that still had a buffer left.
describe('activeAlertEntries with rollover', () => {
  it('does not fire when rollover surplus keeps spend below threshold', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    // Prior month: allocated 100, spent 0 → +100 surplus carries forward.
    // Current month: allocated 100, spent 85. Without rollover, 85/100 = 85%
    // crosses the 80% threshold. With rollover, effective = 200, 85/200 =
    // 42.5% → no alert.
    signals.monthlyAlloc.value = {
      '2026-02': { food: 100 },
      '2026-03': { food: 100 }
    };
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toEqual([]);
  });

  it('still fires when spend exceeds the rollover-adjusted threshold', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    // Prior: 100 alloc, 50 spent → +50 rollover. Current: 100 alloc, 130
    // spent. Effective = 150; 130 >= 150 * 0.8 = 120 → fires.
    signals.monthlyAlloc.value = {
      '2026-02': { food: 100 },
      '2026-03': { food: 100 }
    };
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 50, date: '2026-02-05', category: 'food' }),
      tx({ type: 'expense', amount: 130, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toHaveLength(1);
    expect(signals.activeAlertEntries.value[0]?.key).toBe('2026-03:food:budget-threshold');
  });

  it('recomputes when rolloverSettings.enabled toggles', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    // Baseline scenario: rollover ON → 85/200 = 42.5% → no alert.
    signals.monthlyAlloc.value = {
      '2026-02': { food: 100 },
      '2026-03': { food: 100 }
    };
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toEqual([]);

    // Toggle rollover off — the computed should re-run and the bare alloc
    // threshold should now trip (85 >= 100 * 0.8 = 80).
    signals.rolloverSettings.value = {
      ...signals.rolloverSettings.value,
      enabled: false
    };

    expect(signals.activeAlertEntries.value).toHaveLength(1);
    expect(signals.activeAlertEntries.value[0]?.key).toBe('2026-03:food:budget-threshold');
  });

  it('skips categories whose effective budget is zero or negative', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    // No current-month alloc for "food" but prior-month rollover of 0 —
    // effective budget = 0 → alert must not fire even if spent > 0.
    signals.monthlyAlloc.value = {
      '2026-03': { food: 0 }
    };
    signals.rolloverSettings.value = {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: null,
      negativeHandling: 'zero'
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 50, date: '2026-03-05', category: 'food' })
    ]);

    expect(signals.activeAlertEntries.value).toEqual([]);
  });
});

// CR-Apr22-F slice 3: dismissedAlerts now persists to sessionStorage so a
// user's dismissal sticks for the rest of the browsing session. Test the
// write path end-to-end (dismissAlert action → sessionStorage entry) and
// confirm that a pre-existing sessionStorage entry, fed back into the
// signal, suppresses the matching alert from `activeAlertEntries`.
describe('dismissedAlerts sessionStorage persistence', () => {
  afterEach(() => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(signals.DISMISSED_ALERTS_SESSION_KEY);
    }
  });

  it('writes dismissed alert ids to sessionStorage', () => {
    signals.currentMonth.value = '2026-03';
    alertActions.dismissAlert('food:budget-threshold');

    const raw = sessionStorage.getItem(signals.DISMISSED_ALERTS_SESSION_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual(['2026-03:food:budget-threshold']);
  });

  it('accumulates multiple dismissals in the stored array', () => {
    signals.currentMonth.value = '2026-03';
    alertActions.dismissAlert('food:budget-threshold');
    alertActions.dismissAlert('shopping:budget-threshold');

    const raw = sessionStorage.getItem(signals.DISMISSED_ALERTS_SESSION_KEY);
    const parsed = JSON.parse(raw!) as string[];
    expect(parsed).toEqual(
      expect.arrayContaining([
        '2026-03:food:budget-threshold',
        '2026-03:shopping:budget-threshold'
      ])
    );
    expect(parsed).toHaveLength(2);
  });

  it('suppresses an alert once its id is in dismissedAlerts (simulating post-reload hydration)', () => {
    signals.currentMonth.value = '2026-03';
    signals.alerts.value = {
      budgetThreshold: 0.8,
      browserNotificationsEnabled: false,
      lastNotifiedAlertKeys: []
    };
    signals.monthlyAlloc.value = {
      '2026-03': { food: 100 }
    };
    signals.replaceTransactionLedger([
      tx({ type: 'expense', amount: 85, date: '2026-03-05', category: 'food' })
    ]);

    // Baseline: alert fires.
    expect(signals.activeAlertEntries.value).toHaveLength(1);

    // Simulate the user dismissing, reloading, and re-hydrating: populate
    // the signal from a "restored" array just like _hydrateDismissedAlerts
    // would on next module load.
    const restored = new Set<string>(['2026-03:food:budget-threshold']);
    signals.dismissedAlerts.value = restored;

    expect(signals.activeAlertEntries.value).toEqual([]);
  });

  it('preserves dismissal behavior when sessionStorage throws (quota/private mode)', () => {
    signals.currentMonth.value = '2026-03';
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      // Must not throw — storage failure is swallowed, in-memory dismissal
      // still sticks for this tab.
      expect(() => alertActions.dismissAlert('food:budget-threshold')).not.toThrow();
      expect(signals.dismissedAlerts.value.has('2026-03:food:budget-threshold')).toBe(true);
    } finally {
      sessionStorage.setItem = originalSetItem;
    }
  });
});

// ==========================================
// CR-Apr22-G slice 1 — currentInsights currency reactivity
// ==========================================
//
// The `currentInsights` computed resolves `Services.INSIGHTS_GENERATOR` and
// invokes it. The generator's output embeds `fmtCur(...)` strings, but
// `fmtCur` reads module-level formatter state synced externally by
// `syncCurrencyFormat`, not from `signals.currency` directly. Without an
// explicit read of `signals.currency.value` inside the computed, changing
// the home currency leaves the insight payload cached with the old symbol
// until an unrelated dep (tx count, month, personality) forces a recompute.
//
// These tests stub `INSIGHTS_GENERATOR` via the DI container so the computed
// runs a deterministic generator that reflects the current formatter state,
// then assert that `setCurrency` alone re-runs the computed with the new
// symbol.
describe('currentInsights — currency reactivity (CR-Apr22-G slice 1)', () => {
  const originalCurrency = { ...signals.currency.value };
  let restoreGenerator: (() => void) | null = null;

  afterEach(() => {
    if (restoreGenerator) {
      restoreGenerator();
      restoreGenerator = null;
    }
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
  });

  it('recomputes insight payload with new currency symbol when home currency changes', () => {
    // Seed the formatter cache explicitly before stubbing — the DI container
    // may not have run `createDefaultContainer()` side effects in this test
    // run, so rely on `setCurrency` which calls `syncCurrencyFormat` first.
    settingsActions.setCurrency('USD', '$');

    const container = getDefaultContainer();
    // Stub insights generator: emits an insight string carrying fmtCur of a
    // fixed amount so the returned payload changes when fmtCur's cached
    // symbol flips. `override: true` silences the duplicate-registration
    // guard (createDefaultContainer registers INSIGHTS_GENERATOR lazily).
    const stub = (): InsightsPayload => ({
      insight1: `Tracked spending so far: ${fmtCur(100)}`,
      insight2: null,
      insight3: null
    });
    container.registerValue(Services.INSIGHTS_GENERATOR, stub, { override: true });
    restoreGenerator = () => {
      // Restore by re-registering a no-op that yields the empty payload, so
      // downstream tests don't inherit the "$100" stub. Tests that care
      // about insights will re-register their own stub.
      container.registerValue(
        Services.INSIGHTS_GENERATOR,
        (): InsightsPayload => ({ insight1: null, insight2: null, insight3: null }),
        { override: true }
      );
    };

    // Baseline read: USD symbol must be present.
    const usdPayload = signals.currentInsights.value;
    expect(usdPayload.insight1).toBe('Tracked spending so far: $100.00');

    // Change currency to EUR — setCurrency calls syncCurrencyFormat BEFORE
    // updating signals.currency, so fmtCur is already in "€" mode by the
    // time the signal fires. The currency.value read inside currentInsights
    // is what subscribes the computed to this change; without it the
    // payload below would still show "$100.00".
    settingsActions.setCurrency('EUR', '€');
    const eurPayload = signals.currentInsights.value;
    expect(eurPayload.insight1).toBe('Tracked spending so far: €100.00');
    expect(eurPayload).not.toBe(usdPayload); // proves recomputation

    // Switch to GBP to rule out accidental caching by EUR-specific state.
    settingsActions.setCurrency('GBP', '£');
    expect(signals.currentInsights.value.insight1).toBe('Tracked spending so far: £100.00');
  });

  it('recomputes with zero-decimal formatting when switching to JPY', () => {
    settingsActions.setCurrency('USD', '$');

    const container = getDefaultContainer();
    const stub = (): InsightsPayload => ({
      insight1: `Monthly total: ${fmtCur(1000)}`,
      insight2: null,
      insight3: null
    });
    container.registerValue(Services.INSIGHTS_GENERATOR, stub, { override: true });
    restoreGenerator = () => {
      container.registerValue(
        Services.INSIGHTS_GENERATOR,
        (): InsightsPayload => ({ insight1: null, insight2: null, insight3: null }),
        { override: true }
      );
    };

    expect(signals.currentInsights.value.insight1).toBe('Monthly total: $1,000.00');

    // JPY has 0 decimals per CURRENCY_DECIMALS — the formatted amount
    // collapses from "$1,000.00" to "¥1,000" without fractional digits.
    settingsActions.setCurrency('JPY', '¥');
    expect(signals.currentInsights.value.insight1).toBe('Monthly total: ¥1,000');
  });
});
