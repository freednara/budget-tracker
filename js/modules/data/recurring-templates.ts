/**
 * Recurring Transaction Templates Module
 * 
 * FIXED: Implements a template-based recurring transaction system
 * instead of creating all future occurrences upfront.
 * This prevents database bloat and allows for unlimited recurring series.
 * 
 * @module data/recurring-templates
 */
'use strict';

import * as signals from '../core/signals.js';
import { parseLocalDate, generateId } from '../core/utils-pure.js';
import { SK } from '../core/state.js';
import { safeStorage } from '../core/safe-storage.js';
import { dataSdk } from './data-manager.js';
import type { Transaction } from '../../types/index.js';

type RecurringType = NonNullable<Transaction['recurring_type']>;

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface RecurringTemplate {
  id: string;
  type: 'expense' | 'income';
  category: string;
  amount: number;
  description: string;
  tags: string;
  notes: string;
  startDate: string;
  endDate: string;
  recurringType: RecurringType;
  originalDayOfMonth: number; // Store original day to prevent drift
  lastGeneratedDate?: string; // Track last generated occurrence
  active: boolean;
  /**
   * CR-Apr24-B [P2] finding 43: ISO currency code captured at template
   * creation time so future occurrences post under that currency
   * regardless of later changes to the global `signals.currency` setting.
   * Pre-fix: every generated occurrence stamped `signals.currency.value
   * ?.home ?? 'USD'`, so a user who set up a $100 USD recurring rent
   * template, moved to Europe, and changed the app currency to EUR
   * silently saw future occurrences post as €100 EUR — same numeric
   * amount, completely different real-world value.
   *
   * Optional for backward compat: pre-upgrade templates without the field
   * fall back to `signals.currency.value?.home` at generation time
   * (matching pre-fix behavior for legacy data).
   */
  currency?: string;
}

// ==========================================
// STATE MANAGEMENT
// ==========================================

// Store recurring templates separately from transactions
let recurringTemplates: Map<string, RecurringTemplate> = new Map();

/**
 * Load recurring templates from storage
 */
export function loadRecurringTemplates(): void {
  try {
    const templates = safeStorage.getJSON<Record<string, RecurringTemplate>>(SK.RECURRING, {});
    recurringTemplates = new Map(Object.entries(templates));
  } catch (e) {
    if (import.meta.env.DEV) console.error('Failed to load recurring templates:', e);
  }
}

/**
 * Save recurring templates to storage
 */
function saveRecurringTemplates(): void {
  const templatesObj = Object.fromEntries(recurringTemplates);
  safeStorage.setJSON(SK.RECURRING, templatesObj);
}

/**
 * Clear all recurring templates from memory and storage.
 * Used by app reset flows that must fully remove recurring state.
 */
export function clearRecurringTemplates(): void {
  recurringTemplates = new Map();
  safeStorage.setJSON(SK.RECURRING, {});
}

/**
 * Enumerate the current recurring templates as an array.
 *
 * Exported so callers that need to reason about existing templates (e.g.
 * dedup an incoming seed against what is already persisted — CR-Apr22-F
 * slice 4 / Finding 10: demo seeder was checking transaction presence for
 * dedup which broke after a rollback that removed the spawned occurrence
 * but left the template) don't have to reach into the module-private
 * `recurringTemplates` Map or re-parse `safeStorage.getJSON(SK.RECURRING)`.
 *
 * Returns a shallow array snapshot; mutations to the result don't affect
 * the internal Map.
 */
export function getRecurringTemplates(): RecurringTemplate[] {
  return Array.from(recurringTemplates.values());
}

// ==========================================
// TEMPLATE MANAGEMENT
// ==========================================

/**
 * Create a new recurring template (replaces upfront batch creation)
 */
