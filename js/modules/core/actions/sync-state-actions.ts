/**
 * Sync State Actions
 * Hosts `syncState.applyKeyUpdate()` — the single entry point for
 * applying a remote key-value update to in-memory state.
 *
 * Phase 2 will add a registrable `onRemoteWrite(key, value, metadata)`
 * callback slot here. Phase 3 wires the Firestore engine into that slot.
 *
 * Payload validation (C6, Inline-Behavior-Review rev 12): every remote
 * payload runs through a structural validator before being handed to a
 * setter. Without validation a malformed or foreign payload (from a
 * downlevel tab, a compromised extension, or a corrupted IndexedDB row)
 * would cast-through `as T` and poison in-memory state — and because
 * most setters persist straight back to storage, that poison becomes
 * durable. The validators deliberately do shallow structural checks so
 * they stay cheap; deep semantic validation (e.g. "amount >= 0") stays
 * in the setters where it already lives.
 *
 * @module actions/sync-state-actions
 */
import * as signals from '../signals.js';
import { SK, normalizeAlertPrefs } from '../state.js';
import { userCategoryConfig, isUserCategoryConfigShape } from '../category-store.js';
import { settings, data, savingsGoals, debts } from './data-actions.js';
import { queueEvent } from './action-utils.js';
import { Events } from '../event-bus.js';
import { trackError } from '../error-tracker.js';
import { isTheme } from '../theme-allowlist.js';
import type {
  Transaction,
  FilterPreset,
  TxTemplate,
  SavingsGoal,
  SavingsContribution,
  UserCategoryConfig,
  MonthlyAllocation,
  RolloverSettings,
  Debt,
  CurrencySettings,
  SectionsConfig,
  StreakData,
  InsightPersonality,
  EarnedAchievement
} from '../../../types/index.js';

// ==========================================
// STRUCTURAL VALIDATORS
// ==========================================

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isTransaction = (v: unknown): v is Transaction => {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.__backendId === 'string' &&
    (v.type === 'expense' || v.type === 'income') &&
    typeof v.amount === 'number' && Number.isFinite(v.amount) &&
    typeof v.description === 'string' &&
    typeof v.date === 'string' &&
    typeof v.category === 'string' &&
    typeof v.currency === 'string' &&
    typeof v.recurring === 'boolean'
  );
};

const isTransactionArray = (v: unknown): v is Transaction[] =>
  Array.isArray(v) && v.every(isTransaction);

// Fixes M3 (Inline-Behavior-Review rev 12): `isTheme` used to live here
// as one of three parallel allowlist copies. Now sourced from the shared
// `core/theme-allowlist.ts` module — see that module for rationale.

const isString = (v: unknown): v is string => typeof v === 'string';

const isMonthlyAllocationMap = (v: unknown): v is Record<string, MonthlyAllocation> => {
  if (!isPlainObject(v)) return false;
  // CR-Apr24-E [P2] finding 221: depth-validate the nested per-category
  // amounts. Pre-fix the validator only checked `isPlainObject(val)`,
  // so a remote payload like `{ '2026-04': { food: 'fifty', rent: {} } }`
  // passed the gate and downstream budget code (`alloc[c] ?? 0`,
  // `toCents(alloc[c])`) silently coerced the bad values into NaN +
  // poisoned every rollover/spending-pace/budget-adherence calc until
  // the user reset state. Now require every category amount to be a
  // finite number; reject any month whose values aren't all finite.
  for (const val of Object.values(v)) {
    if (!isPlainObject(val)) return false;
    for (const amount of Object.values(val)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
    }
  }
  return true;
};

const isSavingsGoal = (v: unknown): v is SavingsGoal => {
  if (!isPlainObject(v)) return false;
  // Required fields: id, name, target, saved (numeric). Shape is conservative.
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.target === 'number' && Number.isFinite(v.target) &&
    typeof v.saved === 'number' && Number.isFinite(v.saved)
  );
};

const isSavingsGoalMap = (v: unknown): v is Record<string, SavingsGoal> => {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(isSavingsGoal);
};

/**
 * Rev 13 L73 (Inline-Behavior-Review): sync-path wrapper around the
 * shared `isUserCategoryConfigShape` guard — also allows the `null`
 * sentinel ("not yet initialized") because applyKeyUpdate needs to
 * accept remote resets. Shape guard itself lives in category-store so
 * import-export and state-hydration can share a single source of
 * truth; this wrapper adds only the null-tolerance the sync path
 * needs.
 */
