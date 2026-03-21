/**
 * Application Initialization with Dependency Injection
 * 
 * Refactored initialization using the DI container to eliminate
 * manual setter functions and improve testability
 */

import { getDefaultContainer, Services, DIContainer } from '../core/di-container.js';
import { unmountAll } from '../core/effect-manager.js';
import { initDashboard } from './dashboard.js';
import { initAppEvents } from './app-events.js';
import { loadSampleData } from './sample-data.js';
import { initTheme } from '../features/personalization/theme.js';
import { startOnboarding } from '../features/personalization/onboarding.js';
import { SK, lsGet, lsSet } from '../core/state.js';
import * as signals from '../core/signals.js';
import { dataSdk } from '../data/data-manager.js';
import { migrationManager } from '../data/migration.js';
import { showToast } from '../ui/core/ui.js';
import { updateCharts } from '../ui/core/ui-render.js';
import { renderTransactionsList } from '../data/transaction-renderer.js';
import { renderTemplates } from '../transactions/template-manager.js';
import { DOM } from '../core/dom-cache.js';
import { initMultiTabSync } from '../core/multi-tab-sync.js';
import { initShellNavigation } from '../ui/core/ui-navigation.js';
import * as filterEv from '../ui/interactions/filter-events.js';
import * as formEv from '../ui/interactions/form-events.js';
import * as keyboardEv from '../ui/interactions/keyboard-events.js';
// Dynamic imports will be resolved from DI container

// ==========================================
// COMPONENT CLEANUP MANAGEMENT
// ==========================================

// Global registry for component cleanup functions
const componentCleanupRegistry: (() => void)[] = [];

/**
 * Register a cleanup function for proper disposal
 */
function registerCleanup(cleanup: () => void): void {
  componentCleanupRegistry.push(cleanup);
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
  if (import.meta.env.DEV) console.log(`[startup] ${step}`);
}

function setShellReadyState(isReady: boolean): void {
  (window as any).__APP_SHELL_READY__ = isReady;
  document.documentElement.dataset.appShellReady = isReady ? 'true' : 'false';
}

// ==========================================
// MAIN INITIALIZATION
// ==========================================

/**
 * Initialize the application using dependency injection
 */
