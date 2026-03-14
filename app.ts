'use strict';

// ==========================================
// MODULE IMPORTS
// ==========================================
import { CONFIG } from './js/modules/core/config.js';
import { SK, lsGet, lsSet, persist } from './js/modules/core/state.js';
import * as signals from './js/modules/core/signals.js';
import { validator } from './js/modules/core/validator.js';
import { DOM } from './js/modules/core/dom-cache.js';
import {
  EXPENSE_CATS,
  INCOME_CATS,
  EMOJI_PICKER_CATEGORIES,
  getCatInfo,
  getAllCats
} from './js/modules/core/categories.js';
import { dataSdk } from './js/modules/data/data-manager.js';
import {
  showToast,
  openModal,
  setTimingConfig,
  setSwipeManager
} from './js/modules/ui/core/ui.js';
// Note: showProgress, updateProgress, hideProgress, closeModal used by import-export-events.js and modal-events.js
import {
  fmtCur as fmtCurBase,
  parseLocalDate,
  getMonthKey,
  parseMonthKey,
  monthLabel,
  getPrevMonthKey,
  getTodayStr,
  esc as escapeHtml,
  toCents,
  toDollars,
  generateId
} from './js/modules/core/utils.js';
// Note: CURRENCY_MAP, downloadBlob, debounce, parseAmount used by event modules
// Note: sumByType now used internally by chart-renderers.js
import { swipeManager, setSwipeConfig } from './js/modules/ui/interactions/swipe-manager.js';
import { initTheme, setTheme, setThemeState } from './js/modules/features/personalization/theme.js';
import { startOnboarding, setOnboardingCallbacks } from './js/modules/features/personalization/onboarding.js';
import {
  getMonthTx,
  calcTotals,
  getEffectiveIncome,
  getMonthExpByCat,
  calcVelocity
} from './js/modules/features/financial/calculations.js';
// Note: getMonthlySavings, getTopCat used internally by insights.js
// Note: getUnassigned is used internally by dashboard.js
// Note: getYearStats, getAllTimeStats, formatMonthDisplay, compareYearsMonthly are used internally by analytics.js
import {
  updateInsights
} from './js/modules/features/personalization/insights.js';
import {
  shouldUseWorker,
  getWorkerStatus
} from './js/modules/worker-manager.js';
// Note: filterTransactions from worker-manager.js available for async filtering of large datasets
// PIN UI handlers (crypto functions used internally)
import {
  initPinHandlers,
  setPinConfig,
  shouldShowPinLock,
  showPinLock
} from './js/modules/ui/widgets/pin-ui-handlers.js';
// Filters module - most functions now used by filter-events.js
// Only import functions still needed directly in app.js
// Note: getCurrentFilterState, applyFilterPreset, deleteFilterPreset are internal to filters.js
import {
  setCalendarConfig,
  setFmtCurFn,
  getMonthBadge,
  renderCalendar,
  resetCalendarSelection
} from './js/modules/ui/widgets/calendar.js';
// Note: getUpcomingBillsForMonth, selectCalDay, navigateCalDay are internal
import {
  setTxFmtCurFn,
  setRenderCategoriesFn,
  setEmptyStateFn,
  setUpdateSplitRemainingFn,
  setTxConfig,
  setSwitchTabFn,
  setGetTodayStrFn,
  renderTransactions,
  handlePaginationClick,
  handleTransactionListClick,
  updateReconcileCount,
  startEditing,
  cancelEditing,
  updateRecurringPreview,
  renderTemplates
} from './js/modules/transactions.js';
// Note: saveAsTemplate, renderTransactionsAsync used by filter-events.js
// Note: applyTemplate, deleteTemplate, showSwipeHint, renderPaginationControls,
// handleReconcileClick, populateDeleteModal are internal to transactions.js
import {
  setAnalyticsFmtCurFn,
  calcCategoryTrends
} from './js/modules/analytics.js';
// Note: renderAnalytics, renderYearComparisonChart, renderCategoryTrendsChart,
// updateTrendingSummary, setAnalyticsCurrentPeriod used by modal-events.js
// Note: Most chart render functions are internal to analytics.js
import {
  updateSummary,
  renderEnvelope,
  renderBudgetGauge,
  initDashboard
} from './js/modules/dashboard.js';
// Note: animateValue, updateDailyAllowance, updateTodayBudget, updateMonthlyPace are internal to dashboard.js
// initDashboard() sets up reactive components that auto-update when signals change
import { mountModals } from './js/modules/components/mount-modals.js';
// mountModals() renders all modal templates via Lit, replacing static HTML in index.html
// Import/export functions now used by import-export-events.js module
// Note: validateTransaction is internal to import-export.js
import { on, emit, Events } from './js/modules/core/event-bus.js';
import { checkBackupReminder } from './js/modules/backup-reminder.js';
// Note: hideBackupReminder used by import-export-events.js
// showCelebration used internally by achievements.js
import { renderStreak } from './js/modules/features/gamification/streak-tracker.js';
// Note: checkStreak used by form-events.js
import { checkAlerts } from './js/modules/features/personalization/alerts.js';
// Note: dismissAlert, initAlerts used by modal-events.js
import { renderBadges, checkAchievements } from './js/modules/features/gamification/achievements.js';
// Note: awardAchievement used by form-events.js and import-export-events.js
import {
  setSavingsGoalsFmtCur,
  setSavingsGoalsEmptyState,
  renderSavingsGoals
} from './js/modules/features/financial/savings-goals.js';
import { initRollover } from './js/modules/features/financial/rollover.js';
// Note: setRolloverEnabled, setRolloverMode, setNegativeHandling, setMaxRollover,
// getRolloverSettings used by modal-events.js
// Note: isRolloverEnabled and calculateMonthRollovers used internally by budget-planner-ui.js
import { initDebtPlanner } from './js/modules/features/financial/debt-planner.js';
// Debt UI handlers (debt-planner functions used internally)
// Note: updateDebtSummary and renderDebtList now reactive via dashboard.ts
import {
  initDebtHandlers,
  setDebtFmtCur,
  setDebtRefreshAll
} from './js/modules/ui/widgets/debt-ui-handlers.js';
// Split transactions handlers
import {
  initSplitHandlers,
  setSplitFmtCur,
  setSplitResetMs,
  updateSplitRemaining
} from './js/modules/features/financial/split-transactions.js';
// Budget planner UI handlers
import {
  initBudgetPlannerHandlers,
  setBudgetPlannerFmtCur,
  setBudgetPlannerCallbacks
} from './js/modules/features/financial/budget-planner-ui.js';
// Note: getPlanRemainingCents, updatePlanRemaining used internally by budget-planner-ui.js
// Chart utilities (used internally by chart modules)
// Note: cleanupChartListeners, showChartTooltip, hideChartTooltip in chart-utils.js
// Weekly rollup chart module
import { initWeeklyRollup, renderWeeklyRollup } from './js/modules/features/financial/weekly-rollup.js';
// Chart renderers module
import {
  initChartRenderers,
  fmtShort,
  renderDonutChart,
  renderBarChart,
  renderTrendChart,
  setTrendChartMonths,
  hideCategoryTrendChart,
  renderRecurringBreakdown
} from './js/modules/ui/charts/chart-renderers.js';
// Note: renderCategoryTrendChart, getTrendChartMonths used internally by chart-renderers.js
// Phase 6: Event handler modules
import { initKeyboardEvents } from './js/modules/ui/interactions/keyboard-events.js';
import { initImportExportEvents } from './js/modules/features/import-export/import-export-events.js';
import { initFilterEvents } from './js/modules/ui/interactions/filter-events.js';
import { renderFilterPresets } from './js/modules/ui/widgets/filters.js';
import { initFormEvents } from './js/modules/ui/interactions/form-events.js';
import { initModalEvents, openSettingsModal } from './js/modules/ui/interactions/modal-events.js';
// Phase 2 refactoring: UI navigation module
import {
  switchTab,
  switchMainTab,
  setRenderCategoriesFn as setNavRenderCategoriesFn,
  setRenderQuickShortcutsFn,
  setUpdateChartsFn,
  init as initUiNavigation
} from './js/modules/ui/core/ui-navigation.js';
// Phase 2 refactoring: Emoji picker module
import { init as initEmojiPicker } from './js/modules/ui/interactions/emoji-picker.js';
// Phase 2 refactoring: Empty state module
import {
  emptyState,
  setSwitchMainTabFn as setEmptyStateSwitchMainTabFn,
  setOpenModalFn as setEmptyStateOpenModalFn,
  setLoadSampleDataFn,
  init as initEmptyState
} from './js/modules/ui/core/empty-state.js';
import type { Transaction, Theme, TransactionType, CustomCategory, CurrencySettings, RolloverSettings, AlertPrefs, StreakData } from './js/types/index.js';
// Phase 1 refactoring: Extracted modules
import { loadSampleData } from './js/modules/sample-data.js';
import { renderMonthComparison, setAnalyticsUiFmtCur } from './js/modules/ui/charts/analytics-ui.js';
import { deduplicateTransactions, validateTransactionsOnLoad } from './js/modules/app-init.js';
import { renderScheduler } from './js/modules/render-scheduler.js';
import {
  renderMonthNav,
  renderQuickShortcuts,
  renderCategories,
  updateCharts,
  handleInsightAction,
  populateCategoryFilter,
  renderCustomCatsList,
  setSwitchMainTabFn as setUiRenderSwitchMainTabFn,
  setRenderTransactionsFn
} from './js/modules/ui/core/ui-render.js';
import { initAppEvents } from './js/modules/app-events.js';
import { initStorageEvents } from './js/modules/ui/interactions/storage-events.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface InsightActionData {
  category?: string;
}

