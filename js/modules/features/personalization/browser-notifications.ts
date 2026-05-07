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
    // CR-Apr22-F slice 2: key off the ACTUAL calendar month (via `todayMonth`,
    // derived from `todayStr` so it rolls over at midnight), NOT the viewed
    // month `currentMonth`. Otherwise navigating to a past month in the UI
    // retroactively fires notifications for that month's over-budget
    // categories (which the user already saw when it was current), AND the
    // compaction pass below drops the real current-month keys from storage,
    // causing the same real-month notifications to re-fire on the next
    // reload once the user navigates back. Alerts in the in-app list still
    // follow the viewed month via `activeAlertEntries` — that's the correct
    // UI semantics. Push notifications are a different contract: they
    // represent "attention needed NOW," which is always about today's
    // calendar month.
    const monthKey = signals.todayMonth.value;
    const alertPrefs = normalizeAlertPrefs(signals.alerts.value);
    const activeAlerts = signals.todayMonthAlertEntries.value;
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

    // Round 7 fix: If more than 3 alerts are pending, batch them into a single summary notification
    // instead of firing multiple notifications which can overwhelm the user
    if (newAlerts.length > 3) {
      try {
        const notification = new Notification('Budget alerts', {
          body: `You have ${newAlerts.length} budget alerts. Check the app for details.`,
          tag: 'budget_alerts_summary'
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
        // Mark all as notified via a single summary tag
        newAlerts.forEach((alert) => notifiedKeys.add(alert.key));
      } catch {
        // Ignore notification failures and continue with in-app alerts.
      }
    } else {
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
    }

    previousAlertKeys = currentKeys;
    const nextKeys = Array.from(notifiedKeys);
    // Set-equality (not length-equality) so a same-count swap \u2014 e.g. category A
    // drops out and category B drops in at a month boundary \u2014 still persists the
    // change. The length-only gate previously let the swap re-fire the same
    // notification on every reload until the count happened to differ. Fixes M24
    // (Inline-Behavior-Review rev 12).
    const sameSet =
      nextKeys.length === alertPrefs.lastNotifiedAlertKeys.length &&
      new Set(nextKeys).size === new Set([...nextKeys, ...alertPrefs.lastNotifiedAlertKeys]).size;
    if (!sameSet) {
      saveAlertPrefs(normalizeAlertPrefs({ ...alertPrefs, lastNotifiedAlertKeys: nextKeys }));
    }
  });
}
