/**
 * Budget Alerts Module
 * 
 * Reactive budget threshold monitoring and alert banner.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { on } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import DOM from '../../core/dom-cache.js';
import { html, render } from '../../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import { initBrowserBudgetNotifications } from './browser-notifications.js';

// ==========================================
// ACTIONS
// ==========================================

/**
 * Dismiss an alert (won't show again this month)
 */
export function dismissAlert(alertText: string): void {
  // Remove the "(+X more)" suffix if present
  const cleanText = alertText.replace(/ \(\+\d+ more\)$/, '');
  const mk = signals.currentMonth.value;
  
  // Update signal to trigger re-render
  const nextDismissed = new Set(signals.dismissedAlerts.value);
  nextDismissed.add(`${mk}:${cleanText}`);
  signals.dismissedAlerts.value = nextDismissed;
}

// ==========================================
// RENDERER
// ==========================================

/**
 * Mount the reactive alert banner component
 */
export function mountAlertBanner(): () => void {
  const container = DOM.get('alert-banner');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const alerts = signals.activeAlerts.value;
    
    if (alerts.length === 0) {
      container.classList.add('hidden');
      render(html``, container);
      return;
    }

    container.classList.remove('hidden');
    const firstAlert = alerts[0];
    const moreCount = alerts.length - 1;
    const displayText = firstAlert + (moreCount > 0 ? ` (+${moreCount} more)` : '');

    render(html`
      <div class="w-full px-4 md:px-8 py-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="text-lg">⚠️</span>
          <p id="alert-text" class="text-sm font-semibold text-warning">${displayText}</p>
        </div>
        <button @click=${() => dismissAlert(firstAlert)}
                id="dismiss-alert"
                class="touch-btn text-sm font-bold rounded text-warning"
                aria-label="Dismiss alert">
          ✕
        </button>
      </div>
    `, container);
  });

  return cleanup;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize alert handlers
 */
export function initAlerts(): () => void {
  // Register Feature Event Listener for external control
  const unsubscribe = on(FeatureEvents.DISMISS_ALERT, (data: { id: string }) => {
    dismissAlert(data.id);
  });
  const stopBrowserNotifications = initBrowserBudgetNotifications();
  return () => {
    unsubscribe();
    stopBrowserNotifications();
  };
}

/**
 * Legacy support for checkAlerts (now reactive)
 */
export function checkAlerts(): void {
  // Logic is now automatic via signals.activeAlerts and mountAlertBanner
}