export async function createRecurringTemplate(data: Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>): Promise<string> {
  const id = generateId();
  const template: RecurringTemplate = {
    ...data,
    id,
    active: true,
    originalDayOfMonth: parseLocalDate(data.startDate).getDate(),
    // CR-Apr24-B [P2] finding 43: capture the current app currency at
    // creation time so the template's future occurrences post under
    // that currency even after the user changes their global currency
    // setting. Caller can still override via `data.currency` (e.g.
    // form-events.ts already passes a currency through).
    currency: data.currency ?? signals.currency.value?.home ?? 'USD'
  };

  recurringTemplates.set(id, template);
  saveRecurringTemplates();

  // Generate only the first occurrence immediately
  await generateNextOccurrence(template);

  return id;
}

/**
 * Valid `recurring_type` union, lifted from the `Transaction` type so the
 * runtime validator stays in lockstep with the compile-time contract.
 *
 * Design-Review-Apr21 (new batch): `updateRecurringTemplate()` used to
 * `Object.assign(template, updates)` blindly, which let callers:
 *   1. Change `id` and silently desynchronize the Map key from the
 *      stored template's own id (a malformed update broke all
 *      subsequent `.get(newId)` lookups).
 *   2. Rewind `lastGeneratedDate` to a garbage string, making the
 *      scheduler re-generate already-materialized occurrences.
 *   3. Push `originalDayOfMonth` out of [1, 31], which then fed into
 *      `Math.min(originalDayOfMonth, maxDay)` and produced bogus dates.
 *   4. Overwrite `active` with non-boolean truthiness.
 *   5. Write an unknown `recurringType` that `calculateNextOccurrence`
 *      would then hit in a switch with no default branch, stranding
 *      the template on its last-known date forever.
 */
// CR-Apr22-F slice 1: exported so the manual JSON import + auto-backup
// restore paths (import-export.ts `buildImportState`) can validate
// recurring-template payloads against the same allowlist used by the
// in-place update path below — one source of truth for what counts as a
// well-formed recurring cadence. Adding a new cadence here enables it
// for updates, form submission, AND import-restore hydration in lockstep.
export const VALID_RECURRING_TYPES: ReadonlySet<RecurringType> = new Set<RecurringType>([
  'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'
]);

// CR-Apr22-F slice 1: exported for the same reason — the import-path
// per-row validator reuses this predicate so a legitimate backup from
// this app can always round-trip through export/import without a
// validator divergence silently dropping rows the update path would
// have accepted.
export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yyyy, mm, dd] = match;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

/**
 * Update a recurring template.
 *
 * Accepts a `Partial<RecurringTemplate>` but sanitizes it before
 * merging so malformed callers can't corrupt scheduler state:
 *   - `id` is always stripped (the Map key is the source of truth;
 *     letting it drift turns the template into an orphan).
 *   - `recurringType`, `originalDayOfMonth`, `active`, and
 *     `lastGeneratedDate` are validated; invalid values are dropped
 *     from the update (the existing value is kept) rather than
 *     poisoning the template.
 *   - `startDate` / `endDate` are validated as YYYY-MM-DD so the
 *     scheduler's `parseLocalDate` call doesn't explode downstream.
 */
