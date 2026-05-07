/**
 * Application Initialization with Dependency Injection
 * 
 * Refactored initialization using the DI container to eliminate
 * manual setter functions and improve testability
 */

import { getDefaultContainer, Services, DIContainer } from '../core/di-container.js';
import { unmountAll } from '../core/effect-manager.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, action-plan #37): removed
// `initDashboard` import from orchestration/dashboard.js. That module was a
// no-op backward-compat shim (`initDashboard()` returned `() => {}`) and its
// `animateValue` re-export had zero consumers (summary-cards.ts and
// daily-allowance.ts both import directly from dashboard-animations.js).
// Dashboard UI is owned by the reactive components — the shim added
// indirection without behavior. Module deleted in the same phase.
import { initAppEvents, cleanupAppEvents } from './app-events.js';
import { loadSampleData } from './sample-data.js';
import { initTheme } from '../features/personalization/theme.js';
import { startOnboarding } from '../features/personalization/onboarding.js';
import { SK, lsGet } from '../core/state.js';
import * as signals from '../core/signals.js';
import { dataSdk } from '../data/data-manager.js';
import { migrationManager } from '../data/migration.js';
import { on, emit, Events, initEventBusDefaults } from '../core/event-bus.js';
import { initialize as initializeErrorTracker, trackError, loadAndCall } from '../core/error-tracker.js';
import { DOM } from '../core/dom-cache.js';
import { initMultiTabSync, cleanup as cleanupMultiTabSync } from '../core/multi-tab-sync.js';
import { initShellNavigation, cleanupShellNavigation } from '../ui/core/ui-navigation.js';
import * as filterEv from '../ui/interactions/filter-events.js';
import * as formEv from '../ui/interactions/form-events.js';
import * as keyboardEv from '../ui/interactions/keyboard-events.js';
import { DataSyncEvents, requestDataReload, type TransactionDataDelta } from '../core/data-sync-interface.js';
import { syncCurrencyFormat } from '../core/utils-pure.js';
import type { Transaction, MainTab } from '../../types/index.js';

/**
 * Runtime type guard for Transaction payloads arriving from the event bus.
 *
 * Event-bus payloads are typed `unknown` because subscribers come from many
 * different emit sites. The sync-dispatch handlers below cannot safely cast
 * a payload to `Transaction` — a malformed or foreign event (for example a
 * bug in another module emitting the wrong shape) would silently propagate
 * garbage into the worker delta pipeline and corrupt downstream aggregates.
 *
 * This guard checks the structural contract of a Transaction: the required
 * fields the worker protocol depends on must exist with the right primitive
 * types. Optional fields are not validated — they are tolerated by the
 * worker.
 *
 * Fixes C4 (Inline-Behavior-Review rev 12).
 */
function isTransaction(value: unknown): value is Transaction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.__backendId === 'string' &&
    (v.type === 'expense' || v.type === 'income') &&
    typeof v.amount === 'number' && Number.isFinite(v.amount) &&
    typeof v.description === 'string' &&
    typeof v.date === 'string' &&
    typeof v.category === 'string' &&
    typeof v.currency === 'string' &&
    typeof v.recurring === 'boolean'
  );
}
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
  window.__APP_STARTUP_PROGRESS__ = step;
  document.documentElement.dataset.appStartupProgress = step;
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.__APP_DEBUG_STARTUP__ === true) {
    console.log(`[startup] ${step}`);
  }
}

function setShellReadyState(isReady: boolean): void {
  window.__APP_SHELL_READY__ = isReady;
  document.documentElement.dataset.appShellReady = isReady ? 'true' : 'false';
}

function setInteractiveReadyState(isReady: boolean): void {
  window.__APP_INTERACTIVE_READY__ = isReady;
  document.documentElement.dataset.appInteractiveReady = isReady ? 'true' : 'false';
}

function setBackgroundReadyState(isReady: boolean): void {
  window.__APP_BACKGROUND_READY__ = isReady;
  document.documentElement.dataset.appBackgroundReady = isReady ? 'true' : 'false';
}

function setBackgroundFailedState(isFailed: boolean): void {
  window.__APP_BACKGROUND_FAILED__ = isFailed;
  document.documentElement.dataset.appBackgroundFailed = isFailed ? 'true' : 'false';
}

