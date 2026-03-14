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
import type {
  TransactionType,
  MainTab,
  InsightPersonality,
  Transaction,
  FilterPreset,
  TxTemplate,
  SavingsContribution,
  RolloverSettings,
  PaginationState,
  CurrencySettings
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
 * Uses @preact/signals-core batch for signal updates.
 */
export function batchUpdates(fn: () => void): void {
  batchDepth++;
  try {
    batch(fn);  // Use signal batch for grouped updates
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
    // Deduplicate events during batching
    const existing = pendingEvents.find(e => e.event === event);
    if (existing) {
      existing.payload = payload; // Update with latest payload
    } else {
      pendingEvents.push({ event, payload });
    }
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
  /**
   * Set the current month for viewing
   */
  setCurrentMonth(monthKey: string): boolean {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      console.warn('setCurrentMonth: Invalid month format, expected YYYY-MM');
      return false;
    }
    signals.currentMonth.value = monthKey;
    queueEvent(Events.MONTH_CHANGED, monthKey);
    return true;
  },

  /**
   * Navigate to previous month
   */
  prevMonth(): boolean {
    const [y, m] = signals.currentMonth.value.split('-').map(Number);
    const d = new Date(y, m - 2, 1); // m-1 for 0-index, -1 for prev
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  /**
   * Navigate to next month
   */
  nextMonth(): boolean {
    const [y, m] = signals.currentMonth.value.split('-').map(Number);
    const d = new Date(y, m, 1); // m-1 for 0-index, +1 for next = m
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  /**
   * Set the current expense/income tab
   */
  setCurrentTab(type: TransactionType): boolean {
    if (type !== 'expense' && type !== 'income') {
      console.warn('setCurrentTab: Invalid type, expected "expense" or "income"');
      return false;
    }
    // Update both for backwards compatibility (will be unified later)
    signals.currentTab.value = type;
    signals.currentType.value = type;
    queueEvent(Events.TAB_CHANGED, type);
    return true;
  },

  /**
   * Set the main navigation tab
   */
  setActiveMainTab(tabName: MainTab): boolean {
    const validTabs: MainTab[] = ['dashboard', 'transactions', 'budget'];
    if (!validTabs.includes(tabName)) {
      console.warn(`setActiveMainTab: Invalid tab "${tabName}"`);
      return false;
    }
    signals.activeMainTab.value = tabName;
    return true;
  }
};

// ==========================================
// FORM/EDIT STATE ACTIONS
// ==========================================

export const form = {
  /**
   * Set the currently selected category in the form
   */
  setSelectedCategory(categoryId: string): boolean {
    signals.selectedCategory.value = categoryId || '';
    return true;
  },

  /**
   * Clear the selected category
   */
  clearSelectedCategory(): boolean {
    return this.setSelectedCategory('');
  },

  /**
   * Set the transaction being edited
   */
  setEditingId(txId: string | null): boolean {
    signals.editingId.value = txId;
    return true;
  },

  /**
   * Clear the editing state
   */
  clearEditingId(): boolean {
    return this.setEditingId(null);
  },

  /**
   * Set series edit mode (for recurring transactions)
   */
  setEditSeriesMode(enabled: boolean): boolean {
    signals.editSeriesMode.value = !!enabled;
    return true;
  }
};

// ==========================================
// MODAL STATE ACTIONS
// ==========================================

export const modal = {
  /**
   * Set the transaction pending deletion
   */
  setDeleteTargetId(txId: string | null): boolean {
    signals.deleteTargetId.value = txId;
    return true;
  },

  /**
   * Clear the delete target
   */
  clearDeleteTargetId(): boolean {
    return this.setDeleteTargetId(null);
  },

  /**
   * Set transaction pending edit (for edit-recurring modal)
   */
  setPendingEditTx(tx: Transaction | null): boolean {
    signals.pendingEditTx.value = tx;
    return true;
  },

  /**
   * Clear pending edit transaction
   */
  clearPendingEditTx(): boolean {
    return this.setPendingEditTx(null);
  },

  /**
   * Set the savings goal being added to
   */
  setAddSavingsGoalId(goalId: string | null): boolean {
    signals.addSavingsGoalId.value = goalId;
    return true;
  },

  /**
   * Clear add savings goal modal state
   */
  clearAddSavingsGoalId(): boolean {
    return this.setAddSavingsGoalId(null);
  },

  /**
   * Set the transaction being split
   */
  setSplitTxId(txId: string | null): boolean {
    signals.splitTxId.value = txId;
    return true;
  },

  /**
   * Clear split transaction modal state
   */
  clearSplitTxId(): boolean {
    return this.setSplitTxId(null);
  }
};

// ==========================================
// SETTINGS ACTIONS
// ==========================================

export const settings = {
  /**
   * Set the currency settings
   */
  setCurrency(currencyCode: string, symbol: string): boolean {
    signals.currency.value = { home: currencyCode, symbol };
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Set the insight personality
   */
  setInsightPersonality(personality: InsightPersonality): boolean {
    const valid: InsightPersonality[] = ['serious', 'casual', 'motivating'];
    if (!valid.includes(personality)) {
      console.warn(`setInsightPersonality: Invalid value "${personality}"`);
      return false;
    }
    signals.insightPers.value = personality;
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Set the PIN (encrypted bundle)
   */
  setPin(pinBundle: string): boolean {
    signals.pin.value = pinBundle;
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Clear the PIN
   */
  clearPin(): boolean {
    return this.setPin('');
  },

  /**
   * Update rollover settings
   */
  setRolloverSettings(rolloverSettings: Partial<RolloverSettings>): boolean {
    const validated: RolloverSettings = {
      enabled: !!rolloverSettings.enabled,
      mode: rolloverSettings.mode || 'all',
      categories: Array.isArray(rolloverSettings.categories) ? rolloverSettings.categories : [],
      maxRollover: rolloverSettings.maxRollover ?? null,
      negativeHandling: rolloverSettings.negativeHandling || 'zero'
    };
    signals.rolloverSettings.value = validated;
    // Auto-persisted by effect in signals.ts
    queueEvent(Events.ROLLOVER_SETTINGS_CHANGED, validated);
    return true;
  }
};

// ==========================================
// DATA ACTIONS
// ==========================================

export const data = {
  /**
   * Update filter presets
   */
  setFilterPresets(presets: FilterPreset[]): boolean {
    if (!Array.isArray(presets)) {
      console.warn('setFilterPresets: Expected array');
      return false;
    }
    signals.filterPresets.value = presets;
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Remove a filter preset by ID
   */
  removeFilterPreset(presetId: string): boolean {
    const updated = signals.filterPresets.value.filter((p: FilterPreset) => p.id !== presetId);
    return this.setFilterPresets(updated);
  },

  /**
   * Update transaction templates
   */
  setTxTemplates(templates: TxTemplate[]): boolean {
    if (!Array.isArray(templates)) {
      console.warn('setTxTemplates: Expected array');
      return false;
    }
    signals.txTemplates.value = templates;
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Remove a transaction template by ID
   */
  removeTxTemplate(templateId: string): boolean {
    const updated = signals.txTemplates.value.filter((t: TxTemplate) => t.id !== templateId);
    return this.setTxTemplates(updated);
  },

  /**
   * Update savings contributions
   */
  setSavingsContribs(contributions: SavingsContribution[]): boolean {
    if (!Array.isArray(contributions)) {
      console.warn('setSavingsContribs: Expected array');
      return false;
    }
    signals.savingsContribs.value = contributions;
    // Auto-persisted by effect in signals.ts
    return true;
  },

  /**
   * Remove contributions for a specific goal
   */
  removeContributionsForGoal(goalId: string): boolean {
    const updated = signals.savingsContribs.value.filter((c: SavingsContribution) => c.goalId !== goalId);
    return this.setSavingsContribs(updated);
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
  /**
   * Add a new savings goal (immutable update)
   */
  addGoal(goalData: SavingsGoalData): string {
    const id = `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const newGoal = {
      name: goalData.name,
      target_amount: goalData.target_amount,
      saved_amount: goalData.saved_amount || 0,
      deadline: goalData.deadline || ''
    };

    // Immutable update to trigger signal effects
    const currentGoals = signals.savingsGoals.value as unknown as Record<string, SavingsGoalData>;
    signals.savingsGoals.value = { ...currentGoals, [id]: newGoal };
    // Auto-persisted by effect in signals.ts

    queueEvent(Events.SAVINGS_GOAL_ADDED, { id, goal: newGoal });
    return id;
  },

  /**
   * Delete a savings goal (immutable update)
   */
  deleteGoal(goalId: string): boolean {
    const currentGoals = signals.savingsGoals.value as unknown as Record<string, SavingsGoalData>;
    if (!currentGoals[goalId]) return false;

    // Immutable update - create new object without the deleted goal
    const { [goalId]: _removed, ...remaining } = currentGoals;
    signals.savingsGoals.value = remaining as typeof signals.savingsGoals.value;
    // Auto-persisted by effect in signals.ts

    // Also remove contributions for this goal
    data.removeContributionsForGoal(goalId);

    queueEvent(Events.SAVINGS_GOAL_DELETED, { id: goalId });
    return true;
  },

  /**
   * Add contribution to a goal (immutable update)
   */
  addContribution(goalId: string, amount: number): boolean {
    const currentGoals = signals.savingsGoals.value as unknown as Record<string, SavingsGoalData>;
    const goal = currentGoals[goalId];
    if (!goal) return false;

    // Update goal's saved_amount (immutable)
    const updatedGoal = {
      ...goal,
      saved_amount: (goal.saved_amount || 0) + amount
    };
    signals.savingsGoals.value = {
      ...currentGoals,
      [goalId]: updatedGoal
    } as typeof signals.savingsGoals.value;

    // Add contribution record
    const contribs = [...signals.savingsContribs.value];
    const newContrib: SavingsContribution = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      date: new Date().toISOString().split('T')[0],
      goalId,
      amount
    };
    contribs.push(newContrib);
    signals.savingsContribs.value = contribs;
    // Auto-persisted by effects in signals.ts

    queueEvent(Events.SAVINGS_CONTRIBUTION_ADDED, { goalId, amount, contribution: newContrib });
    return true;
  }
};

// ==========================================
// PAGINATION ACTIONS
// ==========================================

export const pagination = {
  /**
   * Set pagination state
   */
  setPagination(paginationState: Partial<PaginationState>): boolean {
    signals.pagination.value = {
      page: paginationState.page ?? 0,
      totalPages: paginationState.totalPages ?? 0,
      totalItems: paginationState.totalItems ?? 0
    };
    return true;
  },

  /**
   * Set the current page
   */
  setPage(page: number): boolean {
    const current = signals.pagination.value;
    return this.setPagination({
      ...current,
      page: Math.max(0, Math.min(page, current.totalPages - 1))
    });
  },

  /**
   * Go to next page
   */
  nextPage(): boolean {
    return this.setPage(signals.pagination.value.page + 1);
  },

  /**
   * Go to previous page
   */
  prevPage(): boolean {
    return this.setPage(signals.pagination.value.page - 1);
  },

  /**
   * Reset to first page
   */
  resetPage(): boolean {
    return this.setPage(0);
  }
};

// ==========================================
// COMBINED ACTIONS EXPORT
// ==========================================

export const actions = {
  // Batching
  batchUpdates,

  // Navigation
  ...navigation,

  // Form/Edit
  ...form,

  // Modal
  ...modal,

  // Settings
  ...settings,

  // Data
  ...data,

  // Savings Goals
  ...savingsGoals,

  // Pagination
  ...pagination
};

export default actions;
