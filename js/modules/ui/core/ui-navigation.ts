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

import { effect } from '@preact/signals-core';
import { lsSet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getAllCats } from '../../core/categories.js';
import { navigation, form } from '../../core/state-actions.js';
import { emit, Events } from '../../core/event-bus.js';
import DOM from '../../core/dom-cache.js';
import { CONFIG } from '../../core/config.js';
import { replaceTransactionFilters } from '../../data/transaction-surface-coordinator.js';
import type { Transaction, MainTab } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TransactionType = 'expense' | 'income';
type DashboardTransactionType = TransactionType | 'all';

// ==========================================
// DEPENDENCY INJECTION
// ==========================================

import { getDefaultContainer, Services } from '../../core/di-container.js';

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
let renderCategoriesFn: () => void = () => {};
let renderQuickShortcutsFn: () => void = () => {};
let _transactionTypeUiCleanup: (() => void) | null = null;

function syncTransactionEntryUi(): void {
  const currentType = signals.currentType.value;
  const selectedCategory = signals.selectedCategory.value;
  const editingId = signals.editingId.value;

  syncTransactionTabDOM(currentType);

  if (!editingId && selectedCategory) {
    const validCategories = getAllCats(currentType);
    const hasSelectedCategory = validCategories.some((category) => category.id === selectedCategory);
    if (!hasSelectedCategory) {
      form.clearSelectedCategory();
    }
  }

  renderCategoriesFn();
  renderQuickShortcutsFn();
}

function bindTransactionTypeUi(): void {
  if (_transactionTypeUiCleanup) return;

  _transactionTypeUiCleanup = effect(() => {
    signals.currentType.value;
    signals.selectedCategory.value;
    signals.editingId.value;
    syncTransactionEntryUi();
  });
}

/**
 * Set the quick shortcuts render function
 */
export function setRenderCategoriesFn(fn: () => void): void {
  renderCategoriesFn = fn;
  syncTransactionEntryUi();
}

export function setRenderQuickShortcutsFn(fn: () => void): void {
  renderQuickShortcutsFn = fn;
  syncTransactionEntryUi();
}

// Swipe thresholds from centralized config (single source of truth)
const { SWIPE_THRESHOLD, VERTICAL_THRESHOLD } = CONFIG.GESTURES;

// Guard to prevent duplicate swipe listener attachment
let _swipeListenersAttached = false;
let _shellNavigationInitialized = false;
let _navigationListenersInitialized = false;
const _navigationListenerCleanups: Array<() => void> = [];

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
let _transactionsLayoutResizeHandler: (() => void) | null = null;
let _transactionsLayoutDetailsEl: HTMLDetailsElement | null = null;
let _transactionsLayoutToggleHandler: (() => void) | null = null;

function addNavigationListener(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions
): void {
  target.addEventListener(type, handler, options);
  _navigationListenerCleanups.push(() => {
    target.removeEventListener(type, handler, options);
  });
}

function cleanupNavigationListeners(): void {
  const cleanups = _navigationListenerCleanups.splice(0, _navigationListenerCleanups.length);
  cleanups.forEach((cleanup) => cleanup());
}

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
  addNavigationListener(window, 'resize', _shellResizeHandler, { passive: true });

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
    _transactionsLayoutDetailsEl = detailsEl;
    _transactionsLayoutToggleHandler = () => scheduleTransactionsEntryLayoutSync();
    addNavigationListener(detailsEl, 'toggle', _transactionsLayoutToggleHandler);
  }

  _transactionsLayoutResizeHandler = () => scheduleTransactionsEntryLayoutSync();
  addNavigationListener(window, 'resize', _transactionsLayoutResizeHandler, { passive: true });
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

