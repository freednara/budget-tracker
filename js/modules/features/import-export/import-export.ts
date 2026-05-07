/**
 * Import/Export Module
 *
 * Data import validation, export builders, and atomic writes.
 *
 * @module import-export
 */
'use strict';

import { SK, STORAGE_DEFAULTS, normalizeAlertPrefs, normalizeSavingsGoal, BACKUP_REMINDER_TX_COUNT_KEY } from '../../core/state.js';
import { normalizeDueDay } from '../financial/debt-planner.js';
import { safeStorage } from '../../core/safe-storage.js';
// CR-Apr22-F slice 1: the manual JSON export/import path now ships the
// SK.RECURRING template set end-to-end. Prior to this fix, a "full"
// backup was missing recurring-template definitions entirely — importing
// on another device restored the already-materialized transactions but
// silently lost the series that should keep producing future occurrences.
// The module-level RecurringTemplate type + the shared validator set +
// date predicate come from `data/recurring-templates.ts`; keeping them in
// that file's namespace lets the update/seed/restore paths all enforce
// one schema.
import {
  VALID_RECURRING_TYPES,
  isValidYmd,
  type RecurringTemplate
} from '../../data/recurring-templates.js';
import * as signals from '../../core/signals.js';
import { userCategoryConfig, buildConfigFromLegacyCustom, isUserCategoryConfigShape } from '../../core/category-store.js';
import { CURRENCY_MAP, parseAmount, generateId, toCents } from '../../core/utils-pure.js';
import { emit, Events } from '../../core/event-bus.js';
import { validator } from '../../core/validator.js';
import { trackError } from '../../core/error-tracker.js';
import type {
  Transaction,
  SavingsGoal,
  SavingsContribution,
  Debt,
  CurrencySettings,
  StreakData,
  AlertPrefs,
  RolloverSettings,
  FilterPreset,
  TxTemplate,
  InsightPersonality,
  UserCategoryConfig,
  CustomCategory,
  SectionsConfig
} from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

/**
 * A single transaction row rejected by `sanitizeImportedTransactions`.
 *
 * Fixes M12 (Inline-Behavior-Review rev 12). Previously this shape was
 * internal — rejections were silently dropped and the sanitizer returned
 * only the surviving `Transaction[]`. The reviewer flagged the partial-
 * failure-destruction pattern: the caller has no way to tell "imported all
 * 1000 rows successfully" from "silently dropped 200 of 1000." Exported
 * alongside the `SanitizedImportResult` return shape so the caller can
 * surface the count + per-row reasons to the user and to telemetry.
 *
 * `index` is the zero-based offset into the original `incoming` array —
 * useful for UI click-through to "row 347 — invalid date" and for logs.
 */
export interface RejectedImportRecord {
  index: number;
  reason: string;
}

/**
 * Return shape of `sanitizeImportedTransactions` (M12, rev 12).
 *
 * - `accepted`  — the surviving rows, each stamped with a de-duplicated
 *                 `__backendId`. Semantically identical to the prior
 *                 `Transaction[]` return.
 * - `rejected`  — per-row rejection records (index + aggregated reason
 *                 string). Empty array is the "nothing dropped" signal.
 *
 * Callers MUST pass `rejected` through `reportImportValidationRejections`
 * (or an equivalent surfacing call) before displaying a success toast —
 * otherwise the partial-failure information is destroyed at the next
 * function boundary, exactly the hazard M12 was written to close.
 */
export interface SanitizedImportResult {
  accepted: Transaction[];
  rejected: RejectedImportRecord[];
}


interface AtomicWriteEntry {
  key: string;
  value: unknown;
}

interface ImportData {
  version?: string;
  transactions?: unknown[];
  /**
   * CR-Apr22-F slice 1: SK.RECURRING template set in storage shape
   * (object keyed by template id). `unknown` because the shape of every
   * individual row is re-validated row-by-row during
   * `buildImportState` — letting the compiler assume `Record<string,
   * RecurringTemplate>` at the import boundary would silently accept
   * any junk that happened to parse as JSON and feed it to the scheduler
   * without the validator gate the in-place update path enforces.
   */
  recurringTemplates?: unknown;
  savingsGoals?: Record<string, unknown>;
  savingsContributions?: unknown[];
  currency?: unknown;
  achievements?: Record<string, unknown>;
  streak?: unknown;
  sections?: { envelope?: boolean };
  insightPersonality?: string;
  filterPresets?: unknown[];
  txTemplates?: unknown[];
  alertPrefs?: {
    budgetThreshold?: number | null;
    browserNotificationsEnabled?: boolean;
    lastNotifiedAlertKeys?: string[];
  };
  userCategories?: unknown;
  /**
   * Legacy backup compat: pre-v2.x exports carried user-defined cats
   * under this field as `CustomCategory[]`. Newer exports use
   * `userCategories` (a full `UserCategoryConfig`). When both are present,
   * the modern field wins. See the import path below for conversion.
   */
  customCategories?: unknown;
  monthlyAllocations?: Record<string, Record<string, unknown>>;
  debts?: unknown[];
  rolloverSettings?: unknown;
  theme?: string;
  /**
   * L79: canonical numeric milliseconds-since-epoch. `unknown` (widened
   * from the historical `string`) keeps back-compat with legacy exports
   * that serialised `String(value)` — the hydration boundary coerces
   * those to `number` in `buildImportState` via `normalizeLastBackup`.
   */
  lastBackup?: unknown;
  /**
   * L89: transaction count at the time of the last backup. `unknown` is
   * intentional — legacy exports (pre-L89 builds) never emitted this
   * field, and a backup that has it could theoretically carry any shape
   * through an edge-case external tool. The hydration boundary coerces
   * to a finite non-negative number in `buildImportState` via
   * `normalizeLastBackupTxCount`, falling back to `0` on invalid input.
   */
  lastBackupTxCount?: unknown;
  // CR-Apr24-I finding 177: onboarding and filterExpanded round-trip
  // through manual JSON export/import so a restore reproduces the
  // full persisted UI state, not just transactions and financial data.
  onboarding?: unknown;
  filterExpanded?: unknown;
  // CR-Apr24-I finding 202: removed dead `syncState` field — never
  // emitted by buildExportData or read by buildImportState.
}

interface ImportStateResult {
  newS: Record<string, unknown>;
  writes: AtomicWriteEntry[];
  theme: string | null;
}


// ==========================================
// CONSTANTS
// ==========================================

export const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_IMPORT_TRANSACTIONS = 10000;
const MAX_ID_LENGTH = 128;
const SUPPORTED_INSIGHT_PERSONALITIES = new Set<InsightPersonality>([
  'serious',
  'friendly',
  'roast',
  'casual',
  'motivating'
]);

