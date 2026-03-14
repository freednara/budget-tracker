/**
 * State Management Module
 * Handles localStorage operations and storage keys.
 * Application state has been migrated to Preact Signals (see signals.ts).
 *
 * @module state
 */

import { safeStorage } from './error-handler.js';
import type { StorageKeys } from '../../types/index.js';

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
  DEBTS: 'budget_tracker_debts'
} as const;

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
 */
export function persist(key: string, val: unknown): void {
  lsSet(key, val);
}

// ==========================================
// SESSION STATE
// ==========================================

/**
 * Session-only dismissed alerts (not persisted to localStorage)
 */
export const dismissedAlerts: Set<string> = new Set();