// Extend window for globals
declare global {
  interface Window {
    resetEmojiPicker?: () => void;
  }
}

// ==========================================
// 1. CONSTANTS & CONFIG
// ==========================================
// CONFIG imported from ./js/modules/config.js
// Categories and currency map imported from modules
// ACHIEVEMENTS imported from celebration.js

// ==========================================
// 2. DATA LAYER
// ==========================================
// lsGet, lsSet now imported from modules/state.js
// DataManager, dataSdk now imported from modules/data-manager.js

// ==========================================
// 3. APP STATE
// ==========================================
// S, persist, dismissedAlerts now imported from modules/state.js

// Backup reminder functions imported from backup-reminder.js

// Date and utility functions now imported from modules/utils.js
// awardAchievement, renderBadges, checkAchievements imported from achievements.js

// ==========================================
// 4. UTILITIES
// ==========================================
// esc() now imported as escapeHtml from modules/utils.js
// For backward compatibility, alias it
const esc = escapeHtml;

// sanitizeId moved to import-export.js module

// debounce, getCatInfo, getAllCats now imported from modules
// Note: debounce is now used by filter-events.js module

// Date preset helper functions
// formatDateForInput now imported from modules/utils.js

// Filter functions extracted to modules/filters.js:
// getDatePresetRange, clearDatePresetSelection, initFilterPanel, updateActiveFilterCount

