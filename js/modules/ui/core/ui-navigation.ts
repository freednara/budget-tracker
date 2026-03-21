/**
 * UI Navigation Module
 * Handles tab switching, month navigation, and swipe gestures
 *
 * @module ui-navigation
 * @requires state
 * @requires event-bus
 * @requires dom-cache
 * @requires utils
 */
'use strict';

import { lsSet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { navigation, form } from '../../core/state-actions.js';
import { emit, Events } from '../../core/event-bus.js';
import DOM from '../../core/dom-cache.js';
import { parseMonthKey, getMonthKey } from '../../core/utils.js';
import { CONFIG } from '../../core/config.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TransactionType = 'expense' | 'income';
type MainTab = 'dashboard' | 'transactions' | 'budget';

// ==========================================
// DEPENDENCY INJECTION
// ==========================================

import { getDefaultContainer, Services } from '../../core/di-container.js';

/**
 * Get render categories function from DI container
 */
function getRenderCategories(): () => void {
  try {
    return getDefaultContainer().resolveSync<() => void>(Services.RENDER_CATEGORIES);
  } catch {
    return () => {};
  }
}

/**
 * Get update charts function from DI container
 */
function getUpdateCharts(): () => void {
  try {
    return getDefaultContainer().resolveSync<() => void>(Services.UPDATE_CHARTS);
  } catch {
    return () => {};
  }
}

// Module state for quick shortcuts (not yet in DI)
let renderQuickShortcutsFn: () => void = () => {};

/**
 * Set the quick shortcuts render function
 */
export function setRenderQuickShortcutsFn(fn: () => void): void {
  renderQuickShortcutsFn = fn;
}

// Swipe thresholds from centralized config (single source of truth)
const { SWIPE_THRESHOLD, VERTICAL_THRESHOLD } = CONFIG.GESTURES;

// Guard to prevent duplicate swipe listener attachment
let _swipeListenersAttached = false;
let _shellNavigationInitialized = false;
let _navigationListenersInitialized = false;

// Stored handler references for cleanup
let _swipeTouchStartHandler: ((e: TouchEvent) => void) | null = null;
let _swipeTouchEndHandler: ((e: TouchEvent) => void) | null = null;
let _swipeTarget: Element | null = null;
let _shellMetricsBound = false;
let _shellResizeObserver: ResizeObserver | null = null;
let _shellResizeHandler: (() => void) | null = null;
let _transactionsLayoutBound = false;
let _transactionsLayoutResizeObserver: ResizeObserver | null = null;
let _transactionsLayoutMutationObserver: MutationObserver | null = null;
let _transactionsLayoutRaf = 0;

function resetTransactionsEntryViewport(): void {
  const entryBody = document.querySelector('.transactions-entry-body');
  if (entryBody instanceof HTMLElement) {
    entryBody.scrollTop = 0;
  }
}

function scheduleTransactionsEntryLayoutSync(): void {
  if (_transactionsLayoutRaf) {
    cancelAnimationFrame(_transactionsLayoutRaf);
  }
  _transactionsLayoutRaf = requestAnimationFrame(() => {
    _transactionsLayoutRaf = 0;
    syncTransactionsEntryLayout();
  });
}

function syncTransactionsEntryLayout(): void {
  const formSection = DOM.get('form-section');
  const entryBody = document.querySelector('.transactions-entry-body');
  if (!(formSection instanceof HTMLElement) || !(entryBody instanceof HTMLElement)) return;

  const isDesktop = window.matchMedia('(min-width: 1280px)').matches;
  const isVisible = getComputedStyle(formSection).display !== 'none' && formSection.offsetParent !== null;

  if (!isDesktop || !isVisible) {
    formSection.classList.remove('transactions-entry-card--overflowing');
    entryBody.scrollTop = 0;
    return;
  }

  const stickyTop = parseFloat(window.getComputedStyle(formSection).top) || 0;
  const availableHeight = Math.max(0, window.innerHeight - stickyTop - 14);
  formSection.classList.remove('transactions-entry-card--overflowing');

  const isOverflowing = formSection.scrollHeight > availableHeight + 2;
  formSection.classList.toggle('transactions-entry-card--overflowing', isOverflowing);

  if (!isOverflowing) {
    entryBody.scrollTop = 0;
  }
}

function syncAppShellMetrics(): void {
  const root = document.documentElement;
  const appShell = document.querySelector('header.app-shell');
  if (!(appShell instanceof HTMLElement)) return;

  const shellHeight = Math.ceil(appShell.getBoundingClientRect().height);
  root.style.setProperty('--app-shell-stack-height', `${shellHeight}px`);
  scheduleTransactionsEntryLayoutSync();
}

function bindAppShellMetrics(): void {
  if (_shellMetricsBound) return;
  _shellMetricsBound = true;

  syncAppShellMetrics();
  requestAnimationFrame(() => syncAppShellMetrics());

  _shellResizeHandler = () => syncAppShellMetrics();
  window.addEventListener('resize', _shellResizeHandler, { passive: true });

  const appShell = document.querySelector('header.app-shell');
  if (appShell instanceof HTMLElement && typeof ResizeObserver !== 'undefined') {
    _shellResizeObserver = new ResizeObserver(() => syncAppShellMetrics());
    _shellResizeObserver.observe(appShell);
  }
}

function bindTransactionsEntryLayout(): void {
  if (_transactionsLayoutBound) return;
  _transactionsLayoutBound = true;

  const formSection = DOM.get('form-section');
  const recurringSection = DOM.get('recurring-section');
  const detailsEl = DOM.get('transaction-details');

  if (formSection instanceof HTMLElement) {
    if (typeof ResizeObserver !== 'undefined') {
      _transactionsLayoutResizeObserver = new ResizeObserver(() => scheduleTransactionsEntryLayoutSync());
      _transactionsLayoutResizeObserver.observe(formSection);
      if (recurringSection instanceof HTMLElement) {
        _transactionsLayoutResizeObserver.observe(recurringSection);
      }
    }

    _transactionsLayoutMutationObserver = new MutationObserver(() => scheduleTransactionsEntryLayoutSync());
    _transactionsLayoutMutationObserver.observe(formSection, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'class', 'style', 'hidden']
    });
  }

  if (detailsEl instanceof HTMLDetailsElement) {
    detailsEl.addEventListener('toggle', scheduleTransactionsEntryLayoutSync);
  }

  window.addEventListener('resize', scheduleTransactionsEntryLayoutSync, { passive: true });
  scheduleTransactionsEntryLayoutSync();
}