// ==========================================
// INTERNAL HELPERS
// ==========================================

/**
 * Sanitize an ID string to prevent injection/pollution
 */
function sanitizeId(id: unknown): string {
  const cleaned = String(id || '').replace(/[^a-zA-Z0-9_\-~.]/g, '').slice(0, MAX_ID_LENGTH);
  // P9-L2: Reject reserved JavaScript object keys (prototype pollution prevention)
  // Round 7: Added __proto__ to blocked keys to prevent prototype pollution via __proto__ assignment
  if (cleaned.startsWith('__') || ['constructor', 'prototype', '__proto__'].includes(cleaned)) {
    return '';
  }
  return cleaned;
}

function normalizeInsightPersonality(value: unknown): InsightPersonality {
  if (typeof value === 'string' && SUPPORTED_INSIGHT_PERSONALITIES.has(value as InsightPersonality)) {
    return value as InsightPersonality;
  }
  return 'serious';
}


// DRY-01: cloneStorageDefault and readOptionalSignalValue extracted to
// import-helpers.ts — shared with export-builders.ts.
import { cloneStorageDefault, readOptionalSignalValue } from './import-helpers.js';

/**
 * Merge two arrays of identity-keyed objects so an incoming item with a
 * matching id REPLACES the existing one rather than duplicating it.
 *
 * Design-Review-Apr21 batch 7k (item 1): the prior merge branch
 * (`[...existing, ...src]`) concatenated wholesale, so re-importing the
 * same backup duplicated every filter preset, transaction template, or
 * savings contribution on each merge. Identity-based merge keeps the
 * operation idempotent: importing a backup twice leaves the collection
 * identical to importing it once.
 *
 * `getId` returns the dedupe key. Rows whose id cannot be extracted
 * (missing, non-string) fall through to simple append — they would be
 * considered "new" by definition. Incoming rows win on collision
 * (newer edit from another device is exactly the case the user is
 * trying to carry forward).
 */
function mergeById<T>(
  existing: readonly T[],
  incoming: readonly T[],
  getId: (row: T) => string | undefined
): T[] {
  const byId = new Map<string, T>();
  const anonymous: T[] = [];
  for (const row of existing) {
    const id = getId(row);
    if (id) byId.set(id, row); else anonymous.push(row);
  }
  for (const row of incoming) {
    const id = getId(row);
    if (id) byId.set(id, row); else anonymous.push(row);
  }
  return [...anonymous, ...byId.values()];
}

/**
 * Identity accessors for each array-of-objects state kind the merge path
 * supports. Returns `undefined` when the row has no usable id so
 * `mergeById` can fall back to append semantics.
 */
const ARRAY_IDENTITY: Record<string, (row: unknown) => string | undefined> = {
  filterPresets: (r) => (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    ? (r as { id: string }).id
    : undefined,
  txTemplates: (r) => (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    ? (r as { id: string }).id
    : undefined,
  // SavingsContribution rows don't carry a stable id — dedupe on the
  // `goalId|date|amount` tuple, which is the natural identity the UI
  // renders (two contributions on the same day to the same goal with
  // the same amount read as the same deposit).
  savingsContribs: (r) => {
    if (!r || typeof r !== 'object') return undefined;
    const row = r as Record<string, unknown>;
    if (
      typeof row.goalId === 'string' &&
      typeof row.date === 'string' &&
      typeof row.amount === 'number'
    ) {
      return `${row.goalId}|${row.date}|${row.amount}`;
    }
    return undefined;
  },
};

/**
 * Parse a numeric-ish value permissively for import boundaries.
 *
 * Design-Review-Apr21 batch 7k (items 7–9): the debt importer used to
 * reject rows whose balance arrived as a string ("420.50") even though
 * `parseAmount` is already available; similarly it coerced malformed
 * APR values silently to 0, masking truly garbled data as "interest-free
 * debt". Returns `undefined` on unparseable input so callers can choose
 * to reject the row rather than silently fabricate a zero.
 */
function parseNumericOrUndefined(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    // Strip common currency decoration before Number() so "$420.50" works.
    const cleaned = raw.replace(/[^0-9eE.\-+]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '+' || cleaned === '.') return undefined;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Emit a user-visible warning + telemetry for a category of import rows
 * that were dropped because they failed structural validation.
 *
 * Design-Review-Apr21 batch 7k (ext batch, items 8–11): `buildImportState`
 * previously dropped malformed `savingsContributions`, `txTemplates`,
 * `filterPresets`, and debts while routing only a `trackError` call —
 * the user saw a clean success toast and had no idea that a fraction
 * of their data had vanished. This helper centralizes the surfacing so
 * every kind gets the same treatment: a `warning` toast during the
 * import and a structured telemetry breadcrumb with the kind label.
 */
function reportImportPartialDrop(kind: string, droppedCount: number): void {
  if (droppedCount === 0) return;
  const plural = droppedCount === 1 ? 'entry' : 'entries';
  emit(Events.SHOW_TOAST, {
    message: `Import skipped ${droppedCount} malformed ${kind} ${plural}.`,
    type: 'warning',
  });
  trackError(
    new Error(`import.${kind}: ${droppedCount} malformed entries dropped`),
    {
      module: 'ImportExport',
      action: `buildImportState.${kind}`,
    },
    'validationError'
  );
}

/**
 * Validate a single row of a debt's `payments[]` array.
 *
 * Design-Review-Apr21 batch 7k (item 10): debt `payments` arrays used
 * to be accepted wholesale if the outer field was an array, with zero
 * per-row validation. Downstream `sum(p.amount)` and `payments.length`
 * reads then silently poisoned payoff progress when a backup carried
 * malformed entries. Require amount (numeric) + date (string) at the
 * minimum; the transaction link is optional.
 *
 * Design-Review-Apr21 batch 7k (N16): date was previously accepted as
 * any non-empty string. That let "tomorrow", "2026-99-99", and
 * "2026-02-30" flow into the payoff timeline and distort
 * `new Date(p.date)` consumers (bogus dates either NaN out or silently
 * roll into the next month). Tighten to strict `YYYY-MM-DD` *and*
 * verify the parsed components match the input so calendar-invalid
 * dates are rejected, matching the shape every other date field in
 * the app contracts on.
 */
function isValidDebtPaymentRow(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const row = raw as Record<string, unknown>;
  const amt = parseNumericOrUndefined(row.amount);
  if (amt === undefined || amt < 0) return false;
  if (typeof row.date !== 'string' || row.date.length === 0) return false;
  // N16: strict YYYY-MM-DD + calendar validity. The regex eliminates
  // free-form strings ("tomorrow", "April 1"); the round-trip check
  // catches calendar-invalid values like "2026-02-30" that the regex
  // would otherwise allow through.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date);
  if (!match) return false;
  const [, yyyy, mm, dd] = match;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return false;
  }
  return true;
}

/**
 * L79: coerce `SK.LAST_BACKUP` payloads to the canonical `number` contract.
 *
 * Legacy exports (pre-fix `buildExportData`) serialised `String(value)`, so
 * an older backup round-trips as a numeric string and would otherwise be
 * written verbatim through the restoreMap into the `signal<number>` at
 * `signals.ts:215`, violating the type contract and poisoning the
 * `Date(lastBackup)` call sites.
 *
 * Accepts: `number` (passed through if finite & non-negative), numeric
 * strings like `"1713571200000"` (parsed), and everything else (falls back
 * to `0`, matching the `STORAGE_DEFAULTS` cold-boot value).
 */
function normalizeLastBackup(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

/**
 * L89: coerce `BACKUP_REMINDER_TX_COUNT_KEY` payloads to the canonical
 * `signal<number>` contract at `signals.ts:222`.
 *
 * Accepts: `number` (passed through if finite & non-negative, rounded
 * down because the signal represents a discrete transaction count),
 * numeric strings from quirky external tooling, and everything else
 * (falls back to `0`, matching the `STORAGE_DEFAULTS` cold-boot value).
 *
 * Negative or NaN payloads reset to 0 — a backup reminder counter below
 * zero is meaningless and a stray `null` / `"N/A"` from a user who
 * hand-edited the JSON must not poison the signal.
 */
function normalizeLastBackupTxCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return 0;
}

/**
 * L91: coerce `SK.SECTIONS` payloads to the canonical `SectionsConfig`
 * contract — `{envelope: boolean, transactionsTemplates: boolean}`.
 *
 * The restoreMap writes whatever the payload carries straight through
 * to both `newS.sections` and the storage write; a partial or typo'd
 * payload (e.g. `{envelope: false}` with no `transactionsTemplates`,
 * or `{envelope: 'off'}` with a non-boolean) would then violate the
 * `isSectionsConfig` sync validator at `sync-state-actions.ts:144` and
 * crash downstream readers that expect both booleans. This normalizer
 * merges the payload over the canonical `STORAGE_DEFAULTS[SK.SECTIONS]`
 * base and coerces each field to a real boolean so every write from
 * this path is `isSectionsConfig`-valid by construction.
 */
function normalizeSectionsConfig(value: unknown): SectionsConfig {
  const base = STORAGE_DEFAULTS[SK.SECTIONS] as SectionsConfig;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...base };
  }
  const src = value as Record<string, unknown>;
  const coerce = (raw: unknown, fallback: boolean): boolean =>
    typeof raw === 'boolean' ? raw : fallback;
  return {
    envelope: coerce(src.envelope, base.envelope),
    transactionsTemplates: coerce(src.transactionsTemplates, base.transactionsTemplates),
  };
}