// swipeManager now imported from modules/swipe-manager.js

// Emoji Picker extracted to modules/emoji-picker.js

// Filter preset functions extracted to modules/filters.js:
// getCurrentFilterState, applyFilterPreset, saveFilterPreset, deleteFilterPreset, renderFilterPresets

// Transaction template functions extracted to modules/transactions.js:
// saveAsTemplate, applyTemplate, deleteTemplate, renderTemplates

// Screen reader announcements now handled by announceError/announceStatus in utils.js

// Toast and progress functions now imported from modules/ui.js

// fmtCur is now imported from modules/utils.js
// Create wrapper that auto-passes S for convenience
const fmtCur = (amount: number, currency?: string): string => fmtCurBase(amount, currency, S);

// getMonthBadge moved to js/modules/calendar.js

// Calculation functions moved to js/modules/calculations.js
// Imported: getMonthTx, calcTotals, getEffectiveIncome, getMonthlySavings, getMonthExpByCat,
//           getUnassigned, calcVelocity, getTopCat, getYearStats, getAllTimeStats,
//           formatMonthDisplay, compareYearsMonthly
// Internal to module: calcPercentChange, getDetailedYearStats

// Analytics helper functions moved to js/modules/analytics.js:
// getSeasonalPatterns, generateSeasonalInsights, getCategoryTrends, getTrendingCategories, calcCategoryTrends

// ==========================================
// 5. THEME SYSTEM - Now imported from modules/theme.js
// ==========================================

// ==========================================
// 6. SVG CHART RENDERING
// ==========================================
// All chart functions moved to js/modules/chart-renderers.js:
// - renderDonutChart, renderBarChart, renderTrendChart
// - renderCategoryTrendChart, hideCategoryTrendChart, renderRecurringBreakdown
// - fmtShort, setTrendChartMonths, getTrendChartMonths
// Chart utilities moved to js/modules/chart-utils.js:
// - cleanupChartListeners, showChartTooltip, hideChartTooltip
// Weekly rollup moved to js/modules/weekly-rollup.js:
// - renderWeeklyRollup
// Analytics moved to js/modules/analytics.js:
// - calcCategoryTrends, etc.

