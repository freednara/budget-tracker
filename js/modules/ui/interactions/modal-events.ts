/**
 * Modal Events Module
 *
 * Handles all modal event handlers: delete, edit recurring, savings goals,
 * settings, analytics, theme, alerts, celebration, undo, and sample data.
 *
 * @module modal-events
 */
'use strict';

import { SK, persist, lsSet, normalizeAlertPrefs } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { modal, form, settings, savingsGoals as savingsActions } from '../../core/state-actions.js';
import { openModal, closeModal, showToast, showUndoToast } from '../core/ui.js';
import { parseAmount, generateId, getTodayStr, fmtCur } from '../../core/utils.js';
import { dataSdk } from '../../data/data-manager.js';
import { CONFIG, CURRENCY_MAP } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, SavingsContribution, InsightPersonality, AlertPrefs, CurrencySettings, RolloverMode, NegativeHandling, Theme, LegacySavingsGoal, CurrencyFormatter } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface ModalEventCallbacks {
  fmtCur?: CurrencyFormatter;
  renderSavingsGoals?: () => void;
  updateSummary?: () => void;
  renderCustomCatsList?: () => void;
  refreshAll?: () => void;
  resetForm?: () => void | Promise<void>;
  startEditing?: (tx: Transaction) => void;
  loadSampleData?: () => boolean | Promise<boolean>;
}

// Using LegacySavingsGoal from central types

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let fmtCurFn: CurrencyFormatter = fmtCur;
let renderSavingsGoalsFn: (() => void) | null = null;
let updateSummaryFn: (() => void) | null = null;
let renderCustomCatsListFn: (() => void) | null = null;
let refreshAllFn: (() => void) | null = null;
let resetFormFn: (() => void | Promise<void>) | null = null;
let startEditingFn: ((tx: Transaction) => void) | null = null;
let loadSampleDataFn: (() => boolean | Promise<boolean>) | null = null;
const modalEventCleanups: Array<() => void> = [];

function bindModalEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject
): void {
  target.addEventListener(type, handler);
  modalEventCleanups.push(() => {
    target.removeEventListener(type, handler);
  });
}

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

  if (callbacks.fmtCur) fmtCurFn = callbacks.fmtCur;
  if (callbacks.renderSavingsGoals) renderSavingsGoalsFn = callbacks.renderSavingsGoals;
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

/**
 * Open settings modal (exported for keyboard shortcut)
 */