export async function initializeApp(): Promise<InitializationStatus> {
  try {
    setShellReadyState(false);
    setStartupProgress('initialize:start');

    // Get DI container
    const container = getDefaultContainer();
    initStatus.container = container;

    // Bind the static shell before DI/data startup so visible tabs are immediately interactive.
    initShellNavigation();
    setStartupProgress('initialize:shell-navigation-bound');

    // Initialize all services
    await container.initialize();
    setStartupProgress('initialize:container-ready');

    // Initialize theme first (affects UI)
    registerCleanup(initTheme());
    setStartupProgress('initialize:theme-ready');

    // Initialize onboarding
    const { initOnboarding } = await import('../features/personalization/onboarding.js');
    initOnboarding();
    setStartupProgress('initialize:onboarding-ready');

    // Initialize alerts
    const { initAlerts } = await import('../features/personalization/alerts.js');
    initAlerts();
    setStartupProgress('initialize:alerts-ready');

    // Initialize budget rollover system
    const { initRollover } = await import('../features/financial/rollover.js');
    initRollover();
    setStartupProgress('initialize:rollover-ready');

    // Initialize multi-tab synchronization
    initMultiTabSync();
    setStartupProgress('initialize:multi-tab-ready');

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
      onDataChanged: async (transactions) => {
        signals.transactions.value = transactions;

        // OPTIMIZATION: Sync worker dataset in background
        const { syncWorkerDataset, shouldUseWorker } = await import('./worker-manager.js');
        if (shouldUseWorker(transactions.length)) {
          syncWorkerDataset(transactions).catch((err: unknown) =>
            { if (import.meta.env.DEV) console.warn('Worker sync failed:', err); }
          );
        }
      }
    });
    setStartupProgress('initialize:data-ready');

    // Check if migration from localStorage to IndexedDB is needed
    if (await migrationManager.needsMigration()) {
      setStartupProgress('initialize:migration-start');
      showToast('Upgrading database...', 'info');
      const migrationResult = await migrationManager.migrate((progress) => {
        if (progress.phase === 'migrating') {
          if (import.meta.env.DEV) console.log(`Migration progress: ${Math.round(progress.progress)}%`);
        }
      });

      if (migrationResult.isOk) {
        showToast('Database upgrade complete!', 'success');
      } else {
        if (import.meta.env.DEV) console.error('Migration failed:', migrationResult.error);
        showToast('Database upgrade deferred', 'warning');
      }
    }
    setStartupProgress('initialize:migration-ready');

    if (!initResult.isOk) {
      throw new Error('Failed to initialize data layer');
    }

    // Process recurring transactions
    // Note: transactions already loaded by dataSdk.init() via onDataChanged callback
    const { processRecurringTemplates } = await import('../data/recurring-templates.js');
    const generatedCount = await processRecurringTemplates();
    if (generatedCount > 0) {
      showToast(`Generated ${generatedCount} recurring transaction${generatedCount === 1 ? '' : 's'}`, 'info');
    }
    setStartupProgress('initialize:recurring-ready');

    // Always run post-onboarding initialization to attach event listeners and mount components
    // UI elements like tabs and buttons need their listeners regardless of onboarding status
    await postOnboardingInit();
    setStartupProgress('initialize:post-onboarding-ready');

    // Shell-ready means the visible app is interactive, even if slower follow-up work remains.
    setShellReadyState(true);
    setStartupProgress('initialize:shell-ready');

    // Check for onboarding
    const onboardingState = lsGet(SK.ONBOARD, { completed: false, step: 0 }) as { completed: boolean; step: number };
    const hasCompletedOnboarding = onboardingState.completed;
    const hasTransactions = signals.transactions.value.length > 0;

    if (!hasCompletedOnboarding && !hasTransactions) {
      // Start onboarding tour
      startOnboarding();
    }

    initStatus.initialized = true;
    return initStatus;

  } catch (error) {
    if (import.meta.env.DEV) console.error('Application initialization failed:', error);
    initStatus.errors.push(error as Error);
    setShellReadyState(false);
    
    // Show error to user
    showToast('Failed to initialize application', 'error');
    
    return initStatus;
  }
}

/**
 * Post-onboarding initialization
 */