// ==========================================
// 7. RENDER FUNCTIONS
// ==========================================
// renderMonthNav, renderQuickShortcuts, renderCategories, updateCharts, handleInsightAction
// moved to js/modules/ui-render.js
// calculateGoalForecast, renderSavingsGoals imported from savings-goals.js
// renderTransactions, renderPaginationControls, handlePaginationClick imported from transactions.js
// renderBadges, checkAchievements, awardAchievement imported from achievements.js
// showCelebration, spawnConfetti imported from celebration.js
// checkStreak, renderStreak imported from streak-tracker.js
// checkAlerts imported from alerts.js

// ==========================================
// 8. MODAL HELPERS
// ==========================================
// Modal functions (openModal, closeModal, getFocusableElements, trapFocus) now imported from modules/ui.js
// populateDeleteModal moved to modules/transactions.js

// ==========================================
// 9. TAB SWITCHING
// ==========================================
// switchTab() and switchMainTab() extracted to modules/ui-navigation.js

// ==========================================
// 10. EDIT MODE
// ==========================================
// Edit mode functions extracted to modules/transactions.js:
// startEditing, updateRecurringPreview, cancelEditing

// ==========================================
// 11. EVENT HANDLERS
// ==========================================
function setupEvents(): void {
  // Tab switching moved to ui-navigation.js (initUiNavigation handles tab-expense, tab-income)
  DOM.get('cancel-edit-btn')?.addEventListener('click', cancelEditing);

  // Delegated handler for insight action buttons (persists across re-renders)
  DOM.get('insights-dashboard')?.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.insight-action-btn') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    handleInsightAction(btn.dataset.actionType || '', { category: btn.dataset.category });
  });

  // Recurring toggle and preview
  const recurringToggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
  recurringToggle?.addEventListener('change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    const recurringSection = DOM.get('recurring-section');
    if (recurringSection) recurringSection.classList.toggle('hidden', !target.checked);
    if (target.checked) updateRecurringPreview();
  });
  DOM.get('recurring-type')?.addEventListener('change', updateRecurringPreview);
  DOM.get('recurring-end')?.addEventListener('change', updateRecurringPreview);
  DOM.get('date')?.addEventListener('change', () => {
    const toggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
    if (toggle?.checked) updateRecurringPreview();
  });

  // Month nav, swipe gestures, and main tab navigation moved to ui-navigation.js
  // (initUiNavigation handles prev-month, next-month, swipe gestures, .main-tab)

  // Trend chart time range selector
  document.querySelectorAll('.trend-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const button = btn as HTMLElement;
      const months = parseInt(button.dataset.months || '6', 10);
      setTrendChartMonths(months);
      // Update active state
      document.querySelectorAll('.trend-range-btn').forEach(b => {
        b.classList.remove('active', 'btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('active', 'btn-primary');
      btn.classList.remove('btn-secondary');
      // Re-render chart with new range
      renderTrendChart('trend-chart-container', months);
    });
  });

  // Category trend close button
  DOM.get('close-category-trend')?.addEventListener('click', hideCategoryTrendChart);

  // Event handlers moved to dedicated modules:
  // - modal-events.js: delete, edit recurring, savings, settings, analytics, theme, alerts, sample data, undo
  // - filter-events.js: all filter inputs, date presets, filter presets, templates
  // - form-events.js: form submission, real-time validation
  // - import-export-events.js: export JSON/CSV, import flow
  // - keyboard-events.js: global keyboard shortcuts
  // These are initialized in DOMContentLoaded via initXxxEvents() calls

} // end setupEvents

// ==========================================
// 12. UTILITY FUNCTIONS
// ==========================================
// emptyState() and setupEmptyStateCTAs() extracted to modules/empty-state.js

// Re-export for use by empty-state module
function setupEmptyStateCTAs(): void {
  initEmptyState();
}

// DEBT PLANNER RENDERING - moved to debt-ui-handlers.js module

