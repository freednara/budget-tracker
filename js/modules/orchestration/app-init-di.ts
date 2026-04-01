/**
 * Application Initialization with Dependency Injection
 * 
 * Refactored initialization using the DI container to eliminate
 * manual setter functions and improve testability
 */

import { getDefaultContainer, Services, DIContainer } from '../core/di-container.js';
import { unmountAll } from '../core/effect-manager.js';
import { initDashboard } from './dashboard.js';
import { initAppEvents, cleanupAppEvents } from './app-events.js';
import { loadSampleData } from './sample-data.js';
import { initTheme } from '../features/personalization/theme.js';
import { startOnboarding } from '../features/personalization/onboarding.js';
import { SK, lsGet, lsSet } from '../core/state.js';
import * as signals from '../core/signals.js';
import { dataSdk } from '../data/data-manager.js';
import { migrationManager } from '../data/migration.js';
import { showToast } from '../ui/core/ui.js';
import { DOM } from '../core/dom-cache.js';
import { initMultiTabSync, cleanup as cleanupMultiTabSync } from '../core/multi-tab-sync.js';
import { initShellNavigation, cleanupShellNavigation } from '../ui/core/ui-navigation.js';
import * as filterEv from '../ui/interactions/filter-events.js';
import * as formEv from '../ui/interactions/form-events.js';
import * as keyboardEv from '../ui/interactions/keyboard-events.js';
import { on, Events } from '../core/event-bus.js';
import { DataSyncEvents, type TransactionDataDelta } from '../core/data-sync-interface.js';
// Dynamic imports will be resolved from DI container

// ==========================================
// COMPONENT CLEANUP MANAGEMENT
// ==========================================

// Global registry for component cleanup functions
const componentCleanupRegistry: (() => void)[] = [];
const deferredTaskCleanupRegistry: Array<() => void> = [];

/**
 * Register a cleanup function for proper disposal
 */
function registerCleanup(cleanup: () => void): void {
  componentCleanupRegistry.push(cleanup);
}

function registerDeferredTaskCleanup(cleanup: () => void): void {
  deferredTaskCleanupRegistry.push(cleanup);
}

function cleanupDeferredInteractiveWork(): void {
  const pendingCleanups = deferredTaskCleanupRegistry.splice(0, deferredTaskCleanupRegistry.length);
  pendingCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Error cancelling deferred startup work:', error);
    }
  });
}

/**
 * Cleanup all registered components (for app resets, testing, etc.)
 */
export function cleanupAllComponents(): void {
  // Unmount all centrally-managed signal effects first
  unmountAll();

  for (const cleanup of componentCleanupRegistry) {
    try {
      cleanup();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Error during component cleanup:', error);
    }
  }
  
  // Clear the registry
  componentCleanupRegistry.length = 0;
}

// ==========================================
// INITIALIZATION STATUS
// ==========================================

export interface InitializationStatus {
  initialized: boolean;
  container: DIContainer | null;
  errors: Error[];
}

const initStatus: InitializationStatus = {
  initialized: false,
  container: null,
  errors: []
};

function setStartupProgress(step: string): void {
  (window as any).__APP_STARTUP_PROGRESS__ = step;
  document.documentElement.dataset.appStartupProgress = step;
  if (import.meta.env.DEV && typeof window !== 'undefined' && (window as any).__APP_DEBUG_STARTUP__ === true) {
    console.log(`[startup] ${step}`);
  }
}

function setShellReadyState(isReady: boolean): void {
  (window as any).__APP_SHELL_READY__ = isReady;
  document.documentElement.dataset.appShellReady = isReady ? 'true' : 'false';
}

function setInteractiveReadyState(isReady: boolean): void {
  (window as any).__APP_INTERACTIVE_READY__ = isReady;
  document.documentElement.dataset.appInteractiveReady = isReady ? 'true' : 'false';
}

function setBackgroundReadyState(isReady: boolean): void {
  (window as any).__APP_BACKGROUND_READY__ = isReady;
  document.documentElement.dataset.appBackgroundReady = isReady ? 'true' : 'false';
}

