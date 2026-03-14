/**
 * Modal Events Module
 *
 * Handles all modal event handlers: delete, edit recurring, savings goals,
 * settings, analytics, theme, alerts, celebration, undo, and sample data.
 *
 * @module modal-events
 */
'use strict';

import { SK, persist, lsSet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { modal, form, settings } from '../../core/state-actions.js';
import { openModal, closeModal, showToast, showUndoToast } from '../core/ui.js';
import { parseAmount, generateId, getTodayStr } from '../../core/utils.js';
import { dataSdk } from '../../data/data-manager.js';
import {
  getRolloverSettings,
  setRolloverEnabled,
  setRolloverMode,
  setNegativeHandling,
  setMaxRollover
} from '../../features/financial/rollover.js';
import { startOnboarding } from '../../features/personalization/onboarding.js';
import { checkAchievements } from '../../features/gamification/achievements.js';
import {
  setAnalyticsCurrentPeriod,
  renderAnalytics,
  renderYearComparisonChart,
  renderYearOverYearComparison,
  renderCategoryTrendsChart,
  updateTrendingSummary
} from '../../orchestration/analytics.js';
import { setTheme } from '../../features/personalization/theme.js';
import { dismissAlert } from '../../features/personalization/alerts.js';
import { CONFIG, CURRENCY_MAP } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, SavingsContribution, InsightPersonality, AlertPrefs, CurrencySettings, RolloverMode, NegativeHandling, Theme } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;

interface ModalEventCallbacks {
  fmtCur?: CurrencyFormatter;
  renderSavingsGoals?: () => void;
  updateSummary?: () => void;
  renderCustomCatsList?: () => void;
  refreshAll?: () => void;
  startEditing?: (tx: Transaction) => void;
  loadSampleData?: () => void;
}

interface LegacySavingsGoal {
  name: string;
  target_amount: number;
  saved_amount: number;
  deadline?: string;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let fmtCurFn: CurrencyFormatter = (v) => '$' + v.toFixed(2);
let renderSavingsGoalsFn: (() => void) | null = null;
let updateSummaryFn: (() => void) | null = null;
let renderCustomCatsListFn: (() => void) | null = null;
let refreshAllFn: (() => void) | null = null;
let startEditingFn: ((tx: Transaction) => void) | null = null;
let loadSampleDataFn: (() => void) | null = null;

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
}

/**
 * Open settings modal (exported for keyboard shortcut)
 */
