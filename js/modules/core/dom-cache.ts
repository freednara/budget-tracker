/**
 * DOM Cache Module
 * Caches frequently accessed DOM elements to improve performance
 */

import type { SafeMockElement } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface FilterValuesResult {
  showAll: boolean;
  type: string;
  category: string;
  search: string;
  tags: string;
  fromDate: string;
  toDate: string;
  recurring: boolean;
  unreconciled: boolean;
  minAmount: number;
  maxAmount: number;
  sort: string;
}

interface FormValuesResult {
  amount: string;
  description: string;
  date: string;
  tags: string;
  notes: string;
  recurring: boolean;
  recurringType: string;
  recurringEnd: string;
}

type ElementCache = Record<string, HTMLElement | null>;
type ElementUpdateFn = (element: HTMLElement) => void;

// ==========================================
// DOM CACHE CLASS
// ==========================================

class DOMCache {
  private cache: ElementCache;
  private initialized: boolean;

  constructor() {
    this.cache = {};
    this.initialized = false;
  }

  /**
   * Initialize DOM cache after document is ready
   */
  init(): void {
    if (this.initialized) return;

    // Transaction elements
    this.cache.transactionList = document.getElementById('transactions-list');
    this.cache.txShowAllMonths = document.getElementById('tx-show-all-months');
    this.cache.filterType = document.getElementById('filter-type');
    this.cache.filterCategory = document.getElementById('filter-category');
    this.cache.searchText = document.getElementById('search-text');
    this.cache.filterTags = document.getElementById('filter-tags');
    this.cache.filterFrom = document.getElementById('filter-from');
    this.cache.filterTo = document.getElementById('filter-to');
    this.cache.filterRecurring = document.getElementById('filter-recurring');
    this.cache.filterUnreconciled = document.getElementById('filter-unreconciled');
    this.cache.filterMinAmt = document.getElementById('filter-min-amt');
    this.cache.filterMaxAmt = document.getElementById('filter-max-amt');
    this.cache.txSort = document.getElementById('tx-sort');
    this.cache.activeFilterCount = document.getElementById('active-filter-count');
    this.cache.clearFiltersBtn = document.getElementById('clear-filters-btn');

    // Dashboard hero elements (actual IDs from HTML)
    this.cache.heroDailyAmount = document.getElementById('hero-daily-amount');
    this.cache.heroLeftToSpend = document.getElementById('hero-left-to-spend');
    this.cache.heroTodaySpent = document.getElementById('hero-today-spent');
    this.cache.heroMotivation = document.getElementById('hero-motivation');

    // Form elements (corrected IDs to match actual HTML)
    this.cache.txForm = document.getElementById('transaction-form');
    this.cache.txAmount = document.getElementById('amount');
    this.cache.txDescription = document.getElementById('description');
    this.cache.txDate = document.getElementById('date');
    this.cache.txTags = document.getElementById('tags');
    this.cache.txNotes = document.getElementById('tx-notes');
    this.cache.recurringToggle = document.getElementById('recurring-toggle');
    this.cache.recurringType = document.getElementById('recurring-type');
    this.cache.recurringEnd = document.getElementById('recurring-end');
    this.cache.recurringPreview = document.getElementById('recurring-preview');
    this.cache.recurringPreviewText = document.getElementById('recurring-preview-text');
    this.cache.recurringPreviewWarning = document.getElementById('recurring-preview-warning');

    // Modal elements (specific modal IDs that exist in HTML)
    this.cache.deleteModal = document.getElementById('delete-modal');
    this.cache.pinModal = document.getElementById('pin-modal');
    this.cache.settingsModal = document.getElementById('settings-modal');
    this.cache.analyticsModal = document.getElementById('analytics-modal');

    // Alert elements
    this.cache.alertBanner = document.getElementById('alert-banner');
    this.cache.alertText = document.getElementById('alert-text');

    // Tab elements (corrected IDs to match actual HTML)
    this.cache.dashboardTab = document.getElementById('tab-dashboard');
    this.cache.transactionsTab = document.getElementById('tab-transactions');
    this.cache.budgetTab = document.getElementById('tab-budget');

    this.initialized = true;
  }

  /**
   * Get cached element or query if not cached
   */
  get(id: string): HTMLElement | null {
    if (!this.cache[id]) {
      this.cache[id] = document.getElementById(id);
    }
    return this.cache[id];
  }

