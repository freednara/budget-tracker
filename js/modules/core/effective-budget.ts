'use strict';

import * as signals from './signals.js';
import { getMonthAlloc } from './month-alloc.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from './monthly-totals-cache.js';
import { toCents, toDollars } from './utils-pure.js';
import type { RolloverSettings } from '../../types/index.js';

const DEFAULT_ROLLOVER_SETTINGS: RolloverSettings = {
  enabled: false,
  mode: 'all',
  categories: [],
  maxRollover: null,
  negativeHandling: 'zero'
};

function getRolloverSettings(): RolloverSettings {
  return { ...DEFAULT_ROLLOVER_SETTINGS, ...(signals.rolloverSettings.value || {}) };
}

function isCategoryRolloverEnabled(categoryId: string, settings: RolloverSettings): boolean {
  if (!settings.enabled) return false;
  if (settings.mode === 'all') return true;
  return settings.categories?.includes(categoryId) === true;
}

function calculateCategoryRollover(categoryId: string, monthKey: string, settings: RolloverSettings): number {
  if (!isCategoryRolloverEnabled(categoryId, settings)) return 0;

  const allMonthsWithAlloc = Object.keys(signals.monthlyAlloc.value).sort();
  const startMonth = allMonthsWithAlloc.find((mk) => (
    signals.monthlyAlloc.value[mk]?.[categoryId] !== undefined
  ));

  if (!startMonth || startMonth >= monthKey) return 0;

  let accumulatedCents = 0;

  for (const mk of allMonthsWithAlloc) {
    if (mk < startMonth) continue;
    if (mk >= monthKey) break;

    const monthAlloc = signals.monthlyAlloc.value[mk]?.[categoryId] || 0;
    const allocCents = toCents(monthAlloc);
    const totals = calculateMonthlyTotalsWithCache(mk);
    const spentCents = toCents((totals.categoryTotals || {})[categoryId] || 0);

    accumulatedCents += allocCents - spentCents;

    if (accumulatedCents < 0 && settings.negativeHandling === 'zero') {
      accumulatedCents = 0;
    }
  }

  // ROLL-01: Apply max rollover cap to POSITIVE surplus only.
  // Negative balances (overspending) carry forward in full so
  // `negativeHandling` alone controls their fate.
  if (settings.maxRollover !== null && settings.maxRollover !== undefined && accumulatedCents > 0) {
    const maxCents = toCents(settings.maxRollover);
    accumulatedCents = Math.min(accumulatedCents, maxCents);
  }

  return toDollars(accumulatedCents);
}

export function calculateEffectiveMonthBudgetTotal(monthKey: string): number {
  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
  // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
  // once-per-session trackError on a genuine miss (map non-empty but the
  // requested month is missing), which is the data-loss signal the review
  // targets. Shape is identical on the hit path.
  const alloc = getMonthAlloc(monthKey, signals.monthlyAlloc.value);
  const settings = getRolloverSettings();
  let totalBudgetCents = 0;

  for (const [categoryId, amount] of Object.entries(alloc)) {
    const rollover = settings.enabled
      ? calculateCategoryRollover(categoryId, monthKey, settings)
      : 0;
    totalBudgetCents += toCents(amount) + toCents(rollover);
  }

  return toDollars(totalBudgetCents);
}
