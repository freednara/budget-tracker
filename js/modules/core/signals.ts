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
import { lsGet, lsSet, SK } from './state.js';
import { getMonthKey, toCents, toDollars } from './utils.js';
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
  SpendingPaceStatus
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
  lsGet<Record<string, SavingsGoal>>(SK.SAVINGS, {})
);

/**
 * Savings contributions history
 */
export const savingsContribs = signal<SavingsContribution[]>(
  lsGet<SavingsContribution[]>(SK.SAVINGS_CONTRIB, [])
);

/**
 * Monthly budget allocations by month key and category
 */
export const monthlyAlloc = signal<Record<string, MonthlyAllocation>>(
  lsGet<Record<string, MonthlyAllocation>>(SK.ALLOC, {})
);

/**
 * User achievements/badges
 */
export const achievements = signal<Record<string, unknown>>(
  lsGet<Record<string, unknown>>(SK.ACHIEVE, {})
);

/**
 * Streak tracking data
 */
export const streak = signal<StreakData>(
  lsGet<StreakData>(SK.STREAK, { current: 0, longest: 0, lastDate: '' })
);

/**
 * Custom user-defined categories
 */
export const customCats = signal<CustomCategory[]>(
  lsGet<CustomCategory[]>(SK.CUSTOM_CAT, [])
);

/**
 * Debt tracking entries
 */
export const debts = signal<Debt[]>(
  lsGet<Debt[]>(SK.DEBTS, [])
);

// ==========================================
// SETTINGS SIGNALS (persisted)
// ==========================================

/**
 * Currency settings (home currency and symbol)
 */
export const currency = signal<CurrencySettings>(
  lsGet<CurrencySettings>(SK.CURRENCY, { home: 'USD', symbol: '$' })
);

/**
 * Section visibility settings
 */
export const sections = signal<SectionsConfig>(
  lsGet<SectionsConfig>(SK.SECTIONS, { envelope: true })
);

/**
 * PIN for app lock (hashed)
 */
export const pin = signal<string>(
  lsGet<string>(SK.PIN, '')
);

/**
 * Insight message personality
 */
export const insightPers = signal<InsightPersonality>(
  lsGet<InsightPersonality>(SK.INSIGHT_PERS, 'serious')
);

/**
 * Alert preferences
 */
export const alerts = signal<AlertPrefs>(
  lsGet<AlertPrefs>(SK.ALERTS, { budgetThreshold: 0.8 })
);

/**
 * Rollover settings for budget categories
 */
export const rolloverSettings = signal<RolloverSettings>(
  lsGet<RolloverSettings>(SK.ROLLOVER_SETTINGS, {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero'
  })
);

/**
 * Filter presets
 */
export const filterPresets = signal<FilterPreset[]>(
  lsGet<FilterPreset[]>(SK.FILTER_PRESETS, [])
);

/**
 * Transaction templates
 */
export const txTemplates = signal<TxTemplate[]>(
  lsGet<TxTemplate[]>(SK.TX_TEMPLATES, [])
);

// ==========================================
// UI STATE SIGNALS (session only)
// ==========================================

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
 * Transaction data pending edit confirmation
 */
export const pendingEditTx = signal<Transaction | null>(null);

/**
 * Whether editing entire recurring series
 */
export const editSeriesMode = signal<boolean>(false);

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

// ==========================================
// COMPUTED SIGNALS (derived values)
// ==========================================

/**
 * Transactions for the currently selected month
 * Automatically updates when transactions or currentMonth change
 */
export const currentMonthTx: ReadonlySignal<Transaction[]> = computed(() =>
  transactions.value.filter(t =>
    t.date && getMonthKey(t.date) === currentMonth.value
  )
);

/**
 * Totals for the current month (income, expenses, balance)
 * Automatically updates when currentMonthTx changes
 */
