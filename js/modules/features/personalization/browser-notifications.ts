'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../../core/signals.js';
import { settings } from '../../core/state-actions.js';
import { SK, persist, normalizeAlertPrefs } from '../../core/state.js';
import type { AlertPrefs } from '../../../types/index.js';

function saveAlertPrefs(nextAlerts: AlertPrefs): void {
  settings.setAlerts(nextAlerts);
  persist(SK.ALERTS, nextAlerts);
}

function keepCurrentMonthKeys(keys: string[], monthKey: string): string[] {
  return keys.filter((key: string) => key.startsWith(`${monthKey}:`));
}

let previousAlertKeys = new Set<string>();

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  return isBrowserNotificationSupported() ? Notification.permission : 'unsupported';
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isBrowserNotificationSupported()) return 'unsupported';
  return Notification.requestPermission();
}

export function clearStoredBudgetAlertNotifications(): void {
  previousAlertKeys = new Set<string>();
  const nextAlerts = normalizeAlertPrefs({
    ...signals.alerts.value,
    lastNotifiedAlertKeys: []
  });
  saveAlertPrefs(nextAlerts);
}

export function initBrowserBudgetNotifications(): () => void {
  return effect(() => {
    const monthKey = signals.currentMonth.value;
    const alertPrefs = normalizeAlertPrefs(signals.alerts.value);
    const activeAlerts = signals.activeAlertEntries.value;
    const currentKeys = new Set<string>(activeAlerts.map((alert) => alert.key));
    const compactedKeys = keepCurrentMonthKeys(alertPrefs.lastNotifiedAlertKeys, monthKey);

    if (compactedKeys.length !== alertPrefs.lastNotifiedAlertKeys.length) {
      saveAlertPrefs(normalizeAlertPrefs({ ...alertPrefs, lastNotifiedAlertKeys: compactedKeys }));
    }

    if (!alertPrefs.browserNotificationsEnabled || !isBrowserNotificationSupported() || Notification.permission !== 'granted') {
      previousAlertKeys = currentKeys;
      return;
    }

    const notifiedKeys = new Set<string>(compactedKeys);
    const newAlerts = activeAlerts.filter((alert) => (
      !previousAlertKeys.has(alert.key) &&
      !notifiedKeys.has(alert.key)
    ));

    if (newAlerts.length === 0) {
      previousAlertKeys = currentKeys;
      return;
    }

    newAlerts.forEach((alert) => {
      try {
        const notification = new Notification('Budget alert', {
          body: alert.text,
          tag: alert.key
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
        notifiedKeys.add(alert.key);
      } catch {
        // Ignore notification failures and continue with in-app alerts.
      }
    });

    previousAlertKeys = currentKeys;
    const nextKeys = Array.from(notifiedKeys);
    if (nextKeys.length !== alertPrefs.lastNotifiedAlertKeys.length) {
      saveAlertPrefs(normalizeAlertPrefs({ ...alertPrefs, lastNotifiedAlertKeys: nextKeys }));
    }
  });
}
