/**
 * Category Store Module
 *
 * Manages user-owned categories backed by localStorage.
 * On first launch (or migration from hardcoded), seeds from a preset.
 * After that, the user fully owns their category list.
 *
 * @module category-store
 */
'use strict';

import { signal, computed } from '@preact/signals-core';
import { SK, getStored, persist } from './state.js';
import { getDefaultPreset, getPresetById, buildPresetMigrationMap, type CategoryPreset } from './category-presets.js';
import * as signals from './signals.js';
import { Events, emit } from './event-bus.js';
import { queueEvent } from './actions/action-utils.js';
import { generateSecureId } from './utils-dom.js';
import { dataSdk } from '../data/data-manager.js';
// CR-Apr22-E finding: after persisting SK.RECURRING inside the orphan
// sweep, the in-memory `recurringTemplates` map in this module is still
// holding the pre-delete category ids. Reload right after persist so the
// scheduler (which reads the in-memory map, not storage) stops emitting
// occurrences under the deleted id without waiting for a page reload.
import { loadRecurringTemplates } from '../data/recurring-templates.js';
import type {
  CategoryChild,
  FlattenedCategory,
  UserCategory,
  UserCategoryConfig,
  CustomCategory,
  Transaction,
  TxTemplate,
  RolloverSettings
} from '../../types/index.js';

// ==========================================
// CURRENT CONFIG VERSION
// ==========================================

const CONFIG_VERSION = 1;

// ==========================================
// SIGNALS
// ==========================================

/**
 * The user's full category configuration.
 * null means not yet initialized (first launch or migration needed).
 *
 * Fixes L45 (Inline-Behavior-Review rev 12): the eager `getStored` used to
 * run at module-load time, which (a) bypassed the C6 `isUserCategoryConfig`
 * validator that all other entry points now go through (`applyKeyUpdate`
 * and the H8 hardened storage-events path), and (b) duplicated the read
 * that `hydrateAllSignals` already performs via SIGNAL_MAPPINGS. The
 * signal now starts at `null`; boot-time hydration is the single
 * authoritative load path.
 */
export const userCategoryConfig = signal<UserCategoryConfig | null>(null);

/**
 * Rev 13 L73 (Inline-Behavior-Review): shallow structural validator for
 * externally-sourced `UserCategoryConfig` payloads. Guards three entry
 * points against malformed data:
 *
 *   1. `applyKeyUpdate(SK.USER_CATS, value)` — remote tab sync.
 *   2. `buildImportState` — JSON import / backup restore.
 *   3. `SIGNAL_MAPPINGS[SK.USER_CATS]` — the identity transformer used
 *      by `hydrateFromImport`, now replaced with this validator.
 *
 * Before this guard, all three accepted any plain object. A corrupted
 * backup like `{userCategories: {foo: 1}}` would persist and hydrate,
 * and the next `config.expense.filter(...)` call downstream would
 * throw. The validator is deliberately shallow — per-item category
 * validation stays in category-store where the rich type is known.
 */
export function isUserCategoryConfigShape(v: unknown): v is UserCategoryConfig {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version)) return false;
  if (!Array.isArray(obj.expense)) return false;
  if (!Array.isArray(obj.income)) return false;
  if (obj.presetId !== undefined && typeof obj.presetId !== 'string') return false;
  return true;
}

// ==========================================
// INITIALIZATION & MIGRATION
// ==========================================

/**
 * Initialize the category store.
 * Handles first-launch seeding and migration from old custom categories.
 * Returns true if this is a fresh install (needs onboarding preset picker).
 */
export function initCategoryStore(): boolean {
  const existing = userCategoryConfig.value;

  if (existing && existing.version >= CONFIG_VERSION) {
    // Already initialized and up to date
    return false;
  }

  // Check if there are legacy custom categories to migrate
  const legacyCustomCats = getStored<CustomCategory[]>(SK.CUSTOM_CAT);
  const hasLegacyData = legacyCustomCats && legacyCustomCats.length > 0;

  // Check if there are any transactions (existing user vs fresh install)
  const hasTx = getStored<unknown[]>(SK.TX);
  const isExistingUser = (hasTx && hasTx.length > 0) || hasLegacyData;

  if (isExistingUser && !existing) {
    // Existing user — auto-migrate to Personal preset + their custom cats
    migrateFromLegacy(legacyCustomCats || []);
    return false; // Don't show preset picker for existing users
  }

  if (!existing) {
    // Brand new user — seed with Personal preset as default
    // (the onboarding picker can change this)
    applyPreset('personal');
    return true; // Show preset picker
  }

  return false;
}

