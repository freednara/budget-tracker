/**
 * Simple Modals Component
 *
 * Lit templates for simple modals: delete confirmation, edit recurring,
 * import options, and add savings.
 *
 * These maintain existing element IDs for backward compatibility with
 * event handlers in modal-events.ts and other modules.
 *
 * @module components/simple-modals
 */
'use strict';

import { html, type TemplateResult } from '../core/lit-helpers.js';

// ==========================================
// DELETE MODAL
// ==========================================

/**
 * Render the delete transaction confirmation modal
 * Dynamic content (emoji, category, amount, date, desc) is populated by modal-events.ts
 */
export function renderDeleteModal(): TemplateResult {
  return html`
    <div id="delete-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div class="rounded-2xl p-6 w-full card-shadow modal-panel" style="max-width: 300px; text-align: center;">

        <!-- Header -->
        <h3 id="delete-modal-title" class="text-base font-black text-primary mb-3">Delete Transaction?</h3>

        <!-- Hero: Amount -->
        <div id="delete-tx-amount" class="text-3xl font-black mb-4"></div>

        <!-- Info grid -->
        <div class="mb-4" style="display: inline-grid; grid-template-columns: auto auto; gap: 0.2rem 0.75rem; font-size: 0.8125rem; text-align: left;">
          <span class="text-tertiary font-semibold">What</span>
          <span id="delete-tx-desc" class="text-primary"></span>
          <span class="text-tertiary font-semibold">Category</span>
          <span id="delete-tx-category" class="text-primary"><span id="delete-tx-emoji"></span></span>
          <span class="text-tertiary font-semibold">Date</span>
          <span id="delete-tx-date" class="text-primary"></span>
        </div>

        <!-- Warning -->
        <p class="text-xs mb-4 text-tertiary">This cannot be undone.</p>

        <!-- Actions -->
        <div class="flex gap-2">
          <button id="cancel-delete" class="flex-1 btn btn-secondary btn-sm">Cancel</button>
          <button id="confirm-delete" class="flex-1 btn btn-danger btn-sm">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// EDIT RECURRING MODAL
// ==========================================

/**
 * Render the edit recurring transaction modal
 * Allows user to choose between editing single occurrence or entire series
 */
export function renderEditRecurringModal(): TemplateResult {
  return html`
    <div id="edit-recurring-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-recurring-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow modal-panel">
        <h3 id="edit-recurring-title" class="text-xl font-black mb-2 text-primary">Edit Recurring Transaction</h3>
        <p class="text-sm mb-4 text-secondary">This is part of a recurring series. What would you like to edit?</p>
        <div class="space-y-2">
          <button id="edit-single" class="w-full py-3 rounded-lg font-bold text-left px-4 flex items-center gap-3 btn btn-secondary">
            <span class="text-xl">📝</span>
            <div>
              <div class="font-bold">This occurrence only</div>
              <div class="text-xs text-tertiary">Edit just this transaction</div>
            </div>
          </button>
          <button id="edit-series" class="w-full py-3 rounded-lg font-bold text-left px-4 flex items-center gap-3 btn btn-secondary">
            <span class="text-xl">↻</span>
            <div>
              <div class="font-bold">All future occurrences</div>
              <div class="text-xs text-tertiary">Edit this and all future transactions in series</div>
            </div>
          </button>
          <button id="cancel-edit-recurring" class="w-full py-2 rounded-lg text-sm text-tertiary btn btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// IMPORT OPTIONS MODAL
// ==========================================

/**
 * Render the import options modal
 * Allows user to choose between replacing all data or merging
 */
export function renderImportModal(): TemplateResult {
  return html`
    <div id="import-options-modal" class="modal-overlay modal-overlay--stacked" role="dialog" aria-modal="true" aria-labelledby="import-options-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow modal-panel">
        <h3 id="import-options-modal-title" class="text-xl font-black mb-2 text-primary">Import Data</h3>
        <p class="text-sm mb-3 text-secondary">How should we handle this import?</p>
        <!--
          Design-Review-Apr21 P3 (batch 6 follow-up): the chooser
          previously opened with only the generic prompt above — users
          couldn't verify they were acting on the intended backup
          before choosing merge vs. replace. This context block is
          populated by handleImportFile in import-export-events.ts
          with the filename, backup date, and transaction count from
          the parsed file, so the confirming info is visible before
          any destructive or non-destructive choice.

          Design-Review-Apr21 P2 (batch 6 follow-up wave P): removed
          aria-live="polite". The dialog is labelled by
          aria-labelledby="import-options-modal-title" and the modal
          opens with initial focus on a visible control. Screen
          readers announce dialog contents on open via the modal
          semantics — aria-live on a static details block read inside
          the same dialog adds nothing beyond the natural announcement
          order and in some AT combos produces a duplicate read of
          the Backup details block. Live regions are for changes
          occurring outside the focus context; a one-time read of
          text rendered into a freshly-opened dialog doesn't qualify.
        -->
        <div id="import-options-context"
             class="p-3 rounded-lg mb-4 text-xs form-input hidden">
          <div class="font-bold uppercase tracking-tighter text-tertiary mb-2">Backup details</div>
          <dl class="space-y-1">
            <div class="flex justify-between gap-3">
              <dt class="text-secondary">File</dt>
              <dd id="import-options-context__filename" class="text-primary text-right truncate max-w-[60%]"></dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-secondary">Backup date</dt>
              <dd id="import-options-context__date" class="text-primary text-right"></dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-secondary">Transactions</dt>
              <dd id="import-options-context__txcount" class="text-primary text-right"></dd>
            </div>
          </dl>
        </div>
        <div class="space-y-2">
          <button id="import-overwrite" class="w-full py-3 rounded-lg font-bold text-sm btn btn-danger">Replace everything</button>
          <button id="import-merge" class="w-full py-3 rounded-lg font-bold text-sm btn btn-primary">Add to my data</button>
          <!--
            Design-Review-Apr21 P3 (batch 6 follow-up): the shared
            modal opener's focus-resolver picks the first focusable
            control unless one is tagged with
            data-modal-initial-focus. With no tag, keyboard users
            land on the destructive Replace-everything button as
            soon as this dialog opens — one Space/Enter away from
            wiping their data. Route initial focus to Cancel (the
            safest, non-destructive option) so a reflexive
            activation cancels the import rather than triggering
            it. Merge/overwrite still require a deliberate move.
          -->
          <button id="cancel-import" data-modal-initial-focus="true" class="w-full py-3 rounded-lg font-bold text-sm btn btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// ADD SAVINGS MODAL
// ==========================================

/**
 * Render the add savings amount modal
 * Goal name is populated dynamically by savings-goals.ts
 */
export function renderAddSavingsModal(): TemplateResult {
  return html`
    <div id="add-savings-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-savings-modal-title">
      <div class="rounded-2xl p-6 max-w-sm w-full card-shadow savings-card-bg">
        <h3 id="add-savings-modal-title" class="text-xl font-black mb-2 text-primary">Add Funds</h3>
        <p id="add-savings-goal-name" class="text-sm mb-4 text-secondary">Goal name</p>

        <div class="p-3 rounded-lg mb-4 form-input">
          <div class="flex justify-between text-sm">
            <span class="text-secondary">Saved So Far:</span>
            <span id="add-savings-current" class="font-bold" style="color: var(--color-income);">$0.00</span>
          </div>
          <div class="flex justify-between text-sm mt-1">
            <span class="text-secondary">Remaining:</span>
            <span id="add-savings-remaining" class="font-bold text-primary">$0.00</span>
          </div>
        </div>

        <!--
          A11y (Design-Review-Apr21 P2): wire both inputs to their error
          nodes via aria-describedby and promote the error divs to
          role="alert" so screen readers announce validation failures.
          Same pattern as the savings-goal modal above and the main
          transaction form in index.html.
        -->
        <div class="mb-4">
          <label for="add-savings-amount" class="block text-xs font-bold mb-1 text-secondary">AMOUNT TO ADD</label>
          <input type="number" id="add-savings-amount" step="0.01" min="0.01" max="999999.99" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="100.00" aria-describedby="add-savings-amount-error">
          <div id="add-savings-amount-error" class="text-xs mt-1 hidden text-expense" role="alert">Please enter a valid amount</div>
          <p class="text-xs mt-2 text-tertiary">This will create an expense transaction and add to your savings balance.</p>
        </div>

        <div class="mb-4">
          <label for="add-savings-date" class="block text-xs font-bold mb-1 text-secondary">CONTRIBUTION DATE</label>
          <input type="date" id="add-savings-date" class="w-full px-3 py-2 rounded-lg text-sm form-input" aria-describedby="add-savings-date-error">
          <div id="add-savings-date-error" class="text-xs mt-1 hidden text-expense" role="alert">Contribution date can&rsquo;t be in the future.</div>
        </div>

        <div class="flex gap-3">
          <button id="cancel-add-savings" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="confirm-add-savings" class="flex-1 py-3 rounded-lg font-bold btn btn-success">Add Funds</button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// SAVINGS GOAL MODAL
// ==========================================

/**
 * Render the create savings goal modal
 */
/**
 * Default emoji choices for the savings-goal picker. The first entry (`💚`)
 * is the legacy default used throughout the app, kept first so existing
 * goals with no icon look identical.
 */
export const SAVINGS_GOAL_EMOJIS = [
  '💚', '🏖️', '🏠', '🚗', '✈️', '🎓',
  '💍', '🎁', '💻', '🏥', '👶', '🐾'
];

export function renderSavingsGoalModal(): TemplateResult {
  return html`
    <div id="savings-goal-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="savings-goal-modal-title">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow savings-card-bg">
        <h3 id="savings-goal-modal-title" class="text-xl font-black mb-4 text-primary">Add Savings Goal</h3>
        <div class="space-y-3 mb-4">
          <div>
            <label for="savings-goal-name" class="block text-xs font-bold mb-1 text-secondary">GOAL NAME</label>
            <!--
              A11y (Design-Review-Apr21 P2): wire inputs to their inline
              error nodes with aria-describedby and promote the error
              divs to role="alert" so screen readers announce validation
              failures. Mirrors the pattern already used on the main
              transaction form (#amount / #amount-error in index.html).
            -->
            <input type="text" id="savings-goal-name" class="w-full px-3 py-2 rounded-lg text-sm form-input" maxlength="100" placeholder="e.g., Vacation Fund" aria-describedby="savings-goal-name-error">
            <div id="savings-goal-name-error" class="text-xs mt-1 hidden text-expense" role="alert">Please enter a goal name</div>
          </div>
          <div>
            <label for="savings-goal-amount" class="block text-xs font-bold mb-1 text-secondary">TARGET AMOUNT</label>
            <input type="number" id="savings-goal-amount" step="0.01" min="5" max="999999.99" inputmode="decimal" class="w-full px-3 py-2 rounded-lg text-sm form-input" placeholder="5000.00" aria-describedby="savings-goal-amount-error">
            <div id="savings-goal-amount-error" class="text-xs mt-1 hidden text-expense" role="alert">Set a goal of at least $5.00 to track meaningful progress</div>
          </div>
          <div>
            <label for="savings-goal-deadline" class="block text-xs font-bold mb-1 text-secondary">DEADLINE</label>
            <input type="date" id="savings-goal-deadline" class="w-full px-3 py-2 rounded-lg text-sm form-input">
          </div>
          <div>
            <label class="block text-xs font-bold mb-1 text-secondary">ICON</label>
            <!--
              A11y (Design-Review-Apr21 P2): radios need arrow-key
              navigation + roving tabindex (WAI-ARIA APG "Radio Group").
              The first radio starts with tabindex="0" (focus-reachable)
              and the rest with tabindex="-1". Arrow-key handling +
              sync of aria-checked + roving tabindex lives in
              ui/interactions/modal-events.ts → setupSavingsGoalModals.
            -->
            <div id="savings-goal-emoji-picker" class="grid grid-cols-6 gap-2" role="radiogroup" aria-label="Goal icon">
              ${SAVINGS_GOAL_EMOJIS.map((e, i) => html`
                <button
                  type="button"
                  class="savings-goal-emoji-btn text-2xl p-2 rounded-lg form-input"
                  role="radio"
                  aria-checked=${i === 0 ? 'true' : 'false'}
                  tabindex=${i === 0 ? '0' : '-1'}
                  data-emoji=${e}
                  aria-label=${`Choose ${e} icon`}
                >${e}</button>
              `)}
            </div>
          </div>
        </div>
        <div class="flex gap-3">
          <button id="cancel-savings-goal" class="flex-1 py-3 rounded-lg font-bold btn btn-secondary">Cancel</button>
          <button id="save-savings-goal" class="flex-1 py-3 rounded-lg font-bold btn btn-success">Save Goal</button>
        </div>
      </div>
    </div>
  `;
}

// Design-Review-Apr21 P2: the achievement-celebration overlay is defined
// once, statically, in `index.html` (`#celebration-overlay` +
// `.celebration-badge` child structure, z-index 90, `#celebration-close`
// button). A lit-template `renderCelebrationModal()` previously lived here
// and shipped a second overlay with the same ids — creating duplicate ids
// in the live DOM and ambiguous lookups for focus, accessible name, and
// close-button wiring. The template was never composed into
// `renderSimpleModals()` and no site imported it, so it was dead code that
// only existed to diverge. Removed; the static HTML version is the single
// source of truth. See `features/gamification/celebration.ts::showCelebration`
// for the orchestration and `style.css` for the `.celebration-badge` rules.

// ==========================================
// SYNC CONFLICT MODAL
// ==========================================

/**
 * Render the sync conflict resolution modal
 */
export function renderSyncConflictModal(): TemplateResult {
  return html`
    <div id="sync-conflict-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
      <div class="rounded-2xl p-6 max-w-md w-full card-shadow modal-panel">
        <h3 id="sync-conflict-title" class="text-xl font-black mb-2 text-primary flex items-center gap-2">
          <span class="text-warning">⚠️</span> Sync Conflict Detected
        </h3>
        <p class="text-sm mb-4 text-secondary">Another tab made changes that may overlap with yours. Choose how to proceed.</p>

        <div id="sync-conflict-details" class="p-3 rounded-lg mb-6 text-xs form-input">
          <div class="mb-2">
            <span class="font-bold text-tertiary uppercase tracking-tighter">Remote Changes</span>
            <div id="sync-remote-details" class="text-primary mt-1">Checking updates…</div>
          </div>
          <div>
            <span class="font-bold text-tertiary uppercase tracking-tighter">Your Changes</span>
            <div id="sync-local-details" class="text-primary mt-1">Unsaved edits</div>
          </div>
        </div>

        <div class="space-y-2">
          <button id="sync-accept-remote" class="w-full py-3 rounded-lg font-bold text-sm btn btn-danger">
            Accept Updates from Other Tab
          </button>
          <!--
            Design-Review-Apr21 P2 (batch 6 follow-up): the shared
            modal opener's focus-resolver picks the first focusable
            control unless one is tagged with
            data-modal-initial-focus. With no tag, keyboard users
            open this dialog focused on "Accept Updates from Other
            Tab" — one Space/Enter away from discarding their local
            edits in favor of remote changes. Route initial focus
            to Keep-Local (recovery-oriented, preserves the user's
            in-progress work) so a reflexive activation is the
            safest outcome. This complements the batch-6 fix that
            neutralized Escape + backdrop dismissal on this same
            dialog — both changes enforce "explicit choice only"
            for data-loss decisions.
          -->
          <button id="sync-keep-local" data-modal-initial-focus="true" class="w-full py-3 rounded-lg font-bold text-sm btn btn-secondary">
            Keep My Local Changes
          </button>
          <button id="sync-merge-changes" class="w-full py-3 rounded-lg font-bold text-sm btn btn-primary">
            Save & Merge All
          </button>
        </div>
      </div>
    </div>
  `;
}

// ==========================================
// COMBINED SIMPLE MODALS
// ==========================================

/**
 * Render all simple modals at once
 * Useful for mounting all modals in a single container
 */
export function renderSimpleModals(): TemplateResult {
  return html`
    ${renderDeleteModal()}
    ${renderEditRecurringModal()}
    ${renderImportModal()}
    ${renderAddSavingsModal()}
    ${renderSavingsGoalModal()}
    ${renderSyncConflictModal()}
  `;
}