function alignTransactionsViewport(): void {
  revealTransactionsForm();
}

export function revealTransactionsForm(focusId?: string, selectInput = false): void {
  syncAppShellMetrics();

  const formSection = DOM.get('form-section');
  if (!(formSection instanceof HTMLElement)) return;

  const stickyTop = parseFloat(window.getComputedStyle(formSection).top) || 0;
  const targetTop = Math.max(
    0,
    formSection.getBoundingClientRect().top + window.scrollY - stickyTop
  );

  window.scrollTo({
    top: targetTop,
    behavior: 'instant' as ScrollBehavior
  });

  requestAnimationFrame(() => {
    resetTransactionsEntryViewport();
    scheduleTransactionsEntryLayoutSync();
  });

  if (focusId) {
    requestAnimationFrame(() => {
      const focusTarget = DOM.get(focusId);
      if (!(focusTarget instanceof HTMLElement)) return;
      focusTarget.focus();
      if (selectInput && focusTarget instanceof HTMLInputElement) {
        focusTarget.select();
      }
    });
  }
}

// ==========================================
// TAB SWITCHING
// ==========================================

/**
 * Sync the expense/income tab DOM state without mutating signals.
 */
function syncTransactionTabDOM(type: TransactionType): void {
  const te = DOM.get('tab-expense');
  const ti = DOM.get('tab-income');
  if (te && ti) {
    te.classList.toggle('btn-danger', type === 'expense');
    te.classList.toggle('btn-secondary', type !== 'expense');
    ti.classList.toggle('btn-success', type === 'income');
    ti.classList.toggle('btn-secondary', type !== 'income');
  }
}

/**
 * Switch between expense/income tabs.
 * Signal is set first (source of truth), then DOM is synced.
 */
export function switchTab(type: TransactionType): void {
  // Signal is the source of truth
  navigation.setCurrentTab(type);
  if (!signals.editingId.value) form.clearSelectedCategory();

  syncTransactionTabDOM(type);
  getRenderCategories()();
  renderQuickShortcutsFn();
}

/**
 * Switch between main navigation tabs (dashboard/transactions/budget)
 * Sets the signal first (source of truth), then updates DOM to match.
 */
export function switchMainTab(tabName: MainTab): void {
  // Signal is the source of truth - set it first
  navigation.setActiveMainTab(tabName);
  lsSet('budget_tracker_active_tab', tabName);

  // Sync DOM to match signal state
  syncMainTabDOM(tabName);

  if (tabName === 'dashboard') {
    try { getUpdateCharts()(); } catch(e) { if (import.meta.env.DEV) console.error('Chart update failed:', e); }
  }
  if (tabName === 'transactions') {
    requestAnimationFrame(() => {
      revealTransactionsForm();
    });
  }
}

/**
 * Sync main tab DOM state to match a given tab name.
 * Extracted so it can be called from a signal effect if needed.
 */