/**
 * Refresh remaining non-reactive UI components.
 *
 * REACTIVE COMPONENTS (auto-update via signals in initDashboard):
 * - mountSummaryCards: income/expense totals
 * - mountEnvelopeBudget: envelope budget cards
 * - mountBudgetGauge: budget health gauge
 * - mountDailyAllowance: daily allowance display
 * - mountDebtSummary: debt total display
 * - mountDebtList: debt items with progress bars
 * - mountSavingsGoals: savings goals list
 * - mountCalendar: spending heatmap calendar
 * - mountCharts: trend, donut, budget vs actual charts
 * - mountTransactions: transaction list
 *
 * REMAINING (called by refreshAll):
 * - renderMonthNav: month navigation buttons
 * - updateInsights: insight/tip messages
 * - renderBadges/renderStreak: gamification elements
 * - checkAlerts: budget threshold alerts
 * - renderMonthComparison: month-over-month chart
 * - populateCategoryFilter: filter dropdown
 * - updateReconcileCount: reconciliation count
 * - renderRecurringBreakdown: recurring transaction summary
 * - renderWeeklyRollup: weekly spending summary
 * - renderFilterPresets/renderTemplates: settings
 */
function refreshAll(): void {
  const fns: Array<{ name: string; fn: () => void }> = [
    { name: 'renderMonthNav', fn: renderMonthNav },
    { name: 'updateInsights', fn: updateInsights },
    { name: 'renderBadges', fn: renderBadges },
    { name: 'renderStreak', fn: renderStreak },
    { name: 'checkAlerts', fn: checkAlerts },
    { name: 'renderMonthComparison', fn: renderMonthComparison },
    { name: 'populateCategoryFilter', fn: populateCategoryFilter },
    { name: 'updateReconcileCount', fn: updateReconcileCount },
    { name: 'renderRecurringBreakdown', fn: renderRecurringBreakdown },
    { name: 'renderWeeklyRollup', fn: renderWeeklyRollup },
    { name: 'renderFilterPresets', fn: renderFilterPresets },
    { name: 'renderTemplates', fn: renderTemplates }
  ];
  fns.forEach(({ name, fn }) => {
    try { fn(); } catch(e) { console.error(`refreshAll: ${name} failed`, e); }
  });
}

// Note: updateDailyAllowance and updateTodayBudget moved to dashboard.js module
// Note: updateSplitRemaining moved to split-transactions.js module
// Note: getPlanRemainingCents and updatePlanRemaining moved to budget-planner-ui.js module
// populateCategoryFilter, renderCustomCatsList moved to ui-render.js
// Undo toast functionality now handled by showUndoToast() in ui.js module
// Note: updateMonthlyPace moved to dashboard.js module
// Note: loadSampleData moved to sample-data.js module

// ==========================================
// 13. CALENDAR / HEATMAP
// ==========================================
// Calendar functions moved to js/modules/calendar.js:
// getMonthBadge, getUpcomingBillsForMonth, renderCalendar, selectCalDay, navigateCalDay

// ==========================================
// 14. MONTH COMPARISON - Now imported from modules/analytics-ui.js
// ==========================================

// ==========================================
// 15. ENHANCED ONBOARDING SYSTEM - Now imported from modules/onboarding.js
// ==========================================

// ==========================================
// 16. INITIALIZATION
// ==========================================
// Note: deduplicateTransactions and validateTransactionsOnLoad moved to app-init.js module

// Global error handlers to catch unhandled rejections and errors
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  console.error('Unhandled Promise Rejection:', e.reason);
  showToast('An unexpected error occurred. Please refresh if issues persist.', 'error');
});

window.addEventListener('error', (e: ErrorEvent) => {
  console.error('Uncaught Error:', e.error);
  // Don't show toast for every error to avoid spam, but log it
});