function setBackgroundFailedState(isFailed: boolean): void {
  (window as any).__APP_BACKGROUND_FAILED__ = isFailed;
  document.documentElement.dataset.appBackgroundFailed = isFailed ? 'true' : 'false';
}

function recordDeferredStartupFailure(errorLabel: string, error: unknown): void {
  if (import.meta.env.DEV) console.error(errorLabel, error);
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  initStatus.errors.push(normalizedError);
  setBackgroundFailedState(true);
  setStartupProgress('initialize:background-failed');
  const deferredErrors = Array.isArray((window as any).__APP_DEFERRED_ERRORS__)
    ? (window as any).__APP_DEFERRED_ERRORS__
    : [];
  deferredErrors.push({
    label: errorLabel,
    message: normalizedError.message,
    timestamp: Date.now()
  });
  (window as any).__APP_DEFERRED_ERRORS__ = deferredErrors;
}

function createBackgroundTaskTracker(totalTasks: number): (step: string) => void {
  let remainingTasks = totalTasks;
  return (step: string) => {
    if ((window as any).__APP_BACKGROUND_FAILED__ === true) {
      return;
    }
    setStartupProgress(step);
    remainingTasks--;
    if (remainingTasks <= 0) {
      setBackgroundFailedState(false);
      setBackgroundReadyState(true);
      setStartupProgress('initialize:background-ready');
    }
  };
}

function scheduleTrackedDeferredInteractiveWork(
  task: (isCancelled: () => boolean) => Promise<void>,
  errorLabel: string,
  completionStep: string,
  completeBackgroundTask: (step: string) => void
): void {
  let completed = false;
  const completeOnce = (): void => {
    if (completed) return;
    completed = true;
    completeBackgroundTask(completionStep);
  };

  scheduleDeferredInteractiveWork(async (isCancelled) => {
    let succeeded = false;
    try {
      await task(isCancelled);
      succeeded = !isCancelled();
    } finally {
      if (succeeded) {
        completeOnce();
      }
    }
  }, errorLabel);
}

// ==========================================
// MAIN INITIALIZATION
// ==========================================

/**
 * Initialize the application using dependency injection.
 * Completes blocking startup and schedules deferred background work separately.
 */
