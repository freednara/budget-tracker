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

import { signal, computed, batch } from '@preact/signals-core';
import type { Signal, ReadonlySignal } from '@preact/signals-core';
import { getDefaultContainer, Services } from './di-container.js';
import { trackError } from './error-tracker.js';
import { SK, getStored, normalizeAlertPrefs, BACKUP_REMINDER_TX_COUNT_KEY } from './state.js';
import { getMonthKey, getTodayStr as _getTodayStr, toCents, toDollars } from './utils-pure.js';
import { isTrackedExpenseTransaction } from './transaction-classification.js';
import { getMonthAlloc } from './month-alloc.js';
import { calcTotals, getDailyAllowance, getSpendingPace, getMonthExpByCat } from '../features/financial/calculations.js';
// CR-Apr22-F slice 3: budget-alert thresholds must compare spend against the
// rollover-adjusted effective budget, not the raw allocation, so the alert
// list agrees with the envelope budget view (envelope-budget.ts already
// computes `effectiveBudget = amt + rollover`). This adds a direct
// signals → rollover edge, but `signals ↔ calculations ↔ rollover` is
// already a transitive cycle tolerated by the build, so the direct edge
// carries no new risk.
import { isRolloverEnabled, calculateMonthRollovers } from '../features/financial/rollover.js';
// M33 (Phase 5f): unused import deleted — `signals.ts` never called this
// (the `currentMonthTotals` computed at the bottom of the file recomputes
// totals inline from `transactionsByMonth` because cache invalidation
// timing is signal-driven there). Removing the dead import drops a
// circular-import risk surface (signals → monthly-totals-cache → signals).
import { getCatInfo } from './categories.js';
import type {
  Transaction,
  TransactionDataChange,
  SavingsGoal,
  SavingsContribution,
  MonthlyAllocation,
  StreakData,
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
  InsightsPayload,
  DailyAllowanceData,
  SpendingPaceData,
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

export interface MonthSummary extends MonthTotals {
  categoryTotals: Record<string, number>;
  transactionCount: number;
}

export const EMPTY_MONTH_SUMMARY: MonthSummary = {
  income: 0,
  expenses: 0,
  balance: 0,
  categoryTotals: {},
  transactionCount: 0
};

// ==========================================
// CORE DATA SIGNALS (persisted)
// ==========================================

/**
 * All transactions - synced with dataSdk
 * Note: This signal is populated by dataSdk.init() callback
 */
export const transactions = signal<Transaction[]>([]);

const monthTransactionBucketsState = signal<Map<string, Transaction[]>>(new Map());
const monthSummariesState = signal<Record<string, MonthSummary>>({});
const activeMonthKeysState = signal<string[]>([]);
const transactionIndexState = signal<Map<string, Transaction>>(new Map());

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
  normalizeAlertPrefs(getStored<unknown>(SK.ALERTS))
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
 * Transaction count at the time of the last backup.
 *
 * L89 (Inline-Behavior-Review): storage key now reads from the shared
 * `BACKUP_REMINDER_TX_COUNT_KEY` constant in state.ts so the manual
 * export/import pipeline, signal batcher, and hydration registry all
 * reference the same typed identifier. The registry default (0) means
 * `getStored` can omit the explicit fallback — `getStored<number>(key)`
 * returns the canonical default when the key is missing.
 */
export const lastBackupTxCount = signal<number>(
  getStored<number>(BACKUP_REMINDER_TX_COUNT_KEY)
);

// ==========================================
// UI STATE SIGNALS (session only)
// ==========================================

/**
 * Today's date string (YYYY-MM-DD), updated automatically at midnight
 * Use this instead of getTodayStr() inside computed signals
 */
export const todayStr = signal<string>(_getTodayStr());

// Schedule update at next midnight (with cleanup reference for lifecycle management)
let _midnightTimerId: ReturnType<typeof setTimeout> | null = null;
function _scheduleNextMidnight(): void {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  _midnightTimerId = setTimeout(() => {
    todayStr.value = _getTodayStr();
    _scheduleNextMidnight();
  }, msUntilMidnight + 100); // +100ms safety margin
}
_scheduleNextMidnight();

/** Cancel the midnight timer — call during app cleanup/teardown */
export function cancelMidnightTimer(): void {
  if (_midnightTimerId !== null) {
    clearTimeout(_midnightTimerId);
    _midnightTimerId = null;
  }
}

/**
 * Lightweight refresh counter — increment to force dependent computeds to recompute
 * without cloning the entire transactions array
 */
export const refreshVersion = signal<number>(0);

/**
 * Category metadata version counter.
 * Incremented by category-store on every config write (add / rename / recolor /
 * delete / preset apply / migration). Allows computeds in signals.ts (which
 * cannot import category-store without creating a circular dependency) to
 * establish a reactive edge to category changes.
 * CR-Apr24-I finding 96.
 */
export const categoryVersion = signal<number>(0);

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
 * Set of IDs for alerts dismissed by the user.
 *
 * CR-Apr22-F slice 3: persisted to `sessionStorage` (not `localStorage`) so a
 * dismissal sticks for the rest of the browsing session — reload no longer
 * resurfaces the same over-budget toast the user just acknowledged. Scoping
 * to sessionStorage rather than localStorage is deliberate: the user's
 * dismissal is a "stop bugging me right now" gesture, not a permanent
 * preference, and the alert keys embed the month key, so today's dismissal
 * never leaks into tomorrow's month anyway. sessionStorage also dodges the
 * full settings-round-trip (SK constant + storage-registry + sync allowlist
 * + import/export + app-reset) that a localStorage key would require, which
 * is the right cost trade for device-local, ephemeral UI state. Uses the `_`
 * prefix key-naming convention established by `rate-limiter.ts` to bypass
 * the architecture-contract `harbor_*` registry check.
 */
export const DISMISSED_ALERTS_SESSION_KEY = '_dismissed_alerts_session';

function _hydrateDismissedAlerts(): Set<string> {
  if (typeof sessionStorage === 'undefined') return new Set<string>();
  try {
    const raw = sessionStorage.getItem(DISMISSED_ALERTS_SESSION_KEY);
    if (!raw) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    // Narrow each element so the constructed Set is typed end-to-end and
    // tolerates partially corrupted storage without throwing.
    const stringEntries = (parsed as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    );
    return new Set<string>(stringEntries);
  } catch {
    return new Set<string>();
  }
}

export const dismissedAlerts = signal<Set<string>>(_hydrateDismissedAlerts());

/**
 * ID of transaction being edited (null if not editing)
 */
export const editingId = signal<string | null>(null);

/**
 * ID of savings goal for contribution modal
 */
export const addSavingsGoalId = signal<string | null>(null);

/**
 * ID of transaction targeted for deletion (delete confirmation modal).
 * NOTE: DRY-03 incorrectly removed this signal — it IS read by
 * modal-events.ts and written by form-actions.ts. Restored.
 */
export const deleteTargetId = signal<string | null>(null);

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
 * Maintained month buckets updated by startup hydration and transaction patches.
 */
export const transactionsByMonth: ReadonlySignal<Map<string, Transaction[]>> = monthTransactionBucketsState;

function summarizeMonthTransactions(monthTransactions: Transaction[]): MonthSummary {
  let incomeCents = 0;
  let expenseCents = 0;
  const categoryTotalsCents: Record<string, number> = {};

  for (const transaction of monthTransactions) {
    const amountCents = toCents(transaction.amount);
    // CALC-01: guard against NaN from non-finite amounts that bypassed
    // the validator (e.g. import, direct signal write). Without this,
    // a single NaN poisons the entire month's budget calculations.
    if (!Number.isFinite(amountCents)) continue;
    if (transaction.type === 'income') {
      incomeCents += amountCents;
      continue;
    }

    if (!isTrackedExpenseTransaction(transaction)) {
      continue;
    }

    expenseCents += amountCents;
    categoryTotalsCents[transaction.category] = (categoryTotalsCents[transaction.category] || 0) + amountCents;
  }

  const categoryTotals: Record<string, number> = {};
  for (const [categoryId, cents] of Object.entries(categoryTotalsCents)) {
    categoryTotals[categoryId] = toDollars(cents);
  }

  return {
    income: toDollars(incomeCents),
    expenses: toDollars(expenseCents),
    balance: toDollars(incomeCents - expenseCents),
    categoryTotals,
    transactionCount: monthTransactions.length
  };
}

function cloneMonthBuckets(
  buckets: Map<string, Transaction[]>
): Map<string, Transaction[]> {
  return new Map(Array.from(buckets.entries(), ([monthKey, monthTransactions]) => [
    monthKey,
    [...monthTransactions]
  ]));
}

function buildDerivedTransactionState(allTransactions: Transaction[]): {
  index: Map<string, Transaction>;
  buckets: Map<string, Transaction[]>;
  summaries: Record<string, MonthSummary>;
  activeMonths: string[];
} {
  const index = new Map<string, Transaction>();
  const buckets = new Map<string, Transaction[]>();
  const summaries: Record<string, MonthSummary> = {};

  for (const transaction of allTransactions) {
    index.set(transaction.__backendId, transaction);
    if (!transaction.date) continue;
    const monthKey = getMonthKey(transaction.date);
    const monthTransactions = buckets.get(monthKey);
    if (monthTransactions) {
      monthTransactions.push(transaction);
    } else {
      buckets.set(monthKey, [transaction]);
    }
  }

  for (const [monthKey, monthTransactions] of buckets.entries()) {
    summaries[monthKey] = summarizeMonthTransactions(monthTransactions);
  }

  const activeMonths = Object.entries(summaries)
    .filter(([, summary]) => summary.income > 0 || summary.expenses > 0)
    .map(([monthKey]) => monthKey)
    .sort();

  return { index, buckets, summaries, activeMonths };
}

function removeMonthIfEmpty(
  buckets: Map<string, Transaction[]>,
  summaries: Record<string, MonthSummary>,
  monthKey: string
): void {
  const monthTransactions = buckets.get(monthKey) || [];
  if (monthTransactions.length === 0) {
    buckets.delete(monthKey);
    delete summaries[monthKey];
    return;
  }

  summaries[monthKey] = summarizeMonthTransactions(monthTransactions);
}

function computeActiveMonths(
  summaries: Record<string, MonthSummary>
): string[] {
  return Object.entries(summaries)
    .filter(([, summary]) => summary.income > 0 || summary.expenses > 0)
    .map(([monthKey]) => monthKey)
    .sort();
}

export function replaceTransactionLedger(nextTransactions: Transaction[]): void {
  const nextState = buildDerivedTransactionState(nextTransactions);
  batch(() => {
    transactionIndexState.value = nextState.index;
    monthTransactionBucketsState.value = nextState.buckets;
    monthSummariesState.value = nextState.summaries;
    activeMonthKeysState.value = nextState.activeMonths;
    transactions.value = nextTransactions;
  });
}

export function applyTransactionPatch(change: TransactionDataChange): Transaction[] {
  const currentTransactions = transactions.value;
  const currentIndex = transactionIndexState.value;
  const nextTransactions = [...currentTransactions];
  const nextIndex = new Map(currentIndex);
  const nextBuckets = cloneMonthBuckets(monthTransactionBucketsState.value);
  const nextSummaries = { ...monthSummariesState.value };
  const touchedMonths = new Set<string>();

  const getExistingTransaction = (id?: string, fallback?: Transaction): Transaction | undefined => {
    if (fallback?.__backendId) return fallback;
    if (!id) return undefined;
    return nextIndex.get(id);
  };

  const upsertTransaction = (transaction: Transaction): void => {
    const transactionMonth = getMonthKey(transaction.date);
    const monthTransactions = nextBuckets.get(transactionMonth);
    if (monthTransactions) {
      monthTransactions.push(transaction);
    } else {
      nextBuckets.set(transactionMonth, [transaction]);
    }
    nextIndex.set(transaction.__backendId, transaction);
    touchedMonths.add(transactionMonth);
  };

  const removeTransaction = (transaction: Transaction): void => {
    const transactionMonth = getMonthKey(transaction.date);
    const monthTransactions = nextBuckets.get(transactionMonth);
    if (monthTransactions) {
      const transactionIndex = monthTransactions.findIndex((entry) => entry.__backendId === transaction.__backendId);
      if (transactionIndex > -1) {
        monthTransactions.splice(transactionIndex, 1);
      }
    }
    nextIndex.delete(transaction.__backendId);
    touchedMonths.add(transactionMonth);
  };

  switch (change.type) {
    case 'add':
      if (change.item && !nextIndex.has(change.item.__backendId)) {
        nextTransactions.push(change.item);
        upsertTransaction(change.item);
      }
      break;
    case 'batch-add':
      (change.items || []).forEach((transaction) => {
        if (nextIndex.has(transaction.__backendId)) return;
        nextTransactions.push(transaction);
        upsertTransaction(transaction);
      });
      break;
    case 'update': {
      const updatedTransaction = change.item;
      const previousTransaction = getExistingTransaction(updatedTransaction?.__backendId, change.previousItem);
      if (!updatedTransaction || !previousTransaction) {
        return currentTransactions;
      }

      const ledgerIndex = nextTransactions.findIndex((entry) => entry.__backendId === updatedTransaction.__backendId);
      if (ledgerIndex === -1) {
        return currentTransactions;
      }

      nextTransactions[ledgerIndex] = updatedTransaction;

      const previousMonth = getMonthKey(previousTransaction.date);
      const nextMonth = getMonthKey(updatedTransaction.date);
      if (previousMonth === nextMonth) {
        const monthTransactions = nextBuckets.get(previousMonth) || [];
        const monthIndex = monthTransactions.findIndex((entry) => entry.__backendId === updatedTransaction.__backendId);
        if (monthIndex > -1) {
          monthTransactions[monthIndex] = updatedTransaction;
        }
        nextIndex.set(updatedTransaction.__backendId, updatedTransaction);
        touchedMonths.add(previousMonth);
      } else {
        removeTransaction(previousTransaction);
        upsertTransaction(updatedTransaction);
      }
      break;
    }
    case 'delete': {
      const deletedTransaction = getExistingTransaction(change.id, change.item);
      if (!deletedTransaction) {
        return currentTransactions;
      }

      const ledgerIndex = nextTransactions.findIndex((entry) => entry.__backendId === deletedTransaction.__backendId);
      if (ledgerIndex === -1) {
        return currentTransactions;
      }

      nextTransactions.splice(ledgerIndex, 1);
      removeTransaction(deletedTransaction);
      break;
    }
    case 'batch-delete': {
      const deletedIds = new Set(change.ids || []);
      if (deletedIds.size === 0) {
        return currentTransactions;
      }

      for (let i = nextTransactions.length - 1; i >= 0; i--) {
        // Phase 6 Slice 1i (rev 12 L6): `nextTransactions[i]` is
        // `Transaction | undefined` under `noUncheckedIndexedAccess`;
        // the loop bound guarantees presence but a local narrow keeps
        // the downstream method call type-safe.
        const transaction = nextTransactions[i];
        if (!transaction || !deletedIds.has(transaction.__backendId)) continue;
        nextTransactions.splice(i, 1);
        removeTransaction(transaction);
      }
      break;
    }
    case 'split': {
      const splitSource = getExistingTransaction(change.id);
      if (!splitSource) {
        return currentTransactions;
      }

      const ledgerIndex = nextTransactions.findIndex((entry) => entry.__backendId === splitSource.__backendId);
      if (ledgerIndex === -1) {
        return currentTransactions;
      }

      nextTransactions.splice(ledgerIndex, 1, ...(change.items || []));
      removeTransaction(splitSource);
      (change.items || []).forEach((transaction) => {
        upsertTransaction(transaction);
      });
      break;
    }
    default:
      return currentTransactions;
  }

  touchedMonths.forEach((monthKey) => {
    removeMonthIfEmpty(nextBuckets, nextSummaries, monthKey);
  });

  batch(() => {
    monthTransactionBucketsState.value = nextBuckets;
    monthSummariesState.value = nextSummaries;
    activeMonthKeysState.value = computeActiveMonths(nextSummaries);
    transactionIndexState.value = nextIndex;
    transactions.value = nextTransactions;
  });
  return nextTransactions;
}

/**
 * Month-keyed financial summaries used by dashboard and chart consumers.
 * Keeps downstream consumers off the raw transaction arrays where possible.
 */
export const monthSummaries: ReadonlySignal<Record<string, MonthSummary>> = monthSummariesState;

/**
 * Transactions for the currently selected month
 * Automatically updates when transactions or currentMonth change
 * OPTIMIZED: Uses Map-based index for O(1) lookup instead of O(N) filter
 */
export const currentMonthTx: ReadonlySignal<Transaction[]> = computed(() => {
  const mk = currentMonth.value;
  return transactionsByMonth.value.get(mk) || [];
});

export const currentMonthSummary: ReadonlySignal<MonthSummary> = computed(() => {
  return monthSummaries.value[currentMonth.value] || EMPTY_MONTH_SUMMARY;
});

/**
 * Month keys that contain tracked income or expense activity.
 * Keeps dashboard trend eligibility logic off the hot render path.
 */
export const activeTransactionMonths: ReadonlySignal<string[]> = computed(() => {
  return activeMonthKeysState.value;
});

/**
 * Totals for the current month (income, expenses, balance)
 * Automatically updates when currentMonthTx changes
 */
export const currentMonthTotals: ReadonlySignal<MonthTotals> = computed(() => {
  const totals = currentMonthSummary.value;
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
  // rev 12 / #39 M4: `monthlyAlloc.value[mk] || {}` replaced with `getMonthAlloc()`
  // so a missing allocation for a month that should exist surfaces via `trackError`
  // rather than silently collapsing to a zero total budget.
  const alloc = getMonthAlloc(currentMonth.value, monthlyAlloc.value);
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
 *
 * Returns a unified `InsightsPayload` so the UI consumer never has to
 * branch on success vs. error. On a thrown error we track it and surface
 * a user-visible "Insights temporarily unavailable." message in slot 1
 * (with `_error: true` so the consumer can suppress default action buttons).
 *
 * Contract fix (P1 #1, 2026-04-20): previously this returned a lying
 * `Array<{ type, message }>` on error and the object shape on success,
 * which defeated the error sentinel — the consumer fell back to invoking
 * `generateInsights()` directly outside the try/catch, re-throwing and
 * crashing the dashboard. Error and success now share one shape.
 */
export const currentInsights: ReadonlySignal<InsightsPayload> = computed(() => {
  const container = getDefaultContainer();

  // Check if initialized to avoid errors during early startup. This check
  // is OUTSIDE the try/catch so that "not yet initialized" stays distinct
  // from "threw while generating" — the former is normal bootstrap flow,
  // the latter is a genuine error we want to surface.
  // Read refreshVersion so this computed re-evaluates after background
  // init resolves INSIGHTS_GENERATOR and bumps the version signal.
  const _refresh = refreshVersion.value;
  void _refresh;

  if (!container.isInitialized(Services.INSIGHTS_GENERATOR)) {
    return { insight1: null, insight2: null, insight3: null };
  }

  try {
    const generateInsights = container.resolveSync<() => InsightsPayload>(Services.INSIGHTS_GENERATOR);

    // Dependencies that trigger recalculation
    const _txCount = transactions.value.length;
    const _month = currentMonth.value;
    const _personality = insightPers.value;
    // CR-Apr22-G slice 1 (P2): insight generators interpolate fmtCur(...),
    // but fmtCur reads from module-level formatter state (synced externally
    // by syncCurrencyFormat), not from the currency signal. Without an
    // explicit read here the computed doesn't re-run when the user changes
    // home currency, so insight copy stays stale until another unrelated
    // dep (tx add, month change, personality) forces a recompute. Reading
    // currency.value establishes the missing signal dep.
    const _currency = currency.value;
    // CR-Apr24-I finding 96: insight generators interpolate category names
    // via getAllCats / getCatInfo, but the computed has no dependency on
    // category metadata. Without this read, renaming or recoloring a
    // category leaves insight copy stale until another dep triggers.
    // `categoryVersion` is bumped by category-store on every config write;
    // reading it here establishes the missing reactive edge without a
    // circular import (category-store already imports signals).
    const _catVer = categoryVersion.value;
    void _catVer; // suppress unused-variable lint

    return generateInsights();
  } catch (e) {
    // Fixes H4 (Inline-Behavior-Review rev 12) and P1 #1 (2026-04-20):
    // surface a user-visible error on slot 1 and flag the payload so the
    // UI suppresses default action buttons on the error message.
    trackError(e instanceof Error ? e : new Error(String(e)), {
      module: 'signals',
      action: 'currentInsights'
    });
    return {
      insight1: 'Insights temporarily unavailable.',
      insight2: null,
      insight3: null,
      _error: true,
    };
  }
});

/**
 * Total expenses by category for current month
 * Returns a map of category ID to total amount
 */
export const expensesByCategory: ReadonlySignal<Record<string, number>> = computed(() => {
  return currentMonthSummary.value.categoryTotals;
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
 * Recomputes when transactions, monthlyAlloc, currentMonth, or today's date
 * (`todayStr`) change.
 *
 * CR-Apr22-D slice 3 (finding 57 [P2]): `getDailyAllowance` uses `new Date()`
 * internally to derive `isCurrentMonth`, `daysRemaining`, and ultimately the
 * per-day allowance figure. Before this slice the computed did not subscribe
 * to `todayStr`, so if the app stayed open across midnight the dashboard kept
 * showing yesterday's `daysRemaining` (and therefore a subtly wrong daily
 * allowance) until some unrelated signal happened to invalidate the computed.
 * Reading `todayStr.value` establishes the dep-track edge that fires on the
 * scheduled midnight tick (see `_scheduleNextMidnight` above), so the card
 * refreshes at 00:00 local without any user action.
 */
export const dailyAllowanceData: ReadonlySignal<DailyAllowanceData> = computed(() => {
  // Access reactive dependencies so signal recomputes when they change
  const _txCount = transactions.value.length;
  const _alloc = monthlyAlloc.value;
  const mk = currentMonth.value;
  // CR-Apr22-D slice 3: subscribe to the midnight-rollover signal so the
  // daily-allowance card refreshes `daysRemaining` (and the derived
  // `dailyAllowance`) exactly when the date flips local-midnight.
  const _today = todayStr.value;

  // Delegate to pure function in calculations.ts
  return getDailyAllowance(mk);
});

/**
 * Spending pace data for current month
 * Delegates to getSpendingPace() in calculations.ts (single source of truth)
 * Shows if spending is ahead, on track, or behind budget pace.
 *
 * CR-Apr22-D slice 3 (finding 57 [P2]): `getSpendingPace` derives its
 * `expectedPercent = dayOfMonth / daysInMonth * 100` from `new Date()`. The
 * `difference = percentOfBudget - expectedPercent` is what classifies the
 * pace as `under` / `on-track` / `over`. Without a subscription to
 * `todayStr`, the expected-percent baseline would freeze at the day the
 * effect last ran, so a user leaving the app open overnight could wake up
 * still flagged as "on track" when pace should have slipped (or vice
 * versa). Subscribing to `todayStr.value` forces a midnight recompute.
 */
export const spendingPaceData: ReadonlySignal<SpendingPaceData> = computed(() => {
  // Access reactive dependencies so signal recomputes when they change
  const _txCount = transactions.value.length;
  const _alloc = monthlyAlloc.value;
  const mk = currentMonth.value;
  // CR-Apr22-D slice 3: subscribe to the midnight-rollover signal so the
  // expected-percent baseline advances with the real calendar day.
  const _today = todayStr.value;

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
  // rev 12 / #39 M4: see `budgetRemaining` above for helper rationale.
  const alloc = getMonthAlloc(mk, monthlyAlloc.value);
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
export type BudgetAlertEntry = { key: string; text: string; categoryId: string; percentSpent: number };

type AlertInputsSignature = {
  mk: string;
  allocSignature: string;
  expJson: string;
  threshold: number | null;
  dismissedSignature: string;
  // CR-Apr22-F slice 3: memoize the rollover map separately from the base
  // allocation so toggling `rolloverSettings.enabled` or editing a prior
  // month's spend (which shifts this month's rollover) invalidates the
  // cached entries. Empty string when rollover is disabled so the
  // enabled→disabled transition is itself a signature change.
  rolloversSignature: string;
};

/**
 * Pure helper — compute the budget-alert entries for an arbitrary month.
 *
 * Split out so we can drive two consumers with different month-key sources:
 *   - `activeAlertEntries` uses `currentMonth.value` (the VIEWED month). This
 *     feeds the in-app alert list at `inline-alerts.ts`, where it's correct
 *     for the UI to show "what alerts would apply to the month the user is
 *     currently looking at."
 *   - `todayMonthAlertEntries` uses the calendar-current month derived from
 *     `todayStr`. This feeds `browser-notifications.ts`, where notifications
 *     must ONLY fire for the actual current month — otherwise a user who
 *     navigates to a prior month in the UI re-fires historical notifications
 *     they already saw (and moving back to this month compacts them out of
 *     storage, causing a second re-fire on the next reload).
 *
 * CR-Apr22-F slice 2: extracted from the prior single-site computed body
 * so the today-month variant can share logic + memoization shape without
 * code duplication. See `todayMonthAlertEntries` below for the notification
 * caller.
 */
function _runAlertComputation(
  mk: string,
  alloc: Record<string, number>,
  expByCat: Record<string, number>,
  alertSettings: AlertPrefs,
  dismissed: ReadonlySet<string>,
  rollovers: Record<string, number>
): BudgetAlertEntry[] {
  if (alertSettings.budgetThreshold === null) return [];

  const foundAlerts: BudgetAlertEntry[] = [];
  Object.entries(alloc).forEach(([catId, amt]) => {
    // CR-Apr22-F slice 3: compare spend against the rollover-adjusted
    // effective budget so the alert list agrees with the envelope-budget
    // view (which already uses `amt + rollover`). Previously the alert
    // fired purely off the base allocation, surfacing "85% spent" warnings
    // for categories that still had a 30% carryover buffer left — bad
    // signal, and contradicts the on-screen envelope rollup.
    const rollover = rollovers[catId] || 0;
    const effectiveBudget = amt + rollover;
    if (!(effectiveBudget > 0)) return;

    const spent = expByCat[catId] || 0;
    if (spent >= effectiveBudget * alertSettings.budgetThreshold!) {
      const cat = getCatInfo('expense', catId);
      const percentSpent = Math.round(spent / effectiveBudget * 100);
      const percentLabel = percentSpent > 999 ? '>999' : String(percentSpent);
      const alertText = `${cat.emoji} ${cat.name}: ${percentLabel}% spent`;
      const alertKey = `${mk}:${catId}:budget-threshold`;
      const legacyAlertKey = `${mk}:${alertText}`;

      if (!dismissed.has(alertKey) && !dismissed.has(legacyAlertKey)) {
        foundAlerts.push({
          key: alertKey,
          text: alertText,
          categoryId: catId,
          percentSpent
        });
      }
    }
  });
  return foundAlerts;
}

function _signatureFor(
  mk: string,
  alloc: Record<string, number>,
  expByCat: Record<string, number>,
  alertSettings: AlertPrefs,
  dismissed: ReadonlySet<string>,
  rollovers: Record<string, number>
): AlertInputsSignature {
  const allocSignature = Object.entries(alloc)
    .sort(([leftCategoryId], [rightCategoryId]) => leftCategoryId.localeCompare(rightCategoryId))
    .map(([categoryId, amount]) => `${categoryId}:${amount}`)
    .join('|');
  const rolloversSignature = Object.entries(rollovers)
    .sort(([leftCategoryId], [rightCategoryId]) => leftCategoryId.localeCompare(rightCategoryId))
    .map(([categoryId, amount]) => `${categoryId}:${amount}`)
    .join('|');
  return {
    mk,
    allocSignature,
    expJson: JSON.stringify(expByCat),
    threshold: alertSettings.budgetThreshold,
    dismissedSignature: Array.from(dismissed).sort().join('|'),
    rolloversSignature
  };
}

function _sameSignature(a: AlertInputsSignature, b: AlertInputsSignature): boolean {
  return a.mk === b.mk
    && a.allocSignature === b.allocSignature
    && a.expJson === b.expJson
    && a.threshold === b.threshold
    && a.dismissedSignature === b.dismissedSignature
    && a.rolloversSignature === b.rolloversSignature;
}

let _prevAlertInputs: AlertInputsSignature | null = null;
let _prevAlertEntries: BudgetAlertEntry[] = [];

export const activeAlertEntries: ReadonlySignal<BudgetAlertEntry[]> = computed(() => {
  const mk = currentMonth.value;
  // rev 12 / #39 M4: see `budgetRemaining` above for helper rationale.
  const alloc = getMonthAlloc(mk, monthlyAlloc.value);
  const expByCat = expensesByCategory.value;
  const alertSettings = alerts.value;
  const dismissed = dismissedAlerts.value;
  // CR-Apr22-F slice 3: subscribe to `rolloverSettings` (via the explicit
  // `.value` read) so the computed re-runs when the user toggles rollover
  // on/off. The rollover MAP itself changes reactively because
  // `calculateMonthRollovers` reads `signals.monthlyAlloc.value` +
  // prior-month spend — both of which already flow into the signature via
  // `alloc` + `expJson` transitively at the caller — but the enabled-flag
  // toggle needs an explicit read so signals tracks it.
  void rolloverSettings.value;
  const rollovers = isRolloverEnabled() ? calculateMonthRollovers(mk) : {};

  const inputs = _signatureFor(mk, alloc, expByCat, alertSettings, dismissed, rollovers);
  if (_prevAlertInputs && _sameSignature(_prevAlertInputs, inputs)) {
    return _prevAlertEntries;
  }

  const foundAlerts = _runAlertComputation(mk, alloc, expByCat, alertSettings, dismissed, rollovers);
  _prevAlertInputs = inputs;
  _prevAlertEntries = foundAlerts;
  return foundAlerts;
});

export const activeAlerts: ReadonlySignal<string[]> = computed(() => {
  return activeAlertEntries.value.map((alert) => alert.text);
});

/**
 * Calendar-current month key (YYYY-MM), derived from `todayStr`.
 *
 * Updates automatically at midnight via the `todayStr` signal's midnight
 * timer, so a month rollover is captured without any consumer opt-in.
 */
export const todayMonth: ReadonlySignal<string> = computed(() =>
  todayStr.value.slice(0, 7)
);

/**
 * Budget-alert entries keyed to the ACTUAL current calendar month (not the
 * viewed month). See `_runAlertComputation` above for the split rationale.
 *
 * CR-Apr22-F slice 2: used exclusively by `browser-notifications.ts` so
 * notifications fire only for today's month. Independent memoization state
 * from `activeAlertEntries` because the two signals accept different mks
 * and a single memoization slot would thrash on every month-navigation.
 */
let _prevTodayAlertInputs: AlertInputsSignature | null = null;
let _prevTodayAlertEntries: BudgetAlertEntry[] = [];

export const todayMonthAlertEntries: ReadonlySignal<BudgetAlertEntry[]> = computed(() => {
  const mk = todayMonth.value;
  const alloc = getMonthAlloc(mk, monthlyAlloc.value);
  // Read expense-by-category directly off monthSummaries for today's month
  // rather than via `expensesByCategory` (which is scoped to currentMonth).
  // Falls back to empty record when the month has no summary entry yet.
  const monthSummary = monthSummaries.value[mk];
  const expByCat = monthSummary ? monthSummary.categoryTotals : {};
  const alertSettings = alerts.value;
  const dismissed = dismissedAlerts.value;
  // CR-Apr22-F slice 3: match `activeAlertEntries` — compare spend against
  // the rollover-adjusted effective budget.
  void rolloverSettings.value;
  const rollovers = isRolloverEnabled() ? calculateMonthRollovers(mk) : {};

  const inputs = _signatureFor(mk, alloc, expByCat, alertSettings, dismissed, rollovers);
  if (_prevTodayAlertInputs && _sameSignature(_prevTodayAlertInputs, inputs)) {
    return _prevTodayAlertEntries;
  }

  const foundAlerts = _runAlertComputation(mk, alloc, expByCat, alertSettings, dismissed, rollovers);
  _prevTodayAlertInputs = inputs;
  _prevTodayAlertEntries = foundAlerts;
  return foundAlerts;
});

/**
 * Whether budget allocations exist for current month
 */
export const hasBudgetAllocations: ReadonlySignal<boolean> = computed(() => {
  const mk = currentMonth.value;
  // rev 12 / #39 M4: see `budgetRemaining` above for helper rationale.
  const alloc = getMonthAlloc(mk, monthlyAlloc.value);
  return Object.keys(alloc).length > 0;
});

/**
 * Total budget for current month
 */
export const totalBudget: ReadonlySignal<number> = computed(() => {
  const mk = currentMonth.value;
  // rev 12 / #39 M4: see `budgetRemaining` above for helper rationale.
  const alloc = getMonthAlloc(mk, monthlyAlloc.value);
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
  // CR-Apr24-I finding 209: previously `sendStateUpdate` was called
  // with no revision metadata, so sibling tabs couldn't correlate the
  // incoming remote update with the revision ledger. Now await the
  // revision from `recordStateChange` and forward it to the broadcast.
  onWrite: async (key, value) => {
    const rev = await stateRevision.recordStateChange(key, value, getTabId());
    broadcastManager.sendStateUpdate(key, value, { revision: rev.revision });
  }
});

// Register all persisted signals with the batcher.
// This is O(1) per change instead of O(N) where N is number of signals.
//
// CR-Apr24-I finding 225: SK.ONBOARD, SK.LAST_BACKUP, and
// BACKUP_REMINDER_TX_COUNT_KEY were previously registered here even
// though `multi-tab-sync.updateLocalState()` has no handler for them.
// Every write to those signals generated cross-tab `state_update`
// traffic that sibling tabs silently dropped. Removed from this block
// so only keys with a matching `updateLocalState` branch (or storage-
// event fanout path) get broadcast. The signals are still persisted
// locally via their own direct `persist()` calls at their mutation
// sites (onboarding.ts, import-export.ts, etc.).
batcher.registerSignals({
  [SK.SAVINGS]: savingsGoals,
  [SK.SAVINGS_CONTRIB]: savingsContribs,
  [SK.ALLOC]: monthlyAlloc,
  [SK.ACHIEVE]: achievements,
  [SK.STREAK]: streak,
  [SK.DEBTS]: debts,
  [SK.CURRENCY]: currency,
  [SK.SECTIONS]: sections,
  [SK.PIN]: pin,
  [SK.INSIGHT_PERS]: insightPers,
  [SK.ALERTS]: alerts,
  [SK.THEME]: theme,
  [SK.ROLLOVER_SETTINGS]: rolloverSettings,
  [SK.FILTER_PRESETS]: filterPresets,
  [SK.TX_TEMPLATES]: txTemplates
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
