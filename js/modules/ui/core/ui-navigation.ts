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

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type TransactionType = 'expense' | 'income';
type MainTab = 'dashboard' | 'transactions' | 'budget';

// ==========================================
// CALLBACKS (set by app.js to avoid circular deps)
// ==========================================

let renderCategoriesFn: () => void = () => {};
let renderQuickShortcutsFn: () => void = () => {};
let updateChartsFn: () => void = () => {};

export function setRenderCategoriesFn(fn: () => void): void { renderCategoriesFn = fn; }
export function setRenderQuickShortcutsFn(fn: () => void): void { renderQuickShortcutsFn = fn; }
export function setUpdateChartsFn(fn: () => void): void { updateChartsFn = fn; }

// ==========================================
// CONFIG
// ==========================================

const SWIPE_THRESHOLD = 60;
const VERTICAL_THRESHOLD = 100;

// ==========================================
// TAB SWITCHING
// ==========================================

/**
 * Switch between expense/income tabs
 */
export function switchTab(type: TransactionType): void {
  navigation.setCurrentTab(type);
  if (!signals.editingId.value) form.clearSelectedCategory();

  const te = DOM.get('tab-expense');
  const ti = DOM.get('tab-income');

  if (te && ti) {
    te.classList.toggle('btn-danger', type === 'expense');
    te.classList.toggle('btn-secondary', type !== 'expense');
    ti.classList.toggle('btn-success', type === 'income');
    ti.classList.toggle('btn-secondary', type !== 'income');
  }

  renderCategoriesFn();
  renderQuickShortcutsFn();
}

/**
 * Switch between main navigation tabs (dashboard/transactions/budget)
 */
export function switchMainTab(tabName: MainTab): void {
  const tabs: MainTab[] = ['dashboard', 'transactions', 'budget'];

  tabs.forEach(t => {
    const el = DOM.get('tab-' + t);
    if (el) el.style.display = t === tabName ? 'block' : 'none';
  });

  document.querySelectorAll('.main-tab').forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === tabName;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('btn-secondary', !isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  navigation.setActiveMainTab(tabName);
  lsSet('budget_tracker_active_tab', tabName);

  if (tabName === 'dashboard') {
    try { updateChartsFn(); } catch(e) { console.error('Chart update failed:', e); }
  }
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
  let touchStartX = 0;
  let touchStartY = 0;

  const mainContent = document.querySelector('main');
  if (!mainContent) return;

  mainContent.addEventListener('touchstart', (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  mainContent.addEventListener('touchend', (e: TouchEvent) => {
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
  }, { passive: true });
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

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize all navigation event listeners
 */
export function init(): void {
  setupExpenseIncomeTabs();
  setupMonthNavigation();
  setupSwipeGestures();
  setupMainTabListeners();
}
