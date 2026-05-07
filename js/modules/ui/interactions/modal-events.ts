/**
 * Modal Events Module
 *
 * Handles all modal event handlers: delete, edit recurring, savings goals,
 * settings, analytics, theme, alerts, celebration, undo, and sample data.
 *
 * @module modal-events
 */
'use strict';

import { createEventBinder } from '../../core/event-binding.js';
import { SK, persist, lsSet, normalizeAlertPrefs } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { modal, form, settings, savingsGoals as savingsActions } from '../../core/state-actions.js';
import { openModal, closeModal, showToast, showUndoToast } from '../core/ui.js';
import { parseAmount, getTodayStr, fmtCur } from '../../core/utils-pure.js';
import { dataSdk } from '../../data/data-manager.js';
import { CONFIG, CURRENCY_MAP } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, InsightPersonality, RolloverMode, NegativeHandling, Theme } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface ModalEventCallbacks {
  renderSavingsGoals?: () => void;
  updateSummary?: () => void;
  renderCustomCatsList?: () => void;
  refreshAll?: () => void;
  resetForm?: () => void | Promise<void>;
  // Allow `void | Promise<void>` so app-init-di.ts can pass `async` wrappers
  // around dynamic-import loaders without triggering no-misused-promises.
  // Consumers treat the return value as void either way (no `await` on call).
  startEditing?: (tx: Transaction) => void | Promise<void>;
  loadSampleData?: () => boolean | Promise<boolean>;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks. `renderSavingsGoals` is still accepted as a
// callback for caller compatibility but no longer stashed — the savings-
// goal card re-render flows through the reactive signal path now.
let updateSummaryFn: (() => void) | null = null;
let renderCustomCatsListFn: (() => void) | null = null;
let refreshAllFn: (() => void) | null = null;
let resetFormFn: (() => void | Promise<void>) | null = null;
let startEditingFn: ((tx: Transaction) => void | Promise<void>) | null = null;
let loadSampleDataFn: (() => boolean | Promise<boolean>) | null = null;
let cleanupCategoryManager: (() => void) | null = null;
// CR-Apr24-I findings 116/117: coalesce + guard the analytics render timeout
let _analyticsRenderTimer: ReturnType<typeof setTimeout> | null = null;
// CR-Apr24-I finding 126: coalesce onboarding restart timeout
let _onboardingRestartTimer: ReturnType<typeof setTimeout> | null = null;
const modalEventCleanups: Array<() => void> = [];
const bindModalEvent = createEventBinder(modalEventCleanups);

export function cleanupModalEvents(): void {
  const cleanups = modalEventCleanups.splice(0, modalEventCleanups.length);
  cleanups.forEach((cleanup) => cleanup());
}

function loadFeatureEventInterface() {
  return import('../../core/feature-event-interface.js');
}

function loadRolloverModule() {
  return import('../../features/financial/rollover.js');
}

function loadAnalyticsModule() {
  return import('../../orchestration/analytics.js');
}

function loadAppResetModule() {
  return import('../../orchestration/app-reset.js');
}

function loadBrowserNotificationsModule() {
  return import('../../features/personalization/browser-notifications.js');
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize modal event handlers
 */
export function initModalEvents(callbacks: ModalEventCallbacks): void {
  cleanupModalEvents();

  if (callbacks.updateSummary) updateSummaryFn = callbacks.updateSummary;
  if (callbacks.renderCustomCatsList) renderCustomCatsListFn = callbacks.renderCustomCatsList;
  if (callbacks.refreshAll) refreshAllFn = callbacks.refreshAll;
  if (callbacks.resetForm) resetFormFn = callbacks.resetForm;
  if (callbacks.startEditing) startEditingFn = callbacks.startEditing;
  if (callbacks.loadSampleData) loadSampleDataFn = callbacks.loadSampleData;

  setupDeleteModal();
  setupEditRecurringModal();
  setupSavingsGoalModals();
  setupSettingsModal();
  setupAnalyticsModal();
  setupThemeButtons();
  setupAlertAndCelebration();
  setupSampleData();
  setupSyncConflictModal();
}

/**
 * Set up sync conflict modal handlers
 */
function setupSyncConflictModal(): void {
  const acceptRemoteButton = DOM.get('sync-accept-remote');
  if (acceptRemoteButton) bindModalEvent(acceptRemoteButton, 'click', () => {
    window.dispatchEvent(new CustomEvent('sync-conflict-resolution', { 
      detail: { action: 'accept' } 
    }));
    closeModal('sync-conflict-modal');
  });

  const keepLocalButton = DOM.get('sync-keep-local');
  if (keepLocalButton) bindModalEvent(keepLocalButton, 'click', () => {
    window.dispatchEvent(new CustomEvent('sync-conflict-resolution', { 
      detail: { action: 'reject' } 
    }));
    closeModal('sync-conflict-modal');
  });

  const mergeChangesButton = DOM.get('sync-merge-changes');
  if (mergeChangesButton) bindModalEvent(mergeChangesButton, 'click', () => {
    window.dispatchEvent(new CustomEvent('sync-conflict-resolution', { 
      detail: { action: 'merge' } 
    }));
    closeModal('sync-conflict-modal');
  });
}

// Track theme at time of opening settings so Cancel can revert
let _themeOnOpen: string = '';

// CR-Apr24-C2d [P2] finding 110: fingerprint settings state at open so
// Save can detect concurrent cross-tab modifications.
let _settingsSnapshot: string | null = null;

/** Cheaply fingerprint the settings values that the modal form controls. */
function _settingsFingerprint(): string {
  const s = signals.sections.value;
  const c = signals.currency.value;
  const a = signals.alerts.value;
  const ip = signals.insightPers.value;
  const t = signals.theme.value;
  return `${s.envelope}|${s.transactionsTemplates}|${c.home}|${ip}|${a.budgetThreshold}|${a.browserNotificationsEnabled}|${t}`;
}

/**
 * Open settings modal (exported for keyboard shortcut)
 */
export async function openSettingsModal(): Promise<void> {
  _themeOnOpen = signals.theme.value;

  // Grab DOM elements first (stable references, no async risk)
  const showEnvelope = DOM.get<HTMLInputElement>('show-envelope');
  const showTemplates = DOM.get<HTMLInputElement>('show-templates');
  const settingsCurrency = DOM.get<HTMLSelectElement>('settings-currency');
  const insightPersonality = DOM.get<HTMLSelectElement>('insight-personality');
  const alertBudgetExceed = DOM.get<HTMLInputElement>('alert-budget-exceed');
  const browserBudgetNotifications = DOM.get<HTMLInputElement>('browser-budget-notifications');
  const rolloverEnabled = DOM.get<HTMLInputElement>('rollover-enabled');
  const rolloverMode = DOM.get<HTMLSelectElement>('rollover-mode');
  const negativeHandling = DOM.get<HTMLSelectElement>('negative-handling');
  const maxRollover = DOM.get<HTMLInputElement>('max-rollover');

  // CR-Apr24-C2d [P2] finding 112: start the async loads first but
  // do NOT populate form controls until AFTER the awaits resolve —
  // that way the signal reads pick up any cross-tab updates that
  // landed during the import/IO wait (finding 109).
  const browserNotifPromise = browserBudgetNotifications
    ? loadBrowserNotificationsModule()
    : null;
  const featureInterfacePromise = loadFeatureEventInterface();

  // Resolve async work
  if (browserBudgetNotifications && browserNotifPromise) {
    const { isBrowserNotificationSupported, getBrowserNotificationPermission } = await browserNotifPromise;
    browserBudgetNotifications.checked = signals.alerts.value.browserNotificationsEnabled;
    browserBudgetNotifications.disabled = !isBrowserNotificationSupported();
    // CR-Apr24-I finding 113: refresh the tooltip on focus so it shows
    // the current permission even if it changed since modal open.
    const refreshNotifTooltip = (): void => {
      browserBudgetNotifications.title = isBrowserNotificationSupported()
        ? `Current permission: ${getBrowserNotificationPermission()}`
        : 'Browser notifications are not supported in this environment';
    };
    refreshNotifTooltip();
    browserBudgetNotifications.addEventListener('focus', refreshNotifTooltip);
  }
  const { getRolloverSettings } = await featureInterfacePromise;
  const rolloverSettings = await getRolloverSettings() as { enabled: boolean; mode: string; negativeHandling: string; maxRollover?: number };

  // CR-Apr24-C2d [P2] finding 109: read signal values AFTER the
  // async awaits so the form reflects the latest cross-tab state.
  const sections = signals.sections.value;
  const currency = signals.currency.value;
  const alerts = signals.alerts.value;

  if (showEnvelope) showEnvelope.checked = sections.envelope;
  if (showTemplates) showTemplates.checked = sections.transactionsTemplates;
  if (settingsCurrency) settingsCurrency.value = currency.home;
  if (insightPersonality) insightPersonality.value = signals.insightPers.value as string;
  if (alertBudgetExceed) alertBudgetExceed.checked = alerts.budgetThreshold !== null && alerts.budgetThreshold !== undefined;

  if (rolloverEnabled) rolloverEnabled.checked = rolloverSettings.enabled;
  if (rolloverMode) rolloverMode.value = rolloverSettings.mode;
  if (negativeHandling) negativeHandling.value = rolloverSettings.negativeHandling;
  if (maxRollover) maxRollover.value = rolloverSettings.maxRollover?.toString() || '';

  const rolloverOptions = DOM.get('rollover-options');
  if (rolloverOptions) {
    rolloverOptions.classList.toggle('hidden', !rolloverSettings.enabled);
  }

  // CR-Apr24-C2d finding 110: snapshot AFTER populating so the
  // fingerprint matches the values the form was seeded with.
  _settingsSnapshot = _settingsFingerprint();

  // CR-Apr24-C2d [P2] finding 112: guard the async category-manager
  // mount with a "still open?" check so closing the modal before the
  // imports resolve doesn't mount a live component into a hidden dialog.
  openModal('settings-modal');
  void Promise.all([
    import('../../components/category-manager.js'),
    import('../components/async-modal.js')
  ]).then(([{ mountCategoryManager }, asyncModal]) => {
    const modalEl = DOM.get('settings-modal');
    if (!modalEl?.classList.contains('active')) return; // guard
    cleanupCategoryManager = mountCategoryManager('category-manager-mount', undefined, {
      confirm: asyncModal.asyncConfirm,
      alert: asyncModal.asyncAlert,
      prompt: asyncModal.promptTextInput
    });
  }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
}

// ==========================================
// DELETE MODAL
// ==========================================

/**
 * Set up delete confirmation modal handlers
 */
function setupDeleteModal(): void {
  const cancelDeleteButton = DOM.get('cancel-delete');
  if (cancelDeleteButton) bindModalEvent(cancelDeleteButton, 'click', () => {
    closeModal('delete-modal');
    modal.clearDeleteTargetId();
  });

  const confirmDeleteButton = DOM.get('confirm-delete');
  if (confirmDeleteButton) bindModalEvent(confirmDeleteButton, 'click', async () => {
    const deleteTargetId = signals.deleteTargetId.value;
    if (deleteTargetId) {
      const transactions = signals.transactions.value;
      const tx = transactions.find(t => t.__backendId === deleteTargetId);
      if (tx) {
        const btn = DOM.get<HTMLButtonElement>('confirm-delete');
        if (btn) {
          btn.textContent = 'Deleting…';
          btn.disabled = true;
        }
        const backup = { ...tx };

        try {
          const result = await dataSdk.delete(tx);
          if (btn) {
            btn.textContent = 'Delete';
            btn.disabled = false;
          }

          if (!result.isOk) {
            showToast('Couldn\u2019t delete transaction \u2014 close other Harbor Ledger tabs and try again.', 'error');
            return;
          }

          showUndoToast('Transaction deleted', async () => {
            try {
              const undoResult = await dataSdk.create(backup);
              if (!undoResult.isOk) showToast('Couldn\u2019t undo \u2014 the transaction may have already been modified.', 'error');
            } catch (e) {
              if (import.meta.env.DEV) console.error('Undo failed:', e);
              showToast('Couldn\u2019t undo \u2014 the transaction may have already been modified.', 'error');
            }
          });
        } catch (e) {
          if (btn) {
            btn.textContent = 'Delete';
            btn.disabled = false;
          }
          if (import.meta.env.DEV) console.error('Delete failed:', e);
          showToast('Couldn\u2019t delete transaction \u2014 close other Harbor Ledger tabs and try again.', 'error');
          return;
        }
      }
    }
    closeModal('delete-modal');
    modal.clearDeleteTargetId();
  });
}

// ==========================================
// EDIT RECURRING MODAL
// ==========================================

/**
 * Set up edit recurring modal handlers
 */
function setupEditRecurringModal(): void {
  const cancelEditRecurringButton = DOM.get('cancel-edit-recurring');
  if (cancelEditRecurringButton) bindModalEvent(cancelEditRecurringButton, 'click', () => {
    closeModal('edit-recurring-modal');
    modal.clearPendingEditTx();
  });

  const editSingleButton = DOM.get('edit-single');
  if (editSingleButton) bindModalEvent(editSingleButton, 'click', () => {
    closeModal('edit-recurring-modal');
    const pendingEditTx = signals.pendingEditTx.value;
    if (pendingEditTx) {
      form.setEditSeriesMode(false);
      void startEditingFn?.(pendingEditTx);
    }
    modal.clearPendingEditTx();
  });

  const editSeriesButton = DOM.get('edit-series');
  if (editSeriesButton) bindModalEvent(editSeriesButton, 'click', () => {
    closeModal('edit-recurring-modal');
    const pendingEditTx = signals.pendingEditTx.value;
    if (pendingEditTx) {
      form.setEditSeriesMode(true);
      void startEditingFn?.(pendingEditTx);
    }
    modal.clearPendingEditTx();
  });
}

// ==========================================
// SAVINGS GOAL MODALS
// ==========================================

/**
 * Set up savings goal modal handlers
 */
/**
 * Reset the emoji picker in the savings-goal modal so the first option is
 * selected. Any previously-selected radio button is deselected.
 */
function resetSavingsGoalEmojiPicker(): void {
  const picker = DOM.get('savings-goal-emoji-picker');
  if (!picker) return;
  const buttons = picker.querySelectorAll<HTMLButtonElement>('.savings-goal-emoji-btn');
  buttons.forEach((btn, i) => {
    const isDefault = i === 0;
    btn.setAttribute('aria-checked', isDefault ? 'true' : 'false');
    // A11y (Design-Review-Apr21 P2): keep roving tabindex in sync with
    // the checked radio so a keyboard user tabbing into the radiogroup
    // lands on the current selection (WAI-ARIA APG "Radio Group").
    btn.setAttribute('tabindex', isDefault ? '0' : '-1');
    btn.classList.toggle('savings-goal-emoji-btn--selected', isDefault);
  });
}

/**
 * Select the given emoji-picker button: update aria-checked + roving
 * tabindex + visual class across the group, and optionally focus the
 * newly-selected button (true for arrow-key movement, false for click).
 */
function selectEmojiPickerButton(
  picker: HTMLElement,
  target: HTMLButtonElement,
  moveFocus: boolean,
): void {
  const buttons = picker.querySelectorAll<HTMLButtonElement>('.savings-goal-emoji-btn');
  buttons.forEach(btn => {
    const isSelected = btn === target;
    btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    btn.setAttribute('tabindex', isSelected ? '0' : '-1');
    btn.classList.toggle('savings-goal-emoji-btn--selected', isSelected);
  });
  if (moveFocus) target.focus();
}

/**
 * Return the emoji selected in the savings-goal picker (or the first option
 * as a fallback). Kept lenient so the modal still saves if the radio state
 * is somehow out of sync.
 */
function getSelectedGoalEmoji(): string {
  const picker = DOM.get('savings-goal-emoji-picker');
  if (!picker) return '💚';
  const selected = picker.querySelector<HTMLButtonElement>('.savings-goal-emoji-btn[aria-checked="true"]');
  const fallback = picker.querySelector<HTMLButtonElement>('.savings-goal-emoji-btn');
  return (selected ?? fallback)?.dataset.emoji || '💚';
}

function setupSavingsGoalModals(): void {
  // Create new savings goal
  const addSavingsGoalButton = DOM.get('add-savings-goal-btn');
  if (addSavingsGoalButton) bindModalEvent(addSavingsGoalButton, 'click', () => {
    openModal('savings-goal-modal');
    const nameEl = DOM.get<HTMLInputElement>('savings-goal-name');
    const amtEl = DOM.get<HTMLInputElement>('savings-goal-amount');
    const deadlineEl = DOM.get<HTMLInputElement>('savings-goal-deadline');
    if (nameEl) nameEl.value = '';
    if (amtEl) amtEl.value = '';
    if (deadlineEl) deadlineEl.value = '';
    // Design-Review-Apr21 P2: the save handler paints red borders and
    // un-hides the `*-error` alert divs on validation failure but never
    // resets them — so a prior failed save ("goal name required")
    // re-decorated the inputs with error styling that persisted when the
    // modal was dismissed and reopened for a fresh goal. Clearing the
    // error DOM alongside the input values keeps open-state in lockstep
    // with the cleared values; every reopen starts in a neutral state.
    const nameErr = DOM.get('savings-goal-name-error');
    const amtErr = DOM.get('savings-goal-amount-error');
    if (nameEl) nameEl.style.borderColor = 'var(--border-input)';
    if (amtEl) amtEl.style.borderColor = 'var(--border-input)';
    if (nameErr) nameErr.classList.add('hidden');
    if (amtErr) amtErr.classList.add('hidden');
    resetSavingsGoalEmojiPicker();
  });

  // Emoji picker: single-select via event delegation so it works regardless
  // of when the modal DOM is rendered.
  const emojiPicker = DOM.get('savings-goal-emoji-picker');
  if (emojiPicker) {
    bindModalEvent(emojiPicker, 'click', (evt: Event) => {
      const target = (evt.target as HTMLElement | null)?.closest<HTMLButtonElement>('.savings-goal-emoji-btn');
      if (!target) return;
      selectEmojiPickerButton(emojiPicker, target, false);
    });

    // A11y (Design-Review-Apr21 P2): arrow-key navigation for the
    // radiogroup. WAI-ARIA APG "Radio Group" — Left/Up → previous,
    // Right/Down → next, Home → first, End → last, all with wrap.
    // Movement both updates the selection (radio semantics) and moves
    // focus to the newly-selected button (roving tabindex).
    bindModalEvent(emojiPicker, 'keydown', (evt: Event) => {
      const e = evt as KeyboardEvent;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      const buttons = Array.from(emojiPicker.querySelectorAll<HTMLButtonElement>('.savings-goal-emoji-btn'));
      if (buttons.length === 0) return;
      const currentIdx = buttons.findIndex(b => b === document.activeElement);
      if (currentIdx === -1) return;
      e.preventDefault();
      let nextIdx = currentIdx;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextIdx = (currentIdx + 1) % buttons.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextIdx = (currentIdx - 1 + buttons.length) % buttons.length;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = buttons.length - 1;
      }
      const nextBtn = buttons[nextIdx];
      if (nextBtn) selectEmojiPickerButton(emojiPicker, nextBtn, true);
    });
  }

  const cancelSavingsGoalButton = DOM.get('cancel-savings-goal');
  if (cancelSavingsGoalButton) bindModalEvent(cancelSavingsGoalButton, 'click', () => {
    closeModal('savings-goal-modal');
  });

  const saveSavingsGoalButton = DOM.get('save-savings-goal');
  if (saveSavingsGoalButton) bindModalEvent(saveSavingsGoalButton, 'click', () => {
    const nameEl = DOM.get<HTMLInputElement>('savings-goal-name');
    const amtEl = DOM.get<HTMLInputElement>('savings-goal-amount');
    const nameErr = DOM.get('savings-goal-name-error');
    const amtErr = DOM.get('savings-goal-amount-error');
    const deadlineEl = DOM.get<HTMLInputElement>('savings-goal-deadline');

    const name = nameEl?.value.trim() || '';
    const amt = parseAmount(amtEl?.value || '');
    const deadline = deadlineEl?.value || '';

    // Reset errors
    if (nameEl) nameEl.style.borderColor = 'var(--border-input)';
    if (amtEl) amtEl.style.borderColor = 'var(--border-input)';
    if (nameErr) nameErr.classList.add('hidden');
    if (amtErr) amtErr.classList.add('hidden');

    let hasError = false;
    if (!name) {
      if (nameEl) nameEl.style.borderColor = 'var(--color-expense)';
      if (nameErr) nameErr.classList.remove('hidden');
      nameEl?.focus();
      hasError = true;
    }
    if (amt <= 0) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = 'Please enter a valid amount';
        amtErr.classList.remove('hidden');
      }
      if (!hasError) amtEl?.focus();
      hasError = true;
    }
    if (amt > 0 && amt < 5) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = `Target amount must be at least ${fmtCur(5)}`;
        amtErr.classList.remove('hidden');
      }
      if (!hasError) amtEl?.focus();
      hasError = true;
    }
    if (amt > CONFIG.MAX_AMOUNT) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = `Amount cannot exceed ${fmtCur(CONFIG.MAX_AMOUNT)}`;
        amtErr.classList.remove('hidden');
      }
      if (!hasError) amtEl?.focus();
      hasError = true;
    }

    if (hasError) return;

    const icon = getSelectedGoalEmoji();
    // rev 12 #34: SavingsGoalData now uses modern `{target, saved}` shape
    // end-to-end (matches stored SavingsGoal + hydration normalizer).
    savingsActions.addGoal({ name, target: amt, deadline, icon });

    // UI updates are handled automatically via signal effects
    closeModal('savings-goal-modal');
    showToast(`Savings goal "${name}" created — target ${fmtCur(amt)}`);
  });

  // Add savings amount to goal
  const cancelAddSavingsButton = DOM.get('cancel-add-savings');
  if (cancelAddSavingsButton) bindModalEvent(cancelAddSavingsButton, 'click', () => {
    closeModal('add-savings-modal');
    modal.clearAddSavingsGoalId();
  });

  // Live-clear the date error as the user edits
  const addSavingsDateInput = DOM.get('add-savings-date');
  if (addSavingsDateInput) bindModalEvent(addSavingsDateInput, 'input', () => {
    const dateErr = DOM.get('add-savings-date-error');
    addSavingsDateInput.style.borderColor = 'var(--border-input)';
    if (dateErr) dateErr.classList.add('hidden');
  });

  const confirmAddSavingsButton = DOM.get('confirm-add-savings');
  if (confirmAddSavingsButton) bindModalEvent(confirmAddSavingsButton, 'click', async () => {
    const amtEl = DOM.get<HTMLInputElement>('add-savings-amount');
    const amtErr = DOM.get('add-savings-amount-error');
    const dateEl = DOM.get<HTMLInputElement>('add-savings-date');
    const dateErr = DOM.get('add-savings-date-error');
    const amt = parseAmount(amtEl?.value || '');

    // Reset errors
    if (amtEl) amtEl.style.borderColor = 'var(--border-input)';
    if (amtErr) amtErr.classList.add('hidden');
    if (dateEl) dateEl.style.borderColor = 'var(--border-input)';
    if (dateErr) dateErr.classList.add('hidden');

    if (amt <= 0) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) amtErr.classList.remove('hidden');
      amtEl?.focus();
      return;
    }
    if (amt > CONFIG.MAX_AMOUNT) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = `Amount cannot exceed ${fmtCur(CONFIG.MAX_AMOUNT)}`;
        amtErr.classList.remove('hidden');
      }
      amtEl?.focus();
      return;
    }

    // Block future-dated contributions (any past date is allowed). Use
    // local-time getTodayStr, not UTC toISOString — otherwise late-evening
    // west-coast entries would be flagged as "future" because UTC has already
    // ticked into tomorrow. See ADR-001 §9.5 Step 8.
    const contribDateRaw = dateEl?.value || '';
    const today = getTodayStr();
    if (contribDateRaw && contribDateRaw > today) {
      if (dateEl) dateEl.style.borderColor = 'var(--color-expense)';
      if (dateErr) dateErr.classList.remove('hidden');
      dateEl?.focus();
      return;
    }

    const goalId = signals.addSavingsGoalId.value;
    if (goalId) {
      const goalName = signals.savingsGoals.value[goalId]?.name || 'Savings goal';
      const contribDate = contribDateRaw || undefined;
      const success = await savingsActions.addContribution(goalId, amt, contribDate);
      if (success) {
        void loadFeatureEventInterface().then(({ checkAchievements }) => {
          checkAchievements();
        }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
        showToast(`Added ${fmtCur(amt)} to ${goalName}`);
      } else {
        showToast('Couldn\u2019t add to savings \u2014 check your amount and try again.', 'error');
      }
    }
    closeModal('add-savings-modal');
    modal.clearAddSavingsGoalId();
  });
}

