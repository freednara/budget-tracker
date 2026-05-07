/**
 * Budget Tracker Elite - Main Application Entry Point
 * 
 * Clean initialization using Dependency Injection Container
 * Replaces 800+ lines of manual wiring with automated setup
 */

import { initializeApp, cleanupApp, isAppInitialized } from './js/modules/orchestration/app-init-di.js';
import { showToast } from './js/modules/ui/core/ui.js';
import { perfMonitor } from './js/modules/core/performance-monitor.js';
import { switchMainTab } from './js/modules/ui/core/ui-navigation.js';
import { safeStorage } from './js/modules/core/safe-storage.js';

declare const __APP_VERSION__: string;
declare const __APP_BUILD_TIME__: string;

interface AppRuntimeInfo {
  version: string;
  buildTime: string;
  runtimeMode: 'browser' | 'standalone';
  serviceWorkerControlled: boolean;
}

// Phase 6 cleanup (no-explicit-any sweep): the 22 `(window as any)` casts
// in this file are now typed writes against the Window augmentation in
// `js/types/globals.d.ts`. The additional entries needed here
// (__APP_ERRORS__, __APP_INITIALIZED__, __APP_VERSION__, __APP_BUILD_TIME__,
// __APP_RUNTIME_INFO__, __APP_TEST_API__) live alongside the existing
// startup-progress contract in that file — see `AppRuntimeInfo` above for
// the runtime-info payload shape and `HarborLedgerTestApi` (declared in
// globals.d.ts) for the Playwright test handle.

let performanceMonitoringCleanup: (() => void) | null = null;

function setAppDataset(name: string, value: string): void {
  document.documentElement.dataset[name] = value;
}

function isStartupDebugEnabled(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && window.__APP_DEBUG_STARTUP__ === true;
}

function isStandaloneRuntime(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function getRuntimeInfo(): AppRuntimeInfo {
  return {
    version: __APP_VERSION__,
    buildTime: __APP_BUILD_TIME__,
    runtimeMode: isStandaloneRuntime() ? 'standalone' : 'browser',
    serviceWorkerControlled: !!navigator.serviceWorker?.controller,
  };
}

function publishRuntimeInfo(): void {
  const runtimeInfo = getRuntimeInfo();
  window.__APP_VERSION__ = runtimeInfo.version;
  window.__APP_BUILD_TIME__ = runtimeInfo.buildTime;
  window.__APP_RUNTIME_INFO__ = runtimeInfo;
  setAppDataset('appVersion', runtimeInfo.version);
  setAppDataset('appRuntime', runtimeInfo.runtimeMode);
  setAppDataset('appSwControlled', runtimeInfo.serviceWorkerControlled ? 'true' : 'false');
}

function removeUpdateBanner(): void {
  document.getElementById('app-update-banner')?.remove();
}

function showUpdateBanner(onUpdate: () => void): void {
  removeUpdateBanner();

  const banner = document.createElement('div');
  banner.id = 'app-update-banner';
  banner.className = 'update-banner';
  const message = document.createElement('span');
  message.textContent = 'Update ready for Harbor Ledger';

  const updateButton = document.createElement('button');
  updateButton.type = 'button';
  updateButton.className = 'update-btn';
  updateButton.textContent = 'Refresh now';

  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'dismiss-btn';
  dismissButton.setAttribute('aria-label', 'Dismiss update banner');
  dismissButton.textContent = '×';

  banner.append(message, updateButton, dismissButton);

  updateButton?.addEventListener('click', () => onUpdate());
  dismissButton?.addEventListener('click', () => removeUpdateBanner());

  document.body.appendChild(banner);
}

async function activateWaitingServiceWorker(registration: ServiceWorkerRegistration): Promise<void> {
  if (!registration.waiting) {
    window.location.reload();
    return;
  }

  removeUpdateBanner();

  await new Promise<void>((resolve) => {
    let resolved = false;

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        finish();
        window.location.reload();
      },
      { once: true }
    );

    registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(finish, 4000);
  });
}

