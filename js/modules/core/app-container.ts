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
  ApplicationConfig,
  TimingConfig,
  PaginationConfig
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
  
  // Register core services as values (already initialized)
  container.registerValue(Services.CURRENCY_FORMATTER, appServices.fmtCur);
  container.registerValue(Services.GET_TODAY_STR, appServices.getTodayStr);
  container.registerValue('fmtShort', appServices.fmtShort);
  container.registerValue('monthLabel', appServices.monthLabel);
  
  // Register UI services
  container.registerValue(Services.RENDER_CATEGORIES, appServices.renderCategories);
  container.registerValue(Services.RENDER_TRANSACTIONS, appServices.renderTransactions);
  container.registerValue(Services.SWITCH_TAB, appServices.switchTab);
  container.registerValue(Services.SWITCH_MAIN_TAB, appServices.switchMainTab);
  container.registerValue(Services.EMPTY_STATE, appServices.emptyState);
  container.registerValue(Services.UPDATE_CHARTS, appServices.updateCharts);
  container.registerValue('refreshAll', appServices.refreshAll);
  
  // Register feature services
  container.registerValue('calcVelocity', appServices.calcVelocity);
  container.registerValue('renderQuickShortcuts', appServices.renderQuickShortcuts);
  container.registerValue('populateCategoryFilter', appServices.populateCategoryFilter);
  container.registerValue('renderCustomCatsList', appServices.renderCustomCatsList);
  container.registerValue('updateSplitRemaining', appServices.updateSplitRemaining);
  container.registerValue('openSettingsModal', appServices.openSettingsModal);
  
  // Register managers
  container.registerValue(Services.SWIPE_MANAGER, appServices.swipeManager);
  
  // Register configurations
  container.registerValue(Services.TIMING_CONFIG, appConfig.TIMING);
  container.registerValue(Services.PAGINATION_CONFIG, { PAGE_SIZE: appConfig.PAGINATION.PAGE_SIZE });
  container.registerValue(Services.SWIPE_CONFIG, appConfig.SWIPE);
  container.registerValue(Services.CALENDAR_CONFIG, { CALENDAR_INTENSITY: appConfig.CALENDAR_INTENSITY });
  container.registerValue(Services.PIN_CONFIG, { PIN_ERROR_DISPLAY: appConfig.PIN_ERROR_DISPLAY });
  container.registerValue('recurringConfig', { MAX_ENTRIES: appConfig.RECURRING_MAX_ENTRIES });
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