function recordDeferredStartupFailure(errorLabel: string, error: unknown): void {
  if (import.meta.env.DEV) console.error(errorLabel, error);
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  initStatus.errors.push(normalizedError);
  setBackgroundFailedState(true);
  setStartupProgress('initialize:background-failed');
  const deferredErrors: DeferredStartupError[] = Array.isArray(window.__APP_DEFERRED_ERRORS__)
    ? window.__APP_DEFERRED_ERRORS__
    : [];
  deferredErrors.push({
    label: errorLabel,
    message: normalizedError.message,
    timestamp: Date.now()
  });
  window.__APP_DEFERRED_ERRORS__ = deferredErrors;
}

function createBackgroundTaskTracker(totalTasks: number): (step: string) => void {
  let remainingTasks = totalTasks;
  return (step: string) => {
    if (window.__APP_BACKGROUND_FAILED__ === true) {
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
    // Fixes L39 + L60 (Inline-Behavior-Review rev 12): error-tracker and
    // event-bus previously installed global listeners / throttle config at
    // module-import time. That coupled test imports to runtime side effects.
    // Now boot code calls them explicitly — and does so FIRST, before any
    // other module gets a chance to throw, so global error capture is live
    // before the rest of initialization runs.
    initializeErrorTracker();
    initEventBusDefaults();

    cleanupDeferredInteractiveWork();
    setShellReadyState(false);
    setInteractiveReadyState(false);
    setBackgroundReadyState(false);
    setBackgroundFailedState(false);
    setStartupProgress('initialize:start');
    window.__APP_DEFERRED_ERRORS__ = [];

    // One-time key migration: rename budget_tracker_* → harbor_* in localStorage.
    // MUST run before anything reads from SK.* keys (state hydration, theme init, etc.).
    const { migrateStorageKeyNames } = await import('../data/key-migration.js');
    migrateStorageKeyNames();

    // Get DI container
    const container = getDefaultContainer();
    initStatus.container = container;

    // Initialize only shell-critical services on the blocking path.
    // Round 7 fix: Defer initShellNavigation until AFTER container initialization
    // to prevent interactive race when user clicks a tab during boot. If a click
    // arrives before container.initialize() completes, switchMainTab will fail
    // trying to resolve services from an uninitialized container.
    await container.initialize({
      services: [Services.CONFIG, Services.CURRENCY_FORMATTER, Services.GET_TODAY_STR]
    });
    setStartupProgress('initialize:container-ready');

    // Round 7 fix: NOW bind the static shell navigation after DI container is ready.
    // Tab clicks can now safely resolve services since the container is initialized.
    initShellNavigation();
    registerCleanup(cleanupShellNavigation);
    setStartupProgress('initialize:shell-navigation-bound');

    // Synchronise the reactive currency formatter with the hydrated currency signal.
    // Signals are hydrated from localStorage at module-evaluation time, so this runs
    // once with the correct value before any UI renders. Subsequent changes go through
    // data.setCurrencySettings() which also calls syncCurrencyFormat().
    syncCurrencyFormat(signals.currency.value);

    // Initialize theme first (affects UI)
    registerCleanup(initTheme());
    setStartupProgress('initialize:theme-ready');

    // Initialize user-owned category store (migrate from hardcoded if needed)
    const { initCategoryStore } = await import('../core/category-store.js');
    initCategoryStore();
    setStartupProgress('initialize:categories-ready');

    // Check PIN lock
    const pinHandlers = await import('../ui/widgets/pin-ui-handlers.js');
    if (pinHandlers.shouldShowPinLock()) {
      setStartupProgress('initialize:pin-lock-required');
      await pinHandlers.showPinLock();

      // Initialize auto-lock for inactivity when PIN is set.
      //
      // CR-Apr24-D1 [P2] findings 151, 154, 155: route through the
      // module-scoped controller (`startAutoLockIfNeeded`) so storage-
      // events.ts and the local clear-PIN handler can later call
      // `stopAutoLockIfActive()` to tear down the same instance. Pre-fix
      // the cleanup returned by `initAutoLock` was captured in this
      // closure and never reachable from runtime PIN-mutation paths.
      const { startAutoLockIfNeeded } = await import('../features/security/auto-lock.js');
      const autoLockCleanup = startAutoLockIfNeeded(() => {
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

    const savedTab = lsGet('harbor_active_tab', 'dashboard') as string;
    await initializeShellVisibleControls();
    await initializeShellCriticalSurface(savedTab);
    setShellReadyState(true);
    setStartupProgress('initialize:shell-ready');

    // Preset picker is now integrated into onboarding step 0.
    // No separate showPresetPicker() call — the unified flow handles it.

    const onboardingState = lsGet(SK.ONBOARD, { completed: false, step: 0 }) as { completed: boolean; step: number };
    const hasCompletedOnboarding = onboardingState.completed;
    const hasTransactions = signals.transactions.value.length > 0;
    const shouldOnboard = !hasCompletedOnboarding && !hasTransactions;

    await postOnboardingInit(savedTab, hasTransactions);
    setInteractiveReadyState(true);
    setStartupProgress('initialize:interactive-ready');

    const completeBackgroundTask = createBackgroundTaskTracker(4);

    // Start onboarding on the blocking path so the UI appears immediately.
    // startOnboarding() resumes from the saved step — step 0 (preset picker)
    // for new users, or a later step for returning users who paused mid-tour.
    // Mount the reactive renderer here too (don't wait for lazy loader) so
    // the first frame renders without delay.
    if (shouldOnboard) {
      const { initOnboarding, cleanupOnboarding, mountOnboarding } = await import('../features/personalization/onboarding.js');
      initOnboarding();
      registerCleanup(cleanupOnboarding);
      const cleanupMount = mountOnboarding();
      registerCleanup(cleanupMount);
      startOnboarding();
      setStartupProgress('initialize:onboarding-started');
    }

    scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
      // Only init listeners if we didn't already do it on the blocking path above
      if (!shouldOnboard) {
        const { initOnboarding, cleanupOnboarding } = await import('../features/personalization/onboarding.js');
        if (isCancelled()) return;
        initOnboarding();
        registerCleanup(cleanupOnboarding);
      }

      const { initAlerts } = await import('../features/personalization/alerts.js');
      if (isCancelled()) return;
      registerCleanup(initAlerts());

      const { initRollover, cleanupRollover } = await import('../features/financial/rollover.js');
      if (isCancelled()) return;
      initRollover();
      registerCleanup(cleanupRollover);
    }, 'Deferred onboarding/alerts init failed', 'deferred:onboarding-alerts-ready', completeBackgroundTask);

    scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
      if (await migrationManager.needsMigration()) {
        if (isCancelled()) return;

        // ROUND 7 FIX: Set migration-in-progress flag BEFORE starting migration.
        // This prevents user interactions from writing to the data layer while
        // migration moves data from localStorage to IndexedDB. Without this flag,
        // concurrent writes can cause data loss or contention.
        // The flag is a global signal that data-manager checks in its write path.
        (window as unknown as Record<string, boolean>).__APP_MIGRATION_IN_PROGRESS__ = true;

        setStartupProgress('initialize:migration-start');
        emit(Events.SHOW_TOAST, { message: 'Upgrading database...', type: 'info' });
        const migrationResult = await migrationManager.migrate((progress) => {
          if (progress.phase === 'migrating' && import.meta.env.DEV && window.__APP_DEBUG_STARTUP__ === true) {
            console.log(`Migration progress: ${Math.round(progress.progress)}%`);
          }
        });

        // ROUND 7 FIX: Clear the migration-in-progress flag AFTER migration completes
        // (or fails). This re-enables writes to the data layer.
        (window as unknown as Record<string, boolean>).__APP_MIGRATION_IN_PROGRESS__ = false;

        if (isCancelled()) return;
        if (migrationResult.isOk) {
          // Post-migration ledger reload (P1 fix): dataSdk.init() ran at
          // boot against an empty IDB (line 299), so signals.transactions
          // currently holds []. The migration just wrote the user's ledger
          // into IDB but bypassed data-manager's in-memory cache via direct
          // storageManager.createBatch() calls — so without this reload,
          // the returning user would see an empty dashboard for the entire
          // session and only recover on manual page refresh.
          // REQUEST_RELOAD causes data-manager to re-read transactions,
          // invalidate caches, and dispatch onDataChanged() so the signal
          // and every downstream computed derivation refresh in one pass.
          requestDataReload('migration:complete');
          emit(Events.SHOW_TOAST, { message: 'Database upgrade complete!', type: 'success' });
        } else {
          if (import.meta.env.DEV) console.error('Migration failed:', migrationResult.error);
          emit(Events.SHOW_TOAST, { message: 'Database upgrade deferred', type: 'warning' });
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
    emit(Events.SHOW_TOAST, { message: 'Harbor Ledger couldn\u2019t start. Try refreshing the page. If the problem persists, clear your browser cache.', type: 'error' });
    
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

  const validTabs: MainTab[] = ['dashboard', 'budget', 'transactions', 'calendar'];
  const initialTab: MainTab = (validTabs as string[]).includes(savedTab)
    ? savedTab as MainTab
    : 'dashboard';
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
    renderSavingsGoals: () => {},
    updateSummary: () => {},
    renderCustomCatsList: () => {
      // M6 (Inline-Behavior-Review rev 12): route the floating dynamic
      // import through `loadAndCall` so a failed lazy-load surfaces in
      // telemetry instead of producing an unhandled rejection.
      loadAndCall(
        () => import('../ui/core/ui-render.js'),
        (m) => m.renderCustomCatsList(),
        { module: 'AppInitDI', action: 'modal_render_custom_cats_list' }
      );
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
  importExportEv.initImportExportEvents({});
  registerCleanup(importExportEv.cleanupImportExportEvents);
  // M6 (rev 12): loader failure now surfaces via trackError instead of
  // a silent unhandled rejection that would leave the import-confirm
  // dialog wired to nothing.
  loadAndCall(
    () => import('../ui/components/async-modal.js'),
    ({ confirmDataOperation }) => {
      importExportEv.setImportConfirmFn(confirmDataOperation);
    },
    { module: 'AppInitDI', action: 'wire_import_confirm_fn' }
  );

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

  // M6 (rev 12): loader failure now surfaces via trackError.
  loadAndCall(
    () => import('../ui/components/async-modal.js'),
    ({ promptTextInput }) => {
      filterEv.setFilterPromptFn(promptTextInput);
    },
    { module: 'AppInitDI', action: 'wire_filter_prompt_fn' }
  );

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
    switchMainTab: (tab: string) => switchMainTab(tab as MainTab),
    switchTab: (type: 'expense' | 'income') => switchTab(type),
    cancelEditing: async () => {
      const { cancelEditing } = await import('../transactions/edit-mode.js');
      cancelEditing();
    },
    openSettingsModal: () => {
      // M6 (rev 12): migrated from `void import().then()` — same silent
      // unhandled-rejection risk applied even with the leading `void`.
      loadAndCall(
        () => import('../ui/interactions/modal-events.js'),
        ({ openSettingsModal }) => {
          void openSettingsModal();
        },
        { module: 'AppInitDI', action: 'open_settings_modal' }
      );
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
  registerCleanup(splitTransactions.mountSplitModal());
  // M6 (rev 12): migrated from `void import().then()` — `loadAndCall`
  // captures loader failures so the filter-presets strip is never left
  // unrendered without a telemetry signal.
  loadAndCall(
    () => import('../ui/widgets/filters.js'),
    ({ renderFilterPresets }) => {
      renderFilterPresets();
    },
    { module: 'AppInitDI', action: 'initial_render_filter_presets' }
  );
  setStartupProgress('post:form-ui-ready');

  const validTabs: MainTab[] = ['dashboard', 'budget', 'transactions', 'calendar'];
  const initialTab: MainTab = (validTabs as string[]).includes(savedTab)
    ? savedTab as MainTab
    : 'dashboard';
  switchMainTab(initialTab);

  await refreshTransactionsSurface();
  setStartupProgress(hasTransactions ? 'post:transactions-rendered' : 'post:empty-state-rendered');

  registerCleanup(await setupWorkerDeltaSync());
  const { syncWorkerDataset, shouldUseWorker, isWorkerReady } = await import('./worker-manager.js');
  if (shouldUseWorker(signals.transactions.value.length) && !isWorkerReady()) {
    // rev 12 L2 (#32 observability): initial full-sync failure previously DEV-only
    // warned. Route through trackError so prod worker-init races surface in
    // telemetry — there's no retry on this path (unlike syncDeltaOrReload),
    // so a silent failure leaves the worker indeterminate for the rest of the
    // session.
    void syncWorkerDataset(signals.transactions.value).catch((err: unknown) => {
      trackError(err instanceof Error ? err : new Error(String(err)), {
        module: 'AppInitDI',
        action: 'initial_worker_sync',
      });
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
    const { switchTab } = await import('../ui/core/ui-navigation.js');
    const { renderMonthNav, renderCategories, renderQuickShortcuts, populateCategoryFilter, updateCharts } = await import('../ui/core/ui-render.js');
    const { refreshTransactionsSurface } = await import('../data/transaction-surface-coordinator.js');
    const { initLazyLoading, cleanupLazyLoading } = await import('../core/lazy-loader.js');
    if (isCancelled()) return;
    initLazyLoading();
    registerCleanup(cleanupLazyLoading);
    setStartupProgress('post:lazy-loader-ready');

    // Phase 5g-1: removed `initDashboard()` / `cleanupDashboard` wiring —
    // the shim was a no-op returning a no-op cleanup. `post:dashboard-ready`
    // startup-progress beacon had no external consumer (grep-verified) and
    // was also removed. Early-cancel window between lazy-loader and app-events
    // is preserved by the next `if (isCancelled()) return;` check below.
    if (isCancelled()) return;

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
      // Phase 5g-1 (Inline-Behavior-Review rev 12, L54): removed
      // `checkBackupReminder` callback wiring. backup-reminder.ts no
      // longer exports the no-op shim; mountBackupReminder()'s effect
      // is the live path.
      renderMonthNav: () => renderMonthNav(),
      populateCategoryFilter: () => populateCategoryFilter(),
      resetCalendarSelection: async () => {
        const { resetCalendarSelection } = await import('../ui/widgets/calendar.js');
        resetCalendarSelection();
      },
      renderCategories: () => renderCategories(),
      // CR-Apr24-I finding 93: schedule quick-shortcut rerender on category edits
      renderQuickShortcuts: () => renderQuickShortcuts(),
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
      setTemplateRenderCategoriesFn,
      setTemplateSwitchTabFn,
      renderTemplates
    } = await import('../transactions/template-manager.js');
    if (isCancelled()) return;
    initTemplateManager();
    setTemplateRenderCategoriesFn(() => renderCategories());
    setTemplateSwitchTabFn((type: 'expense' | 'income') => switchTab(type));
    renderTemplates();
    registerCleanup(cleanupTemplateManager);
    setStartupProgress('post:templates-ready');

    const { processRecurringTemplates } = await import('../data/recurring-templates.js');
    // CR-Apr24-B [P2] finding 44: processRecurringTemplates now returns a
    // structured result. Read `.generated` for the toast count; the other
    // fields (templatesErrored, capHits) are for telemetry — DEV-only
    // warnings inside the implementation already surface them.
    const result = await processRecurringTemplates();
    const generatedCount = result.generated;
    if (isCancelled()) return;
    if (generatedCount > 0) {
      emit(Events.SHOW_TOAST, { message: `Generated ${generatedCount} recurring transaction${generatedCount === 1 ? '' : 's'}`, type: 'info' });
    }
    setStartupProgress('initialize:recurring-ready');

    const { initDashboardTrendRangeSelector } = await import('../ui/core/ui-render.js');
    const { renderMonthComparison } = await import('../ui/charts/analytics-ui.js');
    await updateCharts();
    initDashboardTrendRangeSelector();
    renderMonthComparison();

    // Resolve lazy DI services so downstream resolveSync() calls succeed.
    // Without this, isInitialized() stays false and resolveSync throws.
    const container = getDefaultContainer();
    await Promise.all([
      container.resolve(Services.INSIGHTS_GENERATOR),
      container.resolve(Services.UPDATE_CHARTS),
    ]);
    // Bump refreshVersion to trigger currentInsights recomputation now
    // that the service is available.
    signals.refreshVersion.value++;

    setupPerformanceMonitoring();
  }, 'Deferred analytics/template init failed', 'post:performance-ready', completeBackgroundTask);

  scheduleTrackedDeferredInteractiveWork(async (isCancelled) => {
    const [
      storageEv,
      debtUiHandlers,
      budgetPlannerUi,
      debtPlanner,
      pinHandlers,
      calculations,
      achievements,
      streakTracker
    ] = await Promise.all([
      import('../ui/interactions/storage-events.js'),
      import('../ui/widgets/debt-ui-handlers.js'),
      import('../features/financial/budget-planner-ui.js'),
      import('../features/financial/debt-planner.js'),
      import('../ui/widgets/pin-ui-handlers.js'),
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

    debtUiHandlers.initDebtHandlers();
    registerCleanup(debtUiHandlers.cleanupDebtHandlers);
    debtUiHandlers.setDebtRefreshAll(() => {
      signals.refreshVersion.value++;
    });

    budgetPlannerUi.initBudgetPlannerHandlers();
    registerCleanup(budgetPlannerUi.cleanupBudgetPlannerHandlers);
    // M6 (rev 12): every loader failure in the budget-planner callback
    // cluster now routes through trackError. The prior mix of
    // `void import()` (3 sites) and bare `import()` (1 site) was the
    // motivating example called out in the finding — both shapes leaked
    // a floating rejection; unifying through `loadAndCall` closes both.
    budgetPlannerUi.setBudgetPlannerCallbacks({
      renderCategories: () => {
        loadAndCall(
          () => import('../ui/core/ui-render.js'),
          (m) => m.renderCategories(),
          { module: 'AppInitDI', action: 'budget_planner_render_categories' }
        );
      },
      renderQuickShortcuts: () => {
        loadAndCall(
          () => import('../ui/core/ui-render.js'),
          (m) => m.renderQuickShortcuts(),
          { module: 'AppInitDI', action: 'budget_planner_render_quick_shortcuts' }
        );
      },
      populateCategoryFilter: () => {
        loadAndCall(
          () => import('../ui/core/ui-render.js'),
          (m) => m.populateCategoryFilter(),
          { module: 'AppInitDI', action: 'budget_planner_populate_category_filter' }
        );
      },
      renderCustomCatsList: () => {
        loadAndCall(
          () => import('../ui/core/ui-render.js'),
          (m) => m.renderCustomCatsList(),
          { module: 'AppInitDI', action: 'budget_planner_render_custom_cats_list' }
        );
      }
    });

    // M6 (rev 12): storage-event fanout callbacks now route every
    // dynamic-import failure through trackError.
    storageEv.initStorageEvents({
      refreshAll: () => {
        signals.refreshVersion.value++;
      },
      updateSummary: () => {},
      renderSavingsGoals: () => {},
      checkAlerts: () => {
        loadAndCall(
          () => import('../features/personalization/alerts.js'),
          (m) => m.checkAlerts(),
          { module: 'AppInitDI', action: 'storage_check_alerts' }
        );
      },
      updateInsights: () => {},
      renderBadges: () => {
        loadAndCall(
          () => import('../features/gamification/achievements.js'),
          (m) => m.checkAchievements(),
          { module: 'AppInitDI', action: 'storage_check_achievements' }
        );
      },
      // CR-Apr24-I finding 136: previously a no-op, leaving the streak
      // widget stale after cross-tab streak updates. Now dynamically
      // imports and calls the real renderStreak so the gamification
      // surface stays in sync across tabs.
      renderStreak: () => {
        loadAndCall(
          () => import('../features/gamification/streak-tracker.js'),
          (m) => m.renderStreak(),
          { module: 'AppInitDI', action: 'storage_render_streak' }
        );
      },
      renderFilterPresets: () => {
        loadAndCall(
          () => import('../ui/widgets/filters.js'),
          (m) => m.renderFilterPresets(),
          { module: 'AppInitDI', action: 'storage_render_filter_presets' }
        );
      },
      renderTemplates: () => {
        loadAndCall(
          () => import('../transactions/template-manager.js'),
          (m) => m.renderTemplates(),
          { module: 'AppInitDI', action: 'storage_render_templates' }
        );
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
    // rev 12 L2 (#32 observability): full-dataset sync failure now routes
    // through trackError instead of DEV-only warn — no retry on this path,
    // so a silent failure produces a worker that's out-of-sync for the
    // remainder of the session with zero prod telemetry.
    void syncWorkerDataset(signals.transactions.value).catch((err: unknown) => {
      trackError(err instanceof Error ? err : new Error(String(err)), {
        module: 'AppInitDI',
        action: 'worker_full_dataset_sync',
      });
    });
  };

  const syncDeltaOrReload = (change: TransactionDataDelta): void => {
    if (!shouldSyncWorker()) return;
    if (!isWorkerReady()) {
      syncFullDataset();
      return;
    }
    // rev 12 L2 (#32 observability): delta-sync failure recovers via a full
    // resync (which will surface its own failure if it also fails), but the
    // delta-failure itself is still worth knowing about — repeated delta
    // failures suggest a worker-protocol regression.
    void syncWorkerDatasetDelta(change).catch((err: unknown) => {
      trackError(err instanceof Error ? err : new Error(String(err)), {
        module: 'AppInitDI',
        action: 'worker_delta_sync_retrying_full',
      });
      syncFullDataset();
    });
  };

  const unsubscribers = [
    on(Events.TRANSACTION_ADDED, (tx: unknown) => {
      if (!isTransaction(tx)) {
        if (import.meta.env.DEV) console.warn('[sync] Ignoring TRANSACTION_ADDED with invalid payload:', tx);
        return;
      }
      syncDeltaOrReload({ type: 'add', item: tx });
    }),
    on(Events.TRANSACTION_UPDATED, (tx: unknown) => {
      if (!isTransaction(tx)) {
        if (import.meta.env.DEV) console.warn('[sync] Ignoring TRANSACTION_UPDATED with invalid payload:', tx);
        return;
      }
      syncDeltaOrReload({ type: 'update', item: tx });
    }),
    on(Events.TRANSACTION_DELETED, (tx: unknown) => {
      if (!isTransaction(tx)) {
        if (import.meta.env.DEV) console.warn('[sync] Ignoring TRANSACTION_DELETED with invalid payload:', tx);
        return;
      }
      syncDeltaOrReload({ type: 'delete', id: tx.__backendId, item: tx });
    }),
    on(Events.TRANSACTIONS_BATCH_ADDED, (payload: unknown) => {
      const candidate = (payload && typeof payload === 'object')
        ? (payload as { transactions?: unknown }).transactions
        : undefined;
      if (!Array.isArray(candidate)) {
        if (import.meta.env.DEV) console.warn('[sync] Ignoring TRANSACTIONS_BATCH_ADDED with invalid payload:', payload);
        return;
      }
      const transactions = candidate.filter(isTransaction);
      if (transactions.length === 0) return;
      if (import.meta.env.DEV && transactions.length !== candidate.length) {
        console.warn(`[sync] TRANSACTIONS_BATCH_ADDED dropped ${candidate.length - transactions.length} invalid items`);
      }
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
      // CR-Apr24-I finding 250: add error handling so cross-tab worker
      // refresh failures get telemetry, matching every other sync path.
      void syncWorkerDataset(payload.transactions).catch((err: unknown) => {
        trackError(err instanceof Error ? err : new Error(String(err)), {
          module: 'worker-manager',
          action: 'cross_tab_full_refresh'
        });
      });
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
  // CR-Apr24-I finding 72: previously only `renderMonthComparison` ran
  // after a multi-tab sync, leaving the full analytics modal (trend
  // charts, YoY, seasonal, category breakdown) stale. Now also call
  // `refreshAnalyticsIfOpen` which re-populates the entire modal if it
  // is currently visible. Lazy-import keeps the module off the critical
  // path when the modal is closed (the common case).
  const { refreshAnalyticsIfOpen } = await import('../features/analytics/analytics-ui.js');

  const unsubscribers = [
    on(DataSyncEvents.TRANSACTION_UPDATED, (payload: { source?: string }) => {
      if (payload.source !== 'multi-tab-sync') return;
      checkAchievements();
      renderMonthComparison();
      refreshAnalyticsIfOpen();
    }),
    on(DataSyncEvents.TRANSACTION_DELTA_APPLIED, (payload: { source?: string }) => {
      if (payload.source !== 'multi-tab-sync') return;
      checkAchievements();
      renderMonthComparison();
      refreshAnalyticsIfOpen();
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
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
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

  const idleCallback = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback : undefined;
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

// ==========================================
// PERFORMANCE MONITORING
// ==========================================

function setupPerformanceMonitoring(): void {
  // Only setup in development
  if (import.meta.env.DEV) {
    // M6 (rev 12): DEV-only dynamic import still benefits from the
    // loadAndCall wrapper — a failing import during dev surfaces in the
    // error console via trackError instead of a silent rejection.
    loadAndCall(
      () => import('../core/performance-integration.js'),
      ({ setupPerformanceMonitoring }) => {
        setupPerformanceMonitoring();
      },
      { module: 'AppInitDI', action: 'setup_performance_monitoring' }
    );
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

  // Tear down the module-level midnight-refresh timer in signals.ts. Without
  // this call the setTimeout chain survives HMR, app reset, and test-harness
  // reuse, scheduling duplicate todayStr updates against stale app state.
  signals.cancelMidnightTimer();

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