function syncMainTabDOM(tabName: MainTab): void {
  const tabs: MainTab[] = ['dashboard', 'transactions', 'budget'];

  for (const t of tabs) {
    const el = DOM.get('tab-' + t);
    if (el) {
      const isVisible = t === tabName;
      el.style.display = isVisible ? 'block' : 'none';
      el.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
      if (isVisible) el.setAttribute('tabindex', '0');
      else el.removeAttribute('tabindex');
    }
  }

  document.querySelectorAll('.main-tab').forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === tabName;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('btn-secondary', !isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

// ==========================================
// MONTH NAVIGATION
// ==========================================

/**
 * Navigate to previous month
 */
export function goToPrevMonth(): void {
  navigation.prevMonth();
}

/**
 * Navigate to next month
 */
export function goToNextMonth(): void {
  navigation.nextMonth();
}

/**
 * Set up month navigation button listeners
 */
export function setupMonthNavigation(): void {
  const prevBtn = DOM.get('prev-month');
  const nextBtn = DOM.get('next-month');

  if (prevBtn) prevBtn.addEventListener('click', goToPrevMonth);
  if (nextBtn) nextBtn.addEventListener('click', goToNextMonth);
}

// ==========================================
// SWIPE GESTURES
// ==========================================

/**
 * Set up touch swipe gestures for month navigation
 */
export function setupSwipeGestures(): void {
  if (_swipeListenersAttached) return;

  let touchStartX = 0;
  let touchStartY = 0;

  const mainContent = document.querySelector('main');
  if (!mainContent) return;

  _swipeListenersAttached = true;
  _swipeTarget = mainContent;

  let touchStartTarget: EventTarget | null = null;

  _swipeTouchStartHandler = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTarget = e.target;
  };

  _swipeTouchEndHandler = (e: TouchEvent) => {
    // Skip month navigation if the swipe started inside a transaction row swipe container
    // to prevent conflicts with row-level swipe actions
    if (touchStartTarget instanceof HTMLElement && touchStartTarget.closest('.swipe-container, .swipe-content, .transaction-row')) {
      return;
    }

    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const diffX = touchEndX - touchStartX;
    const diffY = Math.abs(touchEndY - touchStartY);

    if (Math.abs(diffX) > SWIPE_THRESHOLD && diffY < VERTICAL_THRESHOLD) {
      if (diffX > 0) {
        goToPrevMonth();
      } else {
        goToNextMonth();
      }
    }
  };

  mainContent.addEventListener('touchstart', _swipeTouchStartHandler, { passive: true });
  mainContent.addEventListener('touchend', _swipeTouchEndHandler, { passive: true });
}

/**
 * Remove swipe gesture listeners and reset state
 */
export function cleanupSwipeGestures(): void {
  if (_swipeTarget && _swipeTouchStartHandler && _swipeTouchEndHandler) {
    _swipeTarget.removeEventListener('touchstart', _swipeTouchStartHandler as EventListener);
    _swipeTarget.removeEventListener('touchend', _swipeTouchEndHandler as EventListener);
  }
  _swipeTouchStartHandler = null;
  _swipeTouchEndHandler = null;
  _swipeTarget = null;
  _swipeListenersAttached = false;
}

// ==========================================
// MAIN TAB EVENT SETUP
// ==========================================

/**
 * Set up main tab button listeners
 */
export function setupMainTabListeners(): void {
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab') as MainTab | null;
      if (tab) switchMainTab(tab);
    });
  });
}

// ==========================================
// EXPENSE/INCOME TAB SETUP
// ==========================================

/**
 * Set up expense/income tab listeners
 */
export function setupExpenseIncomeTabs(): void {
  const tabExpense = DOM.get('tab-expense');
  const tabIncome = DOM.get('tab-income');

  if (tabExpense) tabExpense.addEventListener('click', () => switchTab('expense'));
  if (tabIncome) tabIncome.addEventListener('click', () => switchTab('income'));
}

/**
 * Initialize the shell navigation that users see immediately.
 * This must be ready before heavier DI/data startup completes.
 */
export function initShellNavigation(): void {
  if (_shellNavigationInitialized) return;
  _shellNavigationInitialized = true;

  bindAppShellMetrics();
  bindTransactionsEntryLayout();
  setupExpenseIncomeTabs();
  setupMonthNavigation();
  setupMainTabListeners();

  syncMainTabDOM(signals.activeMainTab.value);
  syncTransactionTabDOM(signals.currentTab.value);
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize all navigation event listeners
 */
export function init(): void {
  if (_navigationListenersInitialized) return;
  _navigationListenersInitialized = true;

  initShellNavigation();
  setupSwipeGestures();
}