async function syncRuntimeVersion(): Promise<void> {
  publishRuntimeInfo();

  // The harbor_ rebrand renamed this key from budget_tracker_runtime_version.
  // On the first launch after upgrade, the new key is absent but the legacy
  // key still holds the previous version, so we fall back to it. Without this
  // fallback, upgraded installs look like a fresh first-run and skip the
  // previousVersion → cache-clear + SW-refresh branch below — the exact branch
  // the rebrand relies on. After migration we drop the legacy key so it only
  // runs once.
  const versionKey = 'harbor_runtime_version';
  const legacyVersionKey = 'budget_tracker_runtime_version';
  const currentStored = safeStorage.getItem(versionKey);
  const legacyStored = safeStorage.getItem(legacyVersionKey);
  const previousVersion = currentStored !== null ? currentStored : legacyStored;
  const currentVersion = __APP_VERSION__;

  // Clear the legacy key as soon as we've observed it — one-shot migration.
  if (legacyStored !== null) {
    safeStorage.removeItem(legacyVersionKey);
  }

  if (previousVersion === currentVersion) {
    // Still persist to the new key in case we only had the legacy copy.
    if (currentStored !== currentVersion) {
      safeStorage.setItem(versionKey, currentVersion);
    }
    return;
  }

  safeStorage.setItem(versionKey, currentVersion);

  if (!import.meta.env.PROD) {
    return;
  }

  if (previousVersion && previousVersion !== currentVersion && 'caches' in window) {
    try {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to clear stale caches on version change:', error);
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to refresh service worker registrations:', error);
    }
  }
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  try {
    publishRuntimeInfo();
    await syncRuntimeVersion();

    // Check if already initialized before clearing published readiness state.
    if (isAppInitialized()) {
      if (isStartupDebugEnabled()) console.warn('Application already initialized');
      return;
    }

    window.__APP_ERRORS__ = null;
    window.__APP_STARTUP_PROGRESS__ = null;
    window.__APP_SHELL_READY__ = false;
    window.__APP_INTERACTIVE_READY__ = false;
    window.__APP_BACKGROUND_READY__ = false;
    window.__APP_BACKGROUND_FAILED__ = false;
    window.__APP_INITIALIZED__ = false;
    window.__APP_TEST_API__ = null;
    setAppDataset('appError', 'false');
    setAppDataset('appShellReady', 'false');
    setAppDataset('appInitialized', 'false');
    setAppDataset('appInteractiveReady', 'false');
    setAppDataset('appBackgroundReady', 'false');
    setAppDataset('appBackgroundFailed', 'false');

    // Mark initialization start
    perfMonitor.mark('app.init.start');

    // Initialize application with DI container
    if (isStartupDebugEnabled()) console.log('Starting Budget Tracker Elite...');
    const status = await initializeApp();
    
    // Check initialization status
    if (!status.initialized) {
      throw new Error(`Initialization failed: ${status.errors.map(e => e instanceof Error ? e.message : String(e)).join(', ')}`);
    }

    // Measure initialization time
    const initTime = perfMonitor.measure('app.init', 'app.init.start');
    if (isStartupDebugEnabled()) console.log(`Budget Tracker initialized in ${initTime.toFixed(2)}ms`);

    // Show success message only on first visit (skip on subsequent page loads)
    if (!sessionStorage.getItem('_hl_shown_ready')) {
      showToast('Harbor Ledger ready', 'success');
      try { sessionStorage.setItem('_hl_shown_ready', '1'); } catch { /* ignore */ }
    }

    // Signal that blocking startup is complete and the interactive app is ready.
    window.__APP_INITIALIZED__ = true;
    setAppDataset('appInitialized', 'true');
    publishRuntimeInfo();

    if (window.__PW_TEST__ === true) {
      window.__APP_TEST_API__ = {
        // Widen the MainTab-typed signature to `(tab: string) => void` for
        // Playwright consumers. switchMainTab validates the tab name at
        // runtime, so this is safe.
        switchMainTab: (tab: string) => switchMainTab(tab as never),
      };
    }

    // Setup global error handling
    setupErrorHandling();

    // Setup performance monitoring
    setupPerformanceMonitoring();

  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to initialize application:', error);
    window.__APP_ERRORS__ = error instanceof Error ? error.message : String(error);
    window.__APP_STARTUP_PROGRESS__ = 'initialize:error';
    window.__APP_SHELL_READY__ = false;
    window.__APP_INTERACTIVE_READY__ = false;
    window.__APP_BACKGROUND_READY__ = false;
    window.__APP_BACKGROUND_FAILED__ = false;
    window.__APP_INITIALIZED__ = false;
    setAppDataset('appError', 'true');
    setAppDataset('appShellReady', 'false');
    setAppDataset('appInitialized', 'false');
    setAppDataset('appInteractiveReady', 'false');
    setAppDataset('appBackgroundReady', 'false');
    setAppDataset('appBackgroundFailed', 'false');
    
    // Show error to user
    showToast('Failed to start application. Please refresh the page.', 'error');
    
    // Log to performance monitor
    perfMonitor.recordMetric('app.init.error', 1, 'count', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    // Re-throw for debugging
    throw error;
  }
}

// ==========================================
// ERROR HANDLING
// ==========================================

/**
 * Setup global error handlers
 */
function setupErrorHandling(): void {
  // Handle unhandled errors
  window.addEventListener('error', (event) => {
    if (import.meta.env.DEV) console.error('Unhandled error:', event.error);
    // ErrorEvent.error is typed `any` in lib.dom — narrow via instanceof so
    // we don't propagate the `any` into recordMetric's tag map.
    const errorMessage = event.error instanceof Error ? event.error.message : event.message;
    perfMonitor.recordMetric('app.error.unhandled', 1, 'count', {
      message: errorMessage,
      filename: event.filename,
      line: event.lineno?.toString(),
      column: event.colno?.toString()
    });
  });

  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    if (import.meta.env.DEV) console.error('Unhandled promise rejection:', event.reason);
    // PromiseRejectionEvent.reason is typed `any`; narrow defensively.
    const reasonText = event.reason instanceof Error ? event.reason.message : String(event.reason);
    perfMonitor.recordMetric('app.error.promise', 1, 'count', {
      reason: reasonText
    });
  });
}

