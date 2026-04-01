'use strict';

import * as signals from './signals.js';
import { calculateMonthlyTotalsWithCacheSync } from './monthly-totals-cache.js';
import { toCents, toDollars } from './utils.js';
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
    const totals = calculateMonthlyTotalsWithCacheSync(mk);
    const spentCents = toCents((totals.categoryTotals || {})[categoryId] || 0);

    accumulatedCents += allocCents - spentCents;

    if (accumulatedCents < 0 && settings.negativeHandling === 'zero') {
      accumulatedCents = 0;
    }
  }

  if (settings.maxRollover !== null && settings.maxRollover !== undefined) {
    const maxCents = toCents(settings.maxRollover);
    accumulatedCents = Math.max(-maxCents, Math.min(accumulatedCents, maxCents));
  }

  return toDollars(accumulatedCents);
}

export function calculateEffectiveMonthBudgetTotal(monthKey: string): number {
  const alloc = signals.monthlyAlloc.value[monthKey] || {};
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
