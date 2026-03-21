/**
 * Enhanced Dependency Injection Container
 * 
 * Production-grade DI container with:
 * - Race condition prevention
 * - Circular dependency detection
 * - Automatic dependency injection
 * - Comprehensive error handling and debugging
 */

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ServiceMetadata {
  name: string;
  dependencies?: string[];
  singleton?: boolean;
  lazy?: boolean;
  priority?: number; // For initialization ordering
}

export interface ServiceRegistration<T = any> {
  factory: (...deps: any[]) => T | Promise<T>;
  metadata: ServiceMetadata;
  instance?: T;
  initializationPromise?: Promise<T>; // Prevents re-entrant initialization
}

export type ServiceInitializer = (container: DIContainer) => void | Promise<void>;

export interface DependencyResolutionContext {
  resolutionStack: string[];
  startTime: number;
  visited: Set<string>;
}

export interface ServiceStats {
  name: string;
  initialized: boolean;
  initializationTime?: number;
  dependencies: string[];
  dependents: string[];
}

// ==========================================
// ERRORS
// ==========================================

export class DIContainerError extends Error {
  constructor(message: string, public serviceName?: string, public resolutionStack?: string[]) {
    super(message);
    this.name = 'DIContainerError';
  }
}

export class CircularDependencyError extends DIContainerError {
  constructor(serviceName: string, resolutionStack: string[]) {
    const cycle = [...resolutionStack, serviceName].join(' → ');
    super(`Circular dependency detected: ${cycle}`, serviceName, resolutionStack);
    this.name = 'CircularDependencyError';
  }
}

// ==========================================
// ENHANCED DI CONTAINER
// ==========================================

export class DIContainer {
  private services = new Map<string, ServiceRegistration>();
  private initializers: ServiceInitializer[] = [];
  private initialized = false;
  
  // Enhanced tracking for debugging and performance
  private dependencyGraph = new Map<string, Set<string>>();
  private initializationStats = new Map<string, ServiceStats>();
  private globalResolutionDepth = 0;
  
  // Configuration
  private maxResolutionDepth = 50;
  private resolutionTimeoutMs = 30000; // 30 seconds

  /**
   * Register a service with enhanced metadata and dependency tracking
   */
  register<T>(
    name: string, 
    factory: (...deps: any[]) => T | Promise<T>, 
    metadata?: Partial<ServiceMetadata>
  ): this {
    const serviceMetadata: ServiceMetadata = {
      name,
      singleton: true,
      lazy: true,
      dependencies: [],
      priority: 0,
      ...metadata
    };

    this.services.set(name, {
      factory,
      metadata: serviceMetadata
    });

    // Build dependency graph
    this.updateDependencyGraph(name, serviceMetadata.dependencies || []);
    
    // Initialize stats tracking
    this.initializationStats.set(name, {
      name,
      initialized: false,
      dependencies: serviceMetadata.dependencies || [],
      dependents: []
    });

    return this;
  }

  /**
   * Update the dependency graph for circular dependency detection
   */
  private updateDependencyGraph(serviceName: string, dependencies: string[]): void {
    this.dependencyGraph.set(serviceName, new Set(dependencies));
    
    // Update dependent tracking
    for (const dep of dependencies) {
      if (!this.initializationStats.has(dep)) {
        this.initializationStats.set(dep, {
          name: dep,
          initialized: false,
          dependencies: [],
          dependents: []
        });
      }
      
      const depStats = this.initializationStats.get(dep)!;
      if (!depStats.dependents.includes(serviceName)) {
        depStats.dependents.push(serviceName);
      }
    }
  }

  /**
   * Register a lazy service factory
   */
  registerLazy<T>(name: string, loader: () => Promise<T>, dependencies: string[] = []): this {
    return this.register(name, async (...deps) => {
      const instance = await loader();
      return instance;
    }, { 
      lazy: true, 
      singleton: true, 
      dependencies 
    });
  }

  /**
   * Register an initializer function to run after all services are registered
   */
  registerInitializer(initializer: ServiceInitializer): this {
    this.initializers.push(initializer);
    return this;
  }

