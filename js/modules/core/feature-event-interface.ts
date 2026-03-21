/**
 * Feature Event Interface
 * 
 * Provides a decoupled interface for UI layer to interact with feature modules
 * without direct imports, preventing circular dependencies.
 * 
 * @module feature-event-interface
 */

import { emit, on } from './event-bus.js';
import type { Transaction, RolloverSettings, Debt } from '../../types/index.js';

// ==========================================
// FEATURE EVENT TYPES
// ==========================================

export const FeatureEvents = {
  // Financial calculations
  REQUEST_MONTH_TX: 'feature:request:month_tx',
  REQUEST_MONTH_EXPENSES: 'feature:request:month_expenses',
  REQUEST_EFFECTIVE_INCOME: 'feature:request:effective_income',
  REQUEST_TOTALS: 'feature:request:totals',
  
  // Rollover
  REQUEST_ROLLOVER_SETTINGS: 'feature:request:rollover_settings',
  UPDATE_ROLLOVER_SETTINGS: 'feature:update:rollover_settings',
  
  // Achievements
  CHECK_ACHIEVEMENTS: 'feature:check:achievements',
  AWARD_ACHIEVEMENT: 'feature:award:achievement',
  
  // Streak tracking
  CHECK_STREAK: 'feature:check:streak',
  
  // Theme
  SET_THEME: 'feature:set:theme',
  
  // Alerts
  DISMISS_ALERT: 'feature:dismiss:alert',
  
  // Onboarding
  START_ONBOARDING: 'feature:start:onboarding',
  
  // Import/Export
  CLEAR_IMPORT_DATA: 'feature:clear:import_data',
  
  // PIN/Security
  REQUEST_PIN_CHECK: 'feature:request:pin_check',
  UPDATE_PIN: 'feature:update:pin',
  CLEAR_PIN: 'feature:clear:pin',
  
  // Debt planner
  REQUEST_DEBTS: 'feature:request:debts',
  ADD_DEBT: 'feature:add:debt',
  UPDATE_DEBT: 'feature:update:debt',
  DELETE_DEBT: 'feature:delete:debt'
} as const;

// ==========================================
// REQUEST/RESPONSE PATTERNS
// ==========================================

export interface FeatureRequest<T = unknown> {
  type: string;
  payload?: T;
  callback?: (result: unknown) => void;
}

export interface FeatureResponse<T = unknown> {
  type: string;
  result: T;
  error?: Error;
}

let featureRequestCounter = 0;

/**
 * Request data from a feature module
 */
export function requestFeature<T>(
  event: string, 
  payload?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    featureRequestCounter += 1;
    const responseEvent = `${event}:response:${featureRequestCounter}`;

    // Set timeout to prevent hanging promises
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Feature request timeout: ${event}`));
    }, 5000);

    const cleanup = on(responseEvent, (response: FeatureResponse<T>) => {
      clearTimeout(timeout);
      cleanup();
      if (response.error) {
        reject(response.error);
      } else {
        resolve(response.result);
      }
    });

    emit(event, { payload, responseEvent });
  });
}

/**
 * Notify feature module of an action
 */
export function notifyFeature(event: string, payload?: unknown): void {
  emit(event, payload);
}

// ==========================================
// CALCULATION HELPERS
// ==========================================

export interface CalculationRequest {
  month?: string;
  categoryId?: string;
  type?: 'income' | 'expense' | 'all';
}

export async function getMonthTransactions(month: string) {
  return requestFeature('feature:request:month_tx', { month });
}

export async function getMonthExpensesByCategory(month: string) {
  return requestFeature('feature:request:month_expenses', { month });
}

export async function getEffectiveIncome(month: string) {
  return requestFeature('feature:request:effective_income', { month });
}

export async function calculateTotals(transactions: Transaction[]) {
  return requestFeature('feature:request:totals', { transactions });
}

// ==========================================
// ROLLOVER HELPERS
// ==========================================

export async function getRolloverSettings() {
  return requestFeature('feature:request:rollover_settings');
}

export function updateRolloverSettings(settings: RolloverSettings) {
  notifyFeature('feature:update:rollover_settings', settings);
}

// ==========================================
// ACHIEVEMENT HELPERS
// ==========================================

export function checkAchievements() {
  notifyFeature('feature:check:achievements');
}

export function awardAchievement(id: string) {
  notifyFeature('feature:award:achievement', { id });
}

// ==========================================
// STREAK HELPERS
// ==========================================

export function checkStreak() {
  notifyFeature('feature:check:streak');
}

// ==========================================
// THEME HELPERS
// ==========================================

export function setTheme(theme: 'light' | 'dark' | 'system') {
  notifyFeature('feature:set:theme', { theme });
}

// ==========================================
// ALERT HELPERS
// ==========================================

export function dismissAlert(id: string) {
  notifyFeature('feature:dismiss:alert', { id });
}

// ==========================================
// ONBOARDING HELPERS
// ==========================================

export function startOnboarding() {
  notifyFeature('feature:start:onboarding');
}

// ==========================================
// IMPORT/EXPORT HELPERS
// ==========================================

export function clearImportData() {
  notifyFeature('feature:clear:import_data');
}

// ==========================================
// PIN/SECURITY HELPERS
// ==========================================

export async function checkPin(pin: string): Promise<boolean> {
  return requestFeature('feature:request:pin_check', { pin });
}

export function updatePin(newPin: string, oldPin?: string) {
  notifyFeature('feature:update:pin', { newPin, oldPin });
}

export function clearPin() {
  notifyFeature('feature:clear:pin');
}

// ==========================================
// DEBT PLANNER HELPERS
// ==========================================

export async function getDebts() {
  return requestFeature('feature:request:debts');
}

export function addDebt(debt: Debt) {
  notifyFeature('feature:add:debt', debt);
}

export function updateDebt(id: string, updates: Partial<Debt>) {
  notifyFeature('feature:update:debt', { id, updates });
}

export function deleteDebt(id: string) {
  notifyFeature('feature:delete:debt', { id });
}