/**
 * L93: coerce `SK.STREAK` payloads to the canonical `StreakData` contract
 * at `types/index.ts` — `{current: number, longest: number, lastDate: string}`.
 *
 * Same class of bug as L91: the restoreMap copies any present `streak`
 * object straight through, so a malformed payload (missing `lastDate`,
 * non-numeric `current`, etc.) writes a value that fails `isStreakData`
 * at `sync-state-actions.ts:158` and breaks `streak-tracker.ts:326`
 * which reads `streak.lastDate` directly to compute day deltas.
 *
 * Coerces each field independently — a partially-bad payload keeps the
 * good fields and backfills the rest from the canonical default.
 * Non-finite numbers (NaN, Infinity) fall back to the default; negative
 * streaks are clamped to 0 because a negative run length is meaningless.
 */
function normalizeStreakData(value: unknown): StreakData {
  const base = STORAGE_DEFAULTS[SK.STREAK] as StreakData;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...base };
  }
  const src = value as Record<string, unknown>;
  const coerceCount = (raw: unknown, fallback: number): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback;
    return Math.floor(raw);
  };
  const coerceDate = (raw: unknown, fallback: string): string =>
    typeof raw === 'string' ? raw : fallback;
  return {
    current: coerceCount(src.current, base.current),
    longest: coerceCount(src.longest, base.longest),
    lastDate: coerceDate(src.lastDate, base.lastDate),
  };
}

// ==========================================
// VALIDATION FUNCTIONS
// ==========================================

// validateTransaction removed - use validator.validateTransaction() directly

/**
 * Sanitize and validate imported transactions.
 *
 * M12 (Inline-Behavior-Review rev 12): return type changed from
 * `Transaction[]` to `SanitizedImportResult` (`{ accepted, rejected }`).
 *
 * Prior shape silently dropped every invalid row and returned only the
 * survivors — the caller had no way to distinguish "imported 1000 of
 * 1000" from "imported 800 of 1000 with 200 silently dropped." The inline
 * comment at this function's old DEV-only `console.warn` even acknowledged
 * the gap ("in production, could show summary to user") but never closed
 * it. The new shape preserves all rejection records so callers can surface
 * a structured summary via `reportImportValidationRejections` (below) and
 * route the aggregated count through `trackError` for production telemetry.
 */