  /**
   * Resolve a service by name with race condition prevention and circular dependency detection
   */
  async resolve<T>(name: string, context?: DependencyResolutionContext): Promise<T> {
    const registration = this.services.get(name);
    
    if (!registration) {
      throw new DIContainerError(`Service '${name}' not registered`, name);
    }

    // Create resolution context if this is the top-level call
    if (!context) {
      context = {
        resolutionStack: [],
        startTime: Date.now(),
        visited: new Set()
      };
    }

    // Check for circular dependencies
    if (context.visited.has(name)) {
      throw new CircularDependencyError(name, context.resolutionStack);
    }

    // Check resolution timeout
    if (Date.now() - context.startTime > this.resolutionTimeoutMs) {
      throw new DIContainerError(
        `Service resolution timeout (${this.resolutionTimeoutMs}ms) for '${name}'`,
        name,
        context.resolutionStack
      );
    }

    // Check maximum resolution depth
    if (context.resolutionStack.length > this.maxResolutionDepth) {
      throw new DIContainerError(
        `Maximum resolution depth (${this.maxResolutionDepth}) exceeded for '${name}'`,
        name,
        context.resolutionStack
      );
    }

    // Return existing instance if singleton
    if (registration.metadata.singleton && registration.instance) {
      return registration.instance;
    }

    // Return existing initialization promise to prevent race conditions
    if (registration.initializationPromise) {
      return registration.initializationPromise as Promise<T>;
    }

    // Start resolution tracking
    context.visited.add(name);
    context.resolutionStack.push(name);

    try {
      const initStartTime = Date.now();

      // Create initialization promise to prevent re-entrant calls
      const initializationPromise = this.resolveWithDependencies<T>(name, registration, context);
      
      if (registration.metadata.singleton) {
        registration.initializationPromise = initializationPromise;
      }

      let instance: T;
      try {
        instance = await initializationPromise;
      } catch (err) {
        // Clean up cached promise so the service can be retried on next resolve()
        if (registration.metadata.singleton) {
          delete registration.initializationPromise;
        }
        throw err;
      }

      // Store if singleton
      if (registration.metadata.singleton) {
        registration.instance = instance;
        delete registration.initializationPromise; // Clean up promise
      }

      // Update stats
      const stats = this.initializationStats.get(name);
      if (stats) {
        stats.initialized = true;
        stats.initializationTime = Date.now() - initStartTime;
      }

      return instance;

    } finally {
      // Clean up resolution tracking
      context.visited.delete(name);
      context.resolutionStack.pop();
    }
  }

  /**
   * Resolve service with automatic dependency injection
   */
  private async resolveWithDependencies<T>(
    name: string,
    registration: ServiceRegistration<T>,
    context: DependencyResolutionContext
  ): Promise<T> {
    const dependencies = registration.metadata.dependencies || [];
    
    if (dependencies.length === 0) {
      // No dependencies - call factory directly
      return await registration.factory();
    }

    // Resolve all dependencies first
    const resolvedDependencies: any[] = [];
    
    for (const depName of dependencies) {
      try {
        const dependency = await this.resolve(depName, context);
        resolvedDependencies.push(dependency);
      } catch (error) {
        if (error instanceof DIContainerError) {
          throw error; // Re-throw DI errors as-is
        }
        throw new DIContainerError(
          `Failed to resolve dependency '${depName}' for service '${name}': ${(error as Error).message}`,
          name,
          context.resolutionStack
        );
      }
    }

    // Call factory with resolved dependencies
    try {
      return await registration.factory(...resolvedDependencies);
    } catch (error) {
      throw new DIContainerError(
        `Failed to instantiate service '${name}': ${(error as Error).message}`,
        name,
        context.resolutionStack
      );
    }
  }

  /**
   * Resolve a service synchronously with enhanced error handling
   * Provides better guidance on async patterns
   */
  resolveSync<T>(name: string): T {
    const registration = this.services.get(name);
    
    if (!registration) {
      throw new DIContainerError(`Service '${name}' not registered`, name);
    }
    
    if (!registration.instance) {
      const stats = this.initializationStats.get(name);
      const isInitialized = stats?.initialized || false;
      
      if (!this.initialized) {
        throw new DIContainerError(
          `Service '${name}' resolved before container initialization. ` +
          `Call 'await container.initialize()' first, or use 'await container.resolve("${name}")' for lazy loading.`,
          name
        );
      }
      
      if (!isInitialized) {
        throw new DIContainerError(
          `Service '${name}' not yet initialized. ` +
          `Use 'await container.resolve("${name}")' for automatic initialization.`,
          name
        );
      }
      
      // If we reach here, something went wrong with initialization
      throw new DIContainerError(
        `Service '${name}' initialization completed but instance is missing. This may indicate a factory error.`,
        name
      );
    }
    
    return registration.instance as T;
  }