/**
 * Pure conversion from legacy `CustomCategory[]` to a modern
 * `UserCategoryConfig` seeded from the default preset.
 *
 * Extracted from `migrateFromLegacy` (see rev 13 L70 / Inline-Behavior-Review)
 * so the import-export module can reuse the exact same shape when ingesting
 * a legacy backup. Previously the import path had no compat branch for
 * `customCategories[]`, so older backups silently reset USER_CATS to `null`
 * on overwrite and stranded any transactions/budgets that referenced
 * user-defined category IDs. Keeping ONE source of truth for the legacy →
 * modern shape eliminates the drift risk between boot-time migration and
 * backup import.
 *
 * Pure: does not touch signals or persistence. Callers own the write.
 */
export function buildConfigFromLegacyCustom(
  legacyCustom: CustomCategory[]
): UserCategoryConfig {
  const preset = getDefaultPreset();

  // Convert preset expense cats to UserCategory with order
  const expenseCats: UserCategory[] = preset.expense.map((cat, i) => ({
    id: cat.id,
    name: cat.name,
    emoji: cat.emoji,
    color: cat.color,
    type: 'expense' as const,
    order: i
  }));

  // Convert preset income cats to UserCategory with order
  const incomeCats: UserCategory[] = preset.income.map((cat, i) => ({
    id: cat.id,
    name: cat.name,
    emoji: cat.emoji,
    color: cat.color,
    type: 'income' as const,
    order: i
  }));

  // Merge legacy custom categories
  for (const custom of legacyCustom) {
    const userCat: UserCategory = {
      id: custom.id,
      name: custom.name,
      emoji: custom.emoji,
      color: custom.color,
      type: custom.type,
      order: custom.type === 'expense' ? expenseCats.length : incomeCats.length
    };

    if (custom.type === 'expense') {
      expenseCats.push(userCat);
    } else {
      incomeCats.push(userCat);
    }
  }

  return {
    presetId: 'personal',
    version: CONFIG_VERSION,
    expense: expenseCats,
    income: incomeCats
  };
}

/**
 * Migrate from legacy system (hardcoded cats + custom cats signal).
 * Strips any children arrays from old configs during migration.
 */
function migrateFromLegacy(legacyCustom: CustomCategory[]): void {
  const config = buildConfigFromLegacyCustom(legacyCustom);
  userCategoryConfig.value = config;
  persist(SK.USER_CATS, config);

}

/**
 * Apply a preset, replacing all current categories.
 * Migrates existing allocation and template category IDs to the new preset.
 *
 * Rev 13 L72 (Inline-Behavior-Review): this direct signal write used to
 * skip the CATEGORY_UPDATED event. The trailing `migrateStoredCategoryIds`
 * call *does* emit the event, but only on preset-to-preset switches —
 * the first-apply path (when `oldPresetId` is undefined) and same-preset
 * refreshes both returned without notifying subscribers. Emit
 * unconditionally at the end so `renderCategories`,
 * `populateCategoryFilter`, and `updateInsights` schedule a redraw
 * regardless of the entry path. (If migrateStoredCategoryIds ran it
 * already queued the same event — duplicates collapse in renderScheduler.)
 */
export function applyPreset(presetId: string): void {
  const currentConfig = userCategoryConfig.value;
  const oldPresetId = currentConfig?.presetId;

  const preset = getPresetById(presetId) || getDefaultPreset();
  const config = presetToConfig(preset);
  userCategoryConfig.value = config;
  persist(SK.USER_CATS, config);


  // Migrate stored data if switching between known presets
  if (oldPresetId && oldPresetId !== presetId) {
    migrateStoredCategoryIds(oldPresetId, presetId);
  }

  signals.categoryVersion.value++;  // CR-Apr24-I finding 96
  queueEvent(Events.CATEGORY_UPDATED, undefined);
}

/**
 * Re-map category IDs in allocations, templates, and rollover settings
 * when switching between presets.
 *
 * Fixes M32 (Inline-Behavior-Review rev 12): the previous implementation
 * wrote migrated payloads straight to `persist(...)` without updating the
 * in-memory signals (except for `monthlyAlloc`), and without emitting any
 * domain events. Two consequences:
 *   1. `signals.txTemplates` / `signals.rolloverSettings` stayed stale
 *      after a preset switch within the same tab — UI kept rendering
 *      pre-migration IDs until the next full hydration (page reload).
 *   2. Even the allocation path, which *did* update its signal, skipped
 *      `Events.BUDGET_UPDATED`, so rollups, charts, and analytics
 *      downstream of the event bus missed the change.
 *
 * Fix: update the signal and emit the corresponding event for each key
 * that has an event contract, then emit CATEGORY_UPDATED once at the end
 * so any generic category-aware subscribers resync. Recurring templates
 * have no signal in this codebase, so that path stays persist-only.
 */