export async function initializeApp(): Promise<InitializationStatus> {
  try {
    cleanupDeferredInteractiveWork();
    setShellReadyState(false);
    setInteractiveReadyState(false);
    setBackgroundReadyState(false);
    setBackgroundFailedState(false);
    setStartupProgress('initialize:start');
    (window as any).__APP_DEFERRED_ERRORS__ = [];

    // Get DI container
    const container = getDefaultContainer();
    initStatus.container = container;

    // Bind the static shell before DI/data startup so visible tabs are immediately interactive.
    initShellNavigation();
    registerCleanup(cleanupShellNavigation);
    setStartupProgress('initialize:shell-navigation-bound');

    // Initialize only shell-critical services on the blocking path.
    await container.initialize({
      services: [Services.CONFIG, Services.CURRENCY_FORMATTER, Services.GET_TODAY_STR]
    });
    setStartupProgress('initialize:container-ready');

    // Initialize theme first (affects UI)
    registerCleanup(initTheme());
    setStartupProgress('initialize:theme-ready');

    // Check PIN lock
    const pinHandlers = await import('../ui/widgets/pin-ui-handlers.js');
    if (pinHandlers.shouldShowPinLock()) {
      setStartupProgress('initialize:pin-lock-required');
      await pinHandlers.showPinLock();

      // Initialize auto-lock for inactivity when PIN is set
      const { initAutoLock } = await import('../features/security/auto-lock.js');
      const autoLockCleanup = initAutoLock(() => {
        pinHandlers.showPinLock();
      });
      registerCleanup(autoLockCleanup);
    }
    setStartupProgress('initialize:pin-ready');

    // Initialize data layer
    const initResult = await dataSdk.init({
      onDataChanged: (transactions) => {
        signals.replaceTransactionLedger(transactions);
      },
      onDataPatched: (change) => {
        signals.applyTransactionPatch(change);
      }
    });
    setStartupProgress('initialize:data-ready');

    if (!initResult.isOk) {
      throw new Error('Failed to initialize data layer');
    }

    const savedTab = lsGet('budget_tracker_active_tab', 'dashboard') as string;
    await initializeShellVisibleControls();
    await initializeShellCriticalSurface(savedTab);
    setShellReadyState(true);
    setStartupProgress('initialize:shell-ready');

    const onboardingState = lsGet(SK.ONBOARD, { completed: false, step: 0 }) as { completed: boolean; step: number };
    const hasCompletedOnboarding = onboardingState.completed;
    const hasTransactions = signals.transactions.value.length > 0;

    await postOnboardingInit(savedTab, hasTransactions);
    setInteractiveReadyState(true);
    setStartupProgress('initialize:interactive-ready');

    const completeBackgroundTask = createBackgroundTaskTracker(4);

    scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
      const { initOnboarding } = await import('../features/personalization/onboarding.js');
      if (isCancelled()) return;
      initOnboarding();
      const { cleanupOnboarding } = await import('../features/personalization/onboarding.js');
      registerCleanup(cleanupOnboarding);

      const { initAlerts } = await import('../features/personalization/alerts.js');
      if (isCancelled()) return;
      registerCleanup(initAlerts());

      const { initRollover, cleanupRollover } = await import('../features/financial/rollover.js');
      if (isCancelled()) return;
      initRollover();
      registerCleanup(cleanupRollover);

      if (!hasCompletedOnboarding && !hasTransactions) {
        startOnboarding();
      }
    }, 'Deferred onboarding/alerts init failed', 'deferred:onboarding-alerts-ready', completeBackgroundTask);

    scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
      if (await migrationManager.needsMigration()) {
        if (isCancelled()) return;
        setStartupProgress('initialize:migration-start');
        showToast('Upgrading database...', 'info');
        const migrationResult = await migrationManager.migrate((progress) => {
          if (progress.phase === 'migrating' && import.meta.env.DEV && (window as any).__APP_DEBUG_STARTUP__ === true) {
            console.log(`Migration progress: ${Math.round(progress.progress)}%`);
          }
        });

        if (isCancelled()) return;
        if (migrationResult.isOk) {
          showToast('Database upgrade complete!', 'success');
        } else {
          if (import.meta.env.DEV) console.error('Migration failed:', migrationResult.error);
          showToast('Database upgrade deferred', 'warning');
        }
      }
    }, 'Deferred migration init failed', 'initialize:migration-ready', completeBackgroundTask);

    scheduleBackgroundInitialization(hasTransactions, savedTab, completeBackgroundTask);

    initStatus.initialized = true;
    return initStatus;

  } catch (error) {
    if (import.meta.env.DEV) console.error('Application initialization failed:', error);
    initStatus.errors.push(error as Error);
    setShellReadyState(false);
    setInteractiveReadyState(false);
    setBackgroundReadyState(false);
    setBackgroundFailedState(false);
    
    // Show error to user
    showToast('Failed to initialize application', 'error');
    
    return initStatus;
  }
}

/**
 * Post-onboarding initialization
 */
async function initializeShellCriticalSurface(savedTab: string): Promise<void> {
  const { renderMonthNav } = await import('../ui/core/ui-render.js');
  const { switchMainTab } = await import('../ui/core/ui-navigation.js');

  renderMonthNav();

  const validTabs = ['dashboard', 'budget', 'transactions', 'calendar'];
  const initialTab = (validTabs.includes(savedTab) ? savedTab : 'dashboard') as any;
  switchMainTab(initialTab);
  setStartupProgress('initialize:shell-surface-ready');
}

