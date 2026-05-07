/**
 * Category Manager Component
 *
 * Full category management UI for Settings.
 * Supports add/edit/delete/reorder categories,
 * preset switching, and visibility toggles.
 *
 * @module components/category-manager
 */
'use strict';

import { html, render, nothing } from '../core/lit-helpers.js';
import { CATEGORY_PRESETS, getPresetById } from '../core/category-presets.js';
import {
  userCategoryConfig,
  allExpenseCategories,
  allIncomeCategories,
  addCategory,
  updateCategory,
  deleteCategoryWithCleanup,
  toggleCategoryVisibility,
  reorderCategory,
  applyPreset
} from '../core/category-store.js';
import { DEFAULT_CATEGORY_COLOR } from '../core/categories.js';
import type { UserCategory } from '../../types/index.js';

// ==========================================
// STATE
// ==========================================

let editingCatId: string | null = null;
let activeTab: 'expense' | 'income' = 'expense';
let previewingPresetId: string | null = null;
let onChangeCallback: (() => void) | null = null;
// Round 7 fix: Guard flag to prevent concurrent preset deletion operations
let isProcessing: boolean = false;

/**
 * CR-Apr24-I finding 49: hold a not-yet-persisted category while the
 * user edits the color/emoji/name in the inline form. Previously
 * `handleAddCategory` called `addCategory()` immediately (which persists
 * via `updateConfig` → `saveConfig`), then opened the edit form. If the
 * user clicked Cancel the category was already in localStorage + the
 * reactive signal, so "Cancel" was really "keep a half-configured row."
 *
 * Now: the add flow stores a transient `PendingNewCat` here, renders it
 * as a fake row in the edit form, and only calls `addCategory()` when
 * Save is clicked. Cancel discards the pending object — nothing persisted.
 */
interface PendingNewCat {
  name: string;
  emoji: string;
  color: string;
  type: 'expense' | 'income';
}
let pendingNewCat: PendingNewCat | null = null;

interface CategoryManagerDialogs {
  confirm(options: {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'info' | 'warning' | 'danger';
    details?: string;
  }): Promise<boolean>;
  alert(options: {
    title?: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'error';
    buttonText?: string;
  }): Promise<void>;
  prompt(message: string, title?: string, defaultValue?: string, placeholder?: string): Promise<string | null>;
}

function browserConfirm(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message));
}

function browserAlert(message: string): Promise<void> {
  window.alert(message);
  return Promise.resolve();
}

function browserPrompt(message: string, defaultValue: string): Promise<string | null> {
  return Promise.resolve(window.prompt(message, defaultValue));
}

// Design-Review-Apr21 P2: the add + edit flows previously only checked for
// non-empty names; two users could each create "Groceries" under expenses
// and the list, planner rows, filter dropdowns, and reports would show
// indistinguishable entries keyed by different ids. Enforce per-type name
// uniqueness (case-insensitive + trimmed) at both creation and rename, and
// allow the edit flow to exclude the category being edited so re-saving an
// unchanged name is still permitted.
function findDuplicateCategoryName(
  name: string,
  type: 'expense' | 'income',
  excludeId: string | null = null
): UserCategory | null {
  const list = type === 'expense' ? allExpenseCategories.value : allIncomeCategories.value;
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return list.find(c => c.id !== excludeId && c.name.trim().toLowerCase() === needle) ?? null;
}

let dialogs: CategoryManagerDialogs = {
  confirm: async ({ title, message, details }) => browserConfirm([title, message, details].filter(Boolean).join('\n\n')),
  alert: async ({ title, message }) => browserAlert([title, message].filter(Boolean).join('\n\n')),
  prompt: async (message, title = 'Enter Value', defaultValue = '') =>
    browserPrompt([title, message].filter(Boolean).join('\n\n'), defaultValue)
};

// ==========================================
// MAIN RENDER
// ==========================================

/**
 * Mount the category manager into a container
 */
export function mountCategoryManager(
  containerId: string,
  onChange?: () => void,
  dialogOverrides?: Partial<CategoryManagerDialogs>
): () => void {
  onChangeCallback = onChange || null;
  if (dialogOverrides) {
    dialogs = { ...dialogs, ...dialogOverrides };
  }
  renderCategoryManager(containerId);

  return () => {
    const el = document.getElementById(containerId);
    if (el) {
      render(nothing, el);
    }
    onChangeCallback = null;
    editingCatId = null;
    activeTab = 'expense';
    previewingPresetId = null;
    pendingNewCat = null;
  };
}