export async function openTransactionsForMonthType(type: DashboardTransactionType): Promise<void> {
  switchMainTab('transactions');

  await replaceTransactionFilters({
    ...signals.filters.value,
    type,
    dateFrom: '',
    dateTo: '',
    showAllMonths: false
  }, { resetPage: true });

  requestAnimationFrame(() => {
    const ledgerCard = document.querySelector('.transactions-ledger-card');
    if (!(ledgerCard instanceof HTMLElement)) return;

    const shellHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-shell-stack-height')) || 0;
    const top = Math.max(0, ledgerCard.getBoundingClientRect().top + window.scrollY - shellHeight - 8);
    ledgerCard.tabIndex = -1;
    window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
    ledgerCard.focus({ preventScroll: true });
  });
}

export async function openTransactionsForDate(date: string): Promise<void> {
  switchMainTab('transactions');

  const [{ resetForm }, { formDate, syncFormWithSignals }, { cancelEditing }] = await Promise.all([
    import('../interactions/form-events.js'),
    import('../../transactions/template-manager.js'),
    import('../../transactions/edit-mode.js')
  ]);

  cancelEditing();
  resetForm();
  formDate.value = date;
  syncFormWithSignals();

  requestAnimationFrame(() => {
    revealTransactionsForm('amount', true);
  });
}

export async function openTransactionsEdit(tx: Transaction): Promise<void> {
  switchMainTab('transactions');
  const { startEditing } = await import('../../transactions/edit-mode.js');
  startEditing(tx);
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
  const tabs: MainTab[] = ['dashboard', 'budget', 'transactions', 'calendar'];

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

  if (prevBtn) addNavigationListener(prevBtn, 'click', goToPrevMonth);
  if (nextBtn) addNavigationListener(nextBtn, 'click', goToNextMonth);
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

  addNavigationListener(mainContent, 'touchstart', _swipeTouchStartHandler as EventListener, { passive: true });
  addNavigationListener(mainContent, 'touchend', _swipeTouchEndHandler as EventListener, { passive: true });
}

/**
 * Remove swipe gesture listeners and reset state
 */
export function cleanupSwipeGestures(): void {
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
    addNavigationListener(btn, 'click', () => {
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

  if (tabExpense) addNavigationListener(tabExpense, 'click', () => switchTab('expense'));
  if (tabIncome) addNavigationListener(tabIncome, 'click', () => switchTab('income'));
}

/**
 * Initialize the shell navigation that users see immediately.
 * This must be ready before heavier DI/data startup completes.
 */
export function initShellNavigation(): void {
  if (_shellNavigationInitialized) return;
  _shellNavigationInitialized = true;
  _navigationListenersInitialized = true;

  bindAppShellMetrics();
  bindTransactionsEntryLayout();
  bindTransactionTypeUi();
  setupExpenseIncomeTabs();
  setupMonthNavigation();
  setupMainTabListeners();
  setupSwipeGestures();

  syncMainTabDOM(signals.activeMainTab.value);
  syncTransactionEntryUi();
}

export function cleanupShellNavigation(): void {
  cleanupNavigationListeners();
  cleanupSwipeGestures();

  if (_transactionTypeUiCleanup) {
    _transactionTypeUiCleanup();
    _transactionTypeUiCleanup = null;
  }

  if (_shellResizeObserver) {
    _shellResizeObserver.disconnect();
    _shellResizeObserver = null;
  }
  _shellResizeHandler = null;
  _shellMetricsBound = false;

  if (_transactionsLayoutResizeObserver) {
    _transactionsLayoutResizeObserver.disconnect();
    _transactionsLayoutResizeObserver = null;
  }
  if (_transactionsLayoutMutationObserver) {
    _transactionsLayoutMutationObserver.disconnect();
    _transactionsLayoutMutationObserver = null;
  }
  if (_transactionsLayoutRaf) {
    cancelAnimationFrame(_transactionsLayoutRaf);
    _transactionsLayoutRaf = 0;
  }
  _transactionsLayoutResizeHandler = null;
  _transactionsLayoutDetailsEl = null;
  _transactionsLayoutToggleHandler = null;
  _transactionsLayoutBound = false;

  _shellNavigationInitialized = false;
  _navigationListenersInitialized = false;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize all navigation event listeners
 */
export function init(): void {
  if (_navigationListenersInitialized) return;
  initShellNavigation();
}
