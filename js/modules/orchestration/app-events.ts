/**
 * App Events Module
 *
 * Centralized event bus subscriptions and render scheduler registrations.
 * Extracted from app.ts to reduce file size and improve maintainability.
 *
 * @module app-events
 */
'use strict';

import { on, Events, type UnsubscribeFn } from '../core/event-bus.js';
import { renderScheduler } from '../core/render-scheduler.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type VoidCallback = () => void;

// Track event subscriptions for cleanup on re-init
let _eventUnsubscribers: UnsubscribeFn[] = [];

interface AppEventCallbacks {
  // Non-reactive render functions (still need manual scheduling)
  updateReconcileCount: VoidCallback;
  renderTransactions: VoidCallback;
  renderWeeklyRollup: VoidCallback;
  checkAlerts: VoidCallback;
  updateInsights: VoidCallback;
  renderMonthComparison: VoidCallback;
  renderRecurringBreakdown: VoidCallback;
  checkBackupReminder: VoidCallback;
  renderMonthNav: VoidCallback;
  populateCategoryFilter: VoidCallback;
  resetCalendarSelection: VoidCallback;
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
  // Guard: clean up previous event listeners to prevent duplicate subscriptions on re-init
  if (_eventUnsubscribers.length > 0) {
    _eventUnsubscribers.forEach(unsub => unsub());
    _eventUnsubscribers = [];
  }

  callbacks = cb;

  // MIGRATION NOTE: Components with Signal-based reactivity no longer need manual renders
  // Reactive components: budget-gauge, calendar, charts, daily-allowance, debt-list, 
  // debt-summary, envelope-budget, savings-goals, summary-cards, transactions
  
  // Still using manual rendering (not yet migrated to Signals):
  renderScheduler.register('updateReconcileCount', cb.updateReconcileCount);
  renderScheduler.register('renderTransactions', cb.renderTransactions);
  renderScheduler.register('renderWeeklyRollup', cb.renderWeeklyRollup);
  renderScheduler.register('checkAlerts', cb.checkAlerts);
  renderScheduler.register('updateInsights', cb.updateInsights);
  renderScheduler.register('renderMonthComparison', cb.renderMonthComparison);
  renderScheduler.register('renderRecurringBreakdown', cb.renderRecurringBreakdown);
  renderScheduler.register('checkBackupReminder', cb.checkBackupReminder);
  renderScheduler.register('renderMonthNav', cb.renderMonthNav);
  renderScheduler.register('populateCategoryFilter', cb.populateCategoryFilter);
  renderScheduler.register('resetCalendarSelection', cb.resetCalendarSelection);
  renderScheduler.register('renderCategories', cb.renderCategories);
  renderScheduler.register('checkAchievements', cb.checkAchievements);
  
  // Deprecated - handled by reactive components:
  // renderScheduler.register('updateSummary', cb.updateSummary);
  // renderScheduler.register('renderTransactions', cb.renderTransactions);
  // renderScheduler.register('renderCalendar', cb.renderCalendar);
  // renderScheduler.register('updateCharts', cb.updateCharts);
  // renderScheduler.register('renderBudgetGauge', cb.renderBudgetGauge);
  // renderScheduler.register('renderEnvelope', cb.renderEnvelope);
  // renderScheduler.register('renderSavingsGoals', cb.renderSavingsGoals);

  // Event Bus Setup - Batched Updates via renderScheduler
  // Multiple events can fire in quick succession; scheduler deduplicates and batches
  _eventUnsubscribers.push(on(Events.TRANSACTION_ADDED, () => {
    renderScheduler.schedule(
      'updateReconcileCount', 'renderTransactions', 'renderWeeklyRollup', 'checkAlerts',
      'updateInsights', 'renderMonthComparison', 'renderRecurringBreakdown',
      'checkBackupReminder', 'checkAchievements'
    );
  }));

  _eventUnsubscribers.push(on(Events.TRANSACTIONS_BATCH_ADDED, () => {
    cb.refreshAll();
    cb.checkBackupReminder();
    cb.checkAchievements();
  }));

  _eventUnsubscribers.push(on(Events.TRANSACTION_UPDATED, () => {
    renderScheduler.schedule(
      'renderTransactions', 'updateInsights', 'checkAlerts', 'renderWeeklyRollup',
      'renderMonthComparison', 'renderRecurringBreakdown'
    );
  }));

  _eventUnsubscribers.push(on(Events.TRANSACTION_DELETED, () => {
    renderScheduler.schedule(
      'updateReconcileCount', 'renderTransactions', 'updateInsights', 'checkAlerts',
      'renderWeeklyRollup', 'renderMonthComparison', 'renderRecurringBreakdown',
      'checkBackupReminder'
    );
  }));

  _eventUnsubscribers.push(on(Events.MONTH_CHANGED, () => {
    cb.resetCalendarSelection();
    renderScheduler.schedule(
      'renderMonthNav', 'renderTransactions', 'updateInsights', 'renderMonthComparison',
      'populateCategoryFilter', 'renderWeeklyRollup', 'renderRecurringBreakdown',
      'checkAlerts'
    );
  }));

  _eventUnsubscribers.push(on(Events.BUDGET_UPDATED, () => {
    renderScheduler.schedule('updateInsights', 'checkAlerts', 'checkAchievements');
  }));

  _eventUnsubscribers.push(on(Events.SAVINGS_UPDATED, () => {
    renderScheduler.schedule('checkAchievements');
  }));

  _eventUnsubscribers.push(on(Events.CATEGORY_UPDATED, () => {
    renderScheduler.schedule('renderCategories', 'populateCategoryFilter', 'updateInsights');
  }));

  _eventUnsubscribers.push(on(Events.DATA_IMPORTED, () => {
    cb.refreshAll();
    cb.checkBackupReminder();
    cb.checkAchievements();
  }));
}
