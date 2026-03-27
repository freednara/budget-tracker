/**
 * Lazy Component Loader
 *
 * Advanced lazy loading system for components with intersection observer,
 * priority loading, and performance monitoring.
 *
 * @module core/lazy-loader
 */
'use strict';

// ==========================================
// TYPES
// ==========================================

export interface LazyComponentConfig {
  name: string;
  selector: string;
  loader: () => Promise<{ mount: () => (() => void) }>;
  priority: 'high' | 'medium' | 'low';
  threshold?: number;
  rootMargin?: string;
  dependencies?: string[];
}

export interface LoadedComponent {
  name: string;
  cleanup: () => void;
  loadTime: number;
  mountTime: number;
}

// ==========================================
// LAZY LOADER CLASS
// ==========================================

const MAX_LOAD_RETRIES = 3;

class LazyComponentLoader {
  private initialized = false;
  private observer: IntersectionObserver | null = null;
  private loadedComponents = new Map<string, LoadedComponent>();
  private pendingComponents = new Map<string, LazyComponentConfig>();
  private loadingPromises = new Map<string, Promise<void>>();
  private failureCounts = new Map<string, number>();

  /**
   * Initialize the lazy loader with intersection observer
   */
  init(): void {
    if (this.initialized) return;

    const testMode = (window as any).__PW_TEST__ === true;
    const forceLoad = window.location.search.includes('force-load=true');

    if (forceLoad) {
      if (import.meta.env.DEV) console.log('Force-load mode detected: Loading all lazy components');
      this.initialized = true;
      this.loadAllComponents();
      return;
    }

    if (testMode && import.meta.env.DEV) {
      console.log('Test mode detected: keeping lazy loading selective');
    }

    if (!('IntersectionObserver' in window)) {
      if (import.meta.env.DEV) console.warn('IntersectionObserver not supported - loading all components immediately');
      this.initialized = true;
      this.loadAllComponents();
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const name = entry.target.getAttribute('data-lazy-component');
            if (name) {
              this.loadComponent(name);
            }
          }
        });
      },
      {
        rootMargin: '200px', // Start loading 200px before element comes into view
        threshold: 0.01
      }
    );

    this.initialized = true;
  }

  /**
   * Register a component for lazy loading
   */
  register(config: LazyComponentConfig): void {
    this.pendingComponents.set(config.name, config);

    const forceLoad = window.location.search.includes('force-load=true');

    // Check if element is already in DOM
    const element = document.querySelector(config.selector);
    if (element) {
      // Always mark the element with its component name for identification
      element.setAttribute('data-lazy-component', config.name);
      
      if (config.priority === 'high' || forceLoad) {
        // High priority components load immediately
        this.loadComponent(config.name);
      } else if (this.observer) {
        // Observe for intersection
        this.observer.observe(element);
      }
    }
  }

  /**
   * Load a specific component
   */
  async loadComponent(name: string): Promise<void> {
    if (this.loadedComponents.has(name) || this.loadingPromises.has(name)) {
      return this.loadingPromises.get(name) || Promise.resolve();
    }

    // Check if this component has exceeded its retry limit
    const failures = this.failureCounts.get(name) || 0;
    if (failures >= MAX_LOAD_RETRIES) {
      if (import.meta.env.DEV) console.warn(`Component ${name} permanently failed after ${failures} attempts`);
      return;
    }

    const config = this.pendingComponents.get(name);
    if (!config) {
      if (import.meta.env.DEV) console.warn(`Component ${name} not registered for lazy loading`);
      return;
    }

    const loadPromise = this.performLoad(config);
    this.loadingPromises.set(name, loadPromise);

    try {
      await loadPromise;
      // Reset failure count on success
      this.failureCounts.delete(name);
    } catch (error) {
      if (import.meta.env.DEV) console.error(`Failed to load component ${name}:`, error);
      this.loadingPromises.delete(name);
      // Track failure count to prevent infinite retries
      this.failureCounts.set(name, failures + 1);
      if (failures + 1 >= MAX_LOAD_RETRIES) {
        // Remove from pending so it won't be retried via loadAllComponents
        this.pendingComponents.delete(name);
        if (import.meta.env.DEV) console.warn(`Component ${name} removed after ${failures + 1} failed attempts`);
      }
    }
  }

  /**
   * Perform the actual component loading
   */
  private async performLoad(config: LazyComponentConfig): Promise<void> {
    const startTime = performance.now();

    // Load dependencies first
    if (config.dependencies) {
      await Promise.all(
        config.dependencies.map(dep => this.loadComponent(dep))
      );
    }

    // Load the component module
    const module = await config.loader();
    const loadTime = performance.now() - startTime;

    // Mount the component
    const mountStart = performance.now();
    const cleanup = module.mount();
    const mountTime = performance.now() - mountStart;

    // Store the loaded component
    this.loadedComponents.set(config.name, {
      name: config.name,
      cleanup,
      loadTime,
      mountTime
    });

    // Remove from pending and loading
    this.pendingComponents.delete(config.name);
    this.loadingPromises.delete(config.name);

    // Stop observing the element
    const element = document.querySelector(config.selector);
    if (element && this.observer) {
      this.observer.unobserve(element);
    }

    // Component loaded successfully with performance metrics
  }

  /**
   * Load all remaining components (fallback or final load)
   */
  async loadAllComponents(): Promise<void> {
    const pending = Array.from(this.pendingComponents.values());
    await Promise.all(pending.map(config => this.loadComponent(config.name)));
  }

  /**
   * Cleanup all loaded components
   */
  cleanup(): void {
    this.loadedComponents.forEach(component => {
      try {
        component.cleanup();
      } catch (error) {
        if (import.meta.env.DEV) console.error(`Error cleaning up component ${component.name}:`, error);
      }
    });

    this.loadedComponents.clear();
    this.pendingComponents.clear();
    this.loadingPromises.clear();
    this.failureCounts.clear();

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.initialized = false;
  }

  /**
   * Get performance stats for loaded components
   */
  getPerformanceStats(): {
    totalComponents: number;
    totalLoadTime: number;
    totalMountTime: number;
    averageLoadTime: number;
    averageMountTime: number;
  } {
    const components = Array.from(this.loadedComponents.values());
    const totalLoadTime = components.reduce((sum, c) => sum + c.loadTime, 0);
    const totalMountTime = components.reduce((sum, c) => sum + c.mountTime, 0);

    return {
      totalComponents: components.length,
      totalLoadTime,
      totalMountTime,
      averageLoadTime: totalLoadTime / Math.max(components.length, 1),
      averageMountTime: totalMountTime / Math.max(components.length, 1)
    };
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const lazyLoader = new LazyComponentLoader();

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Register and start lazy loading for all components
 */
export function initLazyLoading(): void {
  lazyLoader.init();

  // Register all components for lazy loading
  const componentConfigs: LazyComponentConfig[] = [
    {
      name: 'summary-cards',
      selector: '#total-income',
      loader: async () => {
        const module = await import('../components/summary-cards.js');
        return { mount: () => module.mountSummaryCards() };
      },
      priority: 'high'
    },
    {
      name: 'insights',
      selector: '#insight-1, #insight-2, #insight-3',
      loader: async () => {
        const module = await import('../components/insights.js');
        return { mount: () => module.mountInsights() };
      },
      priority: 'high'
    },
    {
      name: 'budget-gauge',
      selector: '#budget-gauge-section',
      loader: async () => {
        const module = await import('../components/budget-gauge.js');
        return { mount: () => module.mountBudgetGauge() };
      },
      priority: 'high'
    },
    {
      name: 'daily-allowance',
      selector: '#hero-daily-amount',
      loader: async () => {
        const module = await import('../components/daily-allowance.js');
        return { mount: () => module.mountDailyAllowance() };
      },
      priority: 'high'
    },
    {
      name: 'savings-goals',
      selector: '#savings-goals-list',
      loader: async () => {
        const module = await import('../components/savings-goals.js');
        return { mount: () => module.mountSavingsGoals() };
      },
      priority: 'medium'
    },
    {
      name: 'weekly-rollup',
      selector: '#weekly-rollup-section',
      loader: async () => {
        const module = await import('../components/weekly-rollup.js');
        return { mount: () => module.mountWeeklyRollup() };
      },
      priority: 'medium'
    },
    {
      name: 'recurring-breakdown',
      selector: '#recurring-breakdown-section',
      loader: async () => {
        const module = await import('../components/recurring-breakdown.js');
        return { mount: () => module.mountRecurringBreakdown() };
      },
      priority: 'medium'
    },
    {
      name: 'envelope-budget',
      selector: '#envelope-section',
      loader: async () => {
        const module = await import('../components/envelope-budget.js');
        return { mount: () => module.mountEnvelopeBudget() };
      },
      priority: 'high'
    },
    {
      name: 'charts',
      selector: '[data-component="charts"]',
      loader: async () => {
        const module = await import('../components/charts.js');
        return { mount: () => module.mountCharts() };
      },
      priority: 'low'
    },
    {
      name: 'calendar',
      selector: '[data-component="calendar"]',
      loader: async () => {
        const module = await import('../components/calendar.js');
        return { mount: () => module.mountCalendar() };
      },
      priority: 'low'
    },
    {
      name: 'debt-summary',
      selector: '#debt-summary-cards',
      loader: async () => {
        const module = await import('../components/debt-summary.js');
        return { mount: () => module.mountDebtSummary() };
      },
      priority: 'high'
    },
    {
      name: 'debt-list',
      selector: '#debts-list',
      loader: async () => {
        const module = await import('../components/debt-list.js');
        return { mount: () => module.mountDebtList() };
      },
      priority: 'high'
    },
    {
      name: 'badges',
      selector: '#badges-container',
      loader: async () => {
        const module = await import('../features/gamification/achievements.js');
        return { mount: () => module.mountBadges() };
      },
      priority: 'low'
    },
    {
      name: 'filter-panel',
      selector: '#advanced-filters',
      loader: async () => {
        const module = await import('../ui/widgets/filters.js');
        return { mount: () => module.mountFilterPanel() };
      },
      priority: 'high'
    },
    {
      name: 'alert-banner',
      selector: '#alert-banner',
      loader: async () => {
        const module = await import('../features/personalization/alerts.js');
        return { mount: () => module.mountAlertBanner() };
      },
      priority: 'high'
    },
    {
      name: 'onboarding-ui',
      selector: '#onboarding-overlay',
      loader: async () => {
        const module = await import('../features/personalization/onboarding.js');
        return { mount: () => module.mountOnboarding() };
      },
      priority: 'high'
    },
    {
      name: 'split-modal',
      selector: '#split-modal',
      loader: async () => {
        const module = await import('../features/financial/split-transactions.js');
        return { mount: () => module.mountSplitModal() };
      },
      priority: 'high'
    },
    {
      name: 'backup-reminder',
      selector: '#backup-reminder',
      loader: async () => {
        const module = await import('../orchestration/backup-reminder.js');
        return { mount: () => module.mountBackupReminder() };
      },
      priority: 'medium'
    }
  ];

  componentConfigs.forEach(config => lazyLoader.register(config));
}

export function cleanupLazyLoading(): void {
  lazyLoader.cleanup();
}

/**
 * Force load all components (for testing or immediate load)
 */
export function loadAllComponents(): Promise<void> {
  return lazyLoader.loadAllComponents();
}

/**
 * Get component loading performance statistics
 */
export function getLazyLoadingStats(): ReturnType<LazyComponentLoader['getPerformanceStats']> {
  return lazyLoader.getPerformanceStats();
}