export function sanitizeImportedTransactions(
  incoming: unknown[],
  existingIds: Set<string> = new Set()
): SanitizedImportResult {
  const genId = (): string => 'tx_' + generateId();
  const seen = new Set<string>(existingIds);
  const rejected: RejectedImportRecord[] = [];
  const validated: Partial<Transaction>[] = [];
  // Track which original indices the validator rejected so the second
  // pass below (id-collision detection) can skip them in O(1).
  const validatorRejectedIndices = new Set<number>();

  // Validate and sanitize each transaction using the validator module
  incoming.forEach((t, idx) => {
    const result = validator.validateTransaction(t as Partial<Transaction>);
    if (!result.valid) {
      const reason = Object.entries(result.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
      rejected.push({ index: idx, reason: reason || 'validation failed' });
      validatorRejectedIndices.add(idx);
    } else {
      validated.push(result.sanitized);
    }
  });

  // Assign unique IDs to validated transactions. The DEV-only
  // `console.warn` that used to live here has been removed — rejected
  // records are now returned to the caller, so the partial-failure
  // information is no longer destroyed at the function boundary
  // (finding M12).
  //
  // Design-Review-Apr21 batch 7k (item 12): when an incoming row arrives
  // with an explicit `__backendId` that collides with an already-seen id
  // (either another row earlier in the same batch, or — if the caller
  // seeded `existingIds` — a row already in storage) the prior code
  // silently rewrote it to a fresh id and moved on. That hid corrupted
  // source data (two rows claiming the same identity) and also silently
  // fabricated "new" transactions that downstream content-dedup then had
  // to re-catch. Surface the collision as a rejection so the caller can
  // route it through `reportImportValidationRejections`. Rows without
  // an explicit id still get auto-generated ones (no rejection) — this
  // is legitimate normalization, not silent fabrication.
  const accepted: Transaction[] = [];
  // Walk `validated` with its original index so collisions index back
  // into the caller's `incoming` array, not the post-validator slice.
  let validatedIdx = 0;
  for (let i = 0; i < incoming.length; i++) {
    if (validatorRejectedIndices.has(i)) continue;
    const t = validated[validatedIdx++];
    if (!t) continue;

    const providedId = sanitizeId(t.__backendId);
    if (providedId && seen.has(providedId)) {
      rejected.push({
        index: i,
        reason: `duplicate __backendId: ${providedId}`,
      });
      continue;
    }
    const id = providedId || genId();
    seen.add(id);
    // `t` is typed `Partial<Transaction>` even though the validator has
    // guaranteed all required fields — cast the source rather than the
    // object literal to satisfy `consistent-type-assertions`.
    const validatedTx = t as Transaction;
    const stamped: Transaction = { ...validatedTx, __backendId: id };
    accepted.push(stamped);
  }

  return { accepted, rejected };
}

/**
 * Surface import-validation rejections to the user + production telemetry.
 *
 * M12 (Inline-Behavior-Review rev 12): this is the canonical "close the
 * silent drop" helper for every caller of `sanitizeImportedTransactions`.
 * Import paths (overwrite, merge, filter-merge) call this after the
 * sanitize step — if anything was rejected, the user sees a warning toast
 * with the accepted/total counts plus a short preview of the first few
 * reasons, and the aggregated summary is routed through `trackError` so
 * production telemetry surfaces "users are importing files where 20% of
 * rows fail validation — which field is dominating?"
 *
 * No-op when `rejected.length === 0` — callers always call it so no
 * path is accidentally skipped, but there's no UX cost on clean imports.
 *
 * `sourceLabel` identifies the import path in telemetry (e.g.
 * `'backup_overwrite'`, `'backup_merge_all'`, `'backup_merge_filtered'`).
 * Keeps fingerprints separable so we can see which path dominates.
 */
export function reportImportValidationRejections(
  rejected: RejectedImportRecord[],
  totalIncoming: number,
  sourceLabel: string
): void {
  if (rejected.length === 0) return;

  const accepted = totalIncoming - rejected.length;
  const rejectedCount = rejected.length;
  const plural = rejectedCount === 1 ? '' : 's';
  const preview = rejected
    .slice(0, 3)
    .map(r => `row ${r.index + 1} — ${r.reason}`)
    .join('; ');
  const message =
    `Imported ${accepted} of ${totalIncoming} transactions. ` +
    `${rejectedCount} invalid row${plural} skipped.` +
    (preview ? ` First issue${preview.includes(';') ? 's' : ''}: ${preview}.` : '');

  emit(Events.SHOW_TOAST, { message, type: 'warning' });

  // Production telemetry — per M28's fingerprint sampling, aggregating
  // the first 10 reasons into the Error message keeps the fingerprint
  // meaningful (same path + same dominant reason → dedup by fingerprint;
  // different dominant reason → new fingerprint). Source label goes into
  // `action` so filter dashboards can split by import path.
  const sampleReasons = rejected.slice(0, 10).map(r => r.reason).join(' | ');
  trackError(
    new Error(
      `Import validation dropped ${rejectedCount} of ${totalIncoming} transaction rows` +
      (sampleReasons ? ` (sample: ${sampleReasons})` : '')
    ),
    {
      module: 'ImportExport',
      action: `import_validation_partial_failure:${sourceLabel}`,
    },
    'validationError'
  );
}

// DEAD-01: findContentDuplicates removed — dead code that shadowed the
// live implementation in duplicate-detection.ts (which is what
// import-export-events.ts actually imports). The two implementations had
// diverged (this one used exact+similar key maps; the live one uses
// fuzzy-bucket token-based merchant-stem matching).

// ==========================================
// IMPORT PIPELINE TYPES
// ==========================================

/**
 * Shared context threaded through the 5-stage import pipeline.
 * Each stage reads and mutates this context, keeping inter-stage
 * communication explicit and testable.
 *
 * ARCH-01 (Code-Review-Report): decompose the 926-line monolith into
 * a 5-stage pipeline for maintainability and per-stage testability.
 */
interface ImportPipelineCtx {
  /** The import payload — mutated in-place during coercion (stage 2). */
  d: ImportData;
  mode: 'overwrite' | 'merge';
  existingTx: Transaction[];
  /** Accumulator: signal-layer state to hydrate post-import. */
  newS: Record<string, unknown>;
  /** Accumulator: atomic storage writes to flush. */
  writes: AtomicWriteEntry[];
  /** Mapping from import source fields to signal props + storage keys. */
  restoreMap: Array<{ src: keyof ImportData; prop: string; sk: string }>;
  /** Resolves current signal value for a given prop (merge mode). */
  getExistingValue: (prop: string) => unknown;
}

// ==========================================
// STAGE 1: SETUP & VALIDATION
// ==========================================

/**
 * Version compat check, size guard, initialize accumulators and restore map.
 */
function importStage1_setup(
  d: ImportData,
  mode: 'overwrite' | 'merge',
  existingTx: Transaction[]
): ImportPipelineCtx {
  const importedTxCount = Array.isArray(d.transactions) ? d.transactions.length : 0;
  const finalTxCount = existingTx.length;

  if (importedTxCount > MAX_IMPORT_TRANSACTIONS || finalTxCount > MAX_IMPORT_TRANSACTIONS) {
    throw new Error(`Import exceeds maximum allowed transactions (${MAX_IMPORT_TRANSACTIONS})`);
  }

  const importedVersion = d.version || '1.0';
  const compatibleVersions = ['2.3', '2.5', '2.6'];
  if (!compatibleVersions.includes(importedVersion)) {
    if (import.meta.env.DEV) console.warn(`Import: backup version ${importedVersion} may not be fully compatible with current schema.`);
  }

  const newS: Record<string, unknown> = {};
  const writes: AtomicWriteEntry[] = [];
  writes.push({ key: SK.TX, value: existingTx });

  const getExistingValue = (prop: string): unknown => {
    const signalMap: Record<string, unknown> = {
      savingsGoals: signals.savingsGoals.value,
      savingsContribs: signals.savingsContribs.value,
      currency: signals.currency.value,
      achievements: signals.achievements.value,
      streak: signals.streak.value,
      sections: signals.sections.value,
      insightPers: signals.insightPers.value,
      filterPresets: signals.filterPresets.value,
      txTemplates: signals.txTemplates.value,
      lastBackup: signals.lastBackup.value,
      lastBackupTxCount: signals.lastBackupTxCount.value,
      onboarding: readOptionalSignalValue('onboarding', cloneStorageDefault(SK.ONBOARD)),
      filtersExpanded: readOptionalSignalValue('filtersExpanded', cloneStorageDefault(SK.FILTER_EXPANDED)),
    };
    return signalMap[prop];
  };

  const restoreMap: Array<{ src: keyof ImportData; prop: string; sk: string }> = [
    { src: 'savingsGoals', prop: 'savingsGoals', sk: SK.SAVINGS },
    { src: 'savingsContributions', prop: 'savingsContribs', sk: SK.SAVINGS_CONTRIB },
    { src: 'currency', prop: 'currency', sk: SK.CURRENCY },
    { src: 'achievements', prop: 'achievements', sk: SK.ACHIEVE },
    { src: 'streak', prop: 'streak', sk: SK.STREAK },
    { src: 'sections', prop: 'sections', sk: SK.SECTIONS },
    { src: 'insightPersonality', prop: 'insightPers', sk: SK.INSIGHT_PERS },
    { src: 'filterPresets', prop: 'filterPresets', sk: SK.FILTER_PRESETS },
    { src: 'txTemplates', prop: 'txTemplates', sk: SK.TX_TEMPLATES },
    { src: 'lastBackup', prop: 'lastBackup', sk: SK.LAST_BACKUP },
    { src: 'lastBackupTxCount', prop: 'lastBackupTxCount', sk: BACKUP_REMINDER_TX_COUNT_KEY },
    { src: 'onboarding', prop: 'onboarding', sk: SK.ONBOARD },
    { src: 'filterExpanded', prop: 'filtersExpanded', sk: SK.FILTER_EXPANDED },
  ];

  return { d, mode, existingTx, newS, writes, restoreMap, getExistingValue };
}

// ==========================================
// STAGE 2: TYPE COERCION
// ==========================================

/**
 * Validate and coerce imported array/object fields so downstream stages
 * can assume canonical shapes. Mutates `ctx.d` in place.
 */
function importStage2_coerce(ctx: ImportPipelineCtx): void {
  const { d } = ctx;

  if (d.savingsContributions && !Array.isArray(d.savingsContributions)) d.savingsContributions = [];
  if (d.filterPresets && !Array.isArray(d.filterPresets)) d.filterPresets = [];
  if (d.txTemplates && !Array.isArray(d.txTemplates)) d.txTemplates = [];
  if (d.currency && typeof d.currency !== 'object') d.currency = { home: 'USD', symbol: '$' };
  if (d.savingsGoals && typeof d.savingsGoals !== 'object') d.savingsGoals = {};
  if (d.achievements && typeof d.achievements !== 'object') d.achievements = {};

  // Row-level validation for savingsContributions
  if (Array.isArray(d.savingsContributions) && d.savingsContributions.length > 0) {
    const beforeCount = d.savingsContributions.length;
    const kept = d.savingsContributions.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.goalId !== 'string' || e.goalId.length === 0) return false;
      if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) return false;
      if (typeof e.date !== 'string' || e.date.length === 0) return false;
      return true;
    });
    if (kept.length !== beforeCount) {
      reportImportPartialDrop('savingsContributions', beforeCount - kept.length);
    }
    d.savingsContributions = kept as SavingsContribution[];
  }

  // L95/L96: Row-level validation for txTemplates — downstream readers
  // assume full TxTemplate shape (id, name, type ∈ {expense,income}, category).
  if (Array.isArray(d.txTemplates) && d.txTemplates.length > 0) {
    const beforeCount = d.txTemplates.length;
    const kept = d.txTemplates.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.length === 0) return false;
      if (typeof e.name !== 'string' || e.name.length === 0) return false;
      if (e.type !== 'expense' && e.type !== 'income') return false;
      if (typeof e.category !== 'string' || e.category.length === 0) return false;
      return true;
    });
    if (kept.length !== beforeCount) {
      reportImportPartialDrop('txTemplates', beforeCount - kept.length);
    }
    d.txTemplates = kept as TxTemplate[];
  }

  // L97/L98: Row-level validation for filterPresets — sync validator
  // requires string id + name, UI spreads preset.filters into filter state.
  if (Array.isArray(d.filterPresets) && d.filterPresets.length > 0) {
    const beforeCount = d.filterPresets.length;
    const kept = d.filterPresets.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.length === 0) return false;
      if (typeof e.name !== 'string' || e.name.length === 0) return false;
      // filters must be a plain object (not null, not array)
      if (!e.filters || typeof e.filters !== 'object' || Array.isArray(e.filters)) return false;
      return true;
    });
    if (kept.length !== beforeCount) {
      reportImportPartialDrop('filterPresets', beforeCount - kept.length);
    }
    d.filterPresets = kept as FilterPreset[];
  }
}

