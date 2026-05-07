/**
 * State Hydration Service
 * 
 * Automated state hydration that maps storage keys to their corresponding signals.
 * Eliminates manual signal updates and prevents data loss during imports.
 */

import { SK, lsGet, normalizeAlertPrefs, normalizeSavingsGoalsRecord, BACKUP_REMINDER_TX_COUNT_KEY } from './state.js';
import * as signals from './signals.js';
import { safeStorage } from './safe-storage.js';
import { initCategoryStore, isUserCategoryConfigShape, userCategoryConfig } from './category-store.js';
import { batch, type Signal } from '@preact/signals-core';
import { invalidateAllCache } from './monthly-totals-cache.js';
import { trackError } from './error-tracker.js';
import { normalizeTheme } from './theme-allowlist.js';
// CR-Apr22-F slice 1: SK.RECURRING is storage-backed but not signal-backed
// (the recurring-templates module owns a local `Map<string,
// RecurringTemplate>` rehydrated from storage). When an import writes
// SK.RECURRING via the atomic-write pipeline, the in-memory map is left
// stale until the next boot unless we explicitly reload it here, which
// would silently break "restore a backup + immediately create another
// recurring occurrence" and every scheduler read until reload. Keep the
// map in lock-step by calling `loadRecurringTemplates()` after the
// hydration batch closes, just like `initCategoryStore` does for the
// category store in the absent-`userCategories` branch below.
import { loadRecurringTemplates } from '../data/recurring-templates.js';
import type { Transaction, UserCategoryConfig } from '../../types/index.js';

// ==========================================
// VALIDATORS
// ==========================================

// Fixes L37 (Inline-Behavior-Review rev 12) — the THEME mapping used to
// `identity<Theme>()`, so a corrupted `__theme__` payload (e.g. a number
// from an unrelated key collision, or `null`) would flow straight into
// `signals.theme.value` and poison every downstream `setTheme()` derivation.
// The shared `normalizeTheme` clamps to the declared `'dark' | 'light' |
// 'system'` union and defaults to `'dark'` on anything else.
//
// Fixes M3 (Inline-Behavior-Review rev 12): the local `SUPPORTED_THEMES` +
// `normalizeTheme` used to live here as one of three parallel copies of
// the allowlist (sync-state-actions `isTheme`, auto-backup
// `SUPPORTED_BACKUP_THEMES`). Consolidated into `core/theme-allowlist.ts`
// so the Theme union has exactly one place to update; see that module for
// full rationale.

/**
 * Fixes L36 (Inline-Behavior-Review rev 12): `Number(raw) || 0` masked
 * NaN *and* 0 as "never backed up". If storage held a legitimate 0 (never
 * actually backed up yet) vs. garbage ("foo", null, {}), both collapsed
 * into the same 0 path with no telemetry. Explicit `Number.isFinite` lets
 * malformed payloads surface as "never" while preserving real 0, and
 * keeps the signal invariant: finite number or 0, never NaN / Infinity.
 */
