/**
 * Dependency Injection Container Tests
 * 
 * Tests the DI container's ability to resolve services and handle mocks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  DIContainer, 
  createDefaultContainer, 
  getDefaultContainer, 
  resetDefaultContainer,
  Services 
} from '../js/modules/core/di-container.js';

describe('DI Container', () => {
  let container: DIContainer;

  beforeEach(() => {
    resetDefaultContainer();
    container = new DIContainer();
  });

  afterEach(() => {
    container.clear();
    resetDefaultContainer();
  });

  describe('Service Registration', () => {
    it('should register and resolve a simple service', async () => {
      const testService = { name: 'test' };
      container.register('testService', () => testService);
      
      const resolved = await container.resolve('testService');
      expect(resolved).toBe(testService);
    });

    it('should register and resolve a lazy service', async () => {
      const testService = { name: 'lazy' };
      container.registerLazy('lazyService', async () => testService);
      
      const resolved = await container.resolve('lazyService');
      expect(resolved).toBe(testService);
    });

    it('should register a value directly', async () => {
      const testValue = { value: 42 };
      container.registerValue('testValue', testValue);
      
      const resolved = await container.resolve('testValue');
      expect(resolved).toBe(testValue);
    });

    it('should maintain singleton instances', async () => {
      let callCount = 0;
      container.register('singleton', () => {
        callCount++;
        return { instance: callCount };
      }, { singleton: true });

      const first = await container.resolve('singleton');
      const second = await container.resolve('singleton');

      expect(first).toBe(second);
      expect(callCount).toBe(1);
    });

    it('should throw error for unregistered service', async () => {
      await expect(container.resolve('unknown')).rejects.toThrow("Service 'unknown' not registered");
    });
  });

  describe('Synchronous Resolution', () => {
    it('should resolve synchronously after initialization', async () => {
      const testService = { name: 'sync' };
      container.registerValue('syncService', testService);
      
      await container.initialize();
      
      const resolved = container.resolveSync('syncService');
      expect(resolved).toBe(testService);
    });

    it('should throw if resolving synchronously before initialization', () => {
      container.register('testService', () => ({ name: 'test' }));
      
      expect(() => container.resolveSync('testService'))
        .toThrow('resolved before container initialization');
    });

    it('should pre-initialize lazy singletons during initialization', async () => {
      const lazyService = { name: 'lazy-singleton' };
      container.registerLazy('lazyService', async () => lazyService);
      
      await container.initialize();
      
      // Should be able to resolve synchronously after initialization
      const resolved = container.resolveSync('lazyService');
      expect(resolved).toBe(lazyService);
    });
  });

  describe('Mock Injection', () => {
    it('should allow mock injection for testing', async () => {
      // Create container with real service
      container.register('realService', () => ({ type: 'real' }));
      
      // Override with mock
      const mockService = { type: 'mock', mockMethod: vi.fn() };
      container.registerValue('realService', mockService);
      
      const resolved = await container.resolve<{ type: string; mockMethod: ReturnType<typeof vi.fn> }>('realService');
      expect(resolved).toBe(mockService);
      expect(resolved.type).toBe('mock');
    });

    it('should work with default container', async () => {
      const container = createDefaultContainer();
      
      // Inject mock data SDK
      const mockDataSdk = {
        init: vi.fn().mockResolvedValue({ isOk: true }),
        getAll: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ isOk: true, data: { __backendId: 'test' } })
      };
      
      container.registerValue(Services.DATA_SDK, mockDataSdk);
      
      await container.initialize();
      
      const dataSdk = container.resolveSync(Services.DATA_SDK);
      expect(dataSdk).toBe(mockDataSdk);
    }, 15000);
  });

  describe('Default Container', () => {
    it('should provide singleton default container', () => {
      const first = getDefaultContainer();
      const second = getDefaultContainer();
      
      expect(first).toBe(second);
    });

    it('should reset default container', () => {
      const first = getDefaultContainer();
      resetDefaultContainer();
      const second = getDefaultContainer();
      
      expect(first).not.toBe(second);
    });

    it('should eagerly initialize default services and keep deferred services registered', async () => {
      const container = createDefaultContainer();
      await container.initialize();
      
      // Eager default services are available synchronously after plain initialize()
      expect(() => container.resolveSync(Services.CONFIG)).not.toThrow();
      expect(() => container.resolveSync(Services.VALIDATOR)).not.toThrow();
      expect(() => container.resolveSync(Services.CURRENCY_FORMATTER)).not.toThrow();
      expect(() => container.resolveSync(Services.GET_TODAY_STR)).not.toThrow();

      // Deferred services stay registered for on-demand resolution.
      expect(container.getServiceNames()).toEqual(expect.arrayContaining([
        Services.DATA_SDK,
        Services.EMPTY_STATE,
        Services.RENDER_CATEGORIES,
        Services.SWITCH_TAB
      ]));
      expect(container.isInitialized(Services.DATA_SDK)).toBe(false);
      expect(container.isInitialized(Services.EMPTY_STATE)).toBe(false);
    });
  });

  describe('Module Integration', () => {
    it('should allow modules to pull dependencies without setters', async () => {
      const container = createDefaultContainer();
      
      // Mock currency formatter
      const mockFormatter = vi.fn((value: number) => `TEST$${value}`);
      container.registerValue(Services.CURRENCY_FORMATTER, mockFormatter);
      
      await container.initialize();
      
      // Module can now pull the mock directly
      const formatter = container.resolveSync<(value: number) => string>(Services.CURRENCY_FORMATTER);
      expect(formatter(100)).toBe('TEST$100');
      expect(mockFormatter).toHaveBeenCalledWith(100);
    });

    it('should support configuration access', async () => {
      const container = createDefaultContainer();
      
      // Mock configuration
      const mockConfig = {
        PAGINATION: { PAGE_SIZE: 50 },
        RECURRING_MAX_ENTRIES: 500,
        TIMING: { PIN_ERROR_DISPLAY: 3000 }
      };
      
      container.registerValue(Services.CONFIG, mockConfig);
      await container.initialize();
      
      const config = container.resolveSync<{ PAGINATION: { PAGE_SIZE: number }; RECURRING_MAX_ENTRIES: number; TIMING: { PIN_ERROR_DISPLAY: number } }>(Services.CONFIG);
      expect(config.PAGINATION.PAGE_SIZE).toBe(50);
      expect(config.RECURRING_MAX_ENTRIES).toBe(500);
    });
  });

  describe('Error Handling', () => {
    it('should handle factory errors gracefully', async () => {
      container.register('errorService', () => {
        throw new Error('Factory error');
      });
      
      await expect(container.resolve('errorService')).rejects.toThrow('Factory error');
    });

    it('should handle async factory errors', async () => {
      container.registerLazy('asyncErrorService', async () => {
        throw new Error('Async factory error');
      });
      
      await expect(container.resolve('asyncErrorService')).rejects.toThrow('Async factory error');
    });
  });
});

describe('Transactions Module with DI', () => {
  beforeEach(() => {
    resetDefaultContainer();
  });

  afterEach(() => {
    resetDefaultContainer();
  });

  it('should use currency formatter from DI container', async () => {
    const container = createDefaultContainer();
    
    // Mock formatter
    const mockFormatter = (value: number) => `£${value.toFixed(2)}`;
    container.registerValue(Services.CURRENCY_FORMATTER, mockFormatter);
    
    await container.initialize();
    
    // Import transactions module (which should pull from DI)
    // Note: This would need actual module testing in practice
    const formatter = container.resolveSync<(value: number) => string>(Services.CURRENCY_FORMATTER);
    expect(formatter(99.99)).toBe('£99.99');
  });

  it('should use configuration from DI container', async () => {
    const container = createDefaultContainer();
    
    const mockConfig = {
      PAGINATION: { PAGE_SIZE: 100 },
      RECURRING_MAX_ENTRIES: 1000
    };
    
    container.registerValue(Services.CONFIG, mockConfig);
    await container.initialize();
    
    const config = container.resolveSync<{ PAGINATION: { PAGE_SIZE: number }; RECURRING_MAX_ENTRIES: number }>(Services.CONFIG);
    expect(config.PAGINATION.PAGE_SIZE).toBe(100);
  });
});