function migrateStoredCategoryIds(fromPresetId: string, toPresetId: string): void {
  const migrationMap = buildPresetMigrationMap(fromPresetId, toPresetId);
  if (migrationMap.size === 0) return;

  // 1. Migrate monthly allocations
  const alloc = getStored<Record<string, Record<string, number>>>(SK.ALLOC);
  if (alloc && Object.keys(alloc).length > 0) {
    const migrated: Record<string, Record<string, number>> = {};
    for (const [monthKey, monthAlloc] of Object.entries(alloc)) {
      const newMonth: Record<string, number> = {};
      for (const [catId, amount] of Object.entries(monthAlloc)) {
        const newId = migrationMap.get(catId) || catId;
        // Merge amounts if multiple old IDs map to the same new ID
        newMonth[newId] = (newMonth[newId] || 0) + amount;
      }
      migrated[monthKey] = newMonth;
    }
    persist(SK.ALLOC, migrated);
    signals.monthlyAlloc.value = migrated;
    queueEvent(Events.BUDGET_UPDATED, migrated);
  }

  // 2. Migrate transaction templates
  const templates = getStored<Array<{ category?: string; [k: string]: unknown }>>(SK.TX_TEMPLATES);
  if (templates && templates.length > 0) {
    let changed = false;
    for (const tmpl of templates) {
      if (tmpl.category && migrationMap.has(tmpl.category)) {
        tmpl.category = migrationMap.get(tmpl.category)!;
        changed = true;
      }
    }
    if (changed) {
      persist(SK.TX_TEMPLATES, templates);
      // Propagate to the signal so in-tab consumers see the new IDs without
      // waiting for a reload. The cast here is narrow: the stored shape is
      // TxTemplate-compatible, just typed loosely by the migration helper.
      signals.txTemplates.value = templates as unknown as typeof signals.txTemplates.value;
    }
  }

  // 3. Migrate rollover settings categories
  const rollover = getStored<{ categories?: string[]; [k: string]: unknown }>(SK.ROLLOVER_SETTINGS);
  if (rollover?.categories && rollover.categories.length > 0) {
    let changed = false;
    rollover.categories = rollover.categories.map(catId => {
      const newId = migrationMap.get(catId);
      if (newId) { changed = true; return newId; }
      return catId;
    });
    if (changed) {
      persist(SK.ROLLOVER_SETTINGS, rollover);
      signals.rolloverSettings.value = rollover as unknown as typeof signals.rolloverSettings.value;
    }
  }

  // 4. Migrate recurring templates (no signal — persist-only)
  const recurring = getStored<Record<string, { category?: string; [k: string]: unknown }>>(SK.RECURRING);
  if (recurring && Object.keys(recurring).length > 0) {
    let changed = false;
    for (const tmpl of Object.values(recurring)) {
      if (tmpl.category && migrationMap.has(tmpl.category)) {
        tmpl.category = migrationMap.get(tmpl.category)!;
        changed = true;
      }
    }
    if (changed) persist(SK.RECURRING, recurring);
  }

  // Tell generic category-aware subscribers that the ID space shifted.
  signals.categoryVersion.value++;  // CR-Apr24-I finding 96
  queueEvent(Events.CATEGORY_UPDATED, undefined);
}

/**
 * Merge a preset into existing categories (add missing, keep existing)
 */