export function updateRecurringTemplate(id: string, updates: Partial<RecurringTemplate>): boolean {
  const template = recurringTemplates.get(id);
  if (!template) return false;

  // Build a sanitized update object rather than mutating `updates` in
  // place — callers may hand us a frozen or reused object. Start from
  // an empty partial and copy only vetted fields.
  const safe: Partial<RecurringTemplate> = {};

  // Pass-through scalars that accept any string/number (validator lives
  // upstream at the form boundary). We still want *types* to match, so
  // check typeof before copying.
  if (typeof updates.type === 'string' && (updates.type === 'expense' || updates.type === 'income')) {
    safe.type = updates.type;
  }
  if (typeof updates.category === 'string') safe.category = updates.category;
  if (typeof updates.amount === 'number' && Number.isFinite(updates.amount)) safe.amount = updates.amount;
  if (typeof updates.description === 'string') safe.description = updates.description;
  if (typeof updates.tags === 'string') safe.tags = updates.tags;
  if (typeof updates.notes === 'string') safe.notes = updates.notes;

  // Date fields require YYYY-MM-DD + calendar validity so
  // `parseLocalDate` never receives garbage.
  if ('startDate' in updates && isValidYmd(updates.startDate)) {
    safe.startDate = updates.startDate;
    // CR-Apr24-B [P2] finding 40: when `startDate` changes, also recompute
    // `originalDayOfMonth` so monthly/quarterly/yearly cadence anchors to
    // the NEW start date's day rather than drifting on the original anchor.
    // Pre-fix: a user who created a template with start 2026-01-15
    // (originalDayOfMonth=15), then edited start to 2026-02-20, would see
    // future occurrences land on the 15th of each month — the new start
    // date was a no-op for cadence purposes. The explicit caller can still
    // override `originalDayOfMonth` in the same `updates` payload to
    // decouple the two if needed; the explicit field is honored below
    // (Object.assign with `safe` runs after this block).
    if (updates.startDate) {
      const newDay = parseLocalDate(updates.startDate).getDate();
      if (Number.isFinite(newDay) && newDay >= 1 && newDay <= 31) {
        safe.originalDayOfMonth = newDay;
      }
    }
  }
  if ('endDate' in updates && isValidYmd(updates.endDate)) {
    safe.endDate = updates.endDate;
  }
  if ('lastGeneratedDate' in updates) {
    // lastGeneratedDate may legitimately be cleared by the scheduler;
    // accept `undefined` and well-formed YYYY-MM-DD, reject everything
    // else so a bogus rewind can't force re-generation.
    if (updates.lastGeneratedDate === undefined || isValidYmd(updates.lastGeneratedDate)) {
      safe.lastGeneratedDate = updates.lastGeneratedDate;
    }
  }

  // recurringType: restrict to the RecurringType union so the switch in
  // calculateNextOccurrenceDate can't silently fall through.
  if ('recurringType' in updates && typeof updates.recurringType === 'string') {
    if (VALID_RECURRING_TYPES.has(updates.recurringType as RecurringType)) {
      safe.recurringType = updates.recurringType as RecurringType;
    }
  }

  // originalDayOfMonth: clamp to [1, 31] and require integer.
  if ('originalDayOfMonth' in updates && typeof updates.originalDayOfMonth === 'number') {
    const d = Math.trunc(updates.originalDayOfMonth);
    if (Number.isFinite(d) && d >= 1 && d <= 31) {
      safe.originalDayOfMonth = d;
    }
  }

  // active must be a strict boolean — `'false'` string and other
  // truthy junk used to flip templates the user meant to pause.
  if ('active' in updates && typeof updates.active === 'boolean') {
    safe.active = updates.active;
  }

  // CR-Apr24-B [P2] finding 43: explicit currency override is allowed
  // (e.g. user editing a recurring rent payment to denominate it in EUR
  // after a move). Restricted to non-empty string ISO-shaped values; the
  // canonical 3-letter ISO check lives in the locale layer, but a
  // non-empty string here is sufficient to keep malformed updates from
  // poisoning the field.
  if ('currency' in updates && typeof updates.currency === 'string' && updates.currency.length > 0) {
    safe.currency = updates.currency;
  }

  // `id` is intentionally NOT copied — the Map key is authoritative.
  // Swallowing it silently here is preferable to throwing because
  // every other update field is still honored; callers that want to
  // "rename" a template must delete + recreate.

  Object.assign(template, safe);
  saveRecurringTemplates();
  return true;
}

/**
 * Result of a `deleteRecurringTemplate` operation.
 *
 * CR-Apr24-B [P2] finding 41: callers can now distinguish
 *  - full success (template + all linked transactions deleted)
 *  - partial success (template still present, some transactions failed
 *    to delete, others succeeded — retry the same call to clean up)
 *  - not-found (template id didn't exist)
 *
 * Pre-fix the function returned only `boolean` and threw on the first
 * delete failure inside the `for...of` loop, leaving:
 *   - some transactions deleted, some not
 *   - the template record still present
 *   - the caller without a way to know which transactions succeeded
 *     beyond inspecting the ledger themselves.
 *
 * The boolean return is preserved for back-compat: `deletedCount === toDeleteCount`
 * AND `template` removed → still returns true to existing callers via a
 * companion overload below.
 */
