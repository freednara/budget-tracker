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
  DOM.get('sync-accept-remote')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sync-conflict-resolution', { 
      detail: { action: 'accept' } 
    }));
    closeModal('sync-conflict-modal');
  });

  DOM.get('sync-keep-local')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sync-conflict-resolution', { 
      detail: { action: 'reject' } 
    }));
    closeModal('sync-conflict-modal');
  });

  DOM.get('sync-merge-changes')?.addEventListener('click', () => {
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
  DOM.get('cancel-delete')?.addEventListener('click', () => {
    closeModal('delete-modal');
    modal.clearDeleteTargetId();
  });

  DOM.get('confirm-delete')?.addEventListener('click', async () => {
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
  DOM.get('cancel-edit-recurring')?.addEventListener('click', () => {
    closeModal('edit-recurring-modal');
    modal.clearPendingEditTx();
  });

  DOM.get('edit-single')?.addEventListener('click', () => {
    closeModal('edit-recurring-modal');
    const pendingEditTx = signals.pendingEditTx.value;
    if (pendingEditTx) {
      form.setEditSeriesMode(false);
      startEditingFn?.(pendingEditTx);
    }
    modal.clearPendingEditTx();
  });

  DOM.get('edit-series')?.addEventListener('click', () => {
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
  DOM.get('add-savings-goal-btn')?.addEventListener('click', () => {
    openModal('savings-goal-modal');
    const nameEl = DOM.get('savings-goal-name') as HTMLInputElement | null;
    const amtEl = DOM.get('savings-goal-amount') as HTMLInputElement | null;
    const deadlineEl = DOM.get('savings-goal-deadline') as HTMLInputElement | null;
    if (nameEl) nameEl.value = '';
    if (amtEl) amtEl.value = '';
    if (deadlineEl) deadlineEl.value = '';
  });

  DOM.get('cancel-savings-goal')?.addEventListener('click', () => {
    closeModal('savings-goal-modal');
  });

  DOM.get('save-savings-goal')?.addEventListener('click', () => {
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
  DOM.get('cancel-add-savings')?.addEventListener('click', () => {
    closeModal('add-savings-modal');
    modal.clearAddSavingsGoalId();
  });

  DOM.get('confirm-add-savings')?.addEventListener('click', async () => {
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
  DOM.get('open-settings')?.addEventListener('click', openSettingsModal);

  // Toggle rollover options visibility
  DOM.get('rollover-enabled')?.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const options = DOM.get('rollover-options');
    if (options) {
      options.classList.toggle('hidden', !target.checked);
    }
  });

  // Clear PIN handler is in pin-ui-handlers.ts — no duplicate here

  // Cancel without saving - revert theme if changed, then close
  DOM.get('cancel-settings')?.addEventListener('click', () => {
    // Revert theme if it was changed during this settings session
    if (_themeOnOpen && signals.theme.value !== _themeOnOpen) {
      signals.theme.value = _themeOnOpen as any;
    }
    closeModal('settings-modal');
  });

  // Save settings and close
  DOM.get('close-settings')?.addEventListener('click', async () => {
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

    const sectionsVal = { ...signals.sections.value };
    sectionsVal.envelope = showEnvelope?.checked || false;
    signals.sections.value = sectionsVal;
    persist(SK.SECTIONS, signals.sections.value);

    const curr = settingsCurrency?.value || 'USD';
    const currencyMap = CURRENCY_MAP as Record<string, string>;
    settings.setCurrency(curr, currencyMap[curr] || '$');
    persist(SK.CURRENCY, signals.currency.value);
    if (currencyDisplay) currencyDisplay.textContent = signals.currency.value.symbol;

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
    settings.setAlerts(alertsVal);
    persist(SK.ALERTS, signals.alerts.value);

    const newPers = insightPersonality?.value as InsightPersonality;
    if (newPers !== signals.insightPers.value) {
      settings.setInsightPersonality(newPers);
      persist(SK.INSIGHT_PERS, signals.insightPers.value);
    }

    // Save rollover settings
    const {
      setRolloverEnabled,
      setRolloverMode,
      setNegativeHandling,
      setMaxRollover
    } = await loadRolloverModule();

    setRolloverEnabled(rolloverEnabledEl?.checked || false);
    setRolloverMode((rolloverModeEl?.value || 'all') as RolloverMode);
    setNegativeHandling((negativeHandlingEl?.value || 'zero') as NegativeHandling);
    const maxVal = maxRolloverEl?.value;
    setMaxRollover(maxVal ? parseAmount(maxVal) : null);

    closeModal('settings-modal');
    showToast('Settings saved');
    refreshAllFn?.();
  });

  // Restart Onboarding Tour
  DOM.get('restart-onboarding')?.addEventListener('click', () => {
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

  DOM.get('open-analytics')?.addEventListener('click', () => {
    void openAnalyticsModalHandler();
  });
  DOM.get('close-analytics')?.addEventListener('click', () => closeModal('analytics-modal'));
}

// ==========================================
// THEME AND ALERTS
// ==========================================

/**
 * Set up theme button handlers
 */
function setupThemeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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
  DOM.get('dismiss-alert')?.addEventListener('click', () => {
    const alertText = DOM.get('alert-text');
    const txt = alertText?.textContent || '';
    void loadFeatureEventInterface().then(({ dismissAlert }) => {
      dismissAlert(txt);
    });
  });

  const closeCelebration = (): void => {
    closeModal('celebration-overlay');
  };

  DOM.get('celebration-close')?.addEventListener('click', closeCelebration);
  DOM.get('close-celebration')?.addEventListener('click', closeCelebration);
}

// ==========================================
// SAMPLE DATA
// ==========================================

/**
 * Set up sample data handlers
 */
function setupSampleData(): void {
  DOM.get('load-sample-data')?.addEventListener('click', async () => {
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

      const { switchMainTab, switchTab } = await import('../core/ui-navigation.js');
      switchMainTab('dashboard');
      switchTab('expense');

      await Promise.resolve(resetFormFn?.());
      const { renderTransactionsList } = await import('../../data/transaction-renderer.js');
      await renderTransactionsList(true);
      refreshAllFn?.();
      renderCustomCatsListFn?.();
      updateSummaryFn?.();

      showToast(
        clearBackups ? 'App data and backups cleared' : 'App data cleared. Stored backups were kept.',
        'success'
      );
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

  DOM.get('clear-all-data')?.addEventListener('click', () => {
    openModal('reset-app-data-modal');
  });

  DOM.get('cancel-reset-app-data')?.addEventListener('click', () => {
    closeModal('reset-app-data-modal');
  });

  DOM.get('confirm-reset-keep-backups')?.addEventListener('click', () => {
    void runReset(false);
  });

  DOM.get('confirm-reset-clear-backups')?.addEventListener('click', () => {
    void runReset(true);
  });
}