  /**
   * Initialize all services with dependency-aware ordering
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;

    try {
      if (isDev) console.debug('🚀 Initializing DI Container with dependency resolution...');

      // Get services sorted by priority and dependencies
      const initializationOrder = this.calculateInitializationOrder();
      
      // Group services by dependency depth and resolve each level in parallel
      const depthMap = new Map<number, string[]>();
      const resolved = new Set<string>();

      for (const serviceName of initializationOrder) {
        const registration = this.services.get(serviceName);
        if (!registration?.metadata.lazy || !registration.metadata.singleton) continue;

        // Calculate depth: max depth of dependencies + 1
        const deps = registration.metadata.dependencies || [];
        let depth = 0;
        for (const dep of deps) {
          // Find dep's depth by checking which level it was placed in
          for (const [d, names] of depthMap) {
            if (names.includes(dep)) depth = Math.max(depth, d + 1);
          }
        }
        if (!depthMap.has(depth)) depthMap.set(depth, []);
        depthMap.get(depth)!.push(serviceName);
      }

      // Resolve each depth level in parallel
      const sortedDepths = Array.from(depthMap.keys()).sort((a, b) => a - b);
      for (const depth of sortedDepths) {
        const level = depthMap.get(depth)!;
        await Promise.all(level.map(async (serviceName) => {
          const startTime = Date.now();
          if (isDev) console.debug(`📦 Initializing service: ${serviceName}`);
          try {
            await this.resolve(serviceName);
            if (isDev) {
              const initTime = Date.now() - startTime;
              console.debug(`✅ Service '${serviceName}' initialized in ${initTime}ms`);
            }
          } catch (error) {
            if (isDev) console.error(`Failed to initialize service '${serviceName}':`, error);
            throw error;
          }
        }));
      }

      // Run all initializers
      if (isDev) console.debug('🔧 Running service initializers...');
      for (const initializer of this.initializers) {
        await initializer(this);
      }

      this.initialized = true;
      if (isDev) {
        console.debug('✨ DI Container initialization completed');
        // Log initialization summary
        this.logInitializationSummary();
      }
      
    } catch (error) {
      if (isDev) console.error('DI Container initialization failed:', error);
      throw error;
    }
  }

  /**
   * Calculate optimal service initialization order based on dependencies and priorities
   */
  private calculateInitializationOrder(): string[] {
    const services = Array.from(this.services.keys());
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: string[] = [];

    const visit = (serviceName: string): void => {
      if (visited.has(serviceName)) return;
      
      if (visiting.has(serviceName)) {
        // This should not happen due to our resolve() checks, but be safe
        throw new CircularDependencyError(serviceName, Array.from(visiting));
      }

      visiting.add(serviceName);

      const registration = this.services.get(serviceName);
      const dependencies = registration?.metadata.dependencies || [];

      // Visit all dependencies first
      for (const dep of dependencies) {
        if (this.services.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(serviceName);
      visited.add(serviceName);
      ordered.push(serviceName);
    };

    // Sort services by priority first (higher priority = earlier initialization)
    const prioritizedServices = services.sort((a, b) => {
      const priorityA = this.services.get(a)?.metadata.priority || 0;
      const priorityB = this.services.get(b)?.metadata.priority || 0;
      return priorityB - priorityA;
    });

    // Visit all services in priority order
    for (const serviceName of prioritizedServices) {
      visit(serviceName);
    }

    return ordered;
  }

  /**
   * Clear all services (useful for testing)
   */
  clear(): void {
    this.services.clear();
    this.initializers = [];
    this.initialized = false;
    this.dependencyGraph.clear();
    this.initializationStats.clear();
    this.globalResolutionDepth = 0;
  }

  /**
   * Register a value directly (useful for testing)
   */
  registerValue<T>(name: string, value: T): this {
    this.services.set(name, {
      factory: () => value,
      metadata: {
        name,
        singleton: true,
        lazy: false,
        dependencies: []
      },
      instance: value
    });
    
    this.initializationStats.set(name, {
      name,
      initialized: true,
      dependencies: [],
      dependents: [],
      initializationTime: 0
    });
    
    return this;
  }

  // ==========================================
  // DEBUGGING AND STATISTICS
  // ==========================================

  /**
   * Get detailed statistics about all services
   */
  getServiceStats(): ServiceStats[] {
    return Array.from(this.initializationStats.values());
  }

  /**
   * Get statistics for a specific service
   */
  getServiceStat(name: string): ServiceStats | undefined {
    return this.initializationStats.get(name);
  }

  /**
   * Validate dependency graph for circular dependencies
   */
  validateDependencyGraph(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (serviceName: string, path: string[]): void => {
      if (visited.has(serviceName)) return;
      
      if (visiting.has(serviceName)) {
        throw new CircularDependencyError(serviceName, path);
      }

      visiting.add(serviceName);

      const dependencies = this.dependencyGraph.get(serviceName) || new Set();
      for (const dep of dependencies) {
        visit(dep, [...path, serviceName]);
      }

      visiting.delete(serviceName);
      visited.add(serviceName);
    };

    for (const serviceName of this.dependencyGraph.keys()) {
      visit(serviceName, []);
    }
  }

  /**
   * Get dependency graph as adjacency list
   */
  getDependencyGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    
    for (const [service, deps] of this.dependencyGraph.entries()) {
      graph[service] = Array.from(deps);
    }
    
    return graph;
  }

  /**
   * Log initialization summary for debugging
   */
  private logInitializationSummary(): void {
    const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;
    if (!isDev) return;

    const stats = this.getServiceStats();
    const initialized = stats.filter(s => s.initialized);
    const totalTime = initialized.reduce((sum, s) => sum + (s.initializationTime || 0), 0);

    console.group('📊 DI Container Statistics');
    console.log(`Total Services: ${stats.length}`);
    console.log(`Initialized: ${initialized.length}`);
    console.log(`Total Initialization Time: ${totalTime}ms`);

    if (initialized.length > 0) {
      console.log('🏆 Initialization Times:');
      initialized
        .sort((a, b) => (b.initializationTime || 0) - (a.initializationTime || 0))
        .slice(0, 5)
        .forEach(s => {
          console.log(`  ${s.name}: ${s.initializationTime}ms`);
        });
    }

    console.groupEnd();
  }

  /**
   * Debug a specific service and its dependencies
   */
  debugService(name: string): void {
    const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;
    if (!isDev) return;

    const registration = this.services.get(name);
    const stats = this.initializationStats.get(name);

    if (!registration) {
      if (isDev) console.error(`Service '${name}' not registered`);
      return;
    }

    console.group(`🔍 Service Debug: ${name}`);
    console.log('Registration:', {
      metadata: registration.metadata,
      hasInstance: !!registration.instance,
      hasInitPromise: !!registration.initializationPromise
    });

    if (stats) {
      console.log('Statistics:', stats);
    }

    const dependencies = this.dependencyGraph.get(name);
    if (dependencies && dependencies.size > 0) {
      console.log('Dependencies:', Array.from(dependencies));
    }

    console.groupEnd();
  }

  /**
   * Debug the entire container state
   */
  debugContainer(): void {
    const isDev = typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV;
    if (!isDev) return;

    console.group('🔧 DI Container Debug');
    console.log('Initialized:', this.initialized);
    console.log('Total Services:', this.services.size);
    console.log('Dependency Graph:', this.getDependencyGraph());
    console.log('Service Stats:', this.getServiceStats());
    console.groupEnd();
  }

  /**
   * Check if a service has been initialized
   */
  isInitialized(name: string): boolean {
    const stats = this.initializationStats.get(name);
    return stats?.initialized || false;
  }

  /**
   * Get list of all registered service names
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Check container health and report any issues
   */
  healthCheck(): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for circular dependencies
    try {
      this.validateDependencyGraph();
    } catch (error) {
      if (error instanceof CircularDependencyError) {
        issues.push(`Circular dependency: ${error.message}`);
      }
    }

    // Check for missing dependencies
    for (const [serviceName, registration] of this.services.entries()) {
      for (const dep of registration.metadata.dependencies || []) {
        if (!this.services.has(dep)) {
          issues.push(`Service '${serviceName}' depends on unregistered service '${dep}'`);
        }
      }
    }

    // Check for initialization failures
    for (const [serviceName, stats] of this.initializationStats.entries()) {
      const registration = this.services.get(serviceName);
      if (registration?.metadata.singleton && registration.metadata.lazy && this.initialized && !stats.initialized) {
        issues.push(`Service '${serviceName}' should be initialized but is not`);
      }
    }

    return {
      healthy: issues.length === 0,
      issues
    };
  }
}