async function initializeShellVisibleControls(): Promise<void> {
  setStartupProgress('initialize:modal-surface-start');

  const { mountModals } = await import('../components/mount-modals.js');
  const modalContainer = DOM.get('modal-container');
  if (modalContainer) {
    registerCleanup(mountModals(modalContainer));
  }

  const modalEv = await import('../ui/interactions/modal-events.js');
  modalEv.initModalEvents({
    fmtCur: (v: number) => signals.currency.value.symbol + v.toFixed(2),
    renderSavingsGoals: () => {},
    updateSummary: () => {},
    renderCustomCatsList: () => {
      import('../ui/core/ui-render.js').then((m) => m.renderCustomCatsList());
    },
    refreshAll: () => {
      signals.refreshVersion.value++;
    },
    resetForm: async () => {
      const { resetForm } = await import('../ui/interactions/form-events.js');
      resetForm();
    },
    startEditing: async (tx) => {
      const { startEditing } = await import('../transactions/index.js');
      startEditing(tx);
    },
    loadSampleData: () => loadSampleData()
  });
  registerCleanup(modalEv.cleanupModalEvents);

  const importExportEv = await import('../features/import-export/import-export-events.js');
  importExportEv.initImportExportEvents({
    fmtCur: (v: number) => signals.currency.value.symbol + v.toFixed(2)
  });
  registerCleanup(importExportEv.cleanupImportExportEvents);
  import('../ui/components/async-modal.js').then(({ confirmDataOperation }) => {
    importExportEv.setImportConfirmFn(confirmDataOperation);
  });

  setStartupProgress('initialize:modal-surface-ready');
}

async function postOnboardingInit(savedTab: string, hasTransactions: boolean): Promise<void> {
  setStartupProgress('post:init-start');
  await getDefaultContainer().resolve(Services.SWIPE_MANAGER);
  const { refreshTransactionsSurface, initTransactionSurfaceCoordinator } = await import('../data/transaction-surface-coordinator.js');
  const { openTransactionsForDate, switchMainTab, switchTab, setRenderCategoriesFn, setRenderQuickShortcutsFn } = await import('../ui/core/ui-navigation.js');
  const { mountEditUI } = await import('../transactions/edit-mode.js');
  const { openModal } = await import('../ui/core/ui.js');
  const emptyStateModule = await import('../ui/core/empty-state.js');
  const { mountInlineAlerts } = await import('../ui/widgets/inline-alerts.js');
  const splitTransactions = await import('../features/financial/split-transactions.js');
  setStartupProgress('post:core-imports-ready');
  const { renderMonthNav, renderCategories, renderQuickShortcuts, populateCategoryFilter } = await import('../ui/core/ui-render.js');

  // Critical-path UI modules needed for basic navigation and transaction entry.
  setStartupProgress('post:filter-events-imported');

  initMultiTabSync();
  registerCleanup(cleanupMultiTabSync);
  setStartupProgress('initialize:multi-tab-ready');

  import('../ui/components/async-modal.js').then(({ promptTextInput }) => {
    filterEv.setFilterPromptFn(promptTextInput);
  });

  setStartupProgress('post:form-events-imported');

  setStartupProgress('post:keyboard-events-imported');
  setStartupProgress('post:critical-modules-ready');

  // Initialize filter events (search, presets)
  filterEv.initFilterEvents({
    swipeManagerCloseAll: () => {
      const sm = getDefaultContainer().resolveSync<any>(Services.SWIPE_MANAGER);
      sm?.closeAll();
    }
  });
  registerCleanup(filterEv.cleanupFilterEvents);
  setStartupProgress('post:filter-events-ready');

  // Initialize form events (transaction form submission)
  formEv.initFormEvents({
    fmtCur: (v: number) => signals.currency.value.symbol + v.toFixed(2),
    cancelEditing: async () => {
      const { cancelEditing } = await import('../transactions/edit-mode.js');
      cancelEditing();
    },
    renderCategories: () => renderCategories()
  });
  registerCleanup(formEv.cleanupFormEvents);
  setStartupProgress('post:form-events-ready');

  // Initialize keyboard shortcuts
  registerCleanup(keyboardEv.initKeyboardEvents({
    switchMainTab: (tab: string) => switchMainTab(tab as any),
    switchTab: (type: 'expense' | 'income') => switchTab(type),
    cancelEditing: async () => {
      const { cancelEditing } = await import('../transactions/edit-mode.js');
      cancelEditing();
    },
    openSettingsModal: () => {
      void import('../ui/interactions/modal-events.js').then(({ openSettingsModal }) => {
        void openSettingsModal();
      });
    },
    renderCategories: () => renderCategories()
  }));
  setStartupProgress('post:keyboard-ready');
  registerCleanup(initTransactionSurfaceCoordinator());

  emptyStateModule.init();
  registerCleanup(emptyStateModule.destroy);
  emptyStateModule.setSwitchMainTabFn(switchMainTab as (tabName: string) => void);
  emptyStateModule.setOpenModalFn((modalId: string) => openModal(modalId));
  emptyStateModule.setLoadSampleDataFn(async () => {
    await loadSampleData();
  });
  emptyStateModule.setOpenTransactionsForDateFn((date: string) => {
    void openTransactionsForDate(date);
  });
  setStartupProgress('post:empty-state-ready');

  // Initialize form UI (always needed for new transactions)
  renderMonthNav();
  setRenderCategoriesFn(() => renderCategories());
  renderCategories();
  populateCategoryFilter();
  setRenderQuickShortcutsFn(() => renderQuickShortcuts());
  renderQuickShortcuts();
  registerCleanup(mountEditUI());
  registerCleanup(mountInlineAlerts());
  splitTransactions.setSplitFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
  registerCleanup(splitTransactions.mountSplitModal());
  void import('../ui/widgets/filters.js').then(({ renderFilterPresets }) => {
    renderFilterPresets();
  });
  setStartupProgress('post:form-ui-ready');

  const validTabs = ['dashboard', 'budget', 'transactions', 'calendar'];
  const initialTab = (validTabs.includes(savedTab) ? savedTab : 'dashboard') as any;
  switchMainTab(initialTab);

  await refreshTransactionsSurface();
  setStartupProgress(hasTransactions ? 'post:transactions-rendered' : 'post:empty-state-rendered');

  registerCleanup(await setupWorkerDeltaSync());
  const { syncWorkerDataset, shouldUseWorker, isWorkerReady } = await import('./worker-manager.js');
  if (shouldUseWorker(signals.transactions.value.length) && !isWorkerReady()) {
    void syncWorkerDataset(signals.transactions.value).catch((err: unknown) => {
      if (import.meta.env.DEV) console.warn('Worker sync failed:', err);
    });
  }

  // Note: Auto-save is handled by signal effects, but calling for backwards compatibility
  setupAutoSave();
  setStartupProgress('post:auto-save-ready');
}