  /**
   * Get cached element with null safety (returns mock element if not found)
   */
  getSafe(id: string): HTMLElement | SafeMockElement {
    const element = this.get(id);
    if (element) return element;

    // Return a safe mock element that won't crash on property access
    return {
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
    };
  }

  /**
   * Get cached element by selector (not cached, direct query)
   */
  query<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return document.querySelector<T>(selector);
  }

  /**
   * Get all elements by selector (not cached, direct query)
   */
  queryAll<T extends HTMLElement = HTMLElement>(selector: string): NodeListOf<T> {
    return document.querySelectorAll<T>(selector);
  }

  /**
   * Clear specific cached element
   */
  clear(id: string): void {
    delete this.cache[id];
  }

  /**
   * Clear all cached elements
   */
  clearAll(): void {
    this.cache = {};
    this.initialized = false;
  }

  /**
   * Refresh cache for dynamically created elements
   */
  refresh(...ids: string[]): void {
    ids.forEach(id => {
      this.cache[id] = document.getElementById(id);
    });
  }

  /**
   * Get filter values from cached elements
   */
  getFilterValues(): FilterValuesResult {
    const txShowAllMonths = this.cache.txShowAllMonths as HTMLInputElement | null;
    const filterType = this.cache.filterType as HTMLSelectElement | null;
    const filterCategory = this.cache.filterCategory as HTMLSelectElement | null;
    const searchText = this.cache.searchText as HTMLInputElement | null;
    const filterTags = this.cache.filterTags as HTMLInputElement | null;
    const filterFrom = this.cache.filterFrom as HTMLInputElement | null;
    const filterTo = this.cache.filterTo as HTMLInputElement | null;
    const filterRecurring = this.cache.filterRecurring as HTMLInputElement | null;
    const filterUnreconciled = this.cache.filterUnreconciled as HTMLInputElement | null;
    const filterMinAmt = this.cache.filterMinAmt as HTMLInputElement | null;
    const filterMaxAmt = this.cache.filterMaxAmt as HTMLInputElement | null;
    const txSort = this.cache.txSort as HTMLSelectElement | null;

    return {
      showAll: txShowAllMonths?.checked || false,
      type: filterType?.value || 'all',
      category: filterCategory?.value || '',
      search: searchText?.value?.toLowerCase() || '',
      tags: filterTags?.value?.toLowerCase() || '',
      fromDate: filterFrom?.value || '',
      toDate: filterTo?.value || '',
      recurring: filterRecurring?.checked || false,
      unreconciled: filterUnreconciled?.checked || false,
      minAmount: parseFloat(filterMinAmt?.value || '') || 0,
      maxAmount: parseFloat(filterMaxAmt?.value || '') || 0,
      sort: txSort?.value || 'date-desc'
    };
  }

  /**
   * Get transaction form values from cached elements
   */
  getFormValues(): FormValuesResult {
    const txAmount = this.cache.txAmount as HTMLInputElement | null;
    const txDescription = this.cache.txDescription as HTMLInputElement | null;
    const txDate = this.cache.txDate as HTMLInputElement | null;
    const txTags = this.cache.txTags as HTMLInputElement | null;
    const txNotes = this.cache.txNotes as HTMLTextAreaElement | null;
    const recurringToggle = this.cache.recurringToggle as HTMLInputElement | null;
    const recurringType = this.cache.recurringType as HTMLSelectElement | null;
    const recurringEnd = this.cache.recurringEnd as HTMLInputElement | null;

    return {
      amount: txAmount?.value || '',
      description: txDescription?.value || '',
      date: txDate?.value || '',
      tags: txTags?.value || '',
      notes: txNotes?.value || '',
      recurring: recurringToggle?.checked || false,
      recurringType: recurringType?.value || 'monthly',
      recurringEnd: recurringEnd?.value || ''
    };
  }

  /**
   * Batch update multiple elements efficiently
   */
  batchUpdate(updates: Record<string, ElementUpdateFn>): void {
    requestAnimationFrame(() => {
      Object.entries(updates).forEach(([id, updateFn]) => {
        const element = this.cache[id] || this.get(id);
        if (element && typeof updateFn === 'function') {
          updateFn(element);
        }
      });
    });
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

// Create and export singleton instance
const DOM = new DOMCache();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => DOM.init());
} else {
  DOM.init();
}

export default DOM;
export { DOM };
