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
import { localeService } from '../core/locale-service.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Callbacks may be sync or async. Several suppliers in app-init-di.ts are
// thin wrappers around dynamic `import(...)` calls (e.g. `checkAlerts`,
// `renderMonthComparison`). The render scheduler and event subscriptions
// never await them — fire-and-forget — so async variants must route their
// own errors through trackError if needed. The widened signature prevents
// callers from having to wrap async suppliers in `() => { void foo(); }`
// just to appease no-misused-promises.
type VoidCallback = () => void | Promise<void>;

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
  // Phase 5g-1 (Inline-Behavior-Review rev 12, L54): removed
  // `checkBackupReminder` callback. The supplier in `app-init-di.ts` was
  // a dynamic import that called a no-op shim; the four event-bus
  // subscriptions below scheduled it on every transaction mutation, all
  // for zero behavior. mountBackupReminder()'s effect runs the same
  // logic reactively against signal changes already.
  renderMonthNav: VoidCallback;
  populateCategoryFilter: VoidCallback;
  resetCalendarSelection: VoidCallback;
  renderCategories: VoidCallback;
  renderQuickShortcuts: VoidCallback; // CR-Apr24-I finding 93
  // App-level functions
  refreshAll: VoidCallback;
  checkAchievements: VoidCallback;
}

// ==========================================
// MODULE STATE
// ==========================================

// Phase 6 cleanup: removed the module-level `callbacks: AppEventCallbacks`
// slot. It was written in initAppEvents() and cleared in cleanupAppEvents()
// but never read — every consumer calls the per-handler closures registered
// with renderScheduler below.

export function cleanupAppEvents(): void {
  if (_eventUnsubscribers.length > 0) {
    _eventUnsubscribers.forEach((unsubscribe) => unsubscribe());
    _eventUnsubscribers = [];
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Registers render functions with the scheduler and sets up event bus subscriptions.
 * Must be called after all render functions are available.
 */
export function initAppEvents(cb: AppEventCallbacks): void {
  // Guard: clean up previous event listeners to prevent duplicate subscriptions on re-init
  cleanupAppEvents();

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
  renderScheduler.register('renderMonthNav', cb.renderMonthNav);
  renderScheduler.register('populateCategoryFilter', cb.populateCategoryFilter);
  renderScheduler.register('resetCalendarSelection', cb.resetCalendarSelection);
  renderScheduler.register('renderCategories', cb.renderCategories);
  renderScheduler.register('renderQuickShortcuts', cb.renderQuickShortcuts); // CR-Apr24-I finding 93
  renderScheduler.register('checkAchievements', cb.checkAchievements);
  
  // Deprecated - handled by reactive components:
  // renderScheduler.register('updateSummary', cb.updateSummary);
  // renderScheduler.register('renderTransactions', cb.renderTransactions);
  // (Phase 5g-1, rev 12 L30d: dropped commented `renderCalendar` line —
  //  the shim it referenced has been deleted from calendar.ts.)
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
      'checkAchievements'
    );
  }));

  _eventUnsubscribers.push(on(Events.TRANSACTIONS_BATCH_ADDED, () => {
    // Round 7 fix: Route callbacks through renderScheduler instead of calling directly.
    // checkAchievements is already registered and batches with other renders.
    // refreshAll is scheduled asynchronously to defer it until next microtask,
    // respecting the scheduler's debouncing logic.
    renderScheduler.schedule('checkAchievements');
    void cb.refreshAll();
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
      'renderWeeklyRollup', 'renderMonthComparison', 'renderRecurringBreakdown'
    );
  }));

  _eventUnsubscribers.push(on(Events.TRANSACTIONS_REPLACED, () => {
    renderScheduler.schedule(
      'updateReconcileCount', 'updateInsights', 'checkAlerts', 'renderWeeklyRollup',
      'renderMonthComparison', 'renderRecurringBreakdown',
      'checkAchievements'
    );
  }));

  _eventUnsubscribers.push(on(Events.MONTH_CHANGED, () => {
    void cb.resetCalendarSelection();
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

  // CR-Apr24-I findings 70, 93, 94: CATEGORY_UPDATED must also schedule
  // month-comparison (reads category names/emojis — finding 70),
  // transaction list rows (show category name/emoji/color — finding 94),
  // and quick shortcut buttons (show category emoji/color — finding 93).
  _eventUnsubscribers.push(on(Events.CATEGORY_UPDATED, () => {
    renderScheduler.schedule(
      'renderCategories', 'populateCategoryFilter', 'renderMonthComparison',
      'renderTransactions', 'renderQuickShortcuts'
    );
  }));

  _eventUnsubscribers.push(on(Events.DATA_IMPORTED, () => {
    void cb.refreshAll();
    void cb.checkAchievements();
  }));

  // CR-Apr24-I findings 69, 76: when currency changes, rebuild locale-service
  // formatters (so toasts & duplicate-review summaries use the new currency —
  // fixes 76/77/78) and rerender imperative money surfaces (month-comparison
  // — fixes 69, weekly-rollup for same reason).
  _eventUnsubscribers.push(on(Events.CURRENCY_CHANGED, (settings: { home: string }) => {
    localeService.updateCurrency(settings.home);
    renderScheduler.schedule(
      'renderMonthComparison', 'renderWeeklyRollup', 'renderTransactions',
      'updateInsights'
    );
  }));
}