export function mergePreset(presetId: string): void {
  const preset = getPresetById(presetId);
  if (!preset) return;

  const current = userCategoryConfig.value;
  if (!current) {
    applyPreset(presetId);
    return;
  }

  const existingExpenseIds = new Set(current.expense.map(c => c.id));
  const existingIncomeIds = new Set(current.income.map(c => c.id));

  let nextExpenseOrder = Math.max(0, ...current.expense.map(c => c.order)) + 1;
  let nextIncomeOrder = Math.max(0, ...current.income.map(c => c.order)) + 1;

  const newExpense = [...current.expense];
  const newIncome = [...current.income];

  for (const cat of preset.expense) {
    if (!existingExpenseIds.has(cat.id)) {
      newExpense.push({
        id: cat.id,
        name: cat.name,
        emoji: cat.emoji,
        color: cat.color,
        type: 'expense',
        order: nextExpenseOrder++
      });
    }
  }

  for (const cat of preset.income) {
    if (!existingIncomeIds.has(cat.id)) {
      newIncome.push({
        id: cat.id,
        name: cat.name,
        emoji: cat.emoji,
        color: cat.color,
        type: 'income',
        order: nextIncomeOrder++
      });
    }
  }

  const config: UserCategoryConfig = {
    ...current,
    expense: newExpense,
    income: newIncome
  };

  userCategoryConfig.value = config;
  persist(SK.USER_CATS, config);

  // Rev 13 L72: mergePreset was another direct-signal-write path that
  // skipped the CATEGORY_UPDATED event contract. Added here for parity
  // with applyPreset / updateConfig.
  signals.categoryVersion.value++;  // CR-Apr24-I finding 96
  queueEvent(Events.CATEGORY_UPDATED, undefined);
}

/**
 * Convert a preset to a UserCategoryConfig
 */
function presetToConfig(preset: CategoryPreset): UserCategoryConfig {
  return {
    presetId: preset.id,
    version: CONFIG_VERSION,
    expense: preset.expense.map((cat, i) => ({
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji,
      color: cat.color,
      type: 'expense' as const,
      order: i
    })),
    income: preset.income.map((cat, i) => ({
      id: cat.id,
      name: cat.name,
      emoji: cat.emoji,
      color: cat.color,
      type: 'income' as const,
      order: i
    }))
  };
}

// ==========================================
// CATEGORY CRUD OPERATIONS
// ==========================================

function saveConfig(): void {
  persist(SK.USER_CATS, userCategoryConfig.value);
}

/**
 * Trigger reactivity by creating a new config reference.
 *
 * Rev 13 L72 (Inline-Behavior-Review): every CRUD surface
 * (addCategory / updateCategory / deleteCategory / reorderCategory /
 * toggleCategoryVisibility) routes through this helper, so the missing
 * CATEGORY_UPDATED emit here silently broke the event-bus contract that
 * `app-events.ts` uses to schedule renderCategories / populateCategoryFilter
 * / updateInsights. Callers (e.g. budget-planner-ui, category-manager)
 * papered over the gap with manual rerenders — partial, duplicated, and
 * inconsistent across the codebase. Centralizing the emit here restores
 * the single source of truth.
 */
function updateConfig(updater: (config: UserCategoryConfig) => void): void {
  const config = userCategoryConfig.value;
  if (!config) return;
  // Clone to trigger signal reactivity
  const updated = {
    ...config,
    expense: [...config.expense],
    income: [...config.income]
  };
  updater(updated);
  userCategoryConfig.value = updated;
  saveConfig();

  signals.categoryVersion.value++;  // CR-Apr24-I finding 96
  queueEvent(Events.CATEGORY_UPDATED, undefined);
}

/**
 * Add a new category
 */
export function addCategory(cat: {
  name: string;
  emoji: string;
  color: string;
  type: 'expense' | 'income';
}): UserCategory {
  // Fixes L44 (Inline-Behavior-Review rev 12): switch from
  // `Date.now()+Math.random()` (predictable, collision-prone under rapid
  // fire) to `generateSecureId()` (crypto.getRandomValues-backed) so
  // user-created category IDs follow the same standard as transaction
  // IDs, savings-goal IDs, and debt IDs.
  // CAT-01: Ensure ID uniqueness against existing categories (defensive;
  // generateSecureId uses crypto.getRandomValues so collisions are near-zero).
  const cfg = userCategoryConfig.value;
  const existingIds = new Set([
    ...(cfg?.expense ?? []).map(c => c.id),
    ...(cfg?.income ?? []).map(c => c.id)
  ]);
  let id = `user_${generateSecureId()}`;
  let guard = 0;
  while (existingIds.has(id) && guard++ < 5) {
    id = `user_${generateSecureId()}`;
  }
  let newCat!: UserCategory;

  updateConfig(config => {
    const list = cat.type === 'expense' ? config.expense : config.income;
    const maxOrder = list.length > 0 ? Math.max(...list.map(c => c.order)) : -1;
    newCat = {
      id,
      name: cat.name,
      emoji: cat.emoji,
      color: cat.color,
      type: cat.type,
      order: maxOrder + 1
    };
    list.push(newCat);
  });

  return newCat;
}

/**
 * Update an existing category
 */