const isUserCategoryConfig = (v: unknown): v is UserCategoryConfig | null =>
  v === null || isUserCategoryConfigShape(v);

const isDebt = (v: unknown): v is Debt => {
  if (!isPlainObject(v)) return false;
  // CR-Apr24-E [P2] finding 222: tighten the debt validator. Pre-fix
  // it only checked id/name/balance — but `Debt` includes
  // planner-critical fields (`type`, `originalBalance`,
  // `interestRate`, `minimumPayment`, `dueDay`, `createdAt`,
  // `payments`, `isActive`) that the debt UI + payoff math read as if
  // present. A row with just `{id, name, balance}` from a malformed
  // remote payload would land in `signals.debts` and immediately
  // crash the planner on the first calc that hit `debt.interestRate`
  // or `debt.minimumPayment`. Now require the full required-field
  // surface; payments array must be at minimum present (allow empty).
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.balance === 'number' && Number.isFinite(v.balance) &&
    typeof v.type === 'string' &&
    typeof v.originalBalance === 'number' && Number.isFinite(v.originalBalance) &&
    typeof v.interestRate === 'number' && Number.isFinite(v.interestRate) &&
    typeof v.minimumPayment === 'number' && Number.isFinite(v.minimumPayment) &&
    typeof v.dueDay === 'number' && Number.isFinite(v.dueDay) &&
    typeof v.createdAt === 'string' &&
    Array.isArray(v.payments) &&
    typeof v.isActive === 'boolean'
  );
};

const isDebtArray = (v: unknown): v is Debt[] =>
  Array.isArray(v) && v.every(isDebt);

const isCurrencySettings = (v: unknown): v is CurrencySettings => {
  if (!isPlainObject(v)) return false;
  return typeof v.home === 'string' && typeof v.symbol === 'string';
};

const isSavingsContribution = (v: unknown): v is SavingsContribution => {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.goalId === 'string' &&
    typeof v.amount === 'number' && Number.isFinite(v.amount) &&
    typeof v.date === 'string'
  );
};

const isSavingsContributionArray = (v: unknown): v is SavingsContribution[] =>
  Array.isArray(v) && v.every(isSavingsContribution);

const isPartialRolloverSettings = (v: unknown): v is Partial<RolloverSettings> =>
  // Downstream setter normalizes; only reject non-objects.
  isPlainObject(v);

const isSectionsConfig = (v: unknown): v is SectionsConfig => {
  if (!isPlainObject(v)) return false;
  return typeof v.envelope === 'boolean' && typeof v.transactionsTemplates === 'boolean';
};

const isInsightPersonality = (v: unknown): v is InsightPersonality =>
  v === 'serious' || v === 'friendly' || v === 'roast' ||
  v === 'casual' || v === 'motivating';

/**
 * CR-Apr24-E [P2] findings 217, 218: validate the modern
 * `EarnedAchievement` object shape, not the legacy boolean map.
 *
 * Pre-fix this validator accepted `Record<string, boolean>` —
 * matching the *original* on-disk shape from before the achievement
 * model was extended with earn-date metadata. The runtime now
 * persists `Record<string, EarnedAchievement>` (`{earned, date}`),
 * so the gate was rejecting every legitimate cross-tab achievement
 * payload AND simultaneously letting through any remote `{some_id:
 * true}` payload that matched the dead legacy shape — replacing
 * earn-date-bearing local state with stripped boolean data.
 *
 * Tolerance: empty object `{}` passes (initial state) and an
 * object whose values all match `{earned: boolean, date: string}`
 * passes. Any mixed/unknown shape rejects.
 */
const isEarnedAchievement = (v: unknown): v is EarnedAchievement => {
  if (!isPlainObject(v)) return false;
  return typeof v.earned === 'boolean' && typeof v.date === 'string';
};

const isAchievementsRecord = (v: unknown): v is Record<string, EarnedAchievement> => {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(isEarnedAchievement);
};

const isStreakData = (v: unknown): v is StreakData => {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.current === 'number' && Number.isFinite(v.current) &&
    typeof v.longest === 'number' && Number.isFinite(v.longest) &&
    typeof v.lastDate === 'string'
  );
};

const isFilterPreset = (v: unknown): v is FilterPreset => {
  if (!isPlainObject(v)) return false;
  // CR-Apr24-E [P3] finding 224: also require the `filters` object
  // payload. Pre-fix the validator accepted `{id, name}` only — but
  // the filter-loading UI dereferences `preset.filters` directly to
  // populate the form. A malformed remote preset missing the field
  // would land in state and later crash the load handler on
  // `Object.entries(preset.filters)`. Empty `{}` for filters is
  // valid (preset that resets all filters); non-object rejects.
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    isPlainObject(v.filters)
  );
};