// ==========================================
// STAGE 3: RESTORE MAP & NORMALIZE
// ==========================================

/**
 * Apply the restoreMap (merge/overwrite per key) then post-normalize
 * special fields (insightPers, lastBackup, sections, streak, etc.).
 */
function importStage3_restoreAndNormalize(ctx: ImportPipelineCtx): void {
  const { d, mode, newS, writes, restoreMap, getExistingValue } = ctx;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

  restoreMap.forEach(({ src, prop, sk }) => {
    const srcValue = d[src];
    const existingValue = getExistingValue(prop);
    if (srcValue == null) {
      if (mode === 'overwrite') {
        const defaultVal = cloneStorageDefault(sk);
        newS[prop] = defaultVal;
        writes.push({ key: sk, value: defaultVal });
      }
      else { newS[prop] = existingValue; }
      return;
    }
    if (mode === 'merge' && Array.isArray(existingValue) && Array.isArray(srcValue)) {
      const identityAccessor = ARRAY_IDENTITY[prop];
      if (identityAccessor) {
        newS[prop] = mergeById(
          existingValue as unknown[],
          srcValue as unknown[],
          identityAccessor
        );
      } else {
        newS[prop] = [...(existingValue as unknown[]), ...(srcValue as unknown[])];
      }
    } else if (mode === 'merge' && isObj(existingValue) && isObj(srcValue)) {
      newS[prop] = { ...existingValue, ...srcValue };
    } else {
      newS[prop] = srcValue;
    }
    writes.push({ key: sk, value: newS[prop] });
  });

  // Post-normalize: insightPers
  if ('insightPers' in newS) {
    const normalizedInsightPersonality = normalizeInsightPersonality(newS.insightPers);
    newS.insightPers = normalizedInsightPersonality;
    const idx = writes.findIndex((write) => write.key === SK.INSIGHT_PERS);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = normalizedInsightPersonality;
  }

  // Post-normalize: lastBackup
  if ('lastBackup' in newS) {
    const normalizedLastBackup = normalizeLastBackup(newS.lastBackup);
    newS.lastBackup = normalizedLastBackup;
    const idx = writes.findIndex((write) => write.key === SK.LAST_BACKUP);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = normalizedLastBackup;
  }

  // Post-normalize: lastBackupTxCount
  if ('lastBackupTxCount' in newS) {
    const normalizedTxCount = normalizeLastBackupTxCount(newS.lastBackupTxCount);
    newS.lastBackupTxCount = normalizedTxCount;
    const idx = writes.findIndex((write) => write.key === BACKUP_REMINDER_TX_COUNT_KEY);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = normalizedTxCount;
  }

  // Post-normalize: sections
  if ('sections' in newS) {
    const normalizedSections = normalizeSectionsConfig(newS.sections);
    newS.sections = normalizedSections;
    const idx = writes.findIndex((write) => write.key === SK.SECTIONS);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = normalizedSections;
  }

  // Post-normalize: streak
  if ('streak' in newS) {
    const normalizedStreak = normalizeStreakData(newS.streak);
    newS.streak = normalizedStreak;
    const idx = writes.findIndex((write) => write.key === SK.STREAK);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = normalizedStreak;
  }
}