// ==========================================
// PERFORMANCE MONITORING
// ==========================================

/**
 * Setup performance monitoring and reporting
 */
function setupPerformanceMonitoring(): void {
  performanceMonitoringCleanup?.();

  // Monitor page visibility
  const visibilityHandler = (): void => {
    if (document.hidden) {
      perfMonitor.recordMetric('app.visibility.hidden', 1, 'count');
      // Only record metric when hidden — do NOT call cleanupApp()
      // as it destroys the DI container and leaves the app broken on return
    } else {
      perfMonitor.recordMetric('app.visibility.visible', 1, 'count');
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);

  // Memory monitoring handled by perfMonitor.startMemoryMonitoring() internally

  // Log performance report before unload
  const beforeUnloadHandler = (): void => {
    // Log final performance report
    if (import.meta.env.DEV) {
      perfMonitor.logReport();
    }
    
    // Cleanup application
    cleanupApp();
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);

  // Long task monitoring is registered centrally by performance-integration.ts
  // during development. Keep app-level monitoring focused on lifecycle events
  // so dev logs do not duplicate every long task warning.
  performanceMonitoringCleanup = () => {
    document.removeEventListener('visibilitychange', visibilityHandler);
    window.removeEventListener('beforeunload', beforeUnloadHandler);
  };
}

// ==========================================
// SERVICE WORKER REGISTRATION
// ==========================================

/**
 * Listen for service worker updates (registration handled by vite-plugin-pwa)
 */
async function setupServiceWorkerUpdateListener(): Promise<void> {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    try {
      const registration = await navigator.serviceWorker.ready;

      if (registration.waiting) {
        showUpdateBanner(() => {
          void activateWaitingServiceWorker(registration);
        });
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(() => {
                void activateWaitingServiceWorker(registration);
              });
            }
          });
        }
      });
    } catch (error) {
      if (import.meta.env.DEV) console.error('Service Worker update listener failed:', error);
    }
  }
}

// ==========================================
// APPLICATION STARTUP
// ==========================================

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch(console.error);
  });
} else {
  // DOM already loaded
  main().catch(console.error);
}

// In dev mode, unregister any stale service workers that cause request interception noise
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void (async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
        if (import.meta.env.DEV) console.log('Dev mode: unregistered stale service worker');
      }
    } catch (err) {
      console.error('Dev mode: failed to unregister stale service workers', err);
    }
  })();
}

// Set up service worker update listener after app loads
window.addEventListener('load', () => {
  publishRuntimeInfo();
  setupServiceWorkerUpdateListener().catch(console.error);
});

// ==========================================
// HOT MODULE REPLACEMENT (Development)
// ==========================================

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log('HMR: Module updated, reloading...');
    performanceMonitoringCleanup?.();
    performanceMonitoringCleanup = null;
    cleanupApp();
    window.location.reload();
  });
}

// ==========================================
// EXPORTS FOR TESTING
// ==========================================

export { main, setupErrorHandling, setupPerformanceMonitoring };
