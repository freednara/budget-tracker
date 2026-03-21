/**
 * Signals Module
 * Reactive state management using @preact/signals-core
 *
 * This module provides signal-based state that can coexist with the
 * existing Proxy-based state in state.ts during migration.
 *
 * @module signals
 */
'use strict';

import { signal, computed, effect, batch } from '@preact/signals-core';
import type { Signal, ReadonlySignal } from '@preact/signals-core';
import { getDefaultContainer, Services } from './di-container.js';
import { lsGet, lsSet, SK, getStored } from './state.js';
import { getMonthKey, getTodayStr as _getTodayStr, toCents, toDollars } from './utils.js';
import { isTrackedExpenseTransaction } from './transaction-classification.js';
import { calcTotals, getEffectiveIncome, getDailyAllowance, getSpendingPace, getMonthExpByCat, getMonthTx } from '../features/financial/calculations.js';
import { calculateMonthlyTotalsWithCacheSync } from './monthly-totals-cache.js';
import { getCatInfo } from './categories.js';
import type {
  Transaction,
  SavingsGoal,
  SavingsContribution,
  MonthlyAllocation,
  StreakData,
  CustomCategory,
  CurrencySettings,
  SectionsConfig,
  AlertPrefs,
  FilterPreset,
  TxTemplate,
  PaginationState,
  RolloverSettings,
  Debt,
  TransactionType,
  MainTab,
  InsightPersonality,
  DailyAllowanceData,
  DailyAllowanceStatus,
  SpendingPaceData,
  SpendingPaceStatus,
  Theme
} from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type { Signal, ReadonlySignal };

export interface MonthTotals {
  income: number;
  expenses: number;
  balance: number;
}

// ==========================================
// CORE DATA SIGNALS (persisted)
// ==========================================

/**
 * All transactions - synced with dataSdk
 * Note: This signal is populated by dataSdk.init() callback
 */
export const transactions = signal<Transaction[]>([]);

/**
 * Savings goals configuration
 */
export const savingsGoals = signal<Record<string, SavingsGoal>>(
  getStored<Record<string, SavingsGoal>>(SK.SAVINGS)
);

/**
 * Savings contributions history
 */
export const savingsContribs = signal<SavingsContribution[]>(
  getStored<SavingsContribution[]>(SK.SAVINGS_CONTRIB)
);

/**
 * Monthly budget allocations by month key and category
 */
export const monthlyAlloc = signal<Record<string, MonthlyAllocation>>(
  getStored<Record<string, MonthlyAllocation>>(SK.ALLOC)
);

/**
 * User achievements/badges
 */
export const achievements = signal<Record<string, unknown>>(
  getStored<Record<string, unknown>>(SK.ACHIEVE)
);

/**
 * Streak tracking data
 */
export const streak = signal<StreakData>(
  getStored<StreakData>(SK.STREAK)
);

/**
 * Custom user-defined categories
 */
export const customCats = signal<CustomCategory[]>(
  getStored<CustomCategory[]>(SK.CUSTOM_CAT)
);

/**
 * Debt tracking entries
 */
export const debts = signal<Debt[]>(
  getStored<Debt[]>(SK.DEBTS)
);

// ==========================================
// SETTINGS SIGNALS (persisted)
// ==========================================

/**
 * Currency settings (home currency and symbol)
 */
export const currency = signal<CurrencySettings>(
  getStored<CurrencySettings>(SK.CURRENCY)
);

/**
 * Section visibility settings
 */
export const sections = signal<SectionsConfig>(
  getStored<SectionsConfig>(SK.SECTIONS)
);

/**
 * PIN for app lock (hashed)
 */
export const pin = signal<string>(
  getStored<string>(SK.PIN)
);

/**
 * Insight message personality
 */
export const insightPers = signal<InsightPersonality>(
  getStored<InsightPersonality>(SK.INSIGHT_PERS)
);

/**
 * Alert preferences
 */
export const alerts = signal<AlertPrefs>(
  getStored<AlertPrefs>(SK.ALERTS)
);

/**
 * Current theme preference (light/dark/system)
 */