// ==========================================
// STAGE 4: COMPLEX TRANSFORMATIONS
// ==========================================

/**
 * Deep normalization of savings goals, alerts, currency, categories,
 * allocations, debts, and rollover settings.
 */
function importStage4_transformComplexFields(ctx: ImportPipelineCtx): void {
  const { d, mode, newS, writes } = ctx;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

  // --- Savings goals ---
  if (isObj(newS.savingsGoals)) {
    const sanitized: Record<string, SavingsGoal> = {};
    Object.entries(newS.savingsGoals).forEach(([k, v]) => {
      const safeKey = sanitizeId(k);
      if (!safeKey) return;
      const rawGoal = isObj(v) ? { ...(v) } : null;
      if (!rawGoal) return;
      const coerceAmount = (raw: unknown): number => {
        if (raw === null || raw === undefined) return 0;
        if (typeof raw === 'number' || typeof raw === 'string') return parseAmount(raw);
        return 0;
      };
      if ('target_amount' in rawGoal) rawGoal.target_amount = coerceAmount(rawGoal.target_amount);
      if ('saved_amount' in rawGoal) rawGoal.saved_amount = coerceAmount(rawGoal.saved_amount);
      if ('target' in rawGoal) rawGoal.target = coerceAmount(rawGoal.target);
      if ('saved' in rawGoal) rawGoal.saved = coerceAmount(rawGoal.saved);
      const normalized = normalizeSavingsGoal(rawGoal, safeKey);
      if (!normalized) return;
      if (!normalized.target) normalized.target = 1;
      sanitized[safeKey] = normalized;
    });
    newS.savingsGoals = sanitized;
    const idx = writes.findIndex(w => w.key === SK.SAVINGS);
    const writeEntry = idx >= 0 ? writes[idx] : undefined;
    if (writeEntry) writeEntry.value = sanitized;
  }

  // --- Alert prefs ---
  const rawAlerts = d.alertPrefs;
  if (rawAlerts) {
    if (mode === 'merge') {
      const existingAlerts = normalizeAlertPrefs(signals.alerts.value);
      newS.alerts = normalizeAlertPrefs({
        ...existingAlerts,
        ...(rawAlerts as Record<string, unknown>),
      });
    } else {
      newS.alerts = normalizeAlertPrefs(rawAlerts);
    }
  } else if (mode === 'merge') {
    newS.alerts = normalizeAlertPrefs(signals.alerts.value);
  } else {
    newS.alerts = normalizeAlertPrefs(STORAGE_DEFAULTS[SK.ALERTS]);
  }
  writes.push({ key: SK.ALERTS, value: newS.alerts });

  // --- Currency validation ---
  const currencyMap = CURRENCY_MAP;
  if (newS.currency && typeof newS.currency === 'object') {
    const curr = newS.currency as CurrencySettings;
    if (!currencyMap[curr.home]) {
      newS.currency = { home: 'USD', symbol: '$' };
    } else if (!curr.symbol || curr.symbol !== currencyMap[curr.home]) {
      newS.currency = { ...curr, symbol: currencyMap[curr.home] };
    }
    const cidx = writes.findIndex(w => w.key === SK.CURRENCY);
    const currencyWrite = cidx >= 0 ? writes[cidx] : undefined;
    if (currencyWrite) currencyWrite.value = newS.currency;
    else writes.push({ key: SK.CURRENCY, value: newS.currency });
  }

  // --- User categories ---
  const importedUserCategories = d.userCategories;
  const currentConfig = userCategoryConfig.value;

  if (isUserCategoryConfigShape(importedUserCategories)) {
    newS.userCategories = importedUserCategories;
    writes.push({ key: SK.USER_CATS, value: importedUserCategories });
  } else if (importedUserCategories === null && mode === 'overwrite') {
    newS.userCategories = null;
    writes.push({ key: SK.USER_CATS, value: null });
  } else if (importedUserCategories !== undefined && importedUserCategories !== null) {
    if (mode === 'merge' && currentConfig !== null) {
      newS.userCategories = currentConfig;
      writes.push({ key: SK.USER_CATS, value: currentConfig });
    } else if (mode === 'overwrite') {
      newS.userCategories = null;
      writes.push({ key: SK.USER_CATS, value: null });
    }
  } else if (Array.isArray(d.customCategories)) {
    const rawLegacy = d.customCategories as unknown[];
    const validLegacy: CustomCategory[] = [];
    for (const entry of rawLegacy) {
      if (!entry || !isObj(entry)) continue;
      const e = entry as Record<string, unknown>;
      const id = sanitizeId(e.id);
      const name = typeof e.name === 'string' ? e.name.slice(0, 128) : '';
      const type = e.type === 'income' ? 'income' : e.type === 'expense' ? 'expense' : null;
      const emoji = typeof e.emoji === 'string' ? e.emoji.slice(0, 8) : '';
      const color = typeof e.color === 'string' ? e.color.slice(0, 16) : '';
      if (!id || !name || !type) continue;
      validLegacy.push({ id, name, type, emoji, color });
    }
    newS.userCategories = buildConfigFromLegacyCustom(validLegacy);
    writes.push({ key: SK.USER_CATS, value: newS.userCategories });
  } else if (mode === 'overwrite') {
    newS.userCategories = null;
    writes.push({ key: SK.USER_CATS, value: null });
  } else if (currentConfig !== null) {
    newS.userCategories = currentConfig;
  }

  // --- Monthly allocations ---
  const existingAlloc = signals.monthlyAlloc.value as Record<string, Record<string, number>>;
  if (d.monthlyAllocations && isObj(d.monthlyAllocations)) {
    if (mode === 'merge') {
      const merged: Record<string, Record<string, number>> = { ...existingAlloc };
      Object.entries(d.monthlyAllocations).forEach(([mk, alloc]) => {
        if (!isObj(alloc)) return;
        const monthAlloc = merged[mk];
        if (!monthAlloc) {
          const fresh: Record<string, number> = {};
          Object.entries(alloc).forEach(([catId, amt]) => {
            const safeId = sanitizeId(catId);
            if (safeId) fresh[safeId] = parseAmount(amt as string | number);
          });
          merged[mk] = fresh;
        }
        else {
          Object.entries(alloc).forEach(([catId, amt]) => {
            const safeId = sanitizeId(catId);
            if (safeId) monthAlloc[safeId] = parseAmount(amt as string | number);
          });
        }
      });
      newS.monthlyAlloc = merged;
    } else {
      const normalized: Record<string, Record<string, number>> = {};
      Object.entries(d.monthlyAllocations).forEach(([mk, alloc]) => {
        if (!isObj(alloc)) return;
        const monthMap: Record<string, number> = {};
        Object.entries(alloc).forEach(([catId, amt]) => {
          const safeId = sanitizeId(catId);
          if (safeId) monthMap[safeId] = parseAmount(amt as string | number);
        });
        normalized[mk] = monthMap;
      });
      newS.monthlyAlloc = normalized;
    }
    writes.push({ key: SK.ALLOC, value: newS.monthlyAlloc });
  } else if (mode === 'overwrite') {
    newS.monthlyAlloc = {};
    writes.push({ key: SK.ALLOC, value: {} });
  } else {
    newS.monthlyAlloc = existingAlloc;
  }

  // --- Debts ---
  const existingDebts = signals.debts.value;
  const existingDebtsById: Map<string, Debt> = new Map();
  for (const debt of existingDebts) existingDebtsById.set(debt.id, debt);
  const VALID_DEBT_TYPES: ReadonlySet<Debt['type']> = new Set<Debt['type']>([
    'credit_card', 'student_loan', 'mortgage', 'auto', 'personal', 'medical', 'other'
  ]);
  if (Array.isArray(d.debts)) {
    const rawDebts = d.debts;
    const validDebts: Debt[] = [];
    let droppedDebtCount = 0;
    let droppedPaymentCount = 0;

    for (const raw of rawDebts) {
      if (!raw || typeof raw !== 'object') { droppedDebtCount += 1; continue; }
      const entry = raw as Record<string, unknown>;

      if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
        droppedDebtCount += 1; continue;
      }
      const balance = parseNumericOrUndefined(entry.balance);
      if (balance === undefined || balance < 0) { droppedDebtCount += 1; continue; }

      const interestRateRaw = parseNumericOrUndefined(entry.interestRate);
      if (interestRateRaw === undefined) { droppedDebtCount += 1; continue; }

      const originalBalanceRaw = parseNumericOrUndefined(entry.originalBalance);
      const originalBalance = originalBalanceRaw !== undefined && originalBalanceRaw >= 0
        ? originalBalanceRaw
        : balance;
      const minimumPaymentRaw = parseNumericOrUndefined(entry.minimumPayment);
      const minimumPayment = minimumPaymentRaw !== undefined && minimumPaymentRaw >= 0
        ? minimumPaymentRaw
        : 0;

      const rawType = entry.type;
      const debtType: Debt['type'] = typeof rawType === 'string' && VALID_DEBT_TYPES.has(rawType as Debt['type'])
        ? (rawType as Debt['type'])
        : 'other';

      const dueDay = normalizeDueDay(entry.dueDay as number | string | undefined | null);

      const paymentsKeyPresent = 'payments' in entry;
      const incomingId = sanitizeId(entry.id);
      const existingForId = incomingId ? existingDebtsById.get(incomingId) : undefined;
      let debtPayments: Debt['payments'];
      if (!paymentsKeyPresent && mode === 'merge' && existingForId) {
        debtPayments = existingForId.payments;
      } else {
        const paymentsRaw = Array.isArray(entry.payments) ? entry.payments : [];
        const paymentsBeforeCount = paymentsRaw.length;
        const validPayments = paymentsRaw.filter(isValidDebtPaymentRow) as Debt['payments'];
        if (validPayments.length !== paymentsBeforeCount) {
          droppedPaymentCount += paymentsBeforeCount - validPayments.length;
        }
        debtPayments = validPayments;
      }

      validDebts.push({
        id: incomingId || `debt_${generateId()}`,
        name: String(entry.name).slice(0, 100),
        type: debtType,
        balance: parseAmount(balance),
        originalBalance: parseAmount(originalBalance),
        minimumPayment: parseAmount(minimumPayment),
        interestRate: Math.max(0, Math.min(1, interestRateRaw)),
        dueDay,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        payments: debtPayments,
        isActive: entry.isActive === false ? false : entry.isActive === true ? true : true,
      });
    }

    reportImportPartialDrop('debts', droppedDebtCount);
    reportImportPartialDrop('debtPayments', droppedPaymentCount);

    if (mode === 'merge') {
      newS.debts = mergeById(
        existingDebts,
        validDebts,
        (debt) => debt.id
      );
    } else {
      newS.debts = validDebts;
    }
    writes.push({ key: SK.DEBTS, value: newS.debts });
  } else if (mode === 'overwrite') {
    newS.debts = [];
    writes.push({ key: SK.DEBTS, value: [] });
  } else {
    newS.debts = existingDebts;
  }

  // --- Rollover settings ---
  const existingRollover = signals.rolloverSettings.value;
  const ROLLOVER_DEFAULT: RolloverSettings = {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero',
  };
  const coerceRolloverMode = (raw: unknown, fallback: RolloverSettings['mode']): RolloverSettings['mode'] =>
    raw === 'all' || raw === 'selected' ? raw : fallback;
  const coerceNegHandling = (raw: unknown, fallback: RolloverSettings['negativeHandling']): RolloverSettings['negativeHandling'] =>
    raw === 'zero' || raw === 'carry' || raw === 'ignore' ? raw : fallback;
  if (d.rolloverSettings && typeof d.rolloverSettings === 'object' && !Array.isArray(d.rolloverSettings)) {
    const rs = d.rolloverSettings as Record<string, unknown>;
    const base: RolloverSettings = mode === 'merge' && existingRollover
      ? existingRollover
      : ROLLOVER_DEFAULT;
    newS.rolloverSettings = {
      enabled: 'enabled' in rs ? rs.enabled === true : base.enabled,
      mode: 'mode' in rs ? coerceRolloverMode(rs.mode, base.mode) : base.mode,
      categories: 'categories' in rs
        ? (Array.isArray(rs.categories) ? rs.categories as string[] : base.categories)
        : base.categories,
      maxRollover: 'maxRollover' in rs
        ? (rs.maxRollover === null || rs.maxRollover === undefined
            ? null
            : parseAmount(rs.maxRollover as string | number))
        : base.maxRollover,
      negativeHandling: 'negativeHandling' in rs
        ? coerceNegHandling(rs.negativeHandling, base.negativeHandling)
        : base.negativeHandling,
    };
    writes.push({ key: SK.ROLLOVER_SETTINGS, value: newS.rolloverSettings });
  } else if (mode === 'overwrite') {
    newS.rolloverSettings = { ...ROLLOVER_DEFAULT };
    writes.push({ key: SK.ROLLOVER_SETTINGS, value: newS.rolloverSettings });
  } else {
    newS.rolloverSettings = existingRollover;
  }
}

