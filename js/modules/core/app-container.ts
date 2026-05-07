/**
 * Application Container Setup
 * 
 * Centralizes the registration of services and configuration
 * for the dependency injection container.
 */
'use strict';

import { getDefaultContainer, Services } from './di-container.js';
import type { CurrencyFormatter } from '../../types/index.js';
import type { 
  ApplicationServices, 
  ApplicationConfig
} from '../types/app-config.js';

/**
 * Initialize the DI container with app services
 * This should be called early in app initialization
 */
export function initializeContainer(
  appServices: ApplicationServices,
  appConfig: ApplicationConfig
): void {
  const container = getDefaultContainer();

  // Phase 6 Slice 1d (Inline-Behavior-Review rev 12, L12): bootstrapping
  // intentionally replaces several lazy-factory bindings installed by
  // `createDefaultContainer()` (CURRENCY_FORMATTER, GET_TODAY_STR,
  // RENDER_CATEGORIES, RENDER_TRANSACTIONS, SWITCH_TAB, SWITCH_MAIN_TAB,
  // EMPTY_STATE, SWIPE_MANAGER) with already-initialized values from
  // `appServices`. These overrides are explicit and expected, so they
  // pass `{ override: true }` to silence the new re-registration guard.
  // Keys that do NOT collide with the default container stay plain.
  const overrideOpt = { override: true };

  // Register core services as values (already initialized)
  container.registerValue(Services.CURRENCY_FORMATTER, appServices.fmtCur, overrideOpt);
  container.registerValue(Services.GET_TODAY_STR, appServices.getTodayStr, overrideOpt);
  // CR-Apr24-I finding 337: all registrations in this idempotent helper
  // must pass overrideOpt so a second call doesn't trip the DI guard.
  container.registerValue('fmtShort', appServices.fmtShort, overrideOpt);
  container.registerValue('monthLabel', appServices.monthLabel, overrideOpt);

  // Register UI services
  container.registerValue(Services.RENDER_CATEGORIES, appServices.renderCategories, overrideOpt);
  container.registerValue(Services.RENDER_TRANSACTIONS, appServices.renderTransactions, overrideOpt);
  container.registerValue(Services.SWITCH_TAB, appServices.switchTab, overrideOpt);
  container.registerValue(Services.SWITCH_MAIN_TAB, appServices.switchMainTab, overrideOpt);
  container.registerValue(Services.EMPTY_STATE, appServices.emptyState, overrideOpt);
  container.registerValue(Services.UPDATE_CHARTS, appServices.updateCharts, overrideOpt);
  container.registerValue('refreshAll', appServices.refreshAll, overrideOpt);

  // Register feature services
  container.registerValue('calcVelocity', appServices.calcVelocity, overrideOpt);
  container.registerValue('renderQuickShortcuts', appServices.renderQuickShortcuts, overrideOpt);
  container.registerValue('populateCategoryFilter', appServices.populateCategoryFilter, overrideOpt);
  container.registerValue('renderCustomCatsList', appServices.renderCustomCatsList, overrideOpt);
  container.registerValue('updateSplitRemaining', appServices.updateSplitRemaining, overrideOpt);
  container.registerValue('openSettingsModal', appServices.openSettingsModal, overrideOpt);

  // Register managers
  container.registerValue(Services.SWIPE_MANAGER, appServices.swipeManager, overrideOpt);

  // Register configurations
  container.registerValue(Services.TIMING_CONFIG, appConfig.TIMING, overrideOpt);
  container.registerValue(Services.PAGINATION_CONFIG, { PAGE_SIZE: appConfig.PAGINATION.PAGE_SIZE }, overrideOpt);
  container.registerValue(Services.SWIPE_CONFIG, appConfig.SWIPE, overrideOpt);
  container.registerValue(Services.CALENDAR_CONFIG, { CALENDAR_INTENSITY: appConfig.CALENDAR_INTENSITY }, overrideOpt);
  container.registerValue(Services.PIN_CONFIG, { PIN_ERROR_DISPLAY: appConfig.PIN_ERROR_DISPLAY }, overrideOpt);
  container.registerValue('recurringConfig', { MAX_ENTRIES: appConfig.RECURRING_MAX_ENTRIES }, overrideOpt);
}

/**
 * Example of how modules can use the container
 * Instead of multiple setter functions, modules can get dependencies from the container
 */
export function getAppDependencies() {
  const container = getDefaultContainer();
  return {
    fmtCur: container.resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER),
    renderCategories: container.resolveSync<() => void>(Services.RENDER_CATEGORIES),
    renderTransactions: container.resolveSync<(resetPage?: boolean) => void>(Services.RENDER_TRANSACTIONS),
    switchTab: container.resolveSync<(tabName: string) => void>(Services.SWITCH_TAB),
    switchMainTab: container.resolveSync<(tab: string) => void>(Services.SWITCH_MAIN_TAB),
    emptyState: container.resolveSync(Services.EMPTY_STATE),
    updateCharts: container.resolveSync<() => void>(Services.UPDATE_CHARTS),
    swipeManager: container.resolveSync(Services.SWIPE_MANAGER),
    timingConfig: container.resolveSync(Services.TIMING_CONFIG),
    paginationConfig: container.resolveSync(Services.PAGINATION_CONFIG),
  };
}