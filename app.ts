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

function setAppDataset(name: string, value: string): void {
  document.documentElement.dataset[name] = value;
}

function isStartupDebugEnabled(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && (window as any).__APP_DEBUG_STARTUP__ === true;
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  try {
    (window as any).__APP_ERRORS__ = null;
    (window as any).__APP_STARTUP_PROGRESS__ = null;
    (window as any).__APP_SHELL_READY__ = false;
    (window as any).__APP_INTERACTIVE_READY__ = false;
    (window as any).__APP_BACKGROUND_READY__ = false;
    (window as any).__APP_INITIALIZED__ = false;
    (window as any).__APP_TEST_API__ = null;
    setAppDataset('appError', 'false');
    setAppDataset('appInitialized', 'false');
    setAppDataset('appInteractiveReady', 'false');
    setAppDataset('appBackgroundReady', 'false');

    // Mark initialization start
    perfMonitor.mark('app.init.start');

    // Check if already initialized
    if (isAppInitialized()) {
    if (isStartupDebugEnabled()) console.warn('Application already initialized');
      return;
    }

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

    // Show success message
    showToast('Budget Tracker ready', 'success');

    // Signal to E2E tests that app is fully initialized
    (window as any).__APP_INITIALIZED__ = true;
    setAppDataset('appInitialized', 'true');

    if ((window as any).__PW_TEST__ === true) {
      (window as any).__APP_TEST_API__ = {
        switchMainTab,
      };
    }

    // Setup global error handling
    setupErrorHandling();

    // Setup performance monitoring
    setupPerformanceMonitoring();

  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to initialize application:', error);
    (window as any).__APP_ERRORS__ = error instanceof Error ? error.message : String(error);
    (window as any).__APP_STARTUP_PROGRESS__ = 'initialize:error';
    (window as any).__APP_SHELL_READY__ = false;
    (window as any).__APP_INTERACTIVE_READY__ = false;
    (window as any).__APP_BACKGROUND_READY__ = false;
    (window as any).__APP_INITIALIZED__ = false;
    setAppDataset('appError', 'true');
    setAppDataset('appInitialized', 'false');
    setAppDataset('appInteractiveReady', 'false');
    setAppDataset('appBackgroundReady', 'false');
    
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
    perfMonitor.recordMetric('app.error.unhandled', 1, 'count', {
      message: event.error?.message || event.message,
      filename: event.filename,
      line: event.lineno?.toString(),
      column: event.colno?.toString()
    });
  });

  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    if (import.meta.env.DEV) console.error('Unhandled promise rejection:', event.reason);
    perfMonitor.recordMetric('app.error.promise', 1, 'count', {
      reason: event.reason?.message || String(event.reason)
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
  // Monitor page visibility
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      perfMonitor.recordMetric('app.visibility.hidden', 1, 'count');
      // Only record metric when hidden — do NOT call cleanupApp()
      // as it destroys the DI container and leaves the app broken on return
    } else {
      perfMonitor.recordMetric('app.visibility.visible', 1, 'count');
    }
  });

  // Memory monitoring handled by perfMonitor.startMemoryMonitoring() internally

  // Log performance report before unload
  window.addEventListener('beforeunload', () => {
    // Log final performance report
    if (import.meta.env.DEV) {
      perfMonitor.logReport();
    }
    
    // Cleanup application
    cleanupApp();
  });

  // Long task monitoring is registered centrally by performance-integration.ts
  // during development. Keep app-level monitoring focused on lifecycle events
  // so dev logs do not duplicate every long task warning.
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
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showToast('New version available! Refresh to update.', 'info');
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
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const reg of registrations) {
      reg.unregister();
      if (import.meta.env.DEV) console.log('Dev mode: unregistered stale service worker');
    }
  });
}

// Set up service worker update listener after app loads
window.addEventListener('load', () => {
  setupServiceWorkerUpdateListener().catch(console.error);
});

// ==========================================
// HOT MODULE REPLACEMENT (Development)
// ==========================================

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log('HMR: Module updated, reloading...');
    cleanupApp();
    window.location.reload();
  });
}

// ==========================================
// EXPORTS FOR TESTING
// ==========================================

export { main, setupErrorHandling, setupPerformanceMonitoring };