export const theme = signal<Theme>(
  getStored<Theme>(SK.THEME, 'dark' as Theme)
);

/**
 * Rollover settings for budget categories
 */
export const rolloverSettings = signal<RolloverSettings>(
  getStored<RolloverSettings>(SK.ROLLOVER_SETTINGS)
);

/**
 * Filter presets
 */
export const filterPresets = signal<FilterPreset[]>(
  getStored<FilterPreset[]>(SK.FILTER_PRESETS)
);

/**
 * Transaction templates
 */
export const txTemplates = signal<TxTemplate[]>(
  getStored<TxTemplate[]>(SK.TX_TEMPLATES)
);

/**
 * Last backup timestamp (ms)
 */
export const lastBackup = signal<number>(
  getStored<number>(SK.LAST_BACKUP, 0)
);

/**
 * Transaction count at the time of the last backup
 */
export const lastBackupTxCount = signal<number>(
  getStored<number>('backup_reminder_last_tx_count' as any, 0)
);

// ==========================================
// UI STATE SIGNALS (session only)
// ==========================================

/**
 * Today's date string (YYYY-MM-DD), updated automatically at midnight
 * Use this instead of getTodayStr() inside computed signals
 */
export const todayStr = signal<string>(_getTodayStr());

// Schedule update at next midnight
function _scheduleNextMidnight(): void {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    todayStr.value = _getTodayStr();
    _scheduleNextMidnight();
  }, msUntilMidnight + 100); // +100ms safety margin
}
_scheduleNextMidnight();

/**
 * Lightweight refresh counter — increment to force dependent computeds to recompute
 * without cloning the entire transactions array
 */
export const refreshVersion = signal<number>(0);

/**
 * Currently selected month (YYYY-MM format)
 */
export const currentMonth = signal<string>((() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})());

/**
 * Currently selected transaction type (expense/income)
 */
export const currentType = signal<TransactionType>('expense');

/**
 * Currently selected tab (expense/income) in form
 */
export const currentTab = signal<TransactionType>('expense');

/**
 * Currently selected category ID
 */
export const selectedCategory = signal<string>('');

/**
 * Set of IDs for alerts dismissed in the current session
 */
export const dismissedAlerts = signal<Set<string>>(new Set());

/**
 * ID of transaction being edited (null if not editing)
 */
export const editingId = signal<string | null>(null);

/**
 * ID of transaction pending deletion
 */
export const deleteTargetId = signal<string | null>(null);

/**
 * ID of savings goal for contribution modal
 */
export const addSavingsGoalId = signal<string | null>(null);

/**
 * ID of transaction for split modal
 */
export const splitTxId = signal<string | null>(null);

/**
 * Current rows in the split modal
 */
export interface SplitRow {
  id: string;
  categoryId: string;
  amount: number;
}

export const splitRows = signal<SplitRow[]>([]);

/**
 * Onboarding tour state
 */
export interface OnboardingState {
  active: boolean;
  step: number;
  completed: boolean;
}

export const onboarding = signal<OnboardingState>(
  getStored<OnboardingState>(SK.ONBOARD, { active: false, step: 0, completed: false })
);

/**
 * Transaction data pending edit confirmation
 */
export const pendingEditTx = signal<Transaction | null>(null);

/**
 * Whether the form is in edit mode
 */
export const isEditing = signal<boolean>(false);

/**
 * Text for the form title
 */
export const formTitle = signal<string>('➕ Add Transaction');

/**
 * Text for the form submit button
 */
export const submitButtonText = signal<string>('ADD TRANSACTION');

/**
 * Whether editing entire recurring series
 */
export const editSeriesMode = signal<boolean>(false);

/**
 * Recurring transaction preview data
 */
export interface RecurringPreview {
  show: boolean;
  count: number;
  startDate: string;
  endDate: string;
  isCapped: boolean;
  error?: string;
}

export const recurringPreview = signal<RecurringPreview>({
  show: false,
  count: 0,
  startDate: '',
  endDate: '',
  isCapped: false
});