// ==========================================
// SETTINGS MODAL
// ==========================================

/**
 * Set up settings modal handlers
 */
function setupSettingsModal(): void {
  const openSettingsButton = DOM.get('open-settings');
  if (openSettingsButton) bindModalEvent(openSettingsButton, 'click', openSettingsModal);

  // Toggle rollover options visibility
  const rolloverEnabledControl = DOM.get('rollover-enabled');
  if (rolloverEnabledControl) bindModalEvent(rolloverEnabledControl, 'change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    const options = DOM.get('rollover-options');
    if (options) {
      options.classList.toggle('hidden', !target.checked);
    }
  });

  // Clear PIN handler is in pin-ui-handlers.ts — no duplicate here

  // CR-Apr24-C2d [P2] finding 111: track external theme changes while
  // the settings modal is open so Cancel doesn't silently revert a
  // theme change that arrived from another tab. If the theme changes
  // while the modal is open AND the user hasn't touched the theme
  // picker themselves, update the "theme on open" baseline so Cancel
  // leaves the externally-set theme in place.
  //
  // Implementation: compare with last known `_themeOnOpen` — if the
  // theme changed but no theme-picker click occurred (checked via a
  // flag), adopt the new theme as the baseline.
  //
  // Note: the theme-picker click handler (below) already sets
  // `_themeOnOpen` via the live-preview path, so this only matters
  // for EXTERNAL (cross-tab) theme changes.

  // Cancel without saving - revert theme if changed, then close
  const cancelSettingsHandler = (): void => {
    // Only revert theme if the user actively changed it via the
    // settings modal theme picker. If the theme differs from
    // _themeOnOpen due to an external cross-tab change, DO NOT
    // revert — the external change is authoritative.
    if (_themeOnOpen && signals.theme.value !== _themeOnOpen) {
      settings.setTheme(_themeOnOpen as Theme);
    }
    _settingsSnapshot = null;
    if (cleanupCategoryManager) { cleanupCategoryManager(); cleanupCategoryManager = null; }
    closeModal('settings-modal');
  };
  const cancelSettingsButton = DOM.get('cancel-settings');
  if (cancelSettingsButton) bindModalEvent(cancelSettingsButton, 'click', cancelSettingsHandler);

  // Header X button - same behavior as cancel
  const closeSettingsXButton = DOM.get('close-settings-x');
  if (closeSettingsXButton) bindModalEvent(closeSettingsXButton, 'click', cancelSettingsHandler);

  // Save settings and close
  const closeSettingsButton = DOM.get('close-settings');
  if (closeSettingsButton) bindModalEvent(closeSettingsButton, 'click', async () => {
    // CR-Apr24-C2d [P2] finding 110: detect concurrent cross-tab
    // modifications. If settings changed elsewhere while the modal
    // was open, warn the user — their save will overwrite the newer
    // values with stale form state.
    if (_settingsSnapshot && _settingsFingerprint() !== _settingsSnapshot) {
      showToast('Settings were modified elsewhere — your save will overwrite. Re-open to see latest values.', 'warning');
      _settingsSnapshot = null; // don't re-fire on second save
    }

    const showEnvelope = DOM.get<HTMLInputElement>('show-envelope');
    const showTemplates = DOM.get<HTMLInputElement>('show-templates');
    const settingsCurrency = DOM.get<HTMLSelectElement>('settings-currency');
    const insightPersonality = DOM.get<HTMLSelectElement>('insight-personality');
    const alertBudgetExceed = DOM.get<HTMLInputElement>('alert-budget-exceed');
    const browserBudgetNotificationsEl = DOM.get<HTMLInputElement>('browser-budget-notifications');
    const rolloverEnabledEl = DOM.get<HTMLInputElement>('rollover-enabled');
    const rolloverModeEl = DOM.get<HTMLSelectElement>('rollover-mode');
    const negativeHandlingEl = DOM.get<HTMLSelectElement>('negative-handling');
    const maxRolloverEl = DOM.get<HTMLInputElement>('max-rollover');
    const sectionsVal = {
      ...signals.sections.value,
      envelope: showEnvelope?.checked || false,
      transactionsTemplates: showTemplates?.checked || false
    };
    const curr = settingsCurrency?.value || 'USD';
    const currencyMap = CURRENCY_MAP;
    const currencySymbol = currencyMap[curr] || '$';
    const newPers = insightPersonality?.value as InsightPersonality;
    const rolloverEnabled = rolloverEnabledEl?.checked || false;
    const rolloverMode = (rolloverModeEl?.value || 'all') as RolloverMode;
    const negativeHandling = (negativeHandlingEl?.value || 'zero') as NegativeHandling;
    const maxVal = maxRolloverEl?.value;
    const maxRollover = maxVal ? parseAmount(maxVal) : null;

    try {
      let browserNotificationsEnabled = browserBudgetNotificationsEl?.checked || false;
      if (browserNotificationsEnabled) {
        const {
          isBrowserNotificationSupported,
          getBrowserNotificationPermission,
          requestBrowserNotificationPermission
        } = await loadBrowserNotificationsModule();
        if (!isBrowserNotificationSupported()) {
          browserNotificationsEnabled = false;
          showToast('Browser notifications are not supported in this environment', 'warning');
        } else if (getBrowserNotificationPermission() !== 'granted') {
          const permission = await requestBrowserNotificationPermission();
          if (permission !== 'granted') {
            browserNotificationsEnabled = false;
            showToast('Browser notifications were not enabled', permission === 'denied' ? 'warning' : 'info');
          }
        }
      }

      const alertsVal = normalizeAlertPrefs({
        ...signals.alerts.value,
        budgetThreshold: alertBudgetExceed?.checked ? 0.8 : null,
        browserNotificationsEnabled
      });
      const {
        setRolloverEnabled,
        setRolloverMode,
        setNegativeHandling,
        setMaxRollover
      } = await loadRolloverModule();

      settings.setSections(sectionsVal);
      persist(SK.SECTIONS, signals.sections.value);

      settings.setCurrency(curr, currencySymbol);
      persist(SK.CURRENCY, signals.currency.value);

      settings.setAlerts(alertsVal);
      persist(SK.ALERTS, signals.alerts.value);

      if (newPers !== signals.insightPers.value) {
        settings.setInsightPersonality(newPers);
        persist(SK.INSIGHT_PERS, signals.insightPers.value);
      }

      // Theme is already persisted on click, but ensure it's saved here too
      persist(SK.THEME, signals.theme.value);

      setRolloverEnabled(rolloverEnabled);
      setRolloverMode(rolloverMode);
      setNegativeHandling(negativeHandling);
      setMaxRollover(maxRollover);

      _settingsSnapshot = null;
      if (cleanupCategoryManager) { cleanupCategoryManager(); cleanupCategoryManager = null; }
      closeModal('settings-modal');
      showToast('Settings saved — changes applied');
      refreshAllFn?.();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to save settings:', error);
      showToast('Settings couldn\u2019t be saved \u2014 storage may be full. Try clearing old backups in Settings > Data.', 'error');
    }
  });

  // Restart Onboarding Tour
  const restartOnboardingButton = DOM.get('restart-onboarding');
  if (restartOnboardingButton) bindModalEvent(restartOnboardingButton, 'click', () => {
    lsSet(SK.ONBOARD, { completed: false, step: 0 });
    closeModal('settings-modal');
    // CR-Apr24-I finding 126: cancel any pending restart to prevent
    // duplicate onboarding launches from rapid clicks.
    if (_onboardingRestartTimer) clearTimeout(_onboardingRestartTimer);
    _onboardingRestartTimer = setTimeout(() => {
      _onboardingRestartTimer = null;
      void loadFeatureEventInterface().then(({ startOnboarding }) => {
        startOnboarding();
      }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
    }, 300);
  });
}