async function postOnboardingInit(): Promise<void> {
  setStartupProgress('post:init-start');
  // Initialize lazy loading system first for optimal performance
  const { initLazyLoading } = await import('../core/lazy-loader.js');
  initLazyLoading();
  setStartupProgress('post:lazy-loader-ready');

  // Import legacy functions
  const { renderTransactionsList } = await import('../data/transaction-renderer.js');
  const { switchMainTab, switchTab, setRenderQuickShortcutsFn } = await import('../ui/core/ui-navigation.js');
  const { openModal } = await import('../ui/core/ui.js');
  const emptyStateModule = await import('../ui/core/empty-state.js');
  const { mountEditUI } = await import('../transactions/edit-mode.js');
  setStartupProgress('post:core-imports-ready');
  // updateReconcileCount is now handled via signals
  const { renderMonthNav, renderCategories, renderQuickShortcuts, populateCategoryFilter } = await import('../ui/core/ui-render.js');

  // Initialize empty state handlers
  emptyStateModule.init();
  emptyStateModule.setSwitchMainTabFn(switchMainTab as (tabName: string) => void);
  emptyStateModule.setOpenModalFn((modalId: string) => openModal(modalId));
  emptyStateModule.setLoadSampleDataFn(async () => {
    await loadSampleData();
  });
  setStartupProgress('post:empty-state-ready');

  // Critical-path UI modules needed for basic navigation and transaction entry.
  setStartupProgress('post:filter-events-imported');

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

  // Note: All dashboard and core UI components (charts, gauges, etc.) are now 
  // automatically mounted via lazy-loader.ts using either high-priority loading 
  // or intersection observers for off-screen components.
  
  // Initialize reactive dashboard (legacy compatibility)
  const cleanupDashboard = initDashboard();
  registerCleanup(cleanupDashboard);
  setStartupProgress('post:dashboard-ready');

  // Initialize app events (only for non-reactive components)
  initAppEvents({
    updateReconcileCount: () => {}, // Handled via signals
    renderTransactions: () => {
      void renderTransactionsList();
    },
    renderWeeklyRollup: () => {}, // Handled via signals/mountWeeklyRollup
    updateInsights: () => {}, // Handled via signals/mountInsights
    checkAlerts: async () => {
      const { checkAlerts } = await import('../features/personalization/alerts.js');
      checkAlerts();
    },
    renderMonthComparison: async () => {
      const { updateCharts } = await import('../ui/core/ui-render.js');
      updateCharts();
    },
    renderRecurringBreakdown: async () => {
      const { updateCharts } = await import('../ui/core/ui-render.js');
      updateCharts();
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
      // Force refresh all reactive components by touching signals
      signals.refreshVersion.value++;
    },
    checkAchievements: async () => {
      const { checkAchievements } = await import('../features/gamification/achievements.js');
      checkAchievements();
    }
  });
  setStartupProgress('post:app-events-ready');

  // Update UI based on data
  const hasTransactions = signals.transactions.value.length > 0;
  
  const {
    initTemplateManager,
    setTemplateFmtCurFn,
    setTemplateRenderCategoriesFn,
    setTemplateSwitchTabFn
  } = await import('../transactions/template-manager.js');
  initTemplateManager();
  setTemplateFmtCurFn((value: number) => signals.currency.value.symbol + value.toFixed(2));
  setTemplateRenderCategoriesFn(() => renderCategories());
  setTemplateSwitchTabFn((type: 'expense' | 'income') => switchTab(type));

  // Load templates
  renderTemplates();
  setStartupProgress('post:templates-ready');

  // Initialize form UI (always needed for new transactions)
  renderMonthNav();
  renderCategories();
  populateCategoryFilter();
  setRenderQuickShortcutsFn(() => renderQuickShortcuts());
  renderQuickShortcuts();
  registerCleanup(mountEditUI());
  void import('../ui/widgets/filters.js').then(({ renderFilterPresets }) => {
    renderFilterPresets();
  });
  setStartupProgress('post:form-ui-ready');

  if (hasTransactions) {
    // Restore persisted tab or default to dashboard
    const savedTab = lsGet('budget_tracker_active_tab', 'dashboard') as string;
    const validTabs = ['dashboard', 'budget', 'transactions'];
    switchMainTab((validTabs.includes(savedTab) ? savedTab : 'dashboard') as any);
    
    // Render transactions
    await renderTransactionsList();
    setStartupProgress('post:transactions-rendered');
  } else {
    // Show empty state
    const emptyStateTpl = emptyStateModule.emptyState('🌱', 'Welcome to Budget Tracker', 'Start by adding your first transaction');
    const emptyContainer = DOM.get('transactions-list');
    if (emptyContainer) {
      const { render } = await import('../core/lit-helpers.js');
      render(emptyStateTpl, emptyContainer);
    }
    setStartupProgress('post:empty-state-rendered');
  }

  // Note: Auto-save is handled by signal effects, but calling for backwards compatibility
  setupAutoSave();
  setStartupProgress('post:auto-save-ready');

  // Setup performance monitoring
  setupPerformanceMonitoring();
  setStartupProgress('post:performance-ready');

  // The app shell is now interactive enough for user navigation and transaction entry.
  setShellReadyState(true);
  setStartupProgress('post:shell-ready');

  void (async () => {
    setStartupProgress('deferred:modal-init-start');
    const { mountModals } = await import('../components/mount-modals.js');
    setStartupProgress('deferred:mount-modals-imported');

    const modalContainer = DOM.get('modal-container');
    if (modalContainer) {
      registerCleanup(mountModals(modalContainer));
    }
    setStartupProgress('deferred:modals-mounted');

    const modalEv = await import('../ui/interactions/modal-events.js');
    setStartupProgress('deferred:modal-events-imported');

    modalEv.initModalEvents({
      fmtCur: (v: number) => signals.currency.value.symbol + v.toFixed(2),
      renderSavingsGoals: () => {
        // Savings goals are reactive via mounted signal effects — no re-mount needed.
        // Signal changes from cross-tab sync automatically trigger re-render.
      },
      updateSummary: () => {
        // Summary cards are reactive via mounted signal effects — no re-mount needed.
        // Signal changes from cross-tab sync automatically trigger re-render.
      },
      renderCustomCatsList: () => {
        // Re-render custom categories in settings modal
        import('../ui/core/ui-render.js').then(m => m.renderCustomCatsList());
      },
      refreshAll: () => {
        // Force refresh of reactive signals
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
    setStartupProgress('deferred:modal-events-ready');
  })().catch((error) => {
    if (import.meta.env.DEV) console.error('Deferred modal init failed:', error);
  });

  // Defer non-critical features so the visible shell becomes usable first.
  void Promise.all([
    import('../ui/interactions/storage-events.js'),
    import('../features/import-export/import-export-events.js'),
    import('../ui/widgets/debt-ui-handlers.js'),
    import('../features/financial/budget-planner-ui.js'),
    import('../features/financial/debt-planner.js'),
    import('../ui/widgets/pin-ui-handlers.js'),
    import('../features/financial/split-transactions.js'),
    import('../features/financial/calculations.js'),
    import('../features/gamification/achievements.js'),
    import('../features/gamification/streak-tracker.js')
  ]).then(async ([
    storageEv,
    importExportEv,
    debtUiHandlers,
    budgetPlannerUi,
    debtPlanner,
    pinHandlers,
    splitTransactions,
    calculations,
    achievements,
    streakTracker
  ]) => {
    calculations.initCalculations();
    debtPlanner.initDebtPlanner();
    achievements.initAchievements();
    streakTracker.initStreakTracker();
    pinHandlers.initPinHandlers();

    splitTransactions.setSplitFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
    registerCleanup(splitTransactions.mountSplitModal());

    debtUiHandlers.initDebtHandlers();
    debtUiHandlers.setDebtFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
    debtUiHandlers.setDebtRefreshAll(() => {
      signals.refreshVersion.value++;
    });

    budgetPlannerUi.initBudgetPlannerHandlers();
    budgetPlannerUi.setBudgetPlannerFmtCur((v: number) => signals.currency.value.symbol + v.toFixed(2));
    budgetPlannerUi.setBudgetPlannerCallbacks({
      renderCategories,
      renderQuickShortcuts,
      populateCategoryFilter,
      renderCustomCatsList: () => {
        import('../ui/core/ui-render.js').then(m => m.renderCustomCatsList());
      }
    });

    importExportEv.initImportExportEvents({
      fmtCur: (v: number) => signals.currency.value.symbol + v.toFixed(2)
    });
    import('../ui/components/async-modal.js').then(({ confirmDataOperation }) => {
      importExportEv.setImportConfirmFn(confirmDataOperation);
    });

    // IMPORTANT: Do NOT call mount functions here — reactive components are already mounted
    // and will auto-update when signal values change from storage sync.
    storageEv.initStorageEvents({
      refreshAll: () => {
        signals.refreshVersion.value++;
      },
      updateSummary: () => {
        // Summary cards are reactive — signal changes trigger re-render automatically
      },
      renderSavingsGoals: () => {
        // Savings goals are reactive — signal changes trigger re-render automatically
      },
      checkAlerts: () => {
        import('../features/personalization/alerts.js').then(m => m.checkAlerts());
      },
      updateInsights: () => {
        // Insights are reactive — signal changes trigger re-render automatically
      },
      renderBadges: () => {
        import('../features/gamification/achievements.js').then(m => m.checkAchievements());
      },
      renderStreak: () => {
        // Streak is reactive — signal changes trigger re-render automatically
      },
      renderFilterPresets: () => {
        import('../ui/widgets/filters.js').then(m => m.renderFilterPresets());
      },
      renderTemplates: () => renderTemplates()
    });

    import('../ui/interactions/emoji-picker.js').then(m => m.init());
    setStartupProgress('post:deferred-ready');
  }).catch((error) => {
    if (import.meta.env.DEV) console.error('Deferred post-init setup failed:', error);
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

  // Clear container
  if (initStatus.container) {
    initStatus.container.clear();
  }

  // Reset status
  initStatus.initialized = false;
  initStatus.container = null;
  initStatus.errors = [];
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