/**
 * Currently selected day in the calendar widget
 */
export const selectedCalendarDay = signal<number | null>(null);

/**
 * Active main tab (dashboard/transactions/budget)
 */
export const activeMainTab = signal<MainTab>('dashboard');

/**
 * Pagination state for transaction list
 */
export const pagination = signal<PaginationState>({
  page: 0,
  totalPages: 0,
  totalItems: 0
});

/**
 * Transaction filters state
 */
export interface FilterState {
  searchText: string;
  type: TransactionType | 'all';
  category: string;
  tags: string;
  dateFrom: string;
  dateTo: string;
  minAmount: string;
  maxAmount: string;
  reconciled: 'all' | 'yes' | 'no';
  recurring: boolean;
  showAllMonths: boolean;
  sortBy: string;
}

export const filters = signal<FilterState>({
  searchText: '',
  type: 'all',
  category: '',
  tags: '',
  dateFrom: '',
  dateTo: '',
  minAmount: '',
  maxAmount: '',
  reconciled: 'all',
  recurring: false,
  showAllMonths: false,
  sortBy: 'date-desc'
});

/**
 * Whether advanced filters are expanded
 */
export const filtersExpanded = signal<boolean>(
  getStored<boolean>(SK.FILTER_EXPANDED, false)
);

// ==========================================
// COMPUTED SIGNALS (derived values)
// ==========================================

/**
 * Number of active filters
 */
export const activeFilterCount: ReadonlySignal<number> = computed(() => {
  const f = filters.value;
  let count = 0;
  if (f.searchText) count++;
  if (f.type !== 'all') count++;
  if (f.category) count++;
  if (f.tags) count++;
  if (f.dateFrom) count++;
  if (f.dateTo) count++;
  if (f.minAmount) count++;
  if (f.maxAmount) count++;
  if (f.reconciled !== 'all') count++;
  if (f.recurring) count++;
  return count;
});

/**
 * Transactions grouped by month key (YYYY-MM)
 * Optimized Map-based index for O(1) month lookups
 */
export const transactionsByMonth: ReadonlySignal<Map<string, Transaction[]>> = computed(() => {
  const map = new Map<string, Transaction[]>();
  const _rv = refreshVersion.value; // Also recompute on forced refresh
  
  for (const tx of transactions.value) {
    if (!tx.date) continue;
    const mk = getMonthKey(tx.date);
    if (!map.has(mk)) {
      map.set(mk, []);
    }
    map.get(mk)!.push(tx);
  }
  return map;
});

/**
 * Transactions for the currently selected month
 * Automatically updates when transactions or currentMonth change
 * OPTIMIZED: Uses Map-based index for O(1) lookup instead of O(N) filter
 */
export const currentMonthTx: ReadonlySignal<Transaction[]> = computed(() => {
  const mk = currentMonth.value;
  return transactionsByMonth.value.get(mk) || [];
});

/**
 * Totals for the current month (income, expenses, balance)
 * Automatically updates when currentMonthTx changes
 */
export const currentMonthTotals: ReadonlySignal<MonthTotals> = computed(() => {
  // Keep the currently viewed month live from the signal-backed transaction list.
  // Historical lookups can use the monthly cache, but the active dashboard needs
  // immediate consistency after local edits, imports, and cross-tab sync updates.
  const totals = calcTotals(currentMonthTx.value);
  return {
    income: totals.income,
    expenses: totals.expenses,
    balance: totals.balance
  };
});

/**
 * Budget remaining for current month
 * Calculated as total budget allocation minus expenses
 */
export const budgetRemaining: ReadonlySignal<number> = computed(() => {
  const alloc = monthlyAlloc.value[currentMonth.value] || {};
  const totalBudget = toDollars(
    Object.values(alloc).reduce((sum, v) => sum + toCents(v), 0)
  );
  return totalBudget - currentMonthTotals.value.expenses;
});

/**
 * Unassigned balance for current month (Available to Budget)
 * FIXED: Memoized to avoid O(M*N) historical scanning on every access
 * Accumulates from all previous months for true zero-based budgeting
 */