function renderCategoryManager(containerId: string): void {
  const el = document.getElementById(containerId);
  if (!el) return;

  const config = userCategoryConfig.value;
  if (!config) return;

  const expenses = allExpenseCategories.value;
  const incomes = allIncomeCategories.value;
  const cats = activeTab === 'expense' ? expenses : incomes;

  render(html`
    <!-- Preset Selector -->
    <div class="catmgr-presets">
      <p class="catmgr-section-label">Category Preset</p>
      <div class="catmgr-preset-grid">
        ${CATEGORY_PRESETS.map(p => {
          const isActive = config.presetId === p.id;
          const isPreviewing = previewingPresetId === p.id;
          return html`
            <button
              class="catmgr-preset-btn ${isActive ? 'catmgr-preset-btn--active' : ''} ${isPreviewing ? 'catmgr-preset-btn--previewing' : ''}"
              @click=${() => {
                // CR-Apr22-B slice 2 (Finding #3): previously `if (isActive) return;`
                // locked users out of inspecting the preset they were already on —
                // so the "Reset to Defaults" affordance in the preview panel was
                // unreachable for a diverged active preset. Toggle the preview for
                // active presets too; the preview's apply button invokes
                // `handlePresetClick`, which is now divergence-aware.
                previewingPresetId = isPreviewing ? null : p.id;
                renderCategoryManager(containerId);
              }}
            >
              <span class="catmgr-preset-emoji">${p.emoji}</span>
              <span class="catmgr-preset-name">${p.name}</span>
              ${isActive ? html`<span class="catmgr-preset-active-badge">Active</span>` : ''}
            </button>
          `;
        })}
      </div>
      ${previewingPresetId ? renderPresetPreview(previewingPresetId, containerId) : ''}
    </div>

    <!-- Tab Switcher -->
    <div class="catmgr-tabs">
      <button
        class="catmgr-tab ${activeTab === 'expense' ? 'catmgr-tab--active' : ''}"
        @click=${() => { activeTab = 'expense'; renderCategoryManager(containerId); }}
      >Expense (${expenses.length})</button>
      <button
        class="catmgr-tab ${activeTab === 'income' ? 'catmgr-tab--active' : ''}"
        @click=${() => { activeTab = 'income'; renderCategoryManager(containerId); }}
      >Income (${incomes.length})</button>
    </div>

    <!-- Category List -->
    <div class="catmgr-list">
      ${cats.map((cat, idx) => renderCategoryRow(cat, idx, cats.length, containerId))}
      ${pendingNewCat && pendingNewCat.type === activeTab ? renderPendingEditForm(containerId) : ''}
    </div>

    <!-- Add Category Button -->
    <button
      class="catmgr-add-btn"
      ?disabled=${!!pendingNewCat}
      @click=${() => handleAddCategory(containerId)}
    >+ Add ${activeTab === 'expense' ? 'Expense' : 'Income'} Category</button>
  `, el);
}

// ==========================================
// CATEGORY ROW
// ==========================================

