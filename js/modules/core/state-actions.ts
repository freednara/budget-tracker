/**
 * State Actions Module
 * Centralized state mutations with validation and event emission.
 * Replaces scattered direct S.property = value assignments.
 *
 * @module state-actions
 */

import * as signals from './signals.js';
import { batch } from '@preact/signals-core';
import { emit, Events } from './event-bus.js';
import { SK, normalizeAlertPrefs } from './state.js';
import { dataSdk } from '../data/data-manager.js';
import { generateSecureId } from './utils-dom.js';
import {
  SAVINGS_TRANSFER_CATEGORY_ID,
  SAVINGS_TRANSFER_NOTE_MARKER,
  SAVINGS_TRANSFER_TAG
} from './transaction-classification.js';
import type {
  TransactionType,
  MainTab,
  InsightPersonality,
  Transaction,
  FilterPreset,
  TxTemplate,
  SavingsGoal,
  SavingsContribution,
  AlertPrefs,
  MonthlyAllocation,
  RolloverSettings,
  PaginationState,
  Theme,
  Debt,
  CustomCategory,
  CurrencySettings,
  SectionsConfig,
  StreakData
} from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface PendingEvent {
  event: string;
  payload: unknown;
}

// ==========================================
// BATCHING SUPPORT
// ==========================================

let batchDepth = 0;
let pendingEvents: PendingEvent[] = [];

/**
 * Batch multiple state changes into a single render cycle.
 * Events are collected and emitted after all changes complete.
 */
export function batchUpdates(fn: () => void): void {
  batchDepth++;
  try {
    batch(fn);
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      flushPendingEvents();
    }
  }
}

/**
 * Queue an event for emission (used internally during batching)
 */
function queueEvent(event: string, payload?: unknown): void {
  if (batchDepth > 0) {
    pendingEvents.push({ event, payload });
  } else {
    emit(event, payload);
  }
}

/**
 * Flush all pending events after batch completes
 */
function flushPendingEvents(): void {
  const events = pendingEvents;
  pendingEvents = [];
  events.forEach(({ event, payload }) => emit(event, payload));
}

// ==========================================
// NAVIGATION ACTIONS
// ==========================================