async function init(): Promise<void> {
  // Configure theme module with state reference
  setThemeState(S);
  initTheme();

  // Initialize new feature modules
  initRollover();
  initDebtPlanner();

  // Configure UI module with app settings
  setTimingConfig(CONFIG.TIMING);
  setSwipeManager(swipeManager);
  setSwipeConfig(CONFIG.SWIPE);

  // Configure ui-navigation module
  setNavRenderCategoriesFn(renderCategories);
  setRenderQuickShortcutsFn(renderQuickShortcuts);
  setUpdateChartsFn(updateCharts);
  initUiNavigation();

  // Configure ui-render module
  setUiRenderSwitchMainTabFn(switchMainTab);
  setRenderTransactionsFn(renderTransactions);

  // Initialize emoji picker module
  initEmojiPicker();

  // Configure calendar module
  setCalendarConfig({ CALENDAR_INTENSITY: CONFIG.CALENDAR_INTENSITY });
  setFmtCurFn(fmtCur);

  // Configure transactions module
  setTxFmtCurFn(fmtCur);
  setRenderCategoriesFn(renderCategories);
  setEmptyStateFn(emptyState);
  setUpdateSplitRemainingFn(updateSplitRemaining);
  setTxConfig({ PAGINATION: CONFIG.PAGINATION, RECURRING_MAX_ENTRIES: CONFIG.RECURRING_MAX_ENTRIES });
  setSwitchTabFn(switchTab);
  setGetTodayStrFn(getTodayStr);

  // Configure analytics module
  setAnalyticsFmtCurFn(fmtCur);
  setAnalyticsUiFmtCur(fmtCur);

  // Configure savings-goals module
  setSavingsGoalsFmtCur(fmtCur);
  setSavingsGoalsEmptyState(emptyState);

  // Configure PIN UI handlers module
  setPinConfig({ PIN_ERROR_DISPLAY: CONFIG.TIMING.PIN_ERROR_DISPLAY });
  initPinHandlers();

  // Configure debt UI handlers module
  setDebtFmtCur(fmtCur);
  setDebtRefreshAll(refreshAll);
  initDebtHandlers();

  // Configure split transactions module
  setSplitFmtCur(fmtCur);
  setSplitResetMs(CONFIG.TIMING.SPLIT_RESET);
  initSplitHandlers();

  // Configure budget planner module
  setBudgetPlannerFmtCur(fmtCur);
  setBudgetPlannerCallbacks({
    renderCategories,
    renderQuickShortcuts,
    populateCategoryFilter,
    renderCustomCatsList
  });
  initBudgetPlannerHandlers();

  // Configure chart renderers module
  initChartRenderers({
    fmtCur,
    monthLabel,
    calcVelocity
  });

  // Configure weekly rollup module
  initWeeklyRollup({
    fmtCur,
    fmtShort,
    switchMainTab,
    renderTransactions
  });

  // Phase 6: Initialize event handler modules
  initKeyboardEvents({
    switchMainTab,
    switchTab,
    cancelEditing,
    openSettingsModal,
    renderCategories
  });

  initImportExportEvents({
    fmtCur
  });

  initFilterEvents({
    handleTransactionListClick,
    handlePaginationClick,
    swipeManagerCloseAll: () => swipeManager.closeAll(),
    initEmojiPicker
  });

  initFormEvents({
    fmtCur,
    cancelEditing,
    renderCategories
  });

  initModalEvents({
    fmtCur,
    renderSavingsGoals,
    updateSummary,
    renderCustomCatsList,
    refreshAll,
    startEditing,
    loadSampleData
  });

  // Configure onboarding module with tab switching callbacks
  setOnboardingCallbacks({ switchMainTab, switchTab });

  // Initialize app events (render scheduler registrations and event bus subscriptions)
  initAppEvents({
    updateSummary,
    renderTransactions,
    renderCalendar,
    updateCharts,
    renderBudgetGauge,
    updateReconcileCount,
    renderWeeklyRollup,
    checkAlerts,
    updateInsights,
    renderMonthComparison,
    renderRecurringBreakdown,
    checkBackupReminder,
    renderMonthNav,
    renderEnvelope,
    populateCategoryFilter,
    resetCalendarSelection,
    renderSavingsGoals,
    renderCategories,
    refreshAll,
    checkAchievements
  });

  await dataSdk.init({
    onDataChanged(data: Transaction[]) {
      // Only update state - specific events (TRANSACTION_ADDED/UPDATED/DELETED)
      // are emitted by DataManager and handle targeted UI updates.
      // DATA_IMPORTED is only emitted for bulk imports and multi-tab sync.
      signals.transactions.value = data;
    }
  });

  // One-time deduplication of any transactions with missing/duplicate IDs
  const rawTx = lsGet(SK.TX, []) as unknown[];
  if (!Array.isArray(rawTx)) {
    console.error('P8-M1: Transactions storage was corrupted (non-array). Resetting to empty.');
    lsSet(SK.TX, []);
    signals.transactions.value = [];
    // Notify user of data loss - this is critical
    setTimeout(() => {
      showToast('Data corruption detected. Transactions were reset. Please restore from backup.', 'error');
      alert('Critical Error: Your transaction data was corrupted and has been reset.\n\nIf you have a backup file, you can restore it using Settings > Import Data.');
    }, 100);
  } else {
    const dedupedTx = deduplicateTransactions(rawTx);
    if (dedupedTx.some((t, i) => t.__backendId !== (rawTx[i] as Transaction)?.__backendId)) {
      lsSet(SK.TX, dedupedTx);
      signals.transactions.value = dedupedTx;
    }
  }

  // Validate transactions on load - remove invalid entries
  const validation = validateTransactionsOnLoad(signals.transactions.value);
  if (validation.removed > 0) {
    signals.transactions.value = validation.valid;
    lsSet(SK.TX, validation.valid);
    console.warn(`Removed ${validation.removed} invalid transaction(s) on load`);
    setTimeout(() => {
      showToast(`Removed ${validation.removed} invalid transaction(s)`, 'info');
    }, 500);
  }

  setupEvents();
  setupEmptyStateCTAs();

  // Multi-tab synchronization via storage events
  initStorageEvents({
    refreshAll,
    updateSummary,
    renderSavingsGoals,
    checkAlerts,
    updateInsights,
    renderBadges,
    renderStreak,
    renderFilterPresets,
    renderTemplates
  });

  // PIN check
  if (shouldShowPinLock()) {
    showPinLock();
  }

  // Handle PWA shortcut URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const shortcutAction = urlParams.get('action');
  const shortcutTab = urlParams.get('tab');
  const shortcutType = urlParams.get('type');

  // Set initial date
  const dateInput = DOM.get('date') as HTMLInputElement | null;
  if (dateInput) dateInput.value = getTodayStr();

  // Initialize currency display from saved preference
  const currDisplay = DOM.get('currency-display');
  if (currDisplay && signals.currency.value?.symbol) {
    currDisplay.textContent = signals.currency.value.symbol;
  }

  // Render initial state
  const VALID_TABS = ['dashboard', 'transactions', 'budget'];
  const savedTab = lsGet('budget_tracker_active_tab', 'dashboard') as string;

  // Handle PWA shortcut actions
  if (shortcutTab === 'analytics') {
    // Open analytics modal directly
    switchMainTab('dashboard');
    setTimeout(() => {
      const analyticsBtn = DOM.get('open-analytics');
      if (analyticsBtn) (analyticsBtn as HTMLElement).click();
    }, 100);
  } else if (shortcutAction === 'add' && shortcutType) {
    // Quick add transaction - go to dashboard and focus amount
    switchMainTab('dashboard');
    switchTab(shortcutType === 'income' ? 'income' : 'expense');
    setTimeout(() => {
      const amountInput = DOM.get('amount');
      if (amountInput) amountInput.focus();
    }, 100);
  } else {
    switchMainTab(VALID_TABS.includes(savedTab) ? savedTab as 'dashboard' | 'transactions' | 'budget' : 'dashboard');
  }

  // Clear URL params after handling (keeps URL clean)
  if (shortcutAction || shortcutTab) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  switchTab('expense');
  renderCategories();
  populateCategoryFilter();
  renderQuickShortcuts();

  // Initialize reactive dashboard components (auto-update when signals change)
  initDashboard();

  // Mount all modals via Lit templates (replaces static HTML in index.html)
  const modalContainer = document.getElementById('modal-container');
  if (modalContainer) {
    mountModals(modalContainer);
  }

  refreshAll();
  checkBackupReminder();

  // Render streak display only (streak increments on transaction save, not app open)
  renderStreak();
  checkAchievements();

  // Onboarding
  startOnboarding();

  // Setup real-time form validation
  validator.addRealtimeValidation(DOM.get('amount') as HTMLInputElement, 'amount');
  validator.addRealtimeValidation(DOM.get('date') as HTMLInputElement, 'date');
  validator.addRealtimeValidation(DOM.get('description') as HTMLInputElement, 'description');
  validator.addRealtimeValidation(DOM.get('tx-notes') as HTMLTextAreaElement, 'notes');
  validator.addRealtimeValidation(DOM.get('tags') as HTMLInputElement, 'tags');

  // Log worker status for large datasets (diagnostic)
  const workerStatus = getWorkerStatus();
  if (shouldUseWorker(signals.transactions.value.length)) {
    console.info(`[Worker] Large dataset detected (${signals.transactions.value.length} transactions). Web Worker available for filtering.`);
  }
  if (!workerStatus.supported) {
    console.info('[Worker] Web Workers not supported in this environment.');
  }
}

init();