export async function openSettingsModal(): Promise<void> {
  _themeOnOpen = signals.theme.value;
  const showEnvelope = DOM.get('show-envelope') as HTMLInputElement | null;
  const settingsCurrency = DOM.get('settings-currency') as HTMLSelectElement | null;
  const insightPersonality = DOM.get('insight-personality') as HTMLSelectElement | null;
  const alertBudgetExceed = DOM.get('alert-budget-exceed') as HTMLInputElement | null;
  const browserBudgetNotifications = DOM.get('browser-budget-notifications') as HTMLInputElement | null;
  const rolloverEnabled = DOM.get('rollover-enabled') as HTMLInputElement | null;
  const rolloverMode = DOM.get('rollover-mode') as HTMLSelectElement | null;
  const negativeHandling = DOM.get('negative-handling') as HTMLSelectElement | null;
  const maxRollover = DOM.get('max-rollover') as HTMLInputElement | null;

  const sections = signals.sections.value;
  const currency = signals.currency.value;
  const alerts = signals.alerts.value;

  if (showEnvelope) showEnvelope.checked = sections.envelope;
  if (settingsCurrency) settingsCurrency.value = currency.home;
  if (insightPersonality) insightPersonality.value = signals.insightPers.value as string;
  // Checkbox reflects whether budget alerts are active (any non-null threshold)
  if (alertBudgetExceed) alertBudgetExceed.checked = alerts.budgetThreshold !== null && alerts.budgetThreshold !== undefined;
  if (browserBudgetNotifications) {
    const { isBrowserNotificationSupported, getBrowserNotificationPermission } = await loadBrowserNotificationsModule();
    browserBudgetNotifications.checked = alerts.browserNotificationsEnabled;
    browserBudgetNotifications.disabled = !isBrowserNotificationSupported();
    browserBudgetNotifications.title = isBrowserNotificationSupported()
      ? `Current permission: ${getBrowserNotificationPermission()}`
      : 'Browser notifications are not supported in this environment';
  }

  // Rollover settings
  const { getRolloverSettings } = await loadFeatureEventInterface();
  const rolloverSettings = await getRolloverSettings() as { enabled: boolean; mode: string; negativeHandling: string; maxRollover?: number };
  if (rolloverEnabled) rolloverEnabled.checked = rolloverSettings.enabled;
  if (rolloverMode) rolloverMode.value = rolloverSettings.mode;
  if (negativeHandling) negativeHandling.value = rolloverSettings.negativeHandling;
  if (maxRollover) maxRollover.value = rolloverSettings.maxRollover?.toString() || '';

  // Update visibility of rollover options
  const rolloverOptions = DOM.get('rollover-options');
  if (rolloverOptions) {
    rolloverOptions.classList.toggle('hidden', !rolloverSettings.enabled);
  }

  renderCustomCatsListFn?.();
  openModal('settings-modal');
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
        const btn = DOM.get('confirm-delete') as HTMLButtonElement | null;
        if (btn) {
          btn.textContent = 'Deleting...';
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
            showToast('Failed to delete transaction', 'error');
            return;
          }

          showUndoToast('Transaction deleted', async () => {
            try {
              const undoResult = await dataSdk.create(backup);
              if (!undoResult.isOk) showToast('Undo failed', 'error');
            } catch (e) {
              if (import.meta.env.DEV) console.error('Undo failed:', e);
              showToast('Undo failed', 'error');
            }
          });
        } catch (e) {
          if (btn) {
            btn.textContent = 'Delete';
            btn.disabled = false;
          }
          if (import.meta.env.DEV) console.error('Delete failed:', e);
          showToast('Failed to delete transaction', 'error');
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
      startEditingFn?.(pendingEditTx);
    }
    modal.clearPendingEditTx();
  });

  const editSeriesButton = DOM.get('edit-series');
  if (editSeriesButton) bindModalEvent(editSeriesButton, 'click', () => {
    closeModal('edit-recurring-modal');
    const pendingEditTx = signals.pendingEditTx.value;
    if (pendingEditTx) {
      form.setEditSeriesMode(true);
      startEditingFn?.(pendingEditTx);
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
function setupSavingsGoalModals(): void {
  // Create new savings goal
  const addSavingsGoalButton = DOM.get('add-savings-goal-btn');
  if (addSavingsGoalButton) bindModalEvent(addSavingsGoalButton, 'click', () => {
    openModal('savings-goal-modal');
    const nameEl = DOM.get('savings-goal-name') as HTMLInputElement | null;
    const amtEl = DOM.get('savings-goal-amount') as HTMLInputElement | null;
    const deadlineEl = DOM.get('savings-goal-deadline') as HTMLInputElement | null;
    if (nameEl) nameEl.value = '';
    if (amtEl) amtEl.value = '';
    if (deadlineEl) deadlineEl.value = '';
  });

  const cancelSavingsGoalButton = DOM.get('cancel-savings-goal');
  if (cancelSavingsGoalButton) bindModalEvent(cancelSavingsGoalButton, 'click', () => {
    closeModal('savings-goal-modal');
  });

  const saveSavingsGoalButton = DOM.get('save-savings-goal');
  if (saveSavingsGoalButton) bindModalEvent(saveSavingsGoalButton, 'click', () => {
    const nameEl = DOM.get('savings-goal-name') as HTMLInputElement | null;
    const amtEl = DOM.get('savings-goal-amount') as HTMLInputElement | null;
    const nameErr = DOM.get('savings-goal-name-error');
    const amtErr = DOM.get('savings-goal-amount-error');
    const deadlineEl = DOM.get('savings-goal-deadline') as HTMLInputElement | null;

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
        amtErr.textContent = `Target amount must be at least ${fmtCurFn(5)}`;
        amtErr.classList.remove('hidden');
      }
      if (!hasError) amtEl?.focus();
      hasError = true;
    }
    if (amt > CONFIG.MAX_AMOUNT) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = `Amount cannot exceed ${fmtCurFn(CONFIG.MAX_AMOUNT)}`;
        amtErr.classList.remove('hidden');
      }
      if (!hasError) amtEl?.focus();
      hasError = true;
    }

    if (hasError) return;

    savingsActions.addGoal({ name, target_amount: amt, deadline });
    
    // UI updates are handled automatically via signal effects
    closeModal('savings-goal-modal');
    showToast('Savings goal created');
  });

  // Add savings amount to goal
  const cancelAddSavingsButton = DOM.get('cancel-add-savings');
  if (cancelAddSavingsButton) bindModalEvent(cancelAddSavingsButton, 'click', () => {
    closeModal('add-savings-modal');
    modal.clearAddSavingsGoalId();
  });

  const confirmAddSavingsButton = DOM.get('confirm-add-savings');
  if (confirmAddSavingsButton) bindModalEvent(confirmAddSavingsButton, 'click', async () => {
    const amtEl = DOM.get('add-savings-amount') as HTMLInputElement | null;
    const amtErr = DOM.get('add-savings-amount-error');
    const amt = parseAmount(amtEl?.value || '');

    // Reset error
    if (amtEl) amtEl.style.borderColor = 'var(--border-input)';
    if (amtErr) amtErr.classList.add('hidden');

    if (amt <= 0) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) amtErr.classList.remove('hidden');
      amtEl?.focus();
      return;
    }
    if (amt > CONFIG.MAX_AMOUNT) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = `Amount cannot exceed ${fmtCurFn(CONFIG.MAX_AMOUNT)}`;
        amtErr.classList.remove('hidden');
      }
      amtEl?.focus();
      return;
    }

    const goalId = signals.addSavingsGoalId.value;
    if (goalId) {
      const goalName = signals.savingsGoals.value[goalId]?.name || 'Savings goal';
      const success = await savingsActions.addContribution(goalId, amt);
      if (success) {
        void loadFeatureEventInterface().then(({ checkAchievements }) => {
          checkAchievements();
        });
        showToast(`Added ${fmtCurFn(amt)} to ${goalName}`);
      } else {
        showToast('Failed to add contribution', 'error');
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

  // Cancel without saving - revert theme if changed, then close
  const cancelSettingsButton = DOM.get('cancel-settings');
  if (cancelSettingsButton) bindModalEvent(cancelSettingsButton, 'click', () => {
    // Revert theme if it was changed during this settings session
    if (_themeOnOpen && signals.theme.value !== _themeOnOpen) {
      settings.setTheme(_themeOnOpen as Theme);
    }
    closeModal('settings-modal');
  });

  // Save settings and close
  const closeSettingsButton = DOM.get('close-settings');
  if (closeSettingsButton) bindModalEvent(closeSettingsButton, 'click', async () => {
    const showEnvelope = DOM.get('show-envelope') as HTMLInputElement | null;
    const settingsCurrency = DOM.get('settings-currency') as HTMLSelectElement | null;
    const insightPersonality = DOM.get('insight-personality') as HTMLSelectElement | null;
    const alertBudgetExceed = DOM.get('alert-budget-exceed') as HTMLInputElement | null;
    const browserBudgetNotificationsEl = DOM.get('browser-budget-notifications') as HTMLInputElement | null;
    const rolloverEnabledEl = DOM.get('rollover-enabled') as HTMLInputElement | null;
    const rolloverModeEl = DOM.get('rollover-mode') as HTMLSelectElement | null;
    const negativeHandlingEl = DOM.get('negative-handling') as HTMLSelectElement | null;
    const maxRolloverEl = DOM.get('max-rollover') as HTMLInputElement | null;
    const currencyDisplay = DOM.get('currency-display');

    const sectionsVal = {
      ...signals.sections.value,
      envelope: showEnvelope?.checked || false
    };
    const curr = settingsCurrency?.value || 'USD';
    const currencyMap = CURRENCY_MAP as Record<string, string>;
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
      if (currencyDisplay) currencyDisplay.textContent = signals.currency.value.symbol;

      settings.setAlerts(alertsVal);
      persist(SK.ALERTS, signals.alerts.value);

      if (newPers !== signals.insightPers.value) {
        settings.setInsightPersonality(newPers);
        persist(SK.INSIGHT_PERS, signals.insightPers.value);
      }

      setRolloverEnabled(rolloverEnabled);
      setRolloverMode(rolloverMode);
      setNegativeHandling(negativeHandling);
      setMaxRollover(maxRollover);

      closeModal('settings-modal');
      showToast('Settings saved');
      refreshAllFn?.();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to save settings:', error);
      showToast('Settings not saved. Please try again.', 'error');
    }
  });

  // Restart Onboarding Tour
  const restartOnboardingButton = DOM.get('restart-onboarding');
  if (restartOnboardingButton) bindModalEvent(restartOnboardingButton, 'click', () => {
    lsSet(SK.ONBOARD, { completed: false, step: 0 });
    closeModal('settings-modal');
    setTimeout(() => {
      void loadFeatureEventInterface().then(({ startOnboarding }) => {
        startOnboarding();
      });
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
    const { setAnalyticsCurrentPeriod } = await loadAnalyticsModule();
    setAnalyticsCurrentPeriod('all-time');
    openModal('analytics-modal');
    setTimeout(() => {
      void renderAnalyticsModalNow();
    }, CONFIG.TIMING.UI_DELAY);
  }

  const openAnalyticsButton = DOM.get('open-analytics');
  if (openAnalyticsButton) bindModalEvent(openAnalyticsButton, 'click', () => {
    void openAnalyticsModalHandler();
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
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    bindModalEvent(btn, 'click', () => {
      void loadFeatureEventInterface().then(({ setTheme }) => {
        setTheme((btn.dataset.theme || 'system') as Theme);
      });
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
    void loadFeatureEventInterface().then(({ dismissAlert }) => {
      dismissAlert(txt);
    });
  });

  const closeCelebration = (): void => {
    closeModal('celebration-overlay');
  };

  const celebrationCloseButton = DOM.get('celebration-close');
  if (celebrationCloseButton) bindModalEvent(celebrationCloseButton, 'click', closeCelebration);
  const closeCelebrationButton = DOM.get('close-celebration');
  if (closeCelebrationButton) bindModalEvent(closeCelebrationButton, 'click', closeCelebration);
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
    const keepBtn = DOM.get('confirm-reset-keep-backups') as HTMLButtonElement | null;
    const clearBtn = DOM.get('confirm-reset-clear-backups') as HTMLButtonElement | null;
    const cancelBtn = DOM.get('cancel-reset-app-data') as HTMLButtonElement | null;
    const buttons = [keepBtn, clearBtn, cancelBtn].filter(Boolean) as HTMLButtonElement[];
    const originalTexts = buttons.map((btn) => btn.textContent || '');

    buttons.forEach((btn) => {
      btn.disabled = true;
    });
    if (clearBtn) clearBtn.textContent = clearBackups ? 'Clearing...' : originalTexts[1] || clearBtn.textContent || '';
    if (keepBtn) keepBtn.textContent = clearBackups ? originalTexts[0] || keepBtn.textContent || '' : 'Clearing...';

    try {
      const { resetAppData } = await loadAppResetModule();
      const result = await resetAppData({ clearBackups });

      if (!result.ok) {
        showToast('Reset failed. Please try again.', 'error');
        return;
      }

      closeModal('reset-app-data-modal');
      closeModal('settings-modal');

      const successMessage = clearBackups ? 'App data and backups cleared' : 'App data cleared. Stored backups were kept.';

      try {
        const { switchMainTab, switchTab } = await import('../core/ui-navigation.js');
        const { refreshTransactionsSurface } = await import('../../data/transaction-surface-coordinator.js');
        switchMainTab('dashboard');
        switchTab('expense');

        await Promise.resolve(resetFormFn?.());
        await refreshTransactionsSurface({ resetPage: true });
        refreshAllFn?.();
        renderCustomCatsListFn?.();
        updateSummaryFn?.();
        showToast(successMessage, 'success');
      } catch (followUpError) {
        if (import.meta.env.DEV) console.warn('Reset completed but follow-up UI refresh failed:', followUpError);
        showToast(`${successMessage} Some screens may need a refresh.`, 'warning');
      }
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to reset app data:', error);
      showToast('Reset failed. Please try again.', 'error');
    } finally {
      buttons.forEach((btn, index) => {
        btn.disabled = false;
        btn.textContent = originalTexts[index];
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
