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
  MonthlyAllocation,
  RolloverSettings,
  PaginationState
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
    const validTabs: MainTab[] = ['dashboard', 'transactions', 'budget'];
    if (!validTabs.includes(tabName)) return false;
    signals.activeMainTab.value = tabName;
    return true;
  },

  toggleFiltersExpanded(): void {
    signals.filtersExpanded.value = !signals.filtersExpanded.value;
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
      enabled: !!settings.enabled,
      mode: settings.mode || 'all',
      categories: Array.isArray(settings.categories) ? settings.categories : [],
      maxRollover: settings.maxRollover ?? null,
      negativeHandling: settings.negativeHandling || 'zero'
    };
  },

  setPin(value: string): void {
    signals.pin.value = value;
  },

  clearPin(): void {
    signals.pin.value = '';
  },

  setInsightPersonality(personality: InsightPersonality): void {
    signals.insightPers.value = personality;
  }
};

export const data = {
  setMonthlyAllocations(allocations: Record<string, MonthlyAllocation>): void {
    signals.monthlyAlloc.value = allocations;
    queueEvent(Events.BUDGET_UPDATED, allocations);
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
  pagination
};

export default actions;
