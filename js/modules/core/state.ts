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
import type { AlertPrefs, SavingsGoal, StorageKeys } from '../../types/index.js';

// ==========================================
// STORAGE KEYS
// ==========================================

export const SK: StorageKeys = {
  TX: 'harbor_transactions',
  SAVINGS: 'harbor_savings_goals',
  ALLOC: 'harbor_monthly_allocations',
  THEME: 'harbor_theme',
  ACHIEVE: 'harbor_achievements',
  STREAK: 'harbor_streak',
  ONBOARD: 'harbor_onboarding',
  /** @deprecated Retained for migration.ts and category-store bootstrap. Use SK.USER_CATS for new code. */
  CUSTOM_CAT: 'harbor_custom_categories',
  CURRENCY: 'harbor_currency',
  SECTIONS: 'harbor_sections',
  PIN: 'harbor_pin',
  INSIGHT_PERS: 'harbor_insight_personality',
  ALERTS: 'harbor_alert_prefs',
  SAVINGS_CONTRIB: 'harbor_savings_contributions',
  LAST_BACKUP: 'harbor_last_backup',
  FILTER_PRESETS: 'harbor_filter_presets',
  TX_TEMPLATES: 'harbor_tx_templates',
  FILTER_EXPANDED: 'harbor_filter_expanded',
  ROLLOVER_SETTINGS: 'harbor_rollover_settings',
  DEBTS: 'harbor_debts',
  BUDGET_PLANS: 'harbor_budget_plans',
  ATTACHMENTS: 'harbor_attachments',
  USER_SETTINGS: 'harbor_user_settings',
  SYNC_STATE: 'harbor_sync_state',
  RECURRING: 'harbor_recurring',
  APP_STATS: 'harbor_app_stats',
  HAS_ONBOARDED: 'harbor_has_onboarded',
  USER_CATS: 'harbor_user_categories'
} as const;

/**
 * Storage key for the "transactions count at last backup" reminder counter.
 *
 * L89 (Inline-Behavior-Review): promoted from a bare string literal to a
 * named constant so the restoreMap, signal batcher, hydration registry, and
 * manual-export/import pipeline can all share a single typed reference —
 * previously a raw `'backup_reminder_last_tx_count'` literal that drifted
 * across five files (signals.ts × 2, auto-backup.ts, storage-registry.ts,
 * app-reset.test.ts). The key lives outside the `SK` object because it's
 * an app-owned non-`harbor_*` entry (per storage-registry.ts line 287);
 * adding it to the `StorageKeys` interface would break the "every SK entry
 * is `harbor_*`" convention that boot / reset sweeps rely on.
 *
 * Registered in `STORAGE_DEFAULTS` below with `0` so `getStored<number>()`
 * cold-boots to the canonical zero and so the restoreMap can derive the
 * overwrite default via `cloneCanonicalDefault()` like every other key.
 */
export const BACKUP_REMINDER_TX_COUNT_KEY = 'backup_reminder_last_tx_count' as const;

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
  [SK.SECTIONS]: { envelope: true, transactionsTemplates: false },
  [SK.PIN]: '',
  [SK.INSIGHT_PERS]: 'serious',
  [SK.ALERTS]: { budgetThreshold: 0.8, browserNotificationsEnabled: false, lastNotifiedAlertKeys: [] },
  [SK.ROLLOVER_SETTINGS]: { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' },
  [SK.FILTER_PRESETS]: [],
  [SK.TX_TEMPLATES]: [],
  [SK.THEME]: 'dark',
  [SK.ONBOARD]: { active: false, completed: false, step: 0 },
  [SK.LAST_BACKUP]: 0,
  [BACKUP_REMINDER_TX_COUNT_KEY]: 0,
  [SK.FILTER_EXPANDED]: false,
  // CR-Apr24-I findings 190, 201: BUDGET_PLANS, ATTACHMENTS,
  // USER_SETTINGS, SYNC_STATE, APP_STATS are dead keys with no live
  // readers/writers — removed from defaults to shrink the state surface.
  // SK enum entries kept for backward-compat with Object.values(SK) loops.
  // HAS_ONBOARDED is used by migration.ts — kept.
  [SK.RECURRING]: {},
  [SK.HAS_ONBOARDED]: false,
  [SK.USER_CATS]: null
};

/**
 * Get a stored value using the centralized default.
 * Prefer this over raw lsGet(SK.KEY, hardcodedDefault).
 *
 * Contract: either `defaultValue` is supplied by the caller OR the key
 * appears in `STORAGE_DEFAULTS`. If neither is true we throw instead of
 * silently coercing an empty string into `T` — that coercion masked real
 * key-registration bugs and let consumers of strongly-typed state (e.g.
 * signals hydrated with `getStored<SyncState>(SK.SYNC_STATE)`) receive
 * `""` at runtime while the typechecker still believed they held the
 * promised shape.
 *
 * Fixes C7 (Inline-Behavior-Review rev 12).
 */