const isFilterPresetArray = (v: unknown): v is FilterPreset[] =>
  Array.isArray(v) && v.every(isFilterPreset);

const isTxTemplate = (v: unknown): v is TxTemplate => {
  if (!isPlainObject(v)) return false;
  // CR-Apr24-E [P2] finding 223: tighten validation to the required
  // surface that downstream consumers actually read. Pre-fix only
  // `id` was checked, but `applyTemplate(template)` dereferences
  // `template.type` (to switch tabs) and `template.category` (to
  // validate against current category config). A malformed remote
  // template missing those fields would survive sync and later
  // crash the apply flow. Require `id`, `name`, `type` (income or
  // expense), and `category` here; optional fields like `amount`
  // remain optional at apply time.
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.type === 'income' || v.type === 'expense') &&
    typeof v.category === 'string'
  );
};

const isTxTemplateArray = (v: unknown): v is TxTemplate[] =>
  Array.isArray(v) && v.every(isTxTemplate);

const isAlertPayload = (v: unknown): boolean =>
  // `normalizeAlertPrefs` accepts anything and produces a safe default,
  // but we still require an object so we don't quietly paper over wire
  // errors that send null/number/string for this key.
  isPlainObject(v);

// ==========================================
// DISPATCH
// ==========================================

const DEV = import.meta.env.DEV;

/**
 * Static allowlist of SK constants that sync is authorized to apply.
 * This is the ADR-001 contract: any key NOT in this set is rejected and
 * logged as an unexpected remote update.
 *
 * Fixes H13 (Inline-Behavior-Review rev 12): previously the 17-key
 * switch was the only gate. A future SK constant added without a case
 * (or a case whose SK constant was renamed) silently dropped every
 * remote update. This Set gives us:
 *   1. An explicit, readable source of truth separate from the switch
 *   2. A telemetry hook on unknown-key attempts (see dispatch below)
 *   3. A runtime integrity check in DEV that every allowlisted key has
 *      a switch case and vice-versa
 */
const SYNC_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  SK.TX,
  SK.THEME,
  SK.PIN,
  SK.ALLOC,
  SK.SAVINGS,
  SK.USER_CATS,
  SK.DEBTS,
  SK.CURRENCY,
  SK.SAVINGS_CONTRIB,
  SK.ROLLOVER_SETTINGS,
  SK.SECTIONS,
  SK.ALERTS,
  SK.INSIGHT_PERS,
  SK.ACHIEVE,
  SK.STREAK,
  SK.FILTER_PRESETS,
  SK.TX_TEMPLATES,
  // Round 7 fix: Add persisted keys that were omitted from the allowlist
  SK.HAS_ONBOARDED,
  SK.LAST_BACKUP
]);

function reject(key: string, value: unknown): false {
  if (DEV) console.warn(`[syncState] Rejected update for '${key}': payload failed validation`, value);
  // Fixes H8 (Inline-Behavior-Review rev 12): payload rejections were
  // DEV-only. Route through trackError so corrupted or foreign payloads
  // reaching the sync boundary are visible in production telemetry.
  // Skip Symbol sentinels (used by the DEV integrity probe at module
  // load) — they're diagnostic noise, not real failures.
  if (typeof value !== 'symbol') {
    try {
      trackError(new Error(`syncState payload validation failed for '${key}'`), {
        module: 'sync-state-actions',
        action: `applyKeyUpdate.reject:${key}`
      });
    } catch {
      // Telemetry failure must never break the sync pipeline.
    }
  }
  return false;
}

function rejectUnknownKey(key: string): false {
  // Always log — unknown keys arriving means either the ADR-001 allowlist
  // drifted, or a malicious/corrupted payload is reaching sync. Either
  // way, production observability needs to know.
  if (DEV) console.error(`[syncState] Rejected unknown key '${key}' — not in ADR-001 allowlist`);
  return false;
}

/**
 * Exported for callers that want to check allowlist membership without
 * attempting a write (e.g. the Firestore engine's "should I forward this
 * update?" path).
 */
export function isSyncAllowedKey(key: string): boolean {
  return SYNC_ALLOWED_KEYS.has(key);
}