export const unassignedBalance: ReadonlySignal<number> = computed(() => {
  const mk = currentMonth.value;
  const alloc = monthlyAlloc.value;
  // Simple: current month income minus current month total allocations
  // Avoids expensive multi-month iteration that caused freezes
  const income = currentMonthTotals.value.income;
  const allocCents = Object.values(alloc[mk] || {}).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );
  return income - toDollars(allocCents);
});

/**
 * Savings rate for current month (percentage)
 * Returns (income - expenses) / income * 100
 */
export const savingsRate: ReadonlySignal<number> = computed(() => {
  const { income, expenses } = currentMonthTotals.value;
  return income > 0 ? ((income - expenses) / income) * 100 : 0;
});

/**
 * Current financial insights
 * FIXED: Uses DI container to resolve insights generator, removing circular dependency issues
 * Auto-updates when transactions or personality changes
 */
export const currentInsights: ReadonlySignal<Array<{ type: string; message: string; action?: any }>> = computed(() => {
  try {
    const container = getDefaultContainer();
    
    // Check if initialized to avoid errors during early startup
    if (!container.isInitialized(Services.INSIGHTS_GENERATOR)) {
      return [];
    }
    
    const generateInsights = container.resolveSync<() => any>(Services.INSIGHTS_GENERATOR);

    // Dependencies that trigger recalculation
    const _txCount = transactions.value.length;
    const _month = currentMonth.value;
    const _personality = insightPers.value;

    const insights = generateInsights();
    return insights;
  } catch (e) {
    // If not yet available, return empty
    return [];
  }
});

/**
 * Total expenses by category for current month
 * Returns a map of category ID to total amount
 */
export const expensesByCategory: ReadonlySignal<Record<string, number>> = computed(() => {
  const expByCatCents: Record<string, number> = {};

  // Single pass: filter and accumulate simultaneously
  for (const tx of currentMonthTx.value) {
    if (!isTrackedExpenseTransaction(tx)) continue;
    expByCatCents[tx.category] = (expByCatCents[tx.category] || 0) + toCents(tx.amount);
  }

  // Convert to dollars
  const result: Record<string, number> = {};
  for (const [cat, cents] of Object.entries(expByCatCents)) {
    result[cat] = toDollars(cents);
  }
  return result;
});

/**
 * Total number of transactions
 */
export const transactionCount: ReadonlySignal<number> = computed(() =>
  transactions.value.length
);

/**
 * Whether there are any transactions
 */
export const hasTransactions: ReadonlySignal<boolean> = computed(() =>
  transactions.value.length > 0
);

// ==========================================
// DASHBOARD DISPLAY SIGNALS
// ==========================================

/**
 * Daily allowance data for current month
 * Delegates to getDailyAllowance() in calculations.ts (single source of truth)
 * Recomputes when transactions, monthlyAlloc, or currentMonth change
 */
export const dailyAllowanceData: ReadonlySignal<DailyAllowanceData> = computed(() => {
  // Access reactive dependencies so signal recomputes when they change
  const _txCount = transactions.value.length;
  const _alloc = monthlyAlloc.value;
  const mk = currentMonth.value;

  // Delegate to pure function in calculations.ts
  return getDailyAllowance(mk);
});

/**
 * Spending pace data for current month
 * Delegates to getSpendingPace() in calculations.ts (single source of truth)
 * Shows if spending is ahead, on track, or behind budget pace
 */
export const spendingPaceData: ReadonlySignal<SpendingPaceData> = computed(() => {
  // Access reactive dependencies so signal recomputes when they change
  const _txCount = transactions.value.length;
  const _alloc = monthlyAlloc.value;
  const mk = currentMonth.value;

  // Delegate to pure function in calculations.ts
  return getSpendingPace(mk);
});

/**
 * Envelope budget allocation data for current month
 * Returns array of category allocations with spent amounts and percentages
 */
export interface EnvelopeItem {
  categoryId: string;
  allocated: number;
  spent: number;
  remaining: number;
  percentage: number;
  isOver: boolean;
}

