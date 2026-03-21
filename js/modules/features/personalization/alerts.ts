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
      render(html``, container);
      return;
    }

    const firstAlert = alerts[0];
    const moreCount = alerts.length - 1;
    const displayText = firstAlert + (moreCount > 0 ? ` (+${moreCount} more)` : '');

    render(html`
      <div id="alert-banner" class="bg-expense/10 border-b border-expense/20 p-2 text-center flex items-center justify-center gap-3">
        <span class="text-sm font-bold text-expense flex items-center gap-2">
          <span class="text-lg">⚠️</span>
          <span id="alert-text">${displayText}</span>
        </span>
        <button @click=${() => dismissAlert(firstAlert)}
                class="text-xs font-black uppercase tracking-tighter hover:opacity-70 transition-opacity text-secondary">
          Dismiss
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
export function initAlerts(): void {
  // Register Feature Event Listener for external control
  on(FeatureEvents.DISMISS_ALERT, (data: { id: string }) => {
    dismissAlert(data.id);
  });
}

/**
 * Legacy support for checkAlerts (now reactive)
 */
export function checkAlerts(): void {
  // Logic is now automatic via signals.activeAlerts and mountAlertBanner
}