export function getStored<T>(key: string, defaultValue?: T): T {
  const hasExplicitDefault = arguments.length >= 2;
  const hasRegistryDefault = Object.prototype.hasOwnProperty.call(STORAGE_DEFAULTS, key);

  if (hasExplicitDefault) {
    return lsGet<T>(key, defaultValue as T);
  }
  if (hasRegistryDefault) {
    return lsGet<T>(key, STORAGE_DEFAULTS[key] as T);
  }

  throw new Error(
    `getStored('${key}') has no default — either pass an explicit default ` +
    `or register the key in STORAGE_DEFAULTS. Refusing to coerce '' into T.`
  );
}

/**
 * Fixes H7 (Inline-Behavior-Review rev 12): the savings-goal store used
 * to hold a mix of two shapes — modern `{target, saved}` written by
 * `data-actions.addGoal`, and legacy `{target_amount, saved_amount}`
 * from pre-refactor data, migration, and imported backups. Every
 * consumer (achievements, insights, forecasts, UI components,
 * transaction-detail-panel) independently double-cast through
 * `LegacySavingsGoal` to read legacy field names — which meant that
 * newly-created goals silently failed those reads
 * (`undefined >= undefined` → false in achievements; 0/0 → 0% in
 * insights).
 *
 * This normalizer is the single migration boundary. Every entry point
 * that hydrates the savings-goals signal (state-hydration,
 * import-export) now funnels through `normalizeSavingsGoalsRecord`
 * so the in-memory store is canonical modern shape at all times.
 * After normalization, consumers can read `goal.target` / `goal.saved`
 * directly with no `as unknown as Record<string, LegacySavingsGoal>`
 * escape hatches — and the next persist call writes the canonical
 * shape back to storage, eroding the legacy tail with each app open.
 *
 * Rejects entries that are non-object or missing a usable `name`
 * (returns null) so callers can drop them rather than letting
 * structurally-invalid goals infect computed signals.
 */
export function normalizeSavingsGoal(raw: unknown, fallbackId: string): SavingsGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === 'string' ? r.name : '';
  if (!name) return null;

  // Prefer modern `{target, saved}`; fall back to legacy `{target_amount, saved_amount}`.
  const targetRaw = r.target ?? r.target_amount;
  const savedRaw = r.saved ?? r.saved_amount;
  const target = typeof targetRaw === 'number' && Number.isFinite(targetRaw) ? targetRaw : 0;
  const saved = typeof savedRaw === 'number' && Number.isFinite(savedRaw) ? savedRaw : 0;

  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : fallbackId;
  const result: SavingsGoal = { id, name, target, saved };

  if (typeof r.deadline === 'string' && r.deadline.length > 0) {
    result.deadline = r.deadline;
  }
  // Legacy `emoji` maps to modern `icon`.
  const iconRaw = r.icon ?? (r as { emoji?: unknown }).emoji;
  if (typeof iconRaw === 'string' && iconRaw.length > 0) {
    result.icon = iconRaw;
  }
  // CR-Apr22-G slice 3: preserve createdAt when present (YYYY-MM-DD form).
  // Legacy records lack this field — the starting-balance anchor fall-back
  // handles that case downstream. We only accept strings that look like a
  // date prefix so ISO timestamps or stray Date objects don't slip through.
  if (typeof r.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.createdAt)) {
    // Normalize to YYYY-MM-DD even if the stored value was a full ISO ts.
    result.createdAt = r.createdAt.slice(0, 10);
  }
  // CR-Apr22-G slice 3: preserve historicalNames when present and shaped
  // like a string array. Any non-string entries are filtered out so a
  // malformed backup can't corrupt the fallback-match set.
  if (Array.isArray(r.historicalNames)) {
    const names = r.historicalNames.filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length > 0) result.historicalNames = names;
  }
  return result;
}

/**
 * Normalize an entire savings-goals record. Drops entries that fail
 * per-entry normalization (structurally invalid / missing name).
 * Preserves the storage key as the record key and as the goal's `id`
 * when the goal itself has no id — that way `savingsContribs.goalId`
 * lookups keep matching after normalization.
 */
export function normalizeSavingsGoalsRecord(raw: unknown): Record<string, SavingsGoal> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SavingsGoal> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeSavingsGoal(value, key);
    if (normalized) out[key] = normalized;
  }
  return out;
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