function renderCategoryRow(cat: UserCategory, idx: number, total: number, containerId: string) {
  const isEditing = editingCatId === cat.id;

  if (isEditing) {
    return renderEditForm(cat, containerId);
  }

  return html`
    <div class="catmgr-row ${cat.hidden ? 'catmgr-row--hidden' : ''}">
      <div class="catmgr-row__main">
        <!-- Reorder Controls -->
        <div class="catmgr-row__reorder">
          <button
            class="catmgr-reorder-btn"
            ?disabled=${idx === 0}
            @click=${() => { reorderCategory(cat.id, idx - 1); notifyChange(); renderCategoryManager(containerId); }}
            aria-label="Move ${cat.name} up"
            title="Move ${cat.name} up"
          >▲</button>
          <button
            class="catmgr-reorder-btn"
            ?disabled=${idx === total - 1}
            @click=${() => { reorderCategory(cat.id, idx + 1); notifyChange(); renderCategoryManager(containerId); }}
            aria-label="Move ${cat.name} down"
            title="Move ${cat.name} down"
          >▼</button>
        </div>

        <!-- Category Info -->
        <span class="catmgr-row__swatch" style="background: ${cat.color};" aria-hidden="true"></span>
        <span class="catmgr-row__emoji" aria-hidden="true">${cat.emoji}</span>
        <span class="catmgr-row__name ${cat.hidden ? 'catmgr-row__name--hidden' : ''}">${cat.name}</span>
        ${cat.hidden ? html`<span class="catmgr-badge catmgr-badge--hidden">Hidden</span>` : ''}

        <!-- Actions -->
        <div class="catmgr-row__actions">
          <button class="catmgr-action-btn" @click=${() => { toggleCategoryVisibility(cat.id); notifyChange(); renderCategoryManager(containerId); }}
            title="${cat.hidden ? `Show ${cat.name}` : `Hide ${cat.name}`}" aria-label="${cat.hidden ? `Show ${cat.name}` : `Hide ${cat.name}`}">${cat.hidden ? '👁️' : '👁️‍🗨️'}</button>
          <button class="catmgr-action-btn" @click=${() => { editingCatId = cat.id; renderCategoryManager(containerId); }}
            title="Edit ${cat.name}" aria-label="Edit ${cat.name}">✏️</button>
          <button class="catmgr-action-btn catmgr-action-btn--danger" @click=${() => handleDeleteCategory(cat.id, cat.name, containerId)}
            title="Delete ${cat.name}" aria-label="Delete ${cat.name}">🗑️</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// EDIT FORMS
// ==========================================

function renderEditForm(cat: UserCategory, containerId: string) {
  return html`
    <div class="catmgr-edit-form">
      <div class="catmgr-edit-row">
        <input type="text" class="catmgr-input catmgr-input--emoji" id="edit-cat-emoji" value="${cat.emoji}" maxlength="4" placeholder="🎯" aria-label="Category emoji">
        <input type="text" class="catmgr-input catmgr-input--name" id="edit-cat-name" value="${cat.name}" placeholder="Category name" aria-label="Category name">
        <input type="color" class="catmgr-input catmgr-input--color" id="edit-cat-color" value="${cat.color}" aria-label="Category color">
      </div>
      <div class="catmgr-edit-actions">
        <button class="catmgr-save-btn" @click=${() => handleSaveEdit(cat.id, containerId)}>Save</button>
        <button class="catmgr-cancel-btn" @click=${() => { editingCatId = null; renderCategoryManager(containerId); }}>Cancel</button>
      </div>
    </div>
  `;
}

/**
 * CR-Apr24-I finding 49: render the inline edit form for a not-yet-persisted
 * category. Save commits; Cancel discards without any storage write.
 */
function renderPendingEditForm(containerId: string) {
  if (!pendingNewCat) return '';
  return html`
    <div class="catmgr-edit-form">
      <div class="catmgr-edit-row">
        <input type="text" class="catmgr-input catmgr-input--emoji" id="edit-cat-emoji" value="${pendingNewCat.emoji}" maxlength="4" placeholder="🎯" aria-label="Category emoji">
        <input type="text" class="catmgr-input catmgr-input--name" id="edit-cat-name" value="${pendingNewCat.name}" placeholder="Category name" aria-label="Category name">
        <input type="color" class="catmgr-input catmgr-input--color" id="edit-cat-color" value="${pendingNewCat.color}" aria-label="Category color">
      </div>
      <div class="catmgr-edit-actions">
        <button class="catmgr-save-btn" @click=${() => handleSavePendingCat(containerId)}>Save</button>
        <button class="catmgr-cancel-btn" @click=${() => { pendingNewCat = null; renderCategoryManager(containerId); }}>Cancel</button>
      </div>
    </div>
  `;
}

// ==========================================
// PRESET PREVIEW
// ==========================================

function renderPresetPreview(presetId: string, containerId: string) {
  const preset = getPresetById(presetId);
  if (!preset) return '';

  // CR-Apr22-B slice 2: label the CTA based on whether this is the active
  // preset. For the active preset, clicking Apply triggers a reset-to-
  // defaults flow (divergence-aware confirm or no-op alert) rather than a
  // preset switch.
  const activeConfig = userCategoryConfig.value;
  const isActive = activeConfig?.presetId === presetId;
  const ctaLabel = isActive
    ? `Reset to ${preset.name} Defaults`
    : `Switch to ${preset.name}`;

  return html`
    <div class="catmgr-preset-preview">
      <p class="catmgr-preset-preview__heading">
        ${preset.emoji} ${preset.name} — ${preset.description}
      </p>

      <p class="catmgr-preset-preview__label">Expense (${preset.expense.length})</p>
      <div class="catmgr-preset-preview__chips">
        ${preset.expense.map(c => html`
          <span class="catmgr-preset-preview__chip">
            <span>${c.emoji}</span>
            <span>${c.name}</span>
          </span>
        `)}
      </div>

      <p class="catmgr-preset-preview__label">Income (${preset.income.length})</p>
      <div class="catmgr-preset-preview__chips">
        ${preset.income.map(c => html`
          <span class="catmgr-preset-preview__chip catmgr-preset-preview__chip--income">
            <span>${c.emoji}</span>
            <span>${c.name}</span>
          </span>
        `)}
      </div>

      <div class="catmgr-preset-preview__actions">
        <button class="catmgr-preset-preview__apply" @click=${() => handlePresetClick(presetId, containerId)}>
          ${ctaLabel}
        </button>
        <button class="catmgr-preset-preview__cancel" @click=${() => { previewingPresetId = null; renderCategoryManager(containerId); }}>
          Cancel
        </button>
      </div>
    </div>
  `;
}

// ==========================================
// EVENT HANDLERS
// ==========================================

// CR-Apr22-B slice 2 (Finding #3): `presetId === presetId` is not enough to
// decide whether the current config *shape* actually matches the preset
// defaults. A user can keep `config.presetId = 'personal'` while having:
//   - user_* custom cats that aren't in the preset at all,
//   - preset cats that are hidden (removed from pickers/reports),
//   - preset cats that were deleted via `deleteCategoryWithCleanup`,
//   - preset cats renamed via `updateCategory`.
// The old `return` on a presetId match locked users out of resetting to
// defaults without first flipping to a different preset and flipping back
// — and the cross-preset round-trip would trample user_* cat data anyway.
// `describeConfigDivergenceFromPreset` inspects the four divergence kinds
// so the button can surface a precise "here's what will change" summary.
interface ConfigDivergenceSummary {
  readonly hasDiverged: boolean;
  readonly userCustomCount: number;
  readonly hiddenCount: number;
  readonly missingCount: number;
  readonly renamedCount: number;
  readonly userCustomIds: readonly string[];
}

function describeConfigDivergenceFromPreset(presetId: string): ConfigDivergenceSummary {
  const current = userCategoryConfig.value;
  const preset = CATEGORY_PRESETS.find(p => p.id === presetId);
  if (!current || !preset) {
    return {
      hasDiverged: false,
      userCustomCount: 0,
      hiddenCount: 0,
      missingCount: 0,
      renamedCount: 0,
      userCustomIds: []
    };
  }

  const presetExpenseIds = new Set(preset.expense.map(c => c.id));
  const presetIncomeIds = new Set(preset.income.map(c => c.id));

  const userCustomIds: string[] = [];
  let hiddenCount = 0;
  let renamedCount = 0;

  for (const cat of current.expense) {
    if (cat.hidden) hiddenCount++;
    if (!presetExpenseIds.has(cat.id)) {
      userCustomIds.push(cat.id);
    } else {
      const presetEntry = preset.expense.find(c => c.id === cat.id);
      if (presetEntry && (presetEntry.name !== cat.name || presetEntry.emoji !== cat.emoji)) {
        renamedCount++;
      }
    }
  }
  for (const cat of current.income) {
    if (cat.hidden) hiddenCount++;
    if (!presetIncomeIds.has(cat.id)) {
      userCustomIds.push(cat.id);
    } else {
      const presetEntry = preset.income.find(c => c.id === cat.id);
      if (presetEntry && (presetEntry.name !== cat.name || presetEntry.emoji !== cat.emoji)) {
        renamedCount++;
      }
    }
  }

  const currentExpenseIds = new Set(current.expense.map(c => c.id));
  const currentIncomeIds = new Set(current.income.map(c => c.id));
  let missingCount = 0;
  for (const id of presetExpenseIds) if (!currentExpenseIds.has(id)) missingCount++;
  for (const id of presetIncomeIds) if (!currentIncomeIds.has(id)) missingCount++;

  const userCustomCount = userCustomIds.length;
  const hasDiverged = userCustomCount > 0 || hiddenCount > 0 || missingCount > 0 || renamedCount > 0;

  return {
    hasDiverged,
    userCustomCount,
    hiddenCount,
    missingCount,
    renamedCount,
    userCustomIds
  };
}

function formatDivergenceDetails(div: ConfigDivergenceSummary): string {
  const parts: string[] = [];
  if (div.userCustomCount > 0) {
    parts.push(
      `${div.userCustomCount} custom categor${div.userCustomCount === 1 ? 'y' : 'ies'} will be removed (their transactions, templates, and allocations get reassigned to "Other")`
    );
  }
  if (div.hiddenCount > 0) {
    parts.push(
      `${div.hiddenCount} hidden preset categor${div.hiddenCount === 1 ? 'y' : 'ies'} will be restored to visible`
    );
  }
  if (div.missingCount > 0) {
    parts.push(
      `${div.missingCount} deleted preset categor${div.missingCount === 1 ? 'y' : 'ies'} will be re-added`
    );
  }
  if (div.renamedCount > 0) {
    parts.push(
      `${div.renamedCount} renamed preset categor${div.renamedCount === 1 ? 'y' : 'ies'} will be reset to their default name/emoji`
    );
  }
  return parts.join('; ') + '.';
}

async function handlePresetClick(presetId: string, containerId: string): Promise<void> {
  // Round 7 fix: Prevent concurrent async operations from corrupting state
  if (isProcessing) return;
  isProcessing = true;

  try {
    const current = userCategoryConfig.value;
    if (!current) return;

    const presetName = CATEGORY_PRESETS.find(p => p.id === presetId)?.name || presetId;
    const isSamePreset = current.presetId === presetId;

    // Same preset: decide based on shape divergence, not presetId alone.
    if (isSamePreset) {
      const divergence = describeConfigDivergenceFromPreset(presetId);

      if (!divergence.hasDiverged) {
        // True no-op — surface a visible "already active" message so the
        // click feels responsive instead of silently doing nothing.
        await dialogs.alert({
          title: `${presetName} Preset Active`,
          message: `Your categories already match the default ${presetName} preset. Nothing to reset.`,
          type: 'info'
        });
        previewingPresetId = null;
        renderCategoryManager(containerId);
        return;
      }

      const confirmed = await dialogs.confirm({
        title: `Reset to ${presetName} Defaults`,
        message: `Reset your ${presetName} categories to the default preset?`,
        details: formatDivergenceDetails(divergence),
        type: 'warning',
        confirmText: 'Reset',
        cancelText: 'Cancel'
      });
      if (!confirmed) return;

      // Sweep user_* custom cats FIRST so references (transactions,
      // allocations, templates, recurring, rollover) get remapped to a
      // preset fallback via the centralized atomic cleanup. `applyPreset`
      // with the same presetId is a no-op for the preset→preset migration
      // map, so without this sweep user_* cat references would be stranded
      // after the config swap.
      for (const customId of divergence.userCustomIds) {
        const outcome = await deleteCategoryWithCleanup(customId);
        if (!outcome.ok) {
          if (outcome.error === 'tx_persist_failed') {
            await dialogs.alert({
              title: 'Reset Interrupted',
              message: outcome.message,
              type: 'error'
            });
            notifyChange();
            renderCategoryManager(containerId);
            return;
          }
          if (outcome.error === 'last_category_of_type') {
            // Extreme edge case: user deleted every preset cat of a type,
            // leaving only user_* cats, and we're now trying to delete the
            // last one. Skip it — `applyPreset` below will re-populate the
            // type with preset cats. The remaining user_* ref can't be
            // cleanly remapped by this sweep, but `applyPreset` leaves the
            // stores intact and the user can manually reassign the stray
            // ref. A full cross-preset-to-same-preset migration would
            // require a new helper in category-store; noted as a follow-up
            // in the inline-review log rather than overreaching this slice.
            continue;
          }
          if (outcome.error === 'not_found') {
            // The config shifted under us between the confirm and the
            // sweep. Bail to a clean re-render.
            previewingPresetId = null;
            renderCategoryManager(containerId);
            return;
          }
        }
      }

      applyPreset(presetId);
      previewingPresetId = null;
      notifyChange();
      renderCategoryManager(containerId);
      return;
    }

    // Cross-preset switch: unchanged flow. `applyPreset` handles
    // preset-to-preset id migration via `migrateStoredCategoryIds`.
    const confirmed = await dialogs.confirm({
      title: `Switch to ${presetName}`,
      message: `Replace all your categories with the "${presetName}" preset?`,
      details: 'This will overwrite your current category list. Any custom categories you added will be removed.',
      type: 'warning',
      confirmText: 'Replace All',
      cancelText: 'Cancel'
    });

    if (confirmed) {
      applyPreset(presetId);
      previewingPresetId = null;
      notifyChange();
      renderCategoryManager(containerId);
    }
  } finally {
    isProcessing = false;
  }
}

async function handleAddCategory(containerId: string): Promise<void> {
  const name = await dialogs.prompt(
    `Enter a name for the new ${activeTab} category:`,
    `New ${activeTab === 'expense' ? 'Expense' : 'Income'} Category`,
    '',
    'e.g. Groceries'
  );
  if (!name?.trim()) return;

  const duplicate = findDuplicateCategoryName(name, activeTab);
  if (duplicate) {
    await dialogs.alert({
      title: 'Name Already In Use',
      message: `A ${activeTab} category named "${duplicate.name}" already exists.`,
      type: 'warning'
    });
    return;
  }

  const emoji = await dialogs.prompt(
    'Choose an emoji for this category:',
    'Category Emoji',
    '📦',
    '🎯'
  );

  // CR-Apr22-B slice 2 (Finding #1): `promptTextInput` returns `null` only
  // when the user explicitly cancels (Esc / Cancel button) — empty-confirm
  // yields `''`. Previously the coalescing `(emoji?.trim()) || '📦'`
  // swallowed `null` the same as `''`, so canceling the emoji dialog still
  // persisted the category with the default 📦 — contradicting the user's
  // intent to abort the whole add flow. Treat an explicit cancel as an
  // abort so no category row is created; empty-confirm continues to accept
  // the default emoji (users who tab through without typing still get a
  // sensible value).
  if (emoji === null) return;

  // CR-Apr24-I finding 49: instead of persisting immediately via
  // `addCategory()`, store a transient pending object and render the
  // inline edit form. Only on Save does the category hit storage. Cancel
  // discards the pending object — no phantom row left in localStorage.
  //
  // Design-Review-Apr21 P3 (preserved): seed with the shared neutral
  // `DEFAULT_CATEGORY_COLOR` and drop straight into edit mode so the
  // user picks a deliberate color via the same affordance as existing-
  // category editing. The emoji + name are pre-populated so the user
  // only needs to touch the color swatch and Save.
  pendingNewCat = {
    name: name.trim(),
    emoji: (emoji.trim()) || '📦',
    color: DEFAULT_CATEGORY_COLOR,
    type: activeTab
  };

  renderCategoryManager(containerId);
}

async function handleDeleteCategory(catId: string, name: string, containerId: string): Promise<void> {
  // CR-Apr22-B slice 1: prompt copy updated so users know references will
  // be reassigned (not left orphaned as "Unknown" the way the prior raw
  // `deleteCategory` call left them).
  const confirmed = await dialogs.confirm({
    title: 'Delete Category',
    message: `Delete "${name}"?`,
    details: 'Transactions, templates, and budget allocations that reference this category will be reassigned to a fallback "Other" category. This cannot be undone.',
    type: 'danger',
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  // CR-Apr22-B slice 1: route through the centralized cleanup instead of
  // the raw `deleteCategory` call, which only stripped USER_CATS and left
  // allocations, templates, recurring series, rollover selections, and
  // transaction rows referencing a phantom id.
  const outcome = await deleteCategoryWithCleanup(catId);

  if (!outcome.ok) {
    if (outcome.error === 'last_category_of_type') {
      await dialogs.alert({
        title: 'Cannot Delete',
        message: outcome.message,
        type: 'warning'
      });
      return;
    }
    if (outcome.error === 'tx_persist_failed') {
      await dialogs.alert({
        title: 'Partial Update',
        message: outcome.message,
        type: 'error'
      });
      // Still refresh UI — the category was removed from USER_CATS even if
      // the transaction rewrite failed.
      notifyChange();
      renderCategoryManager(containerId);
      return;
    }
    // 'not_found' — config was re-hydrated between the confirm and the
    // call; silently re-render.
    renderCategoryManager(containerId);
    return;
  }

  // Success — surface a summary so the user sees exactly what got reassigned.
  const reassignments: string[] = [];
  if (outcome.txMigrated > 0) reassignments.push(`${outcome.txMigrated} transaction${outcome.txMigrated === 1 ? '' : 's'}`);
  if (outcome.templatesMigrated > 0) reassignments.push(`${outcome.templatesMigrated} template${outcome.templatesMigrated === 1 ? '' : 's'}`);
  if (outcome.recurringMigrated > 0) reassignments.push(`${outcome.recurringMigrated} recurring series`);
  if (outcome.allocationMonthsStripped > 0) reassignments.push(`${outcome.allocationMonthsStripped} monthly allocation${outcome.allocationMonthsStripped === 1 ? '' : 's'}`);
  if (reassignments.length > 0) {
    await dialogs.alert({
      title: 'Category Deleted',
      message: `Reassigned ${reassignments.join(', ')} to "${outcome.fallbackCatName}".`,
      type: 'success'
    });
  }

  notifyChange();
  renderCategoryManager(containerId);
}

async function handleSaveEdit(catId: string, containerId: string): Promise<void> {
  const emoji = (document.getElementById('edit-cat-emoji') as HTMLInputElement)?.value?.trim();
  const name = (document.getElementById('edit-cat-name') as HTMLInputElement)?.value?.trim();
  const color = (document.getElementById('edit-cat-color') as HTMLInputElement)?.value;

  if (!name) {
    await dialogs.alert({ message: 'Category name is required.', type: 'warning' });
    return;
  }

  // Determine which type this category belongs to so uniqueness is scoped
  // to the correct list. Exclude the row being edited so re-saving an
  // unchanged name (or other-field-only edits) still succeeds.
  const isExpense = allExpenseCategories.value.some(c => c.id === catId);
  const duplicate = findDuplicateCategoryName(name, isExpense ? 'expense' : 'income', catId);
  if (duplicate) {
    await dialogs.alert({
      title: 'Name Already In Use',
      message: `Another ${isExpense ? 'expense' : 'income'} category is already named "${duplicate.name}".`,
      type: 'warning'
    });
    return;
  }

  updateCategory(catId, { name, emoji: emoji || '📦', color });
  editingCatId = null;
  notifyChange();
  renderCategoryManager(containerId);
}

/**
 * CR-Apr24-I finding 49: commit the pending-new-cat to storage. Only
 * at this point does `addCategory()` run, so a Cancel before Save
 * leaves zero trace in localStorage or the category signal.
 */
async function handleSavePendingCat(containerId: string): Promise<void> {
  if (!pendingNewCat) return;

  const emoji = (document.getElementById('edit-cat-emoji') as HTMLInputElement)?.value?.trim();
  const name = (document.getElementById('edit-cat-name') as HTMLInputElement)?.value?.trim();
  const color = (document.getElementById('edit-cat-color') as HTMLInputElement)?.value;

  if (!name) {
    await dialogs.alert({ message: 'Category name is required.', type: 'warning' });
    return;
  }

  const duplicate = findDuplicateCategoryName(name, pendingNewCat.type);
  if (duplicate) {
    await dialogs.alert({
      title: 'Name Already In Use',
      message: `A ${pendingNewCat.type} category named "${duplicate.name}" already exists.`,
      type: 'warning'
    });
    return;
  }

  addCategory({
    name,
    emoji: emoji || '📦',
    color: color || DEFAULT_CATEGORY_COLOR,
    type: pendingNewCat.type
  });

  pendingNewCat = null;
  notifyChange();
  renderCategoryManager(containerId);
}

function notifyChange(): void {
  if (onChangeCallback) onChangeCallback();
}