export const envelopeData: ReadonlySignal<EnvelopeItem[]> = computed(() => {
  const mk = currentMonth.value;
  const alloc = monthlyAlloc.value[mk] || {};
  const expByCat = expensesByCategory.value;

  return Object.entries(alloc).map(([categoryId, allocated]) => {
    const spent = expByCat[categoryId] || 0;
    const remaining = allocated - spent;
    const percentage = allocated > 0 ? Math.min((spent / allocated) * 100, 100) : 0;
    const isOver = spent > allocated;
    return { categoryId, allocated, spent, remaining, percentage, isOver };
  });
});

/**
 * Status of current transaction split
 */
export interface SplitStatus {
  originalAmount: number;
  totalSplitAmount: number;
  remainingAmount: number;
  isValid: boolean;
  hasEmptyFields: boolean;
}

export const splitStatus: ReadonlySignal<SplitStatus> = computed(() => {
  const txId = splitTxId.value;
  const rows = splitRows.value;
  
  if (!txId) return { originalAmount: 0, totalSplitAmount: 0, remainingAmount: 0, isValid: false, hasEmptyFields: false };
  
  const tx = transactions.value.find(t => t.__backendId === txId);
  if (!tx) return { originalAmount: 0, totalSplitAmount: 0, remainingAmount: 0, isValid: false, hasEmptyFields: false };
  
  const origCents = toCents(tx.amount);
  const splitCents = rows.reduce((sum, row) => sum + toCents(row.amount), 0);
  const hasEmptyFields = rows.some(row => !row.categoryId || toCents(row.amount) === 0);
  
  return {
    originalAmount: tx.amount,
    totalSplitAmount: toDollars(splitCents),
    remainingAmount: toDollars(origCents - splitCents),
    isValid: origCents === splitCents && rows.length > 0 && !hasEmptyFields,
    hasEmptyFields
  };
});

/**
 * Current budget alerts for the active month
 * Memoized: skips recomputation when inputs haven't materially changed
 */
let _prevAlertInputs: { mk: string; allocKeys: string; expJson: string; threshold: number | null; dismissedSize: number } | null = null;
let _prevAlertResult: string[] = [];

export const activeAlerts: ReadonlySignal<string[]> = computed(() => {
  const mk = currentMonth.value;
  const alloc = monthlyAlloc.value[mk] || {};
  const expByCat = expensesByCategory.value;
  const alertSettings = alerts.value;
  const dismissed = dismissedAlerts.value;

  if (alertSettings.budgetThreshold === null) return [];

  // Quick memoization check: compare cheap fingerprints of inputs
  const allocKeys = Object.keys(alloc).join(',');
  const expJson = JSON.stringify(expByCat);
  const inputs = { mk, allocKeys, expJson, threshold: alertSettings.budgetThreshold, dismissedSize: dismissed.size };
  if (_prevAlertInputs &&
      _prevAlertInputs.mk === inputs.mk &&
      _prevAlertInputs.allocKeys === inputs.allocKeys &&
      _prevAlertInputs.expJson === inputs.expJson &&
      _prevAlertInputs.threshold === inputs.threshold &&
      _prevAlertInputs.dismissedSize === inputs.dismissedSize) {
    return _prevAlertResult;
  }

  const foundAlerts: string[] = [];

  Object.entries(alloc).forEach(([catId, amt]) => {
    if (!(amt > 0)) return;

    const spent = expByCat[catId] || 0;
    if (spent >= amt * alertSettings.budgetThreshold!) {
      const cat = getCatInfo('expense', catId);
      const alertText = `${cat.emoji} ${cat.name}: ${Math.round(spent / amt * 100)}% spent`;

      // Filter out dismissed alerts
      if (!dismissed.has(`${mk}:${alertText}`)) {
        foundAlerts.push(alertText);
      }
    }
  });

  _prevAlertInputs = inputs;
  _prevAlertResult = foundAlerts;
  return foundAlerts;
});

/**
 * Whether budget allocations exist for current month
 */