// ==========================================
// ANALYTICS MODAL
// ==========================================

/**
 * Set up analytics modal handlers
 */
function setupAnalyticsModal(): void {
  async function renderAnalyticsModalNow(): Promise<void> {
    const { renderAnalyticsModal } = await loadAnalyticsModule();
    renderAnalyticsModal();
  }

  async function openAnalyticsModalHandler(): Promise<void> {
    // 7a (Inline-Behavior-Review, Period/scope coherence): pre-fix this
    // handler hardcoded `setAnalyticsCurrentPeriod('all-time')` on every
    // open, wiping whatever year tab the user had selected the last time
    // they used the modal this session. That contradicted the year-tab
    // switcher's visible UX — clicking "2024" and then closing the modal
    // looked like a durable selection, but the next open reset it to
    // All-Time with no warning. `analyticsCurrentPeriod` is module-scope
    // state in `analytics-ui.ts` and already defaults to `'all-time'` on
    // first page load, so removing the reset gives the right shape:
    // first-open → All-Time, subsequent opens → whatever the user picked.
    // `renderAnalyticsPeriodTabs` has a `hasCurrentPeriod` validity check
    // that self-heals to `years[0]` if the saved period's year no longer
    // has data (e.g., user deleted every 2024 transaction), so stale
    // selections can't stick around after the data supporting them is
    // gone.
    await loadAnalyticsModule();
    openModal('analytics-modal');
    // CR-Apr24-I findings 116/117: (a) cancel any pending render to avoid
    // duplicate work from rapid open attempts, and (b) guard the callback
    // so it only renders if the modal is still open.
    if (_analyticsRenderTimer) clearTimeout(_analyticsRenderTimer);
    _analyticsRenderTimer = setTimeout(() => {
      _analyticsRenderTimer = null;
      const modal = DOM.get('analytics-modal');
      if (modal?.classList.contains('active')) {
        void renderAnalyticsModalNow();
      }
    }, CONFIG.TIMING.UI_DELAY);
  }

  const openAnalyticsButton = DOM.get('open-analytics');
  if (openAnalyticsButton) bindModalEvent(openAnalyticsButton, 'click', () => {
    void openAnalyticsModalHandler();
  });
  // Dashboard "More in Analytics →" links
  document.querySelectorAll<HTMLButtonElement>('[data-open-analytics]').forEach(btn => {
    bindModalEvent(btn, 'click', () => {
      void openAnalyticsModalHandler();
    });
  });
  const closeAnalyticsButton = DOM.get('close-analytics');
  if (closeAnalyticsButton) bindModalEvent(closeAnalyticsButton, 'click', () => closeModal('analytics-modal'));
}