// ==========================================
// SERVICE NAMES
// ==========================================

export const Services = {
  // Configuration
  CONFIG: 'config',
  TIMING_CONFIG: 'timingConfig',
  SWIPE_CONFIG: 'swipeConfig',
  CALENDAR_CONFIG: 'calendarConfig',
  PAGINATION_CONFIG: 'paginationConfig',
  PIN_CONFIG: 'pinConfig',
  
  // Core Services  
  VALIDATOR: 'validator',
  DATA_SDK: 'dataSdk',
  SWIPE_MANAGER: 'swipeManager',
  
  // Formatters
  CURRENCY_FORMATTER: 'currencyFormatter',
  GET_TODAY_STR: 'getTodayStr',
  
  // UI Components
  EMPTY_STATE: 'emptyState',
  RENDER_CATEGORIES: 'renderCategories',
  RENDER_TRANSACTIONS: 'renderTransactions',
  
  // Navigation
  SWITCH_TAB: 'switchTab',
  SWITCH_MAIN_TAB: 'switchMainTab',
  UPDATE_CHARTS: 'updateCharts',
  
  // Features
  INSIGHTS_GENERATOR: 'insightsGenerator',
} as const;

// ==========================================
// DEFAULT CONTAINER SETUP
// ==========================================

/**
 * Create and configure the default container with dependency injection
 */