export function updateCategory(catId: string, updates: Partial<Pick<UserCategory, 'name' | 'emoji' | 'color' | 'hidden'>>): void {
  updateConfig(config => {
    const lists = [config.expense, config.income];
    for (const list of lists) {
      const idx = list.findIndex(c => c.id === catId);
      if (idx !== -1) {
        // Phase 6 Slice 1i (rev 12 L6): `list[idx]` is
        // `UserCategory | undefined` under `noUncheckedIndexedAccess`;
        // the `idx !== -1` guard guarantees presence, but a local pull
        // keeps the spread target well-typed.
        const existing = list[idx];
        if (!existing) return;
        list[idx] = { ...existing, ...updates };
        return;
      }
    }
  });
}

/**
 * Delete a category from the USER_CATS config only.
 *
 * WARNING: leaves orphaned references in monthly allocations, transaction
 * templates, rollover settings, recurring templates, and transaction rows.
 * Prefer `deleteCategoryWithCleanup` in any user-facing path — this raw
 * helper remains for the pure event-contract surface and tests.
 */
export function deleteCategory(catId: string): void {
  updateConfig(config => {
    config.expense = config.expense.filter(c => c.id !== catId);
    config.income = config.income.filter(c => c.id !== catId);
  });
}

// ==========================================
// CR-Apr22-B slice 1 — delete-with-cleanup orchestrator
// ==========================================

/**
 * Result of a successful `deleteCategoryWithCleanup` — surfaces enough detail
 * for callers to build a single "Reassigned N transactions / M templates"
 * toast without a second scan of storage.
 */
export interface DeleteCategoryCleanupResult {
  ok: true;
  deletedCatId: string;
  deletedCatName: string;
  catType: 'expense' | 'income';
  fallbackCatId: string;
  fallbackCatName: string;
  txMigrated: number;
  templatesMigrated: number;
  recurringMigrated: number;
  allocationMonthsStripped: number;
  rolloverStripped: boolean;
}

/**
 * Failure variants. `not_found` means the catId isn't in the current config.
 * `last_category_of_type` means deleting it would leave zero fallbacks
 * (a stuck state — the UI should refuse and prompt the user to add a
 * replacement first). `tx_persist_failed` means orphan cleanup succeeded for
 * USER_CATS / allocations / templates / recurring / rollover but the
 * transaction batch rewrite failed — the category is gone but transaction
 * rows still reference the deleted id. Callers should surface this as a
 * recoverable error and prompt for a reload.
 */
export interface DeleteCategoryCleanupError {
  ok: false;
  error: 'not_found' | 'last_category_of_type' | 'tx_persist_failed';
  message: string;
}

export type DeleteCategoryCleanupOutcome =
  | DeleteCategoryCleanupResult
  | DeleteCategoryCleanupError;

/**
 * Pick the best fallback category for orphaned references after a deletion.
 *
 * Strategy (three tiers, each preferring more user-visible categories):
 *   1. A VISIBLE (`!hidden`) category whose id starts with `other` — every
 *      built-in preset (personal, business, household, freelance) defines
 *      one, and it's the user-visible "Other" bucket that every user
 *      understands is for miscellaneous entries.
 *   2. The first VISIBLE remaining category of the same type.
 *   3. Only if nothing visible exists at all, fall through to the first
 *      remaining category even if hidden — the alternative is returning
 *      `null` and blocking the delete, which is worse UX.
 *
 * CR-Apr22-E finding: the original implementation only excluded the
 * deleted id itself — if the user had hidden their "Other" bucket, a
 * subsequent delete would silently remap transactions into that hidden
 * category, burying the migrated data behind the visibility filter. The
 * hidden-aware traversal above means every happy-path delete lands in a
 * category the user can actually see in their default filters.
 *
 * Returns `null` when zero candidates remain (i.e., the type has only
 * the category being deleted); callers must refuse the delete in that case.
 *
 * Exported for tests and for the identical fallback-picking behavior
 * needed by the import/merge path if it ever needs to repair a payload
 * missing a referenced category id.
 */