export interface DeleteRecurringTemplateResult {
  /** True only if the template record was actually removed. */
  ok: boolean;
  /** Total candidate transactions identified for deletion. */
  toDeleteCount: number;
  /** How many were successfully deleted. */
  deletedCount: number;
  /** Per-transaction failures (id + reason). Empty on full success. */
  failures: Array<{ transactionId: string; error: string }>;
}

/**
 * Delete a recurring template (with option to keep/delete existing transactions).
 *
 * CR-Apr24-B [P2] finding 41: deletion is now best-effort with structured
 * partial-failure reporting. Each transaction delete is wrapped in its
 * own try/catch so one failure doesn't abort the rest of the cleanup;
 * the template record is removed only if every linked transaction was
 * successfully deleted (so a retry of the same call by the caller will
 * pick up where it left off). On partial failure, the caller receives
 * the list of failed transaction ids and the template stays in place
 * for a clean retry.
 */
export async function deleteRecurringTemplate(
  id: string,
  deleteExisting: boolean = false
): Promise<DeleteRecurringTemplateResult> {
  const template = recurringTemplates.get(id);
  if (!template) {
    return { ok: false, toDeleteCount: 0, deletedCount: 0, failures: [] };
  }

  let deletedCount = 0;
  const failures: Array<{ transactionId: string; error: string }> = [];
  let toDelete: Transaction[] = [];

  if (deleteExisting) {
    // Delete associated transactions BEFORE removing the template,
    // so if deletion fails, the template link still exists for retry.
    const allTx = await dataSdk.getAll();
    toDelete = allTx.filter(
      (tx: Transaction) => tx.recurringTemplateId === id
    );
    for (const tx of toDelete) {
      try {
        await dataSdk.delete(tx);
        deletedCount++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({
          transactionId: tx.__backendId ?? '<unknown>',
          error: reason
        });
        if (import.meta.env.DEV) {
          console.error(
            `[recurring] Failed to delete transaction ${tx.__backendId} for template ${id}: ${reason}`
          );
        }
      }
    }
  }

  // Only remove the template record if no per-transaction deletions
  // failed — leaving it intact lets the user retry the same delete and
  // pick up the residual failed rows. If deleteExisting is false, we
  // never had any to delete, so always safe to remove.
  if (failures.length === 0) {
    recurringTemplates.delete(id);
    saveRecurringTemplates();
    return {
      ok: true,
      toDeleteCount: toDelete.length,
      deletedCount,
      failures
    };
  }

  return {
    ok: false,
    toDeleteCount: toDelete.length,
    deletedCount,
    failures
  };
}

// ==========================================
// OCCURRENCE GENERATION
// ==========================================

/**
 * Per-template mutex: concurrent callers of `generateNextOccurrence` for
 * the same template share the same in-flight promise, preventing the
 * classic read-modify-write race where two schedulers (e.g. the visibility
 * tick and an explicit user trigger) both see `lastGeneratedDate=X`, both
 * compute the same `nextDate`, and both call `dataSdk.create()` →
 * duplicate transactions with identical `recurringTemplateId` and date.
 *
 * Fixes C11 (Inline-Behavior-Review rev 12).
 */
const _operationMutex = new Map<string, Promise<Transaction | null>>();

/**
 * Generate the next occurrence of a recurring template
 * FIXED: Uses dataSdk.create() for consistent dual-backend persistence
 * FIXED: Serializes concurrent invocations per template (C11)
 */
export async function generateNextOccurrence(template: RecurringTemplate): Promise<Transaction | null> {
  // If a generation for this template is already in flight, join it.
  const inFlight = _operationMutex.get(template.id);
  if (inFlight) return inFlight;

  const pending = _generateNextOccurrenceInner(template)
    .finally(() => {
      // Release the slot regardless of outcome so retries after failure
      // can proceed. If the slot currently holds a different promise
      // (shouldn't happen, but defensive), don't clobber it.
      if (_operationMutex.get(template.id) === pending) {
        _operationMutex.delete(template.id);
      }
    });
  _operationMutex.set(template.id, pending);
  return pending;
}