export const navigation = {
  setCurrentMonth(monthKey: string): boolean {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return false;
    // Validate month is 01-12
    const month = parseInt(monthKey.split('-')[1], 10);
    if (month < 1 || month > 12) return false;
    signals.currentMonth.value = monthKey;
    queueEvent(Events.MONTH_CHANGED, monthKey);
    return true;
  },

  prevMonth(): boolean {
    const [y, m] = signals.currentMonth.value.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  nextMonth(): boolean {
    const [y, m] = signals.currentMonth.value.split('-').map(Number);
    const d = new Date(y, m, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  setCurrentTab(type: TransactionType): boolean {
    if (type !== 'expense' && type !== 'income') return false;
    signals.currentTab.value = type;
    signals.currentType.value = type;
    queueEvent(Events.TAB_CHANGED, type);
    return true;
  },

  setActiveMainTab(tabName: MainTab): boolean {
    const validTabs: MainTab[] = ['dashboard', 'transactions', 'budget', 'calendar'];
    if (!validTabs.includes(tabName)) return false;
    signals.activeMainTab.value = tabName;
    return true;
  },

  toggleFiltersExpanded(): void {
    signals.filtersExpanded.value = !signals.filtersExpanded.value;
  },

  setFiltersExpanded(expanded: boolean): void {
    signals.filtersExpanded.value = expanded;
  },

  goToMonth(monthKey: string): boolean {
    return this.setCurrentMonth(monthKey);
  }
};

// ==========================================
// FORM & MODAL ACTIONS
// ==========================================

export const form = {
  setSelectedCategory(categoryId: string): boolean {
    signals.selectedCategory.value = categoryId || '';
    return true;
  },

  clearSelectedCategory(): void {
    signals.selectedCategory.value = '';
  },

  setEditingId(txId: string | null): boolean {
    signals.editingId.value = txId;
    return true;
  },

  setEditSeriesMode(mode: boolean): void {
    signals.editSeriesMode.value = mode;
  }
};

export const modal = {
  setDeleteTargetId(txId: string | null): boolean {
    signals.deleteTargetId.value = txId;
    return true;
  },

  clearDeleteTargetId(): void {
    signals.deleteTargetId.value = null;
  },

  setAddSavingsGoalId(goalId: string | null): boolean {
    signals.addSavingsGoalId.value = goalId;
    return true;
  },

  clearAddSavingsGoalId(): void {
    signals.addSavingsGoalId.value = null;
  },

  setSplitTxId(txId: string | null): boolean {
    signals.splitTxId.value = txId;
    if (txId === null) {
      signals.splitRows.value = [];
      return true;
    }

    const tx = signals.transactions.value.find((item) => item.__backendId === txId);
    if (tx) {
      const initialRow: signals.SplitRow = {
        id: `row_${generateSecureId()}`,
        categoryId: tx.category || 'other',
        amount: tx.amount
      };
      signals.splitRows.value = [initialRow];
    } else {
      signals.splitRows.value = [];
    }
    return true;
  },

  clearSplitTxId(): void {
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
  },

  clearPendingEditTx(): void {
    signals.pendingEditTx.value = null;
  },

  setSplitRows(rows: signals.SplitRow[]): void {
    signals.splitRows.value = [...rows];
  },

  addSplitRow(row: signals.SplitRow): void {
    signals.splitRows.value = [...signals.splitRows.value, row];
  },

  updateSplitRow(rowId: string, updates: Partial<signals.SplitRow>): boolean {
    const existing = signals.splitRows.value.some((row) => row.id === rowId);
    if (!existing) return false;
    signals.splitRows.value = signals.splitRows.value.map((row) =>
      row.id === rowId ? { ...row, ...updates } : row
    );
    return true;
  },

  removeSplitRow(rowId: string): boolean {
    const nextRows = signals.splitRows.value.filter((row) => row.id !== rowId);
    if (nextRows.length === signals.splitRows.value.length) return false;
    signals.splitRows.value = nextRows;
    return true;
  }
};

// ==========================================
// SETTINGS & DATA ACTIONS
// ==========================================

export const settings = {
  setCurrency(currencyCode: string, symbol: string): void {
    signals.currency.value = { home: currencyCode, symbol };
  },

  setRolloverSettings(settings: Partial<RolloverSettings>): void {
    signals.rolloverSettings.value = {
      ...(signals.rolloverSettings.value || {
        enabled: false,
        mode: 'all',
        categories: [],
        maxRollover: null,
        negativeHandling: 'zero'
      }),
      ...settings,
      enabled: settings.enabled ?? signals.rolloverSettings.value.enabled ?? false,
      mode: settings.mode || signals.rolloverSettings.value.mode || 'all',
      categories: Array.isArray(settings.categories)
        ? settings.categories
        : (signals.rolloverSettings.value.categories || []),
      maxRollover: settings.maxRollover ?? signals.rolloverSettings.value.maxRollover ?? null,
      negativeHandling: settings.negativeHandling || signals.rolloverSettings.value.negativeHandling || 'zero'
    };
    queueEvent(Events.ROLLOVER_SETTINGS_CHANGED, signals.rolloverSettings.value);
  },

  setPin(value: string): void {
    signals.pin.value = value;
  },

  clearPin(): void {
    signals.pin.value = '';
  },

  setInsightPersonality(personality: InsightPersonality): void {
    signals.insightPers.value = personality;
  },

  setAlerts(nextAlerts: AlertPrefs): void {
    signals.alerts.value = nextAlerts;
  },

  setTheme(theme: Theme): void {
    signals.theme.value = theme;
    queueEvent(Events.THEME_CHANGED, theme);
  },

  setSections(nextSections: SectionsConfig): void {
    signals.sections.value = { ...nextSections };
  },

  setAchievements(achievements: Record<string, boolean>): void {
    signals.achievements.value = { ...achievements };
  },

  setStreak(streak: StreakData): void {
    signals.streak.value = { ...streak };
  }
};

export const data = {
  setMonthlyAllocations(allocations: Record<string, MonthlyAllocation>): void {
    signals.monthlyAlloc.value = allocations;
    queueEvent(Events.BUDGET_UPDATED, allocations);
  },

  setCustomCategories(categories: CustomCategory[]): void {
    signals.customCats.value = [...categories];
    queueEvent(Events.CATEGORY_UPDATED, categories);
  },

  setFilterPresets(presets: FilterPreset[]): void {
    signals.filterPresets.value = presets;
  },

  removeFilterPreset(presetId: string): void {
    signals.filterPresets.value = signals.filterPresets.value.filter(p => p.id !== presetId);
  },

  removeContributionsForGoal(goalId: string): void {
    signals.savingsContribs.value = signals.savingsContribs.value.filter(c => c.goalId !== goalId);
  },

  setTxTemplates(templates: TxTemplate[]): void {
    signals.txTemplates.value = templates;
  },

  removeTxTemplate(templateId: string): void {
    signals.txTemplates.value = signals.txTemplates.value.filter(t => t.id !== templateId);
  },

  setCurrencySettings(currency: CurrencySettings): void {
    signals.currency.value = { ...currency };
  }
};

// ==========================================
// SAVINGS GOAL ACTIONS
// ==========================================

interface SavingsGoalData {
  name: string;
  target_amount: number;
  saved_amount?: number;
  deadline?: string;
}

export const savingsGoals = {
  setGoals(goals: Record<string, SavingsGoal>, options: { emitEvent?: boolean } = {}): void {
    signals.savingsGoals.value = { ...goals };
    if (options.emitEvent !== false) {
      queueEvent(Events.SAVINGS_UPDATED, goals);
    }
  },

  setContributions(contributions: SavingsContribution[]): void {
    signals.savingsContribs.value = [...contributions];
  },

  addGoal(goalData: SavingsGoalData): string {
    const id = `sg_${generateSecureId()}`;
    const newGoal: SavingsGoal = {
      id,
      name: goalData.name,
      target: goalData.target_amount,
      saved: goalData.saved_amount || 0,
      deadline: goalData.deadline || ''
    };

    signals.savingsGoals.value = { ...signals.savingsGoals.value, [id]: newGoal };
    queueEvent(Events.SAVINGS_GOAL_ADDED, { id, goal: newGoal });
    return id;
  },

  deleteGoal(goalId: string): boolean {
    const currentGoals = signals.savingsGoals.value;
    if (!currentGoals[goalId]) return false;

    batchUpdates(() => {
      const { [goalId]: _removed, ...remaining } = currentGoals;
      signals.savingsGoals.value = remaining;
      data.removeContributionsForGoal(goalId);
    });

    queueEvent(Events.SAVINGS_GOAL_DELETED, { id: goalId });
    return true;
  },

  async addContribution(goalId: string, amount: number): Promise<boolean> {
    const goal = signals.savingsGoals.value[goalId];
    if (!goal) return false;

    // Use atomic ledger for the transaction
    const txResult = await dataSdk.create({
      type: 'expense',
      category: SAVINGS_TRANSFER_CATEGORY_ID,
      amount: amount,
      description: `Savings Transfer: ${goal.name}`,
      notes: `${SAVINGS_TRANSFER_NOTE_MARKER} Contribution to goal: ${goal.name} [id:${goalId}]`,
      tags: `savings,goal,${SAVINGS_TRANSFER_TAG}`,
      date: new Date().toISOString().split('T')[0]
    });

    if (!txResult.isOk) return false;

    batchUpdates(() => {
      const updatedGoal = { ...goal, saved: (goal.saved || 0) + amount };
      signals.savingsGoals.value = { ...signals.savingsGoals.value, [goalId]: updatedGoal };

      const newContrib: SavingsContribution = {
        id: `sc_${generateSecureId()}`,
        date: new Date().toISOString().split('T')[0],
        goalId,
        amount,
        transactionId: txResult.data?.__backendId
      };
      signals.savingsContribs.value = [...signals.savingsContribs.value, newContrib];
    });

    queueEvent(Events.SAVINGS_CONTRIBUTION_ADDED, { goalId, amount });
    return true;
  }
};

// ==========================================
// PAGINATION ACTIONS
// ==========================================

export const pagination = {
  setPage(page: number): void {
    const current = signals.pagination.value;
    signals.pagination.value = {
      ...current,
      page: Math.max(0, Math.min(page, current.totalPages - 1))
    };
  },

  resetPage(): void {
    this.setPage(0);
  }
};

// ==========================================
// FILTER / CALENDAR / ALERT / ONBOARDING / DEBT ACTIONS
// ==========================================

const DEFAULT_FILTER_STATE: signals.FilterState = {
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
};

export const filters = {
  setFilters(nextFilters: signals.FilterState): void {
    signals.filters.value = { ...nextFilters };
    queueEvent(Events.FILTER_CHANGED, signals.filters.value);
  },

  updateFilters(updates: Partial<signals.FilterState>): void {
    signals.filters.value = { ...signals.filters.value, ...updates };
    queueEvent(Events.FILTER_CHANGED, signals.filters.value);
  },

  clearFilters(): void {
    this.setFilters(DEFAULT_FILTER_STATE);
  },

  setExpanded(expanded: boolean): void {
    navigation.setFiltersExpanded(expanded);
  }
};

export const calendar = {
  setSelectedDay(day: number | null): void {
    signals.selectedCalendarDay.value = day;
  },

  clearSelectedDay(): void {
    signals.selectedCalendarDay.value = null;
  }
};

export const alerts = {
  dismissAlert(alertId: string, monthKey?: string): void {
    if (!alertId) return;
    const activeMonth = monthKey || signals.currentMonth.value;
    const normalizedAlertId = alertId.startsWith(`${activeMonth}:`)
      ? alertId
      : `${activeMonth}:${alertId.replace(/ \(\+\d+ more\)$/, '')}`;
    const nextDismissed = new Set(signals.dismissedAlerts.value);
    nextDismissed.add(normalizedAlertId);
    signals.dismissedAlerts.value = nextDismissed;
  }
};

export const onboarding = {
  setState(nextState: signals.OnboardingState): void {
    signals.onboarding.value = { ...nextState };
  },

  start(): void {
    signals.onboarding.value = { ...signals.onboarding.value, active: true };
  },

  nextStep(totalSteps: number): void {
    const currentState = signals.onboarding.value;
    const nextStep = currentState.step + 1;
    if (nextStep >= totalSteps) {
      signals.onboarding.value = { active: false, step: 0, completed: true };
      return;
    }
    signals.onboarding.value = { ...currentState, step: nextStep };
  },

  complete(): void {
    signals.onboarding.value = { active: false, step: 0, completed: true };
  },

  reset(): void {
    signals.onboarding.value = { active: true, step: 0, completed: false };
  }
};

export const debts = {
  setDebts(nextDebts: Debt[]): void {
    signals.debts.value = [...nextDebts];
  },

  addDebt(nextDebt: Debt): void {
    signals.debts.value = [...signals.debts.value, nextDebt];
  },

  replaceDebt(debtId: string, nextDebt: Debt): boolean {
    const exists = signals.debts.value.some((debt) => debt.id === debtId);
    if (!exists) return false;
    signals.debts.value = signals.debts.value.map((debt) => debt.id === debtId ? nextDebt : debt);
    return true;
  },

  removeDebt(debtId: string): boolean {
    const nextDebts = signals.debts.value.filter((debt) => debt.id !== debtId);
    if (nextDebts.length === signals.debts.value.length) return false;
    signals.debts.value = nextDebts;
    return true;
  }
};

export const syncState = {
  applyKeyUpdate(key: string, value: unknown): boolean {
    switch (key) {
      case SK.TX:
        signals.replaceTransactionLedger(value as Transaction[]);
        return true;
      case SK.THEME:
        settings.setTheme(value as Theme);
        return true;
      case SK.PIN:
        settings.setPin(value as string);
        return true;
      case SK.ALLOC:
        data.setMonthlyAllocations(value as Record<string, MonthlyAllocation>);
        return true;
      case SK.SAVINGS:
        savingsGoals.setGoals(value as Record<string, SavingsGoal>);
        return true;
      case SK.CUSTOM_CAT:
        data.setCustomCategories(value as CustomCategory[]);
        return true;
      case SK.DEBTS:
        debts.setDebts(value as Debt[]);
        return true;
      case SK.CURRENCY:
        data.setCurrencySettings(value as CurrencySettings);
        return true;
      case SK.SAVINGS_CONTRIB:
        savingsGoals.setContributions(value as SavingsContribution[]);
        return true;
      case SK.ROLLOVER_SETTINGS:
        settings.setRolloverSettings(value as Partial<RolloverSettings>);
        return true;
      case SK.SECTIONS:
        settings.setSections(value as SectionsConfig);
        return true;
      case SK.ALERTS:
        settings.setAlerts(normalizeAlertPrefs(value));
        return true;
      case SK.INSIGHT_PERS:
        settings.setInsightPersonality(value as InsightPersonality);
        return true;
      case SK.ACHIEVE:
        settings.setAchievements(value as Record<string, boolean>);
        return true;
      case SK.STREAK:
        settings.setStreak(value as StreakData);
        return true;
      case SK.FILTER_PRESETS:
        data.setFilterPresets(value as FilterPreset[]);
        return true;
      case SK.TX_TEMPLATES:
        data.setTxTemplates(value as TxTemplate[]);
        return true;
      default:
        return false;
    }
  }
};

// ==========================================
// COMBINED ACTIONS EXPORT
// ==========================================

export const actions = {
  batchUpdates,
  navigation,
  form,
  modal,
  settings,
  data,
  savingsGoals,
  pagination,
  filters,
  calendar,
  alerts,
  onboarding,
  debts,
  syncState
};

export default actions;