export const hasBudgetAllocations: ReadonlySignal<boolean> = computed(() => {
  const mk = currentMonth.value;
  const alloc = monthlyAlloc.value[mk] || {};
  return Object.keys(alloc).length > 0;
});

/**
 * Total budget for current month
 */
export const totalBudget: ReadonlySignal<number> = computed(() => {
  const mk = currentMonth.value;
  const alloc = monthlyAlloc.value[mk] || {};
  const totalCents = Object.values(alloc).reduce((s, v) => s + toCents(v), 0);
  return toDollars(totalCents);
});

/**
 * Budget usage percentage for current month
 */
export const budgetUsagePercent: ReadonlySignal<number> = computed(() => {
  const budget = totalBudget.value;
  if (budget === 0) return 0;
  return Math.min(150, Math.round((currentMonthTotals.value.expenses / budget) * 100));
});

// ==========================================
// PERSISTENCE EFFECTS
// ==========================================

// Import revision tracking, multi-tab sync, and signal batcher
import stateRevision from './state-revision.js';
import { broadcastManager } from './multi-tab-sync-broadcast.js';
import { getTabId } from './tab-id.js';
import { getSignalBatcher } from './signal-batcher.js';

// Initialize signal batcher for optimized persistence
const batcher = getSignalBatcher({
  debounceMs: 150,
  maxBatchSize: 20,
  flushOnVisibilityChange: true,
  onWrite: (key, value) => {
    stateRevision.recordStateChange(key, value, getTabId());
    broadcastManager.sendStateUpdate(key, value);
  }
});

// Register all persisted signals with the batcher
// This is O(1) per change instead of O(N) where N is number of signals
batcher.registerSignals({
  [SK.SAVINGS]: savingsGoals,
  [SK.SAVINGS_CONTRIB]: savingsContribs,
  [SK.ALLOC]: monthlyAlloc,
  [SK.ACHIEVE]: achievements,
  [SK.STREAK]: streak,
  [SK.CUSTOM_CAT]: customCats,
  [SK.DEBTS]: debts,
  [SK.CURRENCY]: currency,
  [SK.SECTIONS]: sections,
  [SK.PIN]: pin,
  [SK.INSIGHT_PERS]: insightPers,
  [SK.ALERTS]: alerts,
  [SK.THEME]: theme,
  [SK.ROLLOVER_SETTINGS]: rolloverSettings,
  [SK.FILTER_PRESETS]: filterPresets,
  [SK.TX_TEMPLATES]: txTemplates,
  [SK.ONBOARD]: onboarding,
  [SK.LAST_BACKUP]: lastBackup,
  ['backup_reminder_last_tx_count' as any]: lastBackupTxCount
});

// ==========================================
// BATCH HELPER
// ==========================================

/**
 * Batch multiple signal updates into a single reaction cycle
 * Use this when updating multiple signals at once to prevent
 * intermediate renders.
 *
 * @example
 * batch(() => {
 *   transactions.value = [...];
 *   currentMonth.value = '2026-03';
 * });
 */
export { signal, batch, getDefaultContainer, Services };

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get transactions for a specific month
 * OPTIMIZED: Uses Map-based index for O(1) lookup
 * @param mk - Month key in YYYY-MM format (defaults to currentMonth)
 */
export function getMonthTransactions(mk?: string): Transaction[] {
  const month = mk ?? currentMonth.value;
  return transactionsByMonth.value.get(month) || [];
}

/**
 * Get expenses for a specific category in a specific month
 * @param categoryId - Category ID
 * @param mk - Month key in YYYY-MM format (defaults to currentMonth)
 */
export function getCategoryExpenses(categoryId: string, mk?: string): number {
  const month = mk ?? currentMonth.value;
  // Use pure function from calculations.ts - single source of truth
  return getMonthExpByCat(categoryId, month);
}

/**
 * Calculate totals for a specific month
 * Uses calcTotals from calculations.ts to maintain single source of truth
 * @param mk - Month key in YYYY-MM format
 */
export function calculateMonthTotals(mk: string): MonthTotals {
  const txs = getMonthTransactions(mk);
  return calcTotals(txs, mk);
}