async function _generateNextOccurrenceInner(template: RecurringTemplate): Promise<Transaction | null> {
  if (!template.active) return null;

  const now = new Date();
  const endDate = parseLocalDate(template.endDate);

  // Calculate next occurrence date
  const nextDate = calculateNextOccurrenceDate(template);

  // Check if we've passed the end date
  if (nextDate > endDate) {
    template.active = false;
    saveRecurringTemplates();
    return null;
  }

  // Check if it's time to generate this occurrence (within 30 days)
  const daysUntil = Math.floor((nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntil > 30) return null; // Don't generate too far in advance

  const dateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

  // De-dup: if a transaction for this template+date already exists (from
  // a previous partial success, a cross-tab race that made it past the
  // mutex, or a manual edit), return it instead of creating a duplicate.
  // This belt-and-suspenders check paired with the mutex above closes the
  // last window where a duplicate could leak through.
  try {
    const existing = await dataSdk.getAll();
    const dup = existing.find(
      tx => tx.recurringTemplateId === template.id && tx.date === dateStr
    );
    if (dup) {
      if (import.meta.env.DEV) console.debug(`[recurring] De-duped occurrence for template ${template.id} on ${dateStr}`);
      // Still advance lastGeneratedDate so the scheduler moves on.
      template.lastGeneratedDate = dateStr;
      saveRecurringTemplates();
      return dup;
    }
  } catch (err) {
    // If the de-dup read fails we fall through to create; the mutex still
    // protects the common case and a duplicate is preferable to never
    // generating at all.
    if (import.meta.env.DEV) console.warn('[recurring] De-dup read failed, proceeding with create:', err);
  }

  // Create the transaction via SDK for atomicity and validation.
  // CR-Apr24-B [P2] finding 43: prefer the template's stored currency
  // over the live signal so a global currency change doesn't silently
  // re-denominate future occurrences. Falls back to signal/USD only for
  // pre-upgrade templates that predate the field.
  const occurrenceCurrency = template.currency ?? signals.currency.value?.home ?? 'USD';
  const result = await dataSdk.create({
    type: template.type,
    category: template.category,
    amount: template.amount,
    description: template.description,
    tags: template.tags,
    notes: template.notes,
    date: dateStr,
    currency: occurrenceCurrency,
    recurring: true,
    recurring_type: template.recurringType,
    recurring_end: template.endDate,
    reconciled: false,
    // Add custom metadata to link back to template
    recurringTemplateId: template.id
  });

  if (!result.isOk || !result.data) {
    if (import.meta.env.DEV) console.error('Failed to generate recurring transaction:', result.error);
    return null;
  }

  // Update template state only after successful creation
  template.lastGeneratedDate = dateStr;
  saveRecurringTemplates();

  return result.data;
}

/**
 * Calculate the next occurrence date for a template
 * FIXED: Properly handles month-end dates without drift
 */
function calculateNextOccurrenceDate(template: RecurringTemplate): Date {
  // If no occurrences have been generated yet, the first occurrence IS the start date
  if (!template.lastGeneratedDate) {
    return parseLocalDate(template.startDate);
  }

  const lastDate = parseLocalDate(template.lastGeneratedDate);
  const nextDate = new Date(lastDate);
  
  switch (template.recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
      
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
      
    case 'biweekly':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
      
    case 'monthly': {
      // FIXED: Use original day of month to prevent drift
      const nextMonth = nextDate.getMonth() + 1;
      const nextYear = nextDate.getFullYear() + (nextMonth > 11 ? 1 : 0);
      const actualMonth = nextMonth % 12;
      const maxDay = new Date(nextYear, actualMonth + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, actualMonth, targetDay);
    }
    
    case 'quarterly': {
      // FIXED: Properly handle year wrap-around for quarterly
      let nextMonth = nextDate.getMonth() + 3;
      let nextYear = nextDate.getFullYear();
      
      if (nextMonth > 11) {
        nextYear += Math.floor(nextMonth / 12);
        nextMonth = nextMonth % 12;
      }
      
      const maxDay = new Date(nextYear, nextMonth + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, nextMonth, targetDay);
    }
    
    case 'yearly': {
      // FIXED: Consistent year increment
      const nextYear = nextDate.getFullYear() + 1;
      const month = nextDate.getMonth();
      const maxDay = new Date(nextYear, month + 1, 0).getDate();
      const targetDay = Math.min(template.originalDayOfMonth, maxDay);
      return new Date(nextYear, month, targetDay);
    }
  }
  
  return nextDate;
}

// ==========================================
// DAILY PROCESSING
// ==========================================

/**
 * Maximum catch-up occurrences per template per processing run.
 *
 * CR-Apr24-B [P2] finding 42: bumped from 100 → 2000 so a template that
 * has been dormant for several years (vacation, app uninstalled, device
 * lost) can fully catch up. Daily cadence × 365 days × 5 years = 1825,
 * comfortably under 2000. The cap is still a safety net — if it ever
 * trips on a real run, the DEV warning below points at the responsible
 * template so a developer can investigate (typical cause: a bug in
 * `calculateNextOccurrenceDate` that fails to advance `lastGeneratedDate`,
 * which would loop forever without the cap).
 *
 * Note that the per-occurrence early-exit in `generateNextOccurrence`
 * (`daysUntil > 30 → return null`) bounds normal runs at "occurrences
 * within the next 30 days" regardless of the cap, so this only affects
 * deep catch-up scenarios.
 */
const CATCH_UP_CEILING = 2000;

/**
 * Process all recurring templates to generate due occurrences.
 * Should be called daily (on app load or via a scheduled job).
 *
 * CR-Apr24-B [P2] findings 42, 44: cap raised to 2000 (was 100, leaving
 * long-overdue series stranded), and per-template processing is wrapped
 * in try/catch so one template's failure doesn't abort the rest of the
 * run. Returns the count of occurrences generated AND the count of
 * templates that errored, so callers can surface a partial-success
 * outcome rather than a silent abort halfway through.
 */
export interface ProcessRecurringResult {
  generated: number;
  templatesProcessed: number;
  templatesErrored: number;
  capHits: number;
}

export async function processRecurringTemplates(): Promise<ProcessRecurringResult> {
  let generated = 0;
  let templatesProcessed = 0;
  let templatesErrored = 0;
  let capHits = 0;

  for (const template of recurringTemplates.values()) {
    if (!template.active) continue;
    templatesProcessed++;

    // CR-Apr24-B [P2] finding 44: isolate per-template failures. Pre-fix
    // a single throw inside `generateNextOccurrence` (e.g. a transient
    // dataSdk error, a malformed date) aborted the entire `for...of`,
    // skipping every subsequent template until the next run — a single
    // bad template could block a healthy fleet for the entire day. Now
    // each template gets its own try/catch and the run continues.
    try {
      let attempts = 0;
      while (attempts < CATCH_UP_CEILING) {
        const tx = await generateNextOccurrence(template);
        if (!tx) break;
        generated++;
        attempts++;
      }
      if (attempts >= CATCH_UP_CEILING) {
        capHits++;
        if (import.meta.env.DEV) {
          console.warn(
            `[recurring] Template ${template.id} hit catch-up ceiling (${CATCH_UP_CEILING}). ` +
            `Possible runaway — verify lastGeneratedDate is advancing.`
          );
        }
      }
    } catch (err) {
      templatesErrored++;
      if (import.meta.env.DEV) {
        console.error(
          `[recurring] Template ${template.id} errored during catch-up: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }
  }

  return { generated, templatesProcessed, templatesErrored, capHits };
}

// ==========================================
// MIGRATION
// ==========================================

// migrateToTemplateSystem removed - was never imported/used.
// Migration logic should go through migration.ts for centralized tracking.

// ==========================================
// INITIALIZATION
// ==========================================

// Load templates on module import
loadRecurringTemplates();

// RECURRING key already exists in SK