export function pickFallbackCategoryId(
  config: UserCategoryConfig,
  catType: 'expense' | 'income',
  deletedCatId: string
): UserCategory | null {
  const list = catType === 'expense' ? config.expense : config.income;
  const candidates = list.filter(c => c.id !== deletedCatId);
  if (candidates.length === 0) return null;

  const visible = candidates.filter(c => !c.hidden);

  // Tier 1: visible "other*".
  const visibleOther = visible.find(c => c.id.startsWith('other'));
  if (visibleOther) return visibleOther;

  // Tier 2: first visible category.
  if (visible.length > 0) {
    const first = visible[0];
    if (first) return first;
  }

  // Tier 3: last-resort — all remaining cats are hidden. Surface one anyway
  // so the delete can succeed; the user will still be able to unhide it
  // from Settings. `candidates[0]` is guaranteed present by the length
  // guard above, but `noUncheckedIndexedAccess` widens it to `T | undefined`.
  const anyCandidate = candidates[0];
  return anyCandidate ?? null;
}

/**
 * Delete a category and sweep every storage key that references it so the
 * app never renders "Unknown" rows or carries zombie allocation entries.
 *
 * Background (CR-Apr22-B slice 1): before this function existed, both
 * delete sites (`components/category-manager.ts:handleDeleteCategory` and
 * `ui/core/ui-render.ts:handleDeleteCustomCat`) diverged:
 *   - `category-manager` called raw `deleteCategory(catId)` and did nothing
 *     else — transactions, templates, recurring series, rollover selections,
 *     and the allocation map kept stale references; UIs downstream of
 *     `getCatInfo` rendered "Unknown ❓" until the user manually fixed each
 *     row.
 *   - `ui-render.handleDeleteCustomCat` cleaned allocations + remapped
 *     transactions to a hardcoded `'other'` / `'other_income'`, but
 *     (a) those ids don't exist on the business/household/freelance presets
 *     (the fallback itself became a phantom id), and (b) templates,
 *     recurring templates, and the rollover `categories` list were skipped.
 *
 * Centralising the sweep here mirrors the `migrateStoredCategoryIds`
 * pattern already used for preset switching — same four stores + the
 * transaction ledger, same signal-update + event-emit contract. Differences:
 *   * remap target is a RUNTIME-picked fallback (see `pickFallbackCategoryId`)
 *     not a preset map, so we survive every category-preset combination;
 *   * transactions are rewritten through `dataSdk.replaceAllTransactions`
 *     rather than raw `persist`, so the write goes through the durable
 *     storage manager (same path as import/restore);
 *   * rollover `categories[]` is STRIPPED not remapped, because an
 *     exhausted selection is indistinguishable from a user unchecking the
 *     entry (and remapping would quietly enable rollover for a category
 *     the user never opted into).
 *
 * Atomicity — CR-Apr22-D finding: the prior ordering (persist ALL side
 * stores, then delete USER_CATS, then rewrite transactions) left a
 * half-deleted state on `replaceAllTransactions` failure — category gone,
 * allocations stripped, templates rewritten, but transaction rows still
 * pointing at a phantom id. Reordering so the transaction rewrite (the
 * only fallible async step) runs FIRST turns the rest into "only commit on
 * success" — if transactions fail, no other store has been mutated and the
 * category is still present for the user to retry. The sweep is now:
 *
 *   1. snapshot fallback + build the rewritten transaction ledger (no
 *      mutation yet — purely computed).
 *   2. if tx batch is non-empty → await `dataSdk.replaceAllTransactions`.
 *      On failure, bail with `tx_persist_failed` — nothing else has moved.
 *      On success, emit TRANSACTIONS_REPLACED.
 *   3. strip allocations (signal + persist, fires BUDGET_UPDATED).
 *   4. remap transaction templates (signal + persist).
 *   5. strip rollover `categories[]` (signal + persist).
 *   6. remap recurring templates (persist-only, no signal).
 *   7. remove from USER_CATS via `deleteCategory` (fires CATEGORY_UPDATED).
 *
 * Steps 3–7 are all synchronous signal/localStorage writes — if any
 * individual step throws we still exit in a mostly-consistent state, but
 * the failure-prone cross-layer call is gated behind success.
 */