// ==========================================
// STAGE 5: FINAL ASSEMBLY
// ==========================================

/**
 * Recurring templates validation + theme resolution + return.
 */
function importStage5_finalize(ctx: ImportPipelineCtx): ImportStateResult {
  const { d, mode, newS, writes } = ctx;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

  // --- Recurring templates ---
  {
    const raw = d.recurringTemplates;
    const isTemplateRow = (v: unknown): v is Partial<RecurringTemplate> & Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v);

    const validateRow = (entry: unknown, fallbackKey: string): RecurringTemplate | null => {
      if (!isTemplateRow(entry)) return null;
      const type = entry.type;
      if (type !== 'expense' && type !== 'income') return null;
      if (typeof entry.category !== 'string' || entry.category.length === 0) return null;
      if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) return null;
      if (!isValidYmd(entry.startDate)) return null;
      if (!isValidYmd(entry.endDate)) return null;
      const recurringType = entry.recurringType;
      if (typeof recurringType !== 'string' || !VALID_RECURRING_TYPES.has(recurringType as RecurringTemplate['recurringType'])) {
        return null;
      }
      const dayRaw = entry.originalDayOfMonth;
      if (typeof dayRaw !== 'number' || !Number.isFinite(dayRaw)) return null;
      const day = Math.trunc(dayRaw);
      if (day < 1 || day > 31) return null;
      const active = entry.active;
      const activeOk = typeof active === 'boolean' ? active : true;
      const lastGen = entry.lastGeneratedDate;
      const lastGenOk = typeof lastGen === 'string' && isValidYmd(lastGen) ? lastGen : undefined;
      const id = typeof entry.id === 'string' && entry.id.length > 0
        ? sanitizeId(entry.id) || fallbackKey
        : fallbackKey;
      if (!id) return null;
      const description = typeof entry.description === 'string' ? entry.description : '';
      const tags = typeof entry.tags === 'string' ? entry.tags : '';
      const notes = typeof entry.notes === 'string' ? entry.notes : '';
      const row: RecurringTemplate = {
        id,
        type,
        category: entry.category,
        amount: parseAmount(entry.amount),
        description,
        tags,
        notes,
        startDate: entry.startDate,
        endDate: entry.endDate,
        recurringType: recurringType as RecurringTemplate['recurringType'],
        originalDayOfMonth: day,
        active: activeOk,
      };
      if (lastGenOk !== undefined) row.lastGeneratedDate = lastGenOk;
      return row;
    };

    const existingRecurring = safeStorage.getJSON<Record<string, RecurringTemplate>>(SK.RECURRING, {});

    if (isObj(raw)) {
      const entries = Object.entries(raw);
      const validated: Record<string, RecurringTemplate> = {};
      let droppedCount = 0;
      for (const [key, value] of entries) {
        const sanitizedKey = sanitizeId(key) || '';
        const row = validateRow(value, sanitizedKey);
        if (!row) { droppedCount += 1; continue; }
        validated[row.id] = row;
      }
      if (droppedCount > 0) {
        reportImportPartialDrop('recurringTemplates', droppedCount);
      }
      if (mode === 'merge') {
        newS.recurringTemplates = { ...existingRecurring, ...validated };
      } else {
        newS.recurringTemplates = validated;
      }
      writes.push({ key: SK.RECURRING, value: newS.recurringTemplates });
    }
    // Field absent: intentionally no wipe (see original comments for rationale)
  }

  // --- Theme resolution ---
  let resolvedTheme: string | null;
  if (typeof d.theme === 'string' && d.theme) {
    resolvedTheme = d.theme;
  } else if (mode === 'overwrite') {
    resolvedTheme = 'dark';
  } else {
    resolvedTheme = null;
  }

  return { newS, writes, theme: resolvedTheme };
}

// ==========================================
// PUBLIC API: PIPELINE ORCHESTRATOR
// ==========================================

/**
 * Computes all new state values and storage writes for an import WITHOUT
 * touching S or calling persist. Returns { newS, writes, theme }.
 *
 * ARCH-01: decomposed into a 5-stage pipeline for maintainability.
 * Each stage is independently testable via the shared ImportPipelineCtx.
 */
export function buildImportState(
  d: ImportData,
  mode: 'overwrite' | 'merge',
  existingTx: Transaction[] = []
): ImportStateResult {
  const ctx = importStage1_setup(d, mode, existingTx);
  importStage2_coerce(ctx);
  importStage3_restoreAndNormalize(ctx);
  importStage4_transformComplexFields(ctx);
  return importStage5_finalize(ctx);
}

// ==========================================
// BARREL RE-EXPORTS — keep downstream import paths stable
// ==========================================

export { buildExportData, buildCsvContent } from './export-builders.js';
export type { ExportData } from './export-builders.js';
export { tryAtomicWrite } from './atomic-write.js';
export type { AtomicWriteEntry } from './atomic-write.js';
