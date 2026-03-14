/**
 * App Events Module
 *
 * Centralized event bus subscriptions and render scheduler registrations.
 * Extracted from app.ts to reduce file size and improve maintainability.
 *
 * @module app-events
 */
'use strict';

import { on, Events } from './core/event-bus.js';
import { renderScheduler } from './core/render-scheduler.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type VoidCallback = () => void;

interface AppEventCallbacks {
  // Render functions
  updateSummary: VoidCallback;
  renderTransactions: VoidCallback;
  renderCalendar: VoidCallback;
  updateCharts: VoidCallback;
  renderBudgetGauge: VoidCallback;
  updateReconcileCount: VoidCallback;
  renderWeeklyRollup: VoidCallback;
  checkAlerts: VoidCallback;
  updateInsights: VoidCallback;
  renderMonthComparison: VoidCallback;
  renderRecurringBreakdown: VoidCallback;
  checkBackupReminder: VoidCallback;
  renderMonthNav: VoidCallback;
  renderEnvelope: VoidCallback;
  populateCategoryFilter: VoidCallback;
  resetCalendarSelection: VoidCallback;
  renderSavingsGoals: VoidCallback;
  renderCategories: VoidCallback;
  // App-level functions
  refreshAll: VoidCallback;
  checkAchievements: VoidCallback;
}

// ==========================================
// MODULE STATE
// ==========================================

let callbacks: AppEventCallbacks | null = null;

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Registers render functions with the scheduler and sets up event bus subscriptions.
 * Must be called after all render functions are available.
 */
export function initAppEvents(cb: AppEventCallbacks): void {
  callbacks = cb;

  // Register render functions with scheduler for batched updates
  renderScheduler.register('updateSummary', cb.updateSummary);
  renderScheduler.register('renderTransactions', cb.renderTransactions);
  renderScheduler.register('renderCalendar', cb.renderCalendar);
  renderScheduler.register('updateCharts', cb.updateCharts);
  renderScheduler.register('renderBudgetGauge', cb.renderBudgetGauge);
  renderScheduler.register('updateReconcileCount', cb.updateReconcileCount);
  renderScheduler.register('renderWeeklyRollup', cb.renderWeeklyRollup);
  renderScheduler.register('checkAlerts', cb.checkAlerts);
  renderScheduler.register('updateInsights', cb.updateInsights);
  renderScheduler.register('renderMonthComparison', cb.renderMonthComparison);
  renderScheduler.register('renderRecurringBreakdown', cb.renderRecurringBreakdown);
  renderScheduler.register('checkBackupReminder', cb.checkBackupReminder);
  renderScheduler.register('renderMonthNav', cb.renderMonthNav);
  renderScheduler.register('renderEnvelope', cb.renderEnvelope);
  renderScheduler.register('populateCategoryFilter', cb.populateCategoryFilter);
  renderScheduler.register('resetCalendarSelection', cb.resetCalendarSelection);
  renderScheduler.register('renderSavingsGoals', cb.renderSavingsGoals);
  renderScheduler.register('renderCategories', cb.renderCategories);

  // Event Bus Setup - Batched Updates via renderScheduler
  // Multiple events can fire in quick succession; scheduler deduplicates and batches
  on(Events.TRANSACTION_ADDED, () => {
    renderScheduler.schedule(
      'updateSummary',
      'renderTransactions',
      'renderCalendar',
      'updateCharts',
      'renderBudgetGauge',
      'updateReconcileCount',
      'renderWeeklyRollup',
      'checkAlerts',
      'updateInsights',
      'renderMonthComparison',
      'renderRecurringBreakdown',
      'checkBackupReminder'
    );
  });

  on(Events.TRANSACTIONS_BATCH_ADDED, (payload: { count: number }) => {
    console.log(`Batch: ${payload.count} transactions added`);
    cb.refreshAll();
    cb.checkBackupReminder();
  });

  on(Events.TRANSACTION_UPDATED, () => {
    renderScheduler.schedule(
      'updateSummary',
      'renderTransactions',
      'renderCalendar',
      'updateCharts',
      'renderBudgetGauge',
      'updateInsights',
      'checkAlerts',
      'renderWeeklyRollup',
      'renderMonthComparison',
      'renderRecurringBreakdown'
    );
  });

  on(Events.TRANSACTION_DELETED, () => {
    renderScheduler.schedule(
      'updateSummary',
      'renderTransactions',
      'renderCalendar',
      'updateCharts',
      'renderBudgetGauge',
      'updateReconcileCount',
      'updateInsights',
      'checkAlerts',
      'renderWeeklyRollup',
      'renderMonthComparison',
      'renderRecurringBreakdown',
      'checkBackupReminder'
    );
  });

  on(Events.MONTH_CHANGED, () => {
    cb.resetCalendarSelection();  // Sync: Reset day selection immediately
    renderScheduler.schedule(
      'renderMonthNav',
      'updateSummary',
      'renderEnvelope',
      'updateInsights',
      'renderTransactions',
      'renderCalendar',
      'renderMonthComparison',
      'populateCategoryFilter',
      'updateCharts',
      'renderBudgetGauge',
      'renderWeeklyRollup',
      'renderRecurringBreakdown',
      'checkAlerts'
    );
  });

  on(Events.BUDGET_UPDATED, () => {
    renderScheduler.schedule(
      'renderEnvelope',
      'updateInsights',
      'renderBudgetGauge',
      'checkAlerts'
    );
  });

  on(Events.SAVINGS_UPDATED, () => {
    renderScheduler.schedule(
      'renderSavingsGoals',
      'updateSummary'
    );
  });

  on(Events.CATEGORY_UPDATED, () => {
    renderScheduler.schedule(
      'renderCategories',
      'populateCategoryFilter',
      'renderTransactions',
      'renderCalendar',
      'updateCharts',
      'updateInsights',
      'renderBudgetGauge'
    );
  });

  on(Events.DATA_IMPORTED, () => {
    // Full refresh needed after import
    cb.refreshAll();
    cb.checkBackupReminder();
    cb.checkAchievements();
  });
}