export async function deleteCategoryWithCleanup(
  catId: string
): Promise<DeleteCategoryCleanupOutcome> {
  const config = userCategoryConfig.value;
  if (!config) {
    return {
      ok: false,
      error: 'not_found',
      message: 'Category configuration not initialized.'
    };
  }

  // Look up the target BEFORE mutation so we keep the original name/type
  // for the toast even after the sweep has finished.
  const target =
    config.expense.find(c => c.id === catId) ||
    config.income.find(c => c.id === catId) ||
    null;
  if (!target) {
    return {
      ok: false,
      error: 'not_found',
      message: `Category "${catId}" not found in current configuration.`
    };
  }

  const catType = target.type;

  const fallback = pickFallbackCategoryId(config, catType, catId);
  if (!fallback) {
    return {
      ok: false,
      error: 'last_category_of_type',
      message: `Cannot delete the only remaining ${catType} category. Add another ${catType} category first.`
    };
  }

  const fallbackCatId = fallback.id;
  const fallbackCatName = fallback.name;

  // -------- 1. Build rewritten transaction ledger (no mutation yet) ---
  // Computing this up-front (before we touch any other store) is what
  // makes the flow atomic: if the only fallible step (`replaceAllTransactions`)
  // fails, we bail before any visible state change.
  let txMigrated = 0;
  const currentTx = signals.transactions.value;
  let migratedTx: Transaction[] | null = null;
  if (Array.isArray(currentTx) && currentTx.length > 0) {
    let txChanged = false;
    const noteTag = `[Original Category: ${target.name}]`;
    const next: Transaction[] = currentTx.map(t => {
      if (t.category === catId) {
        txChanged = true;
        txMigrated++;
        return {
          ...t,
          category: fallbackCatId,
          notes: t.notes ? `${t.notes}\n${noteTag}` : noteTag
        };
      }
      return t;
    });
    if (txChanged) migratedTx = next;
  }

  // -------- 2. Commit transactions first (the one async/fallible step) -
  if (migratedTx) {
    const result = await dataSdk.replaceAllTransactions(migratedTx);
    if (!result.isOk) {
      return {
        ok: false,
        error: 'tx_persist_failed',
        message: 'Could not update transactions for this category. No changes were made; try again or reload the page.'
      };
    }
    emit(Events.TRANSACTIONS_REPLACED);
  }

  // From here on, every step is a synchronous signal+localStorage write.
  // Ordering is strictly "fan out from least-visible to most-visible":
  // allocations/templates/rollover/recurring all mutate adjacent stores
  // that will be swept up by the final CATEGORY_UPDATED event in step 7.

  // -------- 3. Strip allocations ---------------------------------------
  let allocationMonthsStripped = 0;
  const currentAlloc = signals.monthlyAlloc.value;
  if (currentAlloc && typeof currentAlloc === 'object') {
    const nextAlloc: Record<string, Record<string, number>> = {};
    for (const [monthKey, bucket] of Object.entries(currentAlloc)) {
      if (bucket && typeof bucket === 'object' && catId in bucket) {
        const copy = { ...bucket };
        delete copy[catId];
        nextAlloc[monthKey] = copy;
        allocationMonthsStripped++;
      } else {
        nextAlloc[monthKey] = bucket;
      }
    }
    if (allocationMonthsStripped > 0) {
      signals.monthlyAlloc.value = nextAlloc;
      persist(SK.ALLOC, nextAlloc);
      queueEvent(Events.BUDGET_UPDATED, nextAlloc);
    }
  }

  // -------- 4. Remap transaction templates -----------------------------
  let templatesMigrated = 0;
  const templates = signals.txTemplates.value;
  if (Array.isArray(templates) && templates.length > 0) {
    let changed = false;
    const nextTemplates: TxTemplate[] = templates.map(tmpl => {
      if (tmpl.category === catId) {
        changed = true;
        templatesMigrated++;
        return { ...tmpl, category: fallbackCatId };
      }
      return tmpl;
    });
    if (changed) {
      signals.txTemplates.value = nextTemplates;
      persist(SK.TX_TEMPLATES, nextTemplates);
    }
  }

  // -------- 5. Strip from rollover categories[] ------------------------
  let rolloverStripped = false;
  const rollover = signals.rolloverSettings.value;
  if (rollover && Array.isArray(rollover.categories) && rollover.categories.includes(catId)) {
    const nextRollover: RolloverSettings = {
      ...rollover,
      categories: rollover.categories.filter(id => id !== catId)
    };
    signals.rolloverSettings.value = nextRollover;
    persist(SK.ROLLOVER_SETTINGS, nextRollover);
    rolloverStripped = true;
  }

  // -------- 6. Remap recurring templates -------------------------------
  // The recurring-templates module keeps an in-memory Map that's only
  // rehydrated via `loadRecurringTemplates()` — writing SK.RECURRING alone
  // would leave the scheduler firing under the deleted category id until
  // a page reload (CR-Apr22-E finding). Persist then reload so the
  // generator picks up the remap in this session.
  let recurringMigrated = 0;
  const recurring = getStored<Record<string, { category?: string; [k: string]: unknown }>>(SK.RECURRING);
  if (recurring && typeof recurring === 'object') {
    let changed = false;
    const nextRecurring: Record<string, unknown> = {};
    for (const [key, tmpl] of Object.entries(recurring)) {
      if (tmpl && typeof tmpl === 'object' && tmpl.category === catId) {
        nextRecurring[key] = { ...tmpl, category: fallbackCatId };
        recurringMigrated++;
        changed = true;
      } else {
        nextRecurring[key] = tmpl;
      }
    }
    if (changed) {
      persist(SK.RECURRING, nextRecurring);
      loadRecurringTemplates();
    }
  }

  // -------- 7. Remove from USER_CATS (last, fires CATEGORY_UPDATED) ---
  // Deferred to the end so every subscriber that re-renders on this event
  // already sees consistent ALLOC / TX_TEMPLATES / ROLLOVER / RECURRING.
  deleteCategory(catId);

  return {
    ok: true,
    deletedCatId: catId,
    deletedCatName: target.name,
    catType,
    fallbackCatId,
    fallbackCatName,
    txMigrated,
    templatesMigrated,
    recurringMigrated,
    allocationMonthsStripped,
    rolloverStripped
  };
}