export function openSettingsModal(): void {
  const showEnvelope = DOM.get('show-envelope') as HTMLInputElement | null;
  const settingsCurrency = DOM.get('settings-currency') as HTMLSelectElement | null;
  const insightPersonality = DOM.get('insight-personality') as HTMLSelectElement | null;
  const alertBudgetExceed = DOM.get('alert-budget-exceed') as HTMLInputElement | null;
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
  if (alertBudgetExceed) alertBudgetExceed.checked = alerts.budgetThreshold !== null && alerts.budgetThreshold <= 0.8;

  // Rollover settings
  const rolloverSettings = getRolloverSettings();
  if (rolloverEnabled) rolloverEnabled.checked = rolloverSettings.enabled;
  if (rolloverMode) rolloverMode.value = rolloverSettings.mode;
  if (negativeHandling) negativeHandling.value = rolloverSettings.negativeHandling;
  if (maxRollover) maxRollover.value = rolloverSettings.maxRollover?.toString() || '';

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
              console.error('Undo failed:', e);
              showToast('Undo failed', 'error');
            }
          });
        } catch (e) {
          if (btn) {
            btn.textContent = 'Delete';
            btn.disabled = false;
          }
          console.error('Delete failed:', e);
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
    if (amt < 5) {
      if (amtEl) amtEl.style.borderColor = 'var(--color-expense)';
      if (amtErr) {
        amtErr.textContent = amt > 0 && amt < 5 ? 'Target amount must be at least $5.00' : 'Please enter a valid amount';
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

    const savingsGoals = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
    savingsGoals[`sg_${generateId()}`] = { name, target_amount: amt, saved_amount: 0, deadline };
    persist(SK.SAVINGS, signals.savingsGoals.value);
    renderSavingsGoalsFn?.();
    updateSummaryFn?.();
    closeModal('savings-goal-modal');
    showToast('Savings goal created');
  });

  // Add savings amount to goal
  DOM.get('cancel-add-savings')?.addEventListener('click', () => {
    closeModal('add-savings-modal');
    modal.clearAddSavingsGoalId();
  });

  DOM.get('confirm-add-savings')?.addEventListener('click', () => {
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

    const savingsGoals = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
    const goalId = signals.addSavingsGoalId.value;
    if (goalId && savingsGoals[goalId]) {
      savingsGoals[goalId].saved_amount = (savingsGoals[goalId].saved_amount || 0) + amt;
      persist(SK.SAVINGS, signals.savingsGoals.value);
      // Track contribution with date for balance calculations
      const contribs = [...signals.savingsContribs.value];
      contribs.push({ id: generateId(), date: getTodayStr(), goalId, amount: amt });
      signals.savingsContribs.value = contribs;
      persist(SK.SAVINGS_CONTRIB, signals.savingsContribs.value);
      renderSavingsGoalsFn?.();
      updateSummaryFn?.();
      checkAchievements();
      showToast('Contribution added');
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

  // Cancel without saving - just close the modal
  DOM.get('cancel-settings')?.addEventListener('click', () => {
    closeModal('settings-modal');
  });

  // Save settings and close
  DOM.get('close-settings')?.addEventListener('click', () => {
    const showEnvelope = DOM.get('show-envelope') as HTMLInputElement | null;
    const settingsCurrency = DOM.get('settings-currency') as HTMLSelectElement | null;
    const insightPersonality = DOM.get('insight-personality') as HTMLSelectElement | null;
    const alertBudgetExceed = DOM.get('alert-budget-exceed') as HTMLInputElement | null;
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

    const alertsVal = { ...signals.alerts.value };
    alertsVal.budgetThreshold = alertBudgetExceed?.checked ? 0.8 : null;
    signals.alerts.value = alertsVal;
    persist(SK.ALERTS, signals.alerts.value);

    const newPers = insightPersonality?.value as InsightPersonality;
    if (newPers !== signals.insightPers.value) {
      settings.setInsightPersonality(newPers);
      persist(SK.INSIGHT_PERS, signals.insightPers.value);
    }

    // Save rollover settings
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
    setTimeout(() => startOnboarding(), 300);
  });
}

// ==========================================
// ANALYTICS MODAL
// ==========================================

/**
 * Set up analytics modal handlers
 */
function setupAnalyticsModal(): void {
  function openAnalyticsModalHandler(): void {
    setAnalyticsCurrentPeriod('all-time');
    openModal('analytics-modal');
    setTimeout(() => renderAnalytics(), CONFIG.TIMING.UI_DELAY);
  }

  DOM.get('open-analytics')?.addEventListener('click', openAnalyticsModalHandler);
  DOM.get('close-analytics')?.addEventListener('click', () => closeModal('analytics-modal'));

  // Year-over-Year selectors
  DOM.get('yoy-year1')?.addEventListener('change', () => {
    const y1El = DOM.get('yoy-year1') as HTMLSelectElement | null;
    const y2El = DOM.get('yoy-year2') as HTMLSelectElement | null;
    const y1 = y1El?.value;
    const y2 = y2El?.value;
    if (y1 && y2) {
      renderYearComparisonChart('yoy-comparison-chart', y1, y2);
      renderYearOverYearComparison(y1, y2);
    }
  });

  DOM.get('yoy-year2')?.addEventListener('change', () => {
    const y1El = DOM.get('yoy-year1') as HTMLSelectElement | null;
    const y2El = DOM.get('yoy-year2') as HTMLSelectElement | null;
    const y1 = y1El?.value;
    const y2 = y2El?.value;
    if (y1 && y2) {
      renderYearComparisonChart('yoy-comparison-chart', y1, y2);
      renderYearOverYearComparison(y1, y2);
    }
  });

  // Category trend period selector
  DOM.get('trend-period-select')?.addEventListener('change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const months = parseInt(target.value);
    renderCategoryTrendsChart('category-trends-chart', months);
    updateTrendingSummary('category-trends-chart', months);
  });
}

// ==========================================
// THEME AND ALERTS
// ==========================================

/**
 * Set up theme button handlers
 */
function setupThemeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme((btn.dataset.theme || 'system') as Theme));
  });
}

/**
 * Set up alert dismiss and celebration close handlers
 */
function setupAlertAndCelebration(): void {
  DOM.get('dismiss-alert')?.addEventListener('click', () => {
    const alertText = DOM.get('alert-text');
    const txt = alertText?.textContent || '';
    dismissAlert(txt);
  });

  DOM.get('celebration-close')?.addEventListener('click', () => {
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
  DOM.get('load-sample-data')?.addEventListener('click', () => {
    loadSampleDataFn?.();
  });

  DOM.get('clear-all-data')?.addEventListener('click', () => {
    if (confirm('Clear ALL data? This cannot be undone.')) {
      Object.values(SK).forEach(k => localStorage.removeItem(k as string));
      localStorage.removeItem('budget_tracker_active_tab');
      location.reload();
    }
  });
}
