/**
 * Budget Alerts Module
 * 
 * Reactive budget threshold monitoring and alert banner.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { alerts as alertActions } from '../../core/state-actions.js';
import { on } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import { initBrowserBudgetNotifications } from './browser-notifications.js';

// ==========================================
// ACTIONS
// ==========================================

/**
 * Dismiss an alert (won't show again this month)
 */
export function dismissAlert(alertId: string): void {
  alertActions.dismissAlert(alertId, signals.currentMonth.value);
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
  // Logic is now automatic via signals.activeAlertEntries and mountInlineAlerts
}