/**
 * Reorder a category (move to new position)
 */
export function reorderCategory(catId: string, newOrder: number): void {
  updateConfig(config => {
    const lists = [config.expense, config.income];
    for (const list of lists) {
      const idx = list.findIndex(c => c.id === catId);
      if (idx !== -1) {
        // Recompute orders.
        // Phase 6 Slice 1i (rev 12 L6): `splice(...)[0]` is
        // `UserCategory | undefined` under `noUncheckedIndexedAccess`;
        // the `findIndex` hit above guarantees the splice removes a
        // concrete element, but a local guard keeps the second splice
        // call type-safe without a non-null assertion.
        const sorted = [...list].sort((a, b) => a.order - b.order);
        const removeIdx = sorted.findIndex(c => c.id === catId);
        if (removeIdx === -1) return;
        const item = sorted.splice(removeIdx, 1)[0];
        if (!item) return;
        sorted.splice(newOrder, 0, item);
        sorted.forEach((c, i) => {
          const original = list.find(o => o.id === c.id);
          if (original) original.order = i;
        });
        return;
      }
    }
  });
}

/**
 * Toggle category visibility
 */
export function toggleCategoryVisibility(catId: string): void {
  updateConfig(config => {
    const lists = [config.expense, config.income];
    for (const list of lists) {
      const cat = list.find(c => c.id === catId);
      if (cat) {
        cat.hidden = !cat.hidden;
        return;
      }
    }
  });
}

// ==========================================
// COMPUTED ACCESSORS (compatible with old API)
// ==========================================

/**
 * Sorted expense categories (respecting order, excluding hidden)
 */
export const expenseCategories = computed((): CategoryChild[] => {
  const config = userCategoryConfig.value || presetToConfig(getDefaultPreset());
  return config.expense
    .filter(c => !c.hidden)
    .sort((a, b) => a.order - b.order)
    .map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      color: c.color
    }));
});

/**
 * Sorted income categories (respecting order, excluding hidden)
 */
export const incomeCategories = computed((): CategoryChild[] => {
  const config = userCategoryConfig.value || presetToConfig(getDefaultPreset());
  return config.income
    .filter(c => !c.hidden)
    .sort((a, b) => a.order - b.order)
    .map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      color: c.color
    }));
});

/**
 * All categories indexed by ID for O(1) lookup (compatible with old indexedCategories)
 */
export const indexedUserCategories = computed((): Map<string, FlattenedCategory> => {
  const config = userCategoryConfig.value || presetToConfig(getDefaultPreset());

  const index = new Map<string, FlattenedCategory>();

  for (const cat of config.expense) {
    index.set(cat.id, { ...cat, type: 'expense' });
  }

  for (const cat of config.income) {
    index.set(cat.id, { ...cat, type: 'income' });
  }

  return index;
});

/**
 * All expense categories including hidden (for Settings UI)
 */
export const allExpenseCategories = computed((): UserCategory[] => {
  const config = userCategoryConfig.value || presetToConfig(getDefaultPreset());
  return [...config.expense].sort((a, b) => a.order - b.order);
});

/**
 * All income categories including hidden (for Settings UI)
 */
export const allIncomeCategories = computed((): UserCategory[] => {
  const config = userCategoryConfig.value || presetToConfig(getDefaultPreset());
  return [...config.income].sort((a, b) => a.order - b.order);
});
