/**
 * DOM Cache Module
 * 
 * High-performance, lightweight caching for frequently accessed DOM elements.
 * Uses WeakRef to prevent memory leaks while avoiding redundant getElementById calls.
 * 
 * @module dom-cache
 */

import type { SafeMockElement } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// = :=========================================

type ElementCache = Map<string, WeakRef<HTMLElement>>;

// ==========================================
// SAFE MOCK SINGLETON
// ==========================================

/**
 * Module-level singleton mock element returned by getSafe() when element is not found.
 * Avoids allocating a new object on every miss.
 */
const SAFE_MOCK: SafeMockElement = {
  value: '',
  checked: false,
  textContent: '',
  innerHTML: '',
  style: new Proxy({} as Record<string, string>, { get: () => '', set: () => true }),
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false
  },
  setAttribute: () => {},
  getAttribute: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  focus: () => {},
  blur: () => {},
  click: () => {},
  scrollIntoView: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  closest: () => null,
  getBoundingClientRect: () => new DOMRect(),
  offsetHeight: 0,
  offsetWidth: 0,
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0
} as unknown as SafeMockElement;

// ==========================================
// DOM CACHE CLASS
// ==========================================

export class DOMCache {
  private cache: ElementCache = new Map();
  private registry: FinalizationRegistry<string>;
  private registered: WeakSet<HTMLElement> = new WeakSet();

  /**
   * Fast-path cache for known static elements that never leave the DOM.
   * These bypass WeakRef overhead and store direct references.
   */
  private staticCache: Map<string, HTMLElement> = new Map();
  private staticIds: Set<string>;

  constructor() {
    // Automatically clean up cache keys when elements are garbage collected
    this.registry = new FinalizationRegistry((id: string) => {
      this.cache.delete(id);
    });

    // Known static element IDs that persist for the app lifetime
    this.staticIds = new Set([
      'app', 'main-content', 'dashboard-view', 'transactions-view',
      'budget-view', 'nav-dashboard', 'nav-transactions', 'nav-budget',
      'month-display', 'summary-cards', 'transaction-list',
      'total-income', 'total-expenses', 'total-balance',
      'budget-gauge', 'daily-allowance', 'spending-pace'
    ]);
  }

  /**
   * Get an element by ID, using cache if available.
   * Static elements use a direct-reference fast path (no WeakRef overhead).
   */
  get<T extends HTMLElement = HTMLElement>(id: string): T | null {
    // Fast path for known static elements
    if (this.staticIds.has(id)) {
      const cached = this.staticCache.get(id);
      if (cached?.isConnected) return cached as T;
      if (cached) this.staticCache.delete(id);

      const element = document.getElementById(id);
      if (element) {
        this.staticCache.set(id, element);
        return element as T;
      }
      return null;
    }

    // Standard WeakRef path for dynamic elements
    const ref = this.cache.get(id);

    if (ref) {
      const element = ref.deref();
      if (element?.isConnected) return element as T;
      this.cache.delete(id);
    }

    // Not in cache or stale, query and store
    const element = document.getElementById(id);
    if (element) {
      this.cache.set(id, new WeakRef(element));
      // Only register once per element to avoid stale finalization callbacks
      if (!this.registered.has(element)) {
        this.registry.register(element, id);
        this.registered.add(element);
      }
      return element as T;
    }

    return null;
  }

  /**
   * Get cached element with null safety (returns mock element if not found)
   * Prevents runtime crashes in non-critical rendering paths.
   */
  getSafe<T extends HTMLElement = HTMLElement>(id: string): T | SafeMockElement {
    const element = this.get<T>(id);
    if (element) return element;

    // Return the module-level singleton mock to avoid allocating a new object each time
    return SAFE_MOCK;
  }

  /**
   * Direct wrapper for querySelector (uncached)
   */
  query<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return document.querySelector<T>(selector);
  }

  /**
   * Direct wrapper for querySelectorAll (uncached)
   */
  queryAll<T extends HTMLElement = HTMLElement>(selector: string): NodeListOf<T> {
    return document.querySelectorAll<T>(selector);
  }

  /**
   * Clear an entry from the cache
   */
  clear(id: string): void {
    this.cache.delete(id);
    this.staticCache.delete(id);
  }

  /**
   * Clear all entries from the cache
   */
  clearAll(): void {
    this.cache.clear();
    this.staticCache.clear();
  }

  /**
   * Legacy support - No-op in new implementation
   */
  init(): void {}
  refresh(): void {}
  refreshAll(): void {
    this.clearAll();
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const DOM = new DOMCache();
export default DOM;
