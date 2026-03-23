/**
 * Storage Operations Module
 * 
 * Provides localStorage utilities and storage key constants.
 * 
 * ⚠️  LEGACY STATE MIGRATION COMPLETE
 * Application state has been fully migrated to Preact Signals (see signals.ts).
 * This module now only contains storage utilities and key constants.
 *
 * @module storage
 */

import { safeStorage } from './safe-storage.js';
import type { AlertPrefs, StorageKeys } from '../../types/index.js';

// ==========================================
// STORAGE KEYS
// ==========================================

export const SK: StorageKeys = {
  TX: 'budget_tracker_transactions',
  SAVINGS: 'budget_tracker_savings_goals',
  ALLOC: 'budget_tracker_monthly_allocations',
  THEME: 'budget_tracker_theme',
  ACHIEVE: 'budget_tracker_achievements',
  STREAK: 'budget_tracker_streak',
  ONBOARD: 'budget_tracker_onboarding',
  CUSTOM_CAT: 'budget_tracker_custom_categories',
  CURRENCY: 'budget_tracker_currency',
  SECTIONS: 'budget_tracker_sections',
  PIN: 'budget_tracker_pin',
  INSIGHT_PERS: 'budget_tracker_insight_personality',
  ALERTS: 'budget_tracker_alert_prefs',
  SAVINGS_CONTRIB: 'budget_tracker_savings_contributions',
  LAST_BACKUP: 'budget_tracker_last_backup',
  FILTER_PRESETS: 'budget_tracker_filter_presets',
  TX_TEMPLATES: 'budget_tracker_tx_templates',
  FILTER_EXPANDED: 'budget_tracker_filter_expanded',
  ROLLOVER_SETTINGS: 'budget_tracker_rollover_settings',
  DEBTS: 'budget_tracker_debts',
  BUDGET_PLANS: 'budget_tracker_budget_plans',
  ATTACHMENTS: 'budget_tracker_attachments',
  USER_SETTINGS: 'budget_tracker_user_settings',
  SYNC_STATE: 'budget_tracker_sync_state',
  RECURRING: 'budget_tracker_recurring',
  APP_STATS: 'budget_tracker_app_stats',
  HAS_ONBOARDED: 'budget_tracker_has_onboarded'
} as const;

// ==========================================
// STORAGE DEFAULTS (single source of truth)
// When adding new state, add the key to SK and its default here.
// ==========================================

export const STORAGE_DEFAULTS: Record<string, unknown> = {
  [SK.TX]: [],
  [SK.SAVINGS]: {},
  [SK.SAVINGS_CONTRIB]: [],
  [SK.ALLOC]: {},
  [SK.ACHIEVE]: {},
  [SK.STREAK]: { current: 0, longest: 0, lastDate: '' },
  [SK.CUSTOM_CAT]: [],
  [SK.DEBTS]: [],
  [SK.CURRENCY]: { home: 'USD', symbol: '$' },
  [SK.SECTIONS]: { envelope: true },
  [SK.PIN]: '',
  [SK.INSIGHT_PERS]: 'serious',
  [SK.ALERTS]: { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] },
  [SK.ROLLOVER_SETTINGS]: { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' },
  [SK.FILTER_PRESETS]: [],
  [SK.TX_TEMPLATES]: [],
  [SK.THEME]: 'dark',
  [SK.ONBOARD]: { active: false, completed: false, step: 0 },
  [SK.LAST_BACKUP]: 0,
  [SK.FILTER_EXPANDED]: false,
  [SK.BUDGET_PLANS]: {},
  [SK.ATTACHMENTS]: {},
  [SK.USER_SETTINGS]: {},
  [SK.SYNC_STATE]: {},
  [SK.RECURRING]: {},
  [SK.APP_STATS]: {},
  [SK.HAS_ONBOARDED]: false
};

/**
 * Get a stored value using the centralized default.
 * Prefer this over raw lsGet(SK.KEY, hardcodedDefault).
 */
export function getStored<T>(key: string, defaultValue?: T): T {
  const fallback = defaultValue ?? STORAGE_DEFAULTS[key] as T;
  return lsGet<T>(key, fallback ?? ('' as unknown as T));
}

export function normalizeAlertPrefs(value: unknown): AlertPrefs {
  const raw = (value && typeof value === 'object') ? value as Partial<AlertPrefs> : {};
  const budgetThreshold = raw.budgetThreshold === null
    ? null
    : (typeof raw.budgetThreshold === 'number' && raw.budgetThreshold >= 0 && raw.budgetThreshold <= 1
      ? raw.budgetThreshold
      : 0.8);

  return {
    budgetThreshold,
    browserNotificationsEnabled: raw.browserNotificationsEnabled === true,
    lastNotifiedAlertKeys: Array.isArray(raw.lastNotifiedAlertKeys)
      ? raw.lastNotifiedAlertKeys.filter((key: unknown): key is string => typeof key === 'string')
      : []
  };
}

// ==========================================
// LOCALSTORAGE HELPERS
// ==========================================

/**
 * Get value from localStorage with fallback
 */
export function lsGet<T>(key: string, fallback: T): T {
  return safeStorage.getJSON(key, fallback);
}

/**
 * Set value in localStorage
 */
export function lsSet(key: string, val: unknown): boolean {
  return safeStorage.setJSON(key, val);
}

/**
 * Persist helper - shorthand for lsSet
 * Returns false if storage write failed (e.g. quota exceeded)
 */
export function persist(key: string, val: unknown): boolean {
  return lsSet(key, val);
}

// ==========================================
// SESSION STATE
// ==========================================

// dismissedAlerts has been moved to signals.ts as a reactive signal.
// Import from '../core/signals.js' instead.