function scheduleBackgroundInitialization(
  hasTransactions: boolean,
  savedTab: string,
  completeBackgroundTask: (step: string) => void
): void {
  scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
    const { switchMainTab, switchTab } = await import('../ui/core/ui-navigation.js');
    const { renderMonthNav, renderCategories, renderQuickShortcuts, populateCategoryFilter, updateCharts } = await import('../ui/core/ui-render.js');
    const { refreshTransactionsSurface } = await import('../data/transaction-surface-coordinator.js');
    const { initLazyLoading, cleanupLazyLoading } = await import('../core/lazy-loader.js');
    if (isCancelled()) return;
    initLazyLoading();
    registerCleanup(cleanupLazyLoading);
    setStartupProgress('post:lazy-loader-ready');

    const cleanupDashboard = initDashboard();
    if (isCancelled()) {
      cleanupDashboard();
      return;
    }
    registerCleanup(cleanupDashboard);
    setStartupProgress('post:dashboard-ready');

    initAppEvents({
      updateReconcileCount: () => {},
      renderTransactions: () => {
        void refreshTransactionsSurface();
      },
      renderWeeklyRollup: () => {},
      updateInsights: () => {},
      checkAlerts: async () => {
        const { checkAlerts } = await import('../features/personalization/alerts.js');
        checkAlerts();
      },
      renderMonthComparison: async () => {
        const { renderMonthComparison } = await import('../ui/charts/analytics-ui.js');
        renderMonthComparison();
      },
      renderRecurringBreakdown: async () => {
        await updateCharts();
      },
      checkBackupReminder: async () => {
        const { checkBackupReminder } = await import('../orchestration/backup-reminder.js');
        checkBackupReminder();
      },
      renderMonthNav: () => renderMonthNav(),
      populateCategoryFilter: () => populateCategoryFilter(),
      resetCalendarSelection: async () => {
        const { resetCalendarSelection } = await import('../ui/widgets/calendar.js');
        resetCalendarSelection();
      },
      renderCategories: () => renderCategories(),
      refreshAll: () => {
        signals.refreshVersion.value++;
      },
      checkAchievements: async () => {
        const { checkAchievements } = await import('../features/gamification/achievements.js');
        checkAchievements();
      }
    });
    registerCleanup(cleanupAppEvents);
    setStartupProgress('post:app-events-ready');

    const {
      initTemplateManager,
      cleanupTemplateManager,
      setTemplateFmtCurFn,
      setTemplateRenderCategoriesFn,
      setTemplateSwitchTabFn,
      renderTemplates
    } = await import('../transactions/template-manager.js');
    if (isCancelled()) return;
    initTemplateManager();
    setTemplateFmtCurFn((value: number) => signals.currency.value.symbol + value.toFixed(2));
    setTemplateRenderCategoriesFn(() => renderCategories());
    setTemplateSwitchTabFn((type: 'expense' | 'income') => switchTab(type));
    renderTemplates();
    registerCleanup(cleanupTemplateManager);
    setStartupProgress('post:templates-ready');

    const { processRecurringTemplates } = await import('../data/recurring-templates.js');
    const generatedCount = await processRecurringTemplates();
    if (isCancelled()) return;
    if (generatedCount > 0) {
      showToast(`Generated ${generatedCount} recurring transaction${generatedCount === 1 ? '' : 's'}`, 'info');
    }
    setStartupProgress('initialize:recurring-ready');

    const { initDashboardTrendRangeSelector } = await import('../ui/core/ui-render.js');
    const { renderMonthComparison } = await import('../ui/charts/analytics-ui.js');
    await updateCharts();
    initDashboardTrendRangeSelector();
    renderMonthComparison();

    setupPerformanceMonitoring();
  }, 'Deferred analytics/template init failed', 'post:performance-ready', completeBackgroundTask);

  scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
    const [
      storageEv,
      debtUiHandlers,
      budgetPlannerUi,
      debtPlanner,
      pinHandlers,
      splitTransactions,
      calculations,
      achievements,
      streakTracker
    ] = await Promise.all([
      import('../ui/interactions/storage-events.js'),
      import('../ui/widgets/debt-ui-handlers.js'),
      import('../features/financial/budget-planner-ui.js'),
      import('../features/financial/debt-planner.js'),
      import('../ui/widgets/pin-ui-handlers.js'),
      import('../features/financial/split-transactions.js'),
      import('../features/financial/calculations.js'),
      import('../features/gamification/achievements.js'),
      import('../features/gamification/streak-tracker.js')
    ]);
    if (isCancelled()) return;

    calculations.initCalculations();
    registerCleanup(calculations.cleanupCalculations);
    debtPlanner.initDebtPlanner();
    registerCleanup(debtPlanner.cleanupDebtPlanner);
    achievements.initAchievements();
    registerCleanup(achievements.cleanupAchievements);
    streakTracker.initStreakTracker();
    registerCleanup(streakTracker.cleanupStreakTracker);
    pinHandlers.initPinHandlers();
    registerCleanup(pinHandlers.cleanupPinHandlers);
    registerCleanup(await setupRemoteTransactionFollowUps());

    splitTransactions.setSplitFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));

    debtUiHandlers.initDebtHandlers();
    registerCleanup(debtUiHandlers.cleanupDebtHandlers);
    debtUiHandlers.setDebtFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
    debtUiHandlers.setDebtRefreshAll(() => {
      signals.refreshVersion.value++;
    });

    budgetPlannerUi.initBudgetPlannerHandlers();
    registerCleanup(budgetPlannerUi.cleanupBudgetPlannerHandlers);
    budgetPlannerUi.setBudgetPlannerFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
    budgetPlannerUi.setBudgetPlannerCallbacks({
      renderCategories: () => {
        void import('../ui/core/ui-render.js').then((m) => m.renderCategories());
      },
      renderQuickShortcuts: () => {
        void import('../ui/core/ui-render.js').then((m) => m.renderQuickShortcuts());
      },
      populateCategoryFilter: () => {
        void import('../ui/core/ui-render.js').then((m) => m.populateCategoryFilter());
      },
      renderCustomCatsList: () => {
        import('../ui/core/ui-render.js').then(m => m.renderCustomCatsList());
      }
    });

    storageEv.initStorageEvents({
      refreshAll: () => {
        signals.refreshVersion.value++;
      },
      updateSummary: () => {},
      renderSavingsGoals: () => {},
      checkAlerts: () => {
        import('../features/personalization/alerts.js').then(m => m.checkAlerts());
      },
      updateInsights: () => {},
      renderBadges: () => {
        import('../features/gamification/achievements.js').then(m => m.checkAchievements());
      },
      renderStreak: () => {},
      renderFilterPresets: () => {
        import('../ui/widgets/filters.js').then(m => m.renderFilterPresets());
      },
      renderTemplates: () => {
        import('../transactions/template-manager.js').then(m => m.renderTemplates());
      }
    });
    registerCleanup(storageEv.cleanupStorageEvents);

    const emojiPicker = await import('../ui/interactions/emoji-picker.js');
    if (isCancelled()) return;
    emojiPicker.init();
    registerCleanup(emojiPicker.destroy);
  }, 'Deferred post-init setup failed', 'post:deferred-ready', completeBackgroundTask);
}