export function createDefaultContainer(): DIContainer {
  const container = new DIContainer();

  // Register core services with proper dependency declarations
  // Note: CONFIG is registered below with priority: 100
  container.registerLazy(Services.VALIDATOR, async () => {
    const { validator } = await import('./validator.js');
    return validator;
  }, [Services.CONFIG]); // Validator depends on config

  container.registerLazy(Services.DATA_SDK, async () => {
    const { dataSdk } = await import('../data/data-manager.js');
    // Data SDK can use config for initialization settings
    return dataSdk;
  }, [Services.CONFIG]); // Data SDK depends on config

  container.registerLazy(Services.SWIPE_MANAGER, async () => {
    const { swipeManager } = await import('../ui/interactions/swipe-manager.js');
    // Swipe manager can use config for gesture settings
    return swipeManager;
  }, [Services.CONFIG]); // Swipe manager depends on config

  // Register formatters with dependencies
  container.registerLazy(Services.CURRENCY_FORMATTER, async () => {
    const { fmtCur } = await import('./utils.js');
    return fmtCur;
  }, [Services.CONFIG]); // Currency formatter may need locale config

  container.registerLazy(Services.GET_TODAY_STR, async () => {
    const { getTodayStr } = await import('./utils.js');
    return getTodayStr;
  }); // No dependencies

  // Register UI components with proper dependencies
  container.registerLazy(Services.EMPTY_STATE, async () => {
    const { emptyState } = await import('../ui/core/empty-state.js');
    return emptyState;
  }); // No dependencies

  container.registerLazy(Services.RENDER_CATEGORIES, async () => {
    const { renderCategories } = await import('../ui/core/ui-render.js');
    return renderCategories;
  }, [Services.CONFIG, Services.CURRENCY_FORMATTER]); // Depends on config and currency formatter

  container.registerLazy(Services.RENDER_TRANSACTIONS, async () => {
    const { renderTransactionsList } = await import('../data/transaction-renderer.js');
    return renderTransactionsList;
  }, [Services.CONFIG, Services.CURRENCY_FORMATTER, Services.VALIDATOR]); // Multiple dependencies

  // Register navigation services with dependencies
  container.registerLazy(Services.SWITCH_TAB, async () => {
    const { switchTab } = await import('../ui/core/ui-navigation.js');
    return switchTab;
  }, [Services.CONFIG]); // May need timing config

  container.registerLazy(Services.SWITCH_MAIN_TAB, async () => {
    const { switchMainTab } = await import('../ui/core/ui-navigation.js');
    return switchMainTab;
  }, [Services.CONFIG]); // May need timing config

  container.registerLazy(Services.INSIGHTS_GENERATOR, async () => {
    const { generateInsights } = await import('../features/personalization/insights.js');
    return generateInsights;
  }, [Services.CONFIG, Services.DATA_SDK]);

  // Register service priority (higher numbers initialize first)
  container.register(Services.CONFIG, async () => {
    const { CONFIG } = await import('./config.js');
    return CONFIG;
  }, { priority: 100, dependencies: [] }); // Highest priority - no dependencies

  // Advanced example: Service with multiple dependencies and custom factory
  container.register('compositeService', async (config: any, validator: any, dataSdk: any) => {
    // Factory receives resolved dependencies as parameters
    return {
      config,
      validator,
      dataSdk,
      initialized: Date.now()
    };
  }, {
    dependencies: [Services.CONFIG, Services.VALIDATOR, Services.DATA_SDK],
    singleton: true,
    lazy: true
  });

  return container;
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let defaultContainer: DIContainer | null = null;

/**
 * Get the default container instance
 */
export function getDefaultContainer(): DIContainer {
  if (!defaultContainer) {
    defaultContainer = createDefaultContainer();
  }
  return defaultContainer;
}

/**
 * Reset the default container (useful for testing)
 */
export function resetDefaultContainer(): void {
  if (defaultContainer) {
    defaultContainer.clear();
    defaultContainer = null;
  }
}