export const currentMonthTotals: ReadonlySignal<MonthTotals> = computed(() => {
  const txs = currentMonthTx.value;
  let incomeCents = 0;
  let expensesCents = 0;

  for (const tx of txs) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') incomeCents += amtCents;
    else if (tx.type === 'expense') expensesCents += amtCents;
  }

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  return { income, expenses, balance: income - expenses };
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
 * Savings rate for current month (percentage)
 * Returns (income - expenses) / income * 100
 */
export const savingsRate: ReadonlySignal<number> = computed(() => {
  const { income, expenses } = currentMonthTotals.value;
  return income > 0 ? ((income - expenses) / income) * 100 : 0;
});

/**
 * Total expenses by category for current month
 * Returns a map of category ID to total amount
 */
export const expensesByCategory: ReadonlySignal<Record<string, number>> = computed(() => {
  const expByCatCents: Record<string, number> = {};
  const expTx = currentMonthTx.value.filter(t => t.type === 'expense');

  for (const tx of expTx) {
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
 * Recomputes when transactions, monthlyAlloc, or currentMonth change
 */
export const dailyAllowanceData: ReadonlySignal<DailyAllowanceData> = computed(() => {
  const mk = currentMonth.value;
  const now = new Date();
  const [year, month] = mk.split('-').map(Number);
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - now.getDate() + 1) : 0;

  // Get total allocated budget for the month
  const alloc = monthlyAlloc.value[mk] || {};
  const totalBudgetCents = Object.values(alloc as Record<string, number>).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );
  const totalBudget = toDollars(totalBudgetCents);

  // Get total spent (from currentMonthTotals for efficiency)
  const spentCents = toCents(currentMonthTotals.value.expenses);
  const spent = toDollars(spentCents);

  // Calculate remaining budget
  const remainingCents = totalBudgetCents - spentCents;
  const remaining = toDollars(remainingCents);

  // Calculate daily allowance
  const dailyAllowanceCents = daysRemaining > 0 ? Math.floor(remainingCents / daysRemaining) : 0;
  const dailyAllowance = toDollars(dailyAllowanceCents);

  // Determine status based on budget health
  let status: DailyAllowanceStatus = 'neutral';
  if (totalBudget === 0) {
    status = 'no-budget';
  } else if (remaining <= 0) {
    status = 'over';
  } else if (dailyAllowance < totalBudget / daysInMonth * 0.3) {
    status = 'warning';
  } else {
    status = 'healthy';
  }

  return { dailyAllowance, daysRemaining, totalBudget, spent, remaining, status, isCurrentMonth };
});

/**
 * Spending pace data for current month
 * Shows if spending is ahead, on track, or behind budget pace
 */
export const spendingPaceData: ReadonlySignal<SpendingPaceData> = computed(() => {
  const mk = currentMonth.value;
  const now = new Date();
  const [year, month] = mk.split('-').map(Number);
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;

  // Expected percent of budget that should be spent by now
  const expectedPercent = daysInMonth > 0 ? (dayOfMonth / daysInMonth) * 100 : 0;

  // Get total budget and spent
  const alloc = monthlyAlloc.value[mk] || {};
  const totalBudgetCents = Object.values(alloc as Record<string, number>).reduce(
    (s: number, v: number) => s + toCents(v), 0
  );

  if (totalBudgetCents === 0) {
    return { status: 'no-budget' as SpendingPaceStatus, percentOfBudget: 0, expectedPercent, difference: 0, isCurrentMonth };
  }

  const spentCents = toCents(currentMonthTotals.value.expenses);
  const percentOfBudget = totalBudgetCents > 0 ? (spentCents / totalBudgetCents) * 100 : 0;
  const difference = percentOfBudget - expectedPercent;

  let status: SpendingPaceStatus;
  if (difference > 10) {
    status = 'over'; // Red - spending too fast
  } else if (difference > -10) {
    status = 'on-track'; // Yellow - within 10%
  } else {
    status = 'under'; // Green - spending less than expected
  }

  return { status, percentOfBudget, expectedPercent, difference, isCurrentMonth };
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

// Auto-persist signals to localStorage when they change
effect(() => { lsSet(SK.SAVINGS, savingsGoals.value); });
effect(() => { lsSet(SK.SAVINGS_CONTRIB, savingsContribs.value); });
effect(() => { lsSet(SK.ALLOC, monthlyAlloc.value); });
effect(() => { lsSet(SK.ACHIEVE, achievements.value); });
effect(() => { lsSet(SK.STREAK, streak.value); });
effect(() => { lsSet(SK.CUSTOM_CAT, customCats.value); });
effect(() => { lsSet(SK.DEBTS, debts.value); });
effect(() => { lsSet(SK.CURRENCY, currency.value); });
effect(() => { lsSet(SK.SECTIONS, sections.value); });
effect(() => { lsSet(SK.PIN, pin.value); });
effect(() => { lsSet(SK.INSIGHT_PERS, insightPers.value); });
effect(() => { lsSet(SK.ALERTS, alerts.value); });
effect(() => { lsSet(SK.ROLLOVER_SETTINGS, rolloverSettings.value); });
effect(() => { lsSet(SK.FILTER_PRESETS, filterPresets.value); });
effect(() => { lsSet(SK.TX_TEMPLATES, txTemplates.value); });

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
export { batch };

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Get transactions for a specific month
 * @param mk - Month key in YYYY-MM format (defaults to currentMonth)
 */
export function getMonthTransactions(mk?: string): Transaction[] {
  const month = mk ?? currentMonth.value;
  return transactions.value.filter(t =>
    t.date && getMonthKey(t.date) === month
  );
}

/**
 * Get expenses for a specific category in a specific month
 * @param categoryId - Category ID
 * @param mk - Month key in YYYY-MM format (defaults to currentMonth)
 */
export function getCategoryExpenses(categoryId: string, mk?: string): number {
  const month = mk ?? currentMonth.value;
  let totalCents = 0;

  for (const tx of transactions.value) {
    if (tx.type === 'expense' &&
        tx.category === categoryId &&
        tx.date &&
        getMonthKey(tx.date) === month) {
      totalCents += toCents(tx.amount);
    }
  }

  return toDollars(totalCents);
}

/**
 * Calculate totals for a specific month
 * @param mk - Month key in YYYY-MM format
 */
export function calculateMonthTotals(mk: string): MonthTotals {
  const txs = getMonthTransactions(mk);
  let incomeCents = 0;
  let expensesCents = 0;

  for (const tx of txs) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') incomeCents += amtCents;
    else if (tx.type === 'expense') expensesCents += amtCents;
  }

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  return { income, expenses, balance: income - expenses };
}