function normalizeLastBackup(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * CR-Apr24-I finding 196: stricter normalizer for the backup-reminder
 * transaction counter — clamps to a non-negative integer, matching the
 * contract `normalizeLastBackupTxCount` enforces in the manual import
 * path. `normalizeLastBackup` allows negatives and fractions, which is
 * fine for timestamps but not for a count.
 */
function normalizeLastBackupTxCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Rev 13 L73 (Inline-Behavior-Review): the previous SK.USER_CATS mapping
 * used `identity<UserCategoryConfig | null>()`, which trusted import /
 * backup payloads end-to-end. A corrupted `{userCategories: {foo: 1}}`
 * would hydrate as-is and the next `config.expense.filter(...)` call
 * downstream (category-store.ts line ~538, getEnabledExpenseCategories)
 * would throw because `.expense` is missing. The transformer now
 * delegates to the shared shape guard and treats any failure as a
 * typed hydration failure — `hydrateFromImport` catches it, accumulates
 * it into `failed[]`, and the user sees the partial-restore warning
 * rather than a corrupted in-memory config.
 */
function normalizeUserCategories(raw: unknown): UserCategoryConfig | null {
  if (raw === null || raw === undefined) return null;
  if (isUserCategoryConfigShape(raw)) return raw;
  throw new Error('userCategories payload failed structural validation');
}

// ==========================================
// SIGNAL MAPPING REGISTRY
// ==========================================

/**
 * Fixes H5 (Inline-Behavior-Review rev 12): SIGNAL_MAPPINGS used to be
 * `{[SK.X]: {signal, transformer: (raw: unknown) => raw as <typeof signal.value>}}`
 * which forced every read site (`hydrateAllSignals`, `hydrateFromImport`,
 * `getHydrationStats`, `debugSignalState`) to escape with
 * `(mapping.signal as any).value = ...` and `(SIGNAL_MAPPINGS as any)[key]`.
 * The compiler had no way to enforce that a key's transformer output type
 * matched its signal's input type — a `(value as Foo)` regression in any
 * row would silently push the wrong shape into a signal with zero signal.
 *
 * The fix is a generic `SignalMapping<T>` plus a `mapping<T>(signal, fn)`
 * helper that ties the signal's value type and the transformer's return
 * type together at the construction site. The registry is then typed as a
 * record of `SignalMapping<unknown>` for uniform iteration, which is sound
 * because for every row "transformer output → signal write" stays inside
 * the same closed T (each entry was built by `mapping<T>` with a single T).
 */
interface SignalMapping<T> {
  readonly signal: Signal<T>;
  readonly transformer: (raw: unknown) => T;
}

function mapping<T>(
  signal: Signal<T>,
  transformer: (raw: unknown) => T
): SignalMapping<T> {
  return { signal, transformer };
}

/**
 * Identity transformer factory. Used when storage already contains values
 * structurally identical to the signal's type (the common case). Centralizes
 * the one remaining `as T` so it's labeled and grep-able instead of strewn
 * across 13 call sites.
 *
 * Concrete shape validation belongs in the C6 `applyKeyUpdate` validators
 * (see sync-state-actions.ts), not here — hydration's job is to map raw
 * storage to typed signals; rejecting bad payloads is the validator's job.
 */
function identity<T>(): (raw: unknown) => T {
  return (raw) => raw as T;
}

/**
 * Maps storage keys to their corresponding signals and transformers.
 * FIXED: Removed SK.TX from here as it's correctly handled by DataManager.init().
 */
const SIGNAL_MAPPINGS: Readonly<Record<string, SignalMapping<unknown>>> = {
  // Fixes H7: route the savings record through normalizeSavingsGoalsRecord
  // so the in-memory signal is always canonical {target, saved} shape, even
  // when storage still holds pre-refactor {target_amount, saved_amount}
  // entries. This makes the LegacySavingsGoal double-cast elsewhere obsolete.
  [SK.SAVINGS]: mapping(signals.savingsGoals, (value) => normalizeSavingsGoalsRecord(value)),
  [SK.SAVINGS_CONTRIB]: mapping(signals.savingsContribs, identity<typeof signals.savingsContribs.value>()),
  [SK.CURRENCY]: mapping(signals.currency, identity<typeof signals.currency.value>()),
  [SK.USER_CATS]: mapping(userCategoryConfig, normalizeUserCategories),
  [SK.ALLOC]: mapping(signals.monthlyAlloc, identity<typeof signals.monthlyAlloc.value>()),
  [SK.DEBTS]: mapping(signals.debts, identity<typeof signals.debts.value>()),
  [SK.ROLLOVER_SETTINGS]: mapping(signals.rolloverSettings, identity<typeof signals.rolloverSettings.value>()),
  [SK.ALERTS]: mapping(signals.alerts, (value) => normalizeAlertPrefs(value)),
  [SK.ACHIEVE]: mapping(signals.achievements, identity<typeof signals.achievements.value>()),
  [SK.STREAK]: mapping(signals.streak, identity<typeof signals.streak.value>()),
  [SK.INSIGHT_PERS]: mapping(signals.insightPers, identity<typeof signals.insightPers.value>()),
  [SK.FILTER_PRESETS]: mapping(signals.filterPresets, identity<typeof signals.filterPresets.value>()),
  [SK.TX_TEMPLATES]: mapping(signals.txTemplates, identity<typeof signals.txTemplates.value>()),
  [SK.LAST_BACKUP]: mapping(signals.lastBackup, normalizeLastBackup),
  // L89 (Inline-Behavior-Review): register the backup-reminder tx-count
  // key so the manual JSON import path can restore it through the same
  // hydrateFromImport → SIGNAL_MAPPINGS → signal write pipeline every
  // other state slice uses. Before this entry, `newS.lastBackupTxCount`
  // (written by buildImportState) hit `propertyToStorageKey`, found no
  // mapping, and was silently dropped by hydrateFromImport — so an
  // imported backup left `signals.lastBackupTxCount` untouched and the
  // "add N tx since last backup" nag fired from a stale counter.
  // CR-Apr24-I finding 196: use the stricter tx-count normalizer that
  // clamps to non-negative integers, not the timestamp normalizer.
  [BACKUP_REMINDER_TX_COUNT_KEY]: mapping(signals.lastBackupTxCount, normalizeLastBackupTxCount),
  [SK.SECTIONS]: mapping(signals.sections, identity<typeof signals.sections.value>()),
  [SK.THEME]: mapping(signals.theme, normalizeTheme),
  [SK.ONBOARD]: mapping(signals.onboarding, identity<typeof signals.onboarding.value>()),
  [SK.FILTER_EXPANDED]: mapping(signals.filtersExpanded, identity<typeof signals.filtersExpanded.value>())
};

// ==========================================
// HYDRATION SERVICE
// ==========================================

/**
 * Hydrate all signals from their corresponding storage values
 * CRITICAL FIX: Each signal hydration is wrapped independently in try-catch
 * to ensure partial failures don't prevent other signals from hydrating.
 * Tracks and logs failed hydrations with fallback values.
 */
export function hydrateAllSignals(): void {
  const failedSignals: Array<{ key: string; error: Error }> = [];

  batch(() => {
    for (const [storageKey, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
      // Wrap each signal hydration in its own try-catch
      try {
        const storedValue = safeStorage.getJSON(storageKey, undefined);

        if (storedValue !== undefined) {
          try {
            const transformedValue = mapping.transformer(storedValue);
            // Fixes H5: no cast needed — SignalMapping<T> ties
            // transformer output and signal input to the same T.
            mapping.signal.value = transformedValue;
          } catch (transformError) {
            // Transformer failed - track and use current signal value as fallback
            const err = transformError instanceof Error ? transformError : new Error(String(transformError));
            failedSignals.push({ key: storageKey, error: err });
            trackError(err, { module: 'StateHydration', action: `transform_${storageKey}` });
            if (import.meta.env.DEV) {
              console.warn(`Transformer failed for ${storageKey}, keeping existing signal value:`, transformError);
            }
          }
        }
      } catch (storageError) {
        // Storage read failed - track but continue with next signal
        const err = storageError instanceof Error ? storageError : new Error(String(storageError));
        failedSignals.push({ key: storageKey, error: err });
        trackError(err, { module: 'StateHydration', action: `read_${storageKey}` });
        if (import.meta.env.DEV) {
          console.warn(`Storage read failed for ${storageKey}:`, storageError);
        }
      }
    }
  });

  // Log summary of failures if any occurred
  if (failedSignals.length > 0) {
    if (import.meta.env.DEV) {
      console.error(
        `Signal hydration completed with ${failedSignals.length} failure(s):`,
        failedSignals.map(f => `${f.key} - ${f.error.message}`)
      );
    }
  }
}

/**
 * Hydrate signals from import state data
 * @param importData - The imported state data object
 * @param transactions - The authoritative imported transaction ledger when available
 * FIXED: Uses batch() for atomic consistency
 */
/**
 * Per-key failure record returned by `hydrateFromImport` so callers can
 * surface a user-visible "imported X of Y sections" message.
 */
export interface ImportHydrationFailure {
  /** Property name from the import file (e.g. `savingsGoals`). */
  propertyName: string;
  /** Storage key backing that property (e.g. `SK.SAVINGS`). */
  storageKey: string;
  /** The transformer error. */
  error: Error;
}

export interface ImportHydrationResult {
  attempted: number;
  succeeded: number;
  failed: ImportHydrationFailure[];
}

/** Keys the import path treats as critical — failure here should be
 *  surfaced loudly even relative to other keys. */
const CRITICAL_IMPORT_KEYS: ReadonlySet<string> = new Set([
  SK.SAVINGS,
  SK.ALLOC,
  SK.DEBTS
]);

export function hydrateFromImport(
  importData: Record<string, unknown>,
  transactions?: Transaction[]
): ImportHydrationResult {
  const hasImportedUserCategories = Object.prototype.hasOwnProperty.call(importData, 'userCategories');

  // Build reverse mapping: property name -> storage key
  const propertyToStorageKey: Record<string, string> = {
    savingsGoals: SK.SAVINGS,
    savingsContribs: SK.SAVINGS_CONTRIB,
    currency: SK.CURRENCY,
    userCategories: SK.USER_CATS,
    monthlyAlloc: SK.ALLOC,
    debts: SK.DEBTS,
    rolloverSettings: SK.ROLLOVER_SETTINGS,
    alerts: SK.ALERTS,
    achievements: SK.ACHIEVE,
    streak: SK.STREAK,
    insightPers: SK.INSIGHT_PERS,
    filterPresets: SK.FILTER_PRESETS,
    txTemplates: SK.TX_TEMPLATES,
    lastBackup: SK.LAST_BACKUP,
    lastBackupTxCount: BACKUP_REMINDER_TX_COUNT_KEY,
    sections: SK.SECTIONS,
    theme: SK.THEME,
    onboarding: SK.ONBOARD,
    filtersExpanded: SK.FILTER_EXPANDED
  };

  // Fixes H18 (Inline-Behavior-Review rev 12): the import path now
  // mirrors the boot path's telemetry contract. Failures are accumulated,
  // trackError'd unconditionally, and returned to the caller so the
  // import-UI can surface "N of M sections restored" rather than
  // silently dropping corrupted keys.
  let attempted = 0;
  let succeeded = 0;
  const failed: ImportHydrationFailure[] = [];

  batch(() => {
    for (const [propertyName, value] of Object.entries(importData)) {
      const storageKey = propertyToStorageKey[propertyName];

      if (storageKey && value !== undefined) {
        // Fixes H5: lookup returns a well-typed SignalMapping<unknown>
        // (or undefined). No cast. Transformer output and signal input
        // share the same T per-entry by construction.
        const mapping = SIGNAL_MAPPINGS[storageKey];

        if (mapping) {
          attempted++;
          try {
            const transformedValue = mapping.transformer(value);
            mapping.signal.value = transformedValue;
            succeeded++;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            failed.push({ propertyName, storageKey, error: err });
            const critTag = CRITICAL_IMPORT_KEYS.has(storageKey) ? '.critical' : '';
            trackError(err, {
              module: 'StateHydration',
              action: `import_${storageKey}${critTag}`
            });
            if (import.meta.env.DEV) {
              console.warn(`Failed to hydrate signal ${propertyName} from import:`, error);
            }
          }
        }
      }
    }
    invalidateAllCache();
    if (transactions) {
      signals.replaceTransactionLedger(transactions);
    }
  });

  if (!hasImportedUserCategories) {
    userCategoryConfig.value = null;
    initCategoryStore();
  }

  // CR-Apr22-F slice 1: rebuild the recurring-templates in-memory Map
  // whenever the import touched SK.RECURRING. `buildImportState` adds
  // `recurringTemplates` to `importData`/`newS` exactly when it pushed
  // an SK.RECURRING write (present payload in either mode, or absent
  // payload in overwrite mode — both valid rehydration triggers).
  // Merge mode with an absent payload skips both the storage write and
  // this reload, leaving the in-memory map untouched, which matches the
  // "no-op" semantics documented in `buildImportState`.
  if (Object.prototype.hasOwnProperty.call(importData, 'recurringTemplates')) {
    loadRecurringTemplates();
  }

  if (failed.length > 0 && import.meta.env.DEV) {
    console.warn(
      `[StateHydration] Import partial-failure: ${succeeded}/${attempted} sections restored. ` +
      `Failed: ${failed.map(f => f.propertyName).join(', ')}`
    );
  }

  return { attempted, succeeded, failed };
}

/**
 * Validate that all critical signals are properly hydrated
 * @returns Array of missing or invalid signal names
 */
export function validateSignalHydration(): string[] {
  const issues: string[] = [];

  // Check critical signals for proper initialization
  if (!Array.isArray(signals.transactions.value)) {
    issues.push('transactions signal not properly initialized');
  }

  if (!signals.currency.value || typeof signals.currency.value.symbol !== 'string') {
    issues.push('currency signal missing or invalid');
  }

  // Add more validation as needed for other critical signals

  return issues;
}

/**
 * Get statistics about current signal hydration
 */
export function getHydrationStats() {
  const totalMappings = Object.keys(SIGNAL_MAPPINGS).length;
  let hydratedCount = 0;
  let emptyCount = 0;

  for (const [, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
    // Fixes H5: mapping.signal is Signal<unknown> from the registry's
    // uniform iteration type, so `.value` is `unknown` — no cast needed.
    const currentValue: unknown = mapping.signal.value;

    if (currentValue !== undefined && currentValue !== null) {
      hydratedCount++;

      if (Array.isArray(currentValue) && currentValue.length === 0) {
        emptyCount++;
      } else if (typeof currentValue === 'object' && Object.keys(currentValue).length === 0) {
        emptyCount++;
      }
    }
  }

  return {
    totalMappings,
    hydratedCount,
    emptyCount,
    hydrationRate: hydratedCount / totalMappings
  };
}

// ==========================================
// DEBUGGING UTILITIES
// ==========================================

/**
 * Log the current state of all signals for debugging
 */
export function debugSignalState(): void {
  if (!import.meta.env.DEV) return;
  console.group('Signal Hydration Debug');

  for (const [storageKey, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
    // Fixes H5: Signal<unknown>.value is already `unknown` — no cast.
    const currentValue: unknown = mapping.signal.value;
    const storageValue = lsGet(storageKey as keyof typeof SK, undefined);

    console.log(`${storageKey}:`, {
      signalValue: currentValue,
      storageValue,
      synced: JSON.stringify(currentValue) === JSON.stringify(storageValue)
    });
  }

  console.groupEnd();
}

export default {
  hydrateAllSignals,
  hydrateFromImport,
  validateSignalHydration,
  getHydrationStats,
  debugSignalState
};