async function setupWorkerDeltaSync(): Promise<() => void> {
  const {
    syncWorkerDataset,
    syncWorkerDatasetDelta,
    shouldUseWorker,
    isWorkerReady
  } = await import('./worker-manager.js');

  const shouldSyncWorker = (): boolean => {
    return shouldUseWorker(signals.transactions.value.length) || isWorkerReady();
  };

  const syncFullDataset = (): void => {
    if (!shouldSyncWorker()) return;
    void syncWorkerDataset(signals.transactions.value).catch((err: unknown) => {
      if (import.meta.env.DEV) console.warn('Worker full dataset sync failed:', err);
    });
  };

  const syncDeltaOrReload = (change: TransactionDataDelta): void => {
    if (!shouldSyncWorker()) return;
    if (!isWorkerReady()) {
      syncFullDataset();
      return;
    }
    void syncWorkerDatasetDelta(change).catch((err: unknown) => {
      if (import.meta.env.DEV) console.warn('Worker delta sync failed, retrying full sync:', err);
      syncFullDataset();
    });
  };

  const unsubscribers = [
    on(Events.TRANSACTION_ADDED, (tx: unknown) => {
      syncDeltaOrReload({ type: 'add', item: tx as any });
    }),
    on(Events.TRANSACTION_UPDATED, (tx: unknown) => {
      syncDeltaOrReload({ type: 'update', item: tx as any });
    }),
    on(Events.TRANSACTION_DELETED, (tx: unknown) => {
      syncDeltaOrReload({ type: 'delete', id: (tx as any).__backendId, item: tx as any });
    }),
    on(Events.TRANSACTIONS_BATCH_ADDED, (payload: unknown) => {
      const transactions = (payload as { transactions?: any[] }).transactions || [];
      if (transactions.length === 0) return;
      syncDeltaOrReload({ type: 'batch-add', items: transactions });
    }),
    on(Events.TRANSACTIONS_REPLACED, () => {
      syncFullDataset();
    }),
    on(Events.DATA_IMPORTED, () => {
      syncFullDataset();
    }),
    on(DataSyncEvents.TRANSACTION_UPDATED, (payload: { transactions?: any[]; source?: string }) => {
      if (
        payload.source !== 'multi-tab-sync'
        || !payload.transactions
        || (!shouldUseWorker(payload.transactions.length) && !isWorkerReady())
      ) {
        return;
      }
      void syncWorkerDataset(payload.transactions);
    }),
    on(DataSyncEvents.TRANSACTION_DELTA_APPLIED, (payload: { source?: string; change?: TransactionDataDelta }) => {
      if (payload.source !== 'multi-tab-sync' || !payload.change || !shouldSyncWorker()) {
        return;
      }
      syncDeltaOrReload(payload.change);
    })
  ];

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

async function setupRemoteTransactionFollowUps(): Promise<() => void> {
  const { checkAchievements } = await import('../features/gamification/achievements.js');
  const { renderMonthComparison } = await import('../ui/charts/analytics-ui.js');

  const unsubscribers = [
    on(DataSyncEvents.TRANSACTION_UPDATED, (payload: { source?: string }) => {
      if (payload.source !== 'multi-tab-sync') return;
      checkAchievements();
      renderMonthComparison();
    }),
    on(DataSyncEvents.TRANSACTION_DELTA_APPLIED, (payload: { source?: string }) => {
      if (payload.source !== 'multi-tab-sync') return;
      checkAchievements();
      renderMonthComparison();
    })
  ];

  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

function scheduleDeferredInteractiveWork(
  task: (isCancelled: () => boolean) => Promise<void>,
  errorLabel: string = 'Deferred interactive init failed'
): void {
  let cancelled = false;
  let settled = false;
  let idleId: number | null = null;
  let animationFrameId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const unregisterCleanup = (): void => {
    const index = deferredTaskCleanupRegistry.indexOf(cancelTask);
    if (index >= 0) {
      deferredTaskCleanupRegistry.splice(index, 1);
    }
  };

  const runTask = () => {
    if (cancelled) return;
    void (async () => {
      try {
        await task(() => cancelled);
      } catch (error) {
        if (!cancelled) {
          recordDeferredStartupFailure(errorLabel, error);
        }
      } finally {
        settled = true;
        unregisterCleanup();
      }
    })();
  };

  const cancelTask = (): void => {
    cancelled = true;
    if (idleId !== null && typeof (window as any).cancelIdleCallback === 'function') {
      (window as any).cancelIdleCallback(idleId);
      idleId = null;
    }
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (settled) {
      unregisterCleanup();
    }
  };

  registerDeferredTaskCleanup(cancelTask);

  const idleCallback = (window as any).requestIdleCallback as ((callback: () => void, options?: { timeout: number }) => number) | undefined;
  if (idleCallback) {
    idleId = idleCallback(() => {
      idleId = null;
      runTask();
    }, { timeout: 200 });
    return;
  }

  animationFrameId = requestAnimationFrame(() => {
    animationFrameId = null;
    timeoutId = setTimeout(() => {
      timeoutId = null;
      runTask();
    }, 0);
  });
}

// ==========================================
// AUTO-SAVE FUNCTIONALITY
// ==========================================

function setupAutoSave(): void {
  // Auto-save is now handled by signal effects in signals.ts
  // Each signal has an effect() that automatically persists changes to localStorage
  // This eliminates redundant saves and prevents race conditions
  
  // Note: Keeping the function for backwards compatibility but it's now a no-op
  // Auto-save functionality moved to signal effects for better performance
}

/**
 * @deprecated Auto-save is now handled by signal effects
 */
function saveAllState(): void {
  // No-op: Signals automatically persist via effects
  // Keeping this function to avoid breaking existing calls
}

// ==========================================
// PERFORMANCE MONITORING
// ==========================================

function setupPerformanceMonitoring(): void {
  // Only setup in development
  if (import.meta.env.DEV) {
    // Import performance monitor
    import('../core/performance-integration.js').then(({ setupPerformanceMonitoring }) => {
      setupPerformanceMonitoring();
    });
  }
}

// ==========================================
// CLEANUP
// ==========================================

/**
 * Cleanup function for app shutdown
 */
export function cleanupApp(): void {
  // State is automatically saved by signal effects
  // No explicit save needed on cleanup

  cleanupDeferredInteractiveWork();
  cleanupAllComponents();
  cleanupAppEvents();

  // Clear container
  if (initStatus.container) {
    initStatus.container.clear();
  }

  // Reset status
  initStatus.initialized = false;
  initStatus.container = null;
  initStatus.errors = [];
  setShellReadyState(false);
  setInteractiveReadyState(false);
  setBackgroundReadyState(false);
  setBackgroundFailedState(false);
}

// ==========================================
// EXPORTS FOR TESTING
// ==========================================

export function getInitializationStatus(): InitializationStatus {
  return { ...initStatus };
}

export function isAppInitialized(): boolean {
  return initStatus.initialized;
}