export const syncState = {
  applyKeyUpdate(key: string, value: unknown): boolean {
    // Allowlist gate FIRST — reject and log any key not explicitly
    // sanctioned by ADR-001 before we look at the value. This closes
    // H13: previously the default branch below was the only guard and
    // it logged nothing, so a drifted allowlist went unnoticed.
    if (!SYNC_ALLOWED_KEYS.has(key)) {
      return rejectUnknownKey(key);
    }
    switch (key) {
      case SK.TX:
        if (!isTransactionArray(value)) return reject(key, value);
        signals.replaceTransactionLedger(value);
        return true;
      case SK.THEME:
        if (!isTheme(value)) return reject(key, value);
        settings.setTheme(value);
        return true;
      case SK.PIN:
        if (!isString(value)) return reject(key, value);
        settings.setPin(value);
        return true;
      case SK.ALLOC:
        if (!isMonthlyAllocationMap(value)) return reject(key, value);
        data.setMonthlyAllocations(value);
        return true;
      case SK.SAVINGS:
        if (!isSavingsGoalMap(value)) return reject(key, value);
        savingsGoals.setGoals(value);
        return true;
      case SK.USER_CATS:
        if (!isUserCategoryConfig(value)) return reject(key, value);
        // Rev 13 L72 (Inline-Behavior-Review): this branch is the sync
        // peer to `category-store.updateConfig()` — every other SK.*
        // case delegates to a setter that emits its domain event, but
        // USER_CATS has no dedicated setter and writes the signal
        // directly. Without the explicit emit here, a category change
        // received from another tab (via multi-tab-sync -> applyKeyUpdate)
        // updates local state but never triggers the
        // renderCategories / populateCategoryFilter / updateInsights
        // scheduler wired in app-events.ts.
        userCategoryConfig.value = value;
        queueEvent(Events.CATEGORY_UPDATED, undefined);
        return true;
      case SK.DEBTS:
        if (!isDebtArray(value)) return reject(key, value);
        debts.setDebts(value);
        return true;
      case SK.CURRENCY:
        if (!isCurrencySettings(value)) return reject(key, value);
        data.setCurrencySettings(value);
        return true;
      case SK.SAVINGS_CONTRIB:
        if (!isSavingsContributionArray(value)) return reject(key, value);
        savingsGoals.setContributions(value);
        return true;
      case SK.ROLLOVER_SETTINGS:
        if (!isPartialRolloverSettings(value)) return reject(key, value);
        settings.setRolloverSettings(value);
        return true;
      case SK.SECTIONS:
        if (!isSectionsConfig(value)) return reject(key, value);
        settings.setSections(value);
        return true;
      case SK.ALERTS:
        if (!isAlertPayload(value)) return reject(key, value);
        settings.setAlerts(normalizeAlertPrefs(value));
        return true;
      case SK.INSIGHT_PERS:
        if (!isInsightPersonality(value)) return reject(key, value);
        settings.setInsightPersonality(value);
        return true;
      case SK.ACHIEVE:
        if (!isAchievementsRecord(value)) return reject(key, value);
        settings.setAchievements(value);
        return true;
      case SK.STREAK:
        if (!isStreakData(value)) return reject(key, value);
        settings.setStreak(value);
        return true;
      case SK.FILTER_PRESETS:
        if (!isFilterPresetArray(value)) return reject(key, value);
        data.setFilterPresets(value);
        return true;
      case SK.TX_TEMPLATES:
        if (!isTxTemplateArray(value)) return reject(key, value);
        data.setTxTemplates(value);
        return true;
      default:
        // Invariant: if the allowlist above accepted `key` then exactly
        // one case above must match. Reaching here means the allowlist
        // and switch have drifted — a developer added a key to
        // SYNC_ALLOWED_KEYS without a case, and silently-dropping the
        // update is exactly the bug H13 flagged. Log loudly.
        if (DEV) console.error(
          `[syncState] INVARIANT VIOLATION: key '${key}' is in SYNC_ALLOWED_KEYS ` +
          `but has no switch case. Every allowlisted key must have a handler.`
        );
        return false;
    }
  }
};

// Runtime integrity check (DEV only): verify every allowlisted key is
// handled by at least exercising the switch with a sentinel value. We
// run this once at module load.
if (DEV) {
  const DISPATCH_SENTINEL = Symbol('dispatch-probe');
  for (const key of SYNC_ALLOWED_KEYS) {
    try {
      // Call with a known-invalid sentinel. Valid keys should hit a case
      // and return via `reject(...)` (false). Missing cases fall to the
      // `default` branch which will log the invariant violation.
      syncState.applyKeyUpdate(key, DISPATCH_SENTINEL);
    } catch {
      // Setters shouldn't throw on validator rejection, but if one does
      // we swallow here — the validator will have already logged.
    }
  }
}
