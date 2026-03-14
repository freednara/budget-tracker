/**
 * Budget Alerts Module
 *
 * Checks budget thresholds and displays alert banners.
 *
 * @module alerts
 */
'use strict';

import { dismissedAlerts } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getMonthExpByCat } from '../financial/calculations.js';
import { getCatInfo } from '../../core/categories.js';
import DOM from '../../core/dom-cache.js';

/**
 * Check all budget categories for threshold alerts
 * Shows banner if any category exceeds the user's alert threshold
 */
export function checkAlerts(): void {
  const alerts: string[] = [];
  const alloc = signals.monthlyAlloc.value[signals.currentMonth.value] || {};

  Object.entries(alloc).forEach(([catId, amt]) => {
    // Skip zero/negative/NaN allocations
    if (!(amt > 0)) return;

    const spent = getMonthExpByCat(catId, signals.currentMonth.value);

    // Check if spending exceeds user's threshold
    if (signals.alerts.value.budgetThreshold !== null && spent >= amt * signals.alerts.value.budgetThreshold) {
      const cat = getCatInfo('expense', catId);
      alerts.push(`${cat.emoji} ${cat.name}: ${Math.round(spent / amt * 100)}% spent`);
    }
  });

  const banner = DOM.get('alert-banner');
  if (!banner) return;

  // Filter out dismissed alerts (scoped to current month)
  const visible = alerts.filter(a => !dismissedAlerts.has(`${signals.currentMonth.value}:${a}`));

  if (visible.length) {
    banner.classList.remove('hidden');
    const textEl = DOM.get('alert-text');
    if (textEl) {
      textEl.textContent = visible[0] + (visible.length > 1 ? ` (+${visible.length - 1} more)` : '');
    }
  } else {
    banner.classList.add('hidden');
  }
}

/**
 * Dismiss an alert (won't show again this session)
 */
export function dismissAlert(alertText: string): void {
  // Remove the "(+X more)" suffix if present
  const cleanText = alertText.replace(/ \(\+\d+ more\)$/, '');
  // Scope dismissal to current month so alerts reappear in new months
  dismissedAlerts.add(`${signals.currentMonth.value}:${cleanText}`);
  checkAlerts(); // Re-check to update banner
}

/**
 * Initialize alerts - check on page load
 */
export function initAlerts(): void {
  checkAlerts();
}