// ==========================================
// THEME AND ALERTS
// ==========================================

/**
 * Set up theme button handlers
 */
function setupThemeButtons(): void {
  DOM.queryAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    bindModalEvent(btn, 'click', () => {
      void loadFeatureEventInterface().then(({ setTheme }) => {
        const theme = (btn.dataset.theme || 'system') as Theme;
        setTheme(theme);
        // Persist immediately so theme survives modal close/cancel
        persist(SK.THEME, theme);
        // Update the "open" snapshot so Cancel doesn't revert
        _themeOnOpen = theme;
      }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
    });
  });
}

/**
 * Set up alert dismiss and celebration close handlers
 */
function setupAlertAndCelebration(): void {
  const dismissAlertButton = DOM.get('dismiss-alert');
  if (dismissAlertButton) bindModalEvent(dismissAlertButton, 'click', () => {
    const alertText = DOM.get('alert-text');
    const txt = alertText?.textContent || '';
    const alertId = dismissAlertButton.getAttribute('data-alert-id')
      || alertText?.getAttribute('data-alert-id')
      || txt;
    void loadFeatureEventInterface().then(({ dismissAlert }) => {
      dismissAlert(alertId);
    }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
  });

  // Design-Review-Apr21 P2: only the static `#celebration-close` button in
  // `index.html` exists — the old `#close-celebration` binding paired to the
  // deleted `renderCelebrationModal()` lit template and is now dead. Keep
  // the single live binding.
  const celebrationCloseButton = DOM.get('celebration-close');
  if (celebrationCloseButton) bindModalEvent(celebrationCloseButton, 'click', () => {
    // CR-Apr24-I finding 148: stop the confetti animation loop before
    // hiding the overlay so it doesn't keep running in the background.
    void import('../../features/gamification/celebration.js').then(({ clearConfetti }) => {
      clearConfetti();
    }).catch((e) => { if (import.meta.env.DEV) console.error(e); });
    closeModal('celebration-overlay');
  });
}

// ==========================================
// SAMPLE DATA
// ==========================================

/**
 * Set up sample data handlers
 */
function setupSampleData(): void {
  const loadSampleDataButton = DOM.get('load-sample-data');
  if (loadSampleDataButton) bindModalEvent(loadSampleDataButton, 'click', async () => {
    const loaded = await Promise.resolve(loadSampleDataFn?.() ?? false);
    if (!loaded) return;

    closeModal('settings-modal');
    const { switchMainTab } = await import('../core/ui-navigation.js');
    switchMainTab('dashboard');
  });

  const runReset = async (clearBackups: boolean): Promise<void> => {
    const keepBtn = DOM.get('confirm-reset-keep-backups');
    const clearBtn = DOM.get('confirm-reset-clear-backups');
    const cancelBtn = DOM.get('cancel-reset-app-data');
    const buttons = [keepBtn, clearBtn, cancelBtn].filter(Boolean) as HTMLButtonElement[];
    const originalTexts = buttons.map((btn) => btn.textContent || '');

    buttons.forEach((btn) => {
      btn.disabled = true;
    });
    if (clearBtn) clearBtn.textContent = clearBackups ? 'Clearing…' : originalTexts[1] || clearBtn.textContent || '';
    if (keepBtn) keepBtn.textContent = clearBackups ? originalTexts[0] || keepBtn.textContent || '' : 'Clearing…';

    try {
      const { resetAppData } = await loadAppResetModule();
      const result = await resetAppData({ clearBackups });

      if (!result.ok) {
        showToast('Reset couldn\u2019t complete. Close other Harbor Ledger tabs and try again.', 'error');
        return;
      }

      // CR-May02-B: reload the page after a successful reset instead of
      // trying to surgically refresh every UI surface in-place. The
      // previous approach used dynamic `import()` calls to pull in
      // ui-navigation, transaction-surface-coordinator, and onboarding
      // after the Preact signal batch completed. Those dynamic imports
      // deadlocked the renderer — the batch left deferred signal effects
      // queued, and when the first `await import(...)` yielded, those
      // effects fired mid-module-resolution inside Vite's ESM loader,
      // creating a circular-evaluation freeze. A full reload is the
      // most robust solution: it guarantees every module, signal, DOM
      // element, and effect starts from a clean slate consistent with
      // the wiped storage — exactly matching a first-time-user boot.
      window.location.reload();
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to reset app data:', error);
      showToast('Reset couldn\u2019t complete. Close other Harbor Ledger tabs and try again.', 'error');
    } finally {
      buttons.forEach((btn, index) => {
        // Phase 6 Slice 1i (rev 12 L6): `originalTexts[index]` is
        // `string | null | undefined` under `noUncheckedIndexedAccess`;
        // `?? null` collapses the `undefined` back to the `string | null`
        // assignable to `textContent`.
        btn.disabled = false;
        btn.textContent = originalTexts[index] ?? null;
      });
    }
  };

  const clearAllDataButton = DOM.get('clear-all-data');
  if (clearAllDataButton) bindModalEvent(clearAllDataButton, 'click', () => {
    openModal('reset-app-data-modal');
  });

  const cancelResetButton = DOM.get('cancel-reset-app-data');
  if (cancelResetButton) bindModalEvent(cancelResetButton, 'click', () => {
    closeModal('reset-app-data-modal');
  });

  const confirmResetKeepBackupsButton = DOM.get('confirm-reset-keep-backups');
  if (confirmResetKeepBackupsButton) bindModalEvent(confirmResetKeepBackupsButton, 'click', () => {
    void runReset(false);
  });

  const confirmResetClearBackupsButton = DOM.get('confirm-reset-clear-backups');
  if (confirmResetClearBackupsButton) bindModalEvent(confirmResetClearBackupsButton, 'click', () => {
    void runReset(true);
  });
}
