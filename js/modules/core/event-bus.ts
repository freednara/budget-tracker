/**
 * Event Bus Module
 *
 * Lightweight pub/sub for targeted UI updates.
 * Replaces brute-force refreshAll() with granular event-driven rendering.
 *
 * @module event-bus
 */

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export type EventHandler<T = unknown> = (payload: T) => void;

export type UnsubscribeFn = () => void;

// ==========================================
// EVENT LISTENER STORAGE
// ==========================================

const listeners = new Map<string, EventHandler[]>();

// ==========================================
// EVENT BUS FUNCTIONS
// ==========================================

/**
 * Emit an event to all registered handlers
 */
export function emit<T = unknown>(event: string, payload?: T): void {
  const handlers = listeners.get(event) || [];
  handlers.forEach(fn => {
    try {
      fn(payload);
    } catch (e) {
      console.error(`Event handler failed for ${event}:`, e);
    }
  });
}

/**
 * Subscribe to an event
 * @returns Unsubscribe function
 */
export function on<T = unknown>(event: string, handler: EventHandler<T>): UnsubscribeFn {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event)!.push(handler as EventHandler);
  return () => off(event, handler as EventHandler);
}

/**
 * Unsubscribe from an event
 */
export function off(event: string, handler: EventHandler): void {
  const handlers = listeners.get(event);
  if (handlers) {
    const idx = handlers.indexOf(handler);
    if (idx > -1) handlers.splice(idx, 1);
  }
}

/**
 * Clear all listeners (useful for testing)
 */
export function clearAll(): void {
  listeners.clear();
}

// ==========================================
// STANDARD EVENT NAMES
// ==========================================

export const Events = {
  // Transaction events
  TRANSACTION_ADDED: 'transaction:added',
  TRANSACTIONS_BATCH_ADDED: 'transactions:batch_added',
  TRANSACTION_UPDATED: 'transaction:updated',
  TRANSACTION_DELETED: 'transaction:deleted',

  // Navigation events
  MONTH_CHANGED: 'month:changed',
  TAB_CHANGED: 'tab:changed',

  // Data events
  BUDGET_UPDATED: 'budget:updated',
  SAVINGS_UPDATED: 'savings:updated',
  CATEGORY_UPDATED: 'category:updated',

  // Filter events
  FILTER_CHANGED: 'filter:changed',

  // UI events
  THEME_CHANGED: 'theme:changed',

  // Import/export events
  DATA_IMPORTED: 'data:imported',

  // Debt events
  DEBT_ADDED: 'debt:added',
  DEBT_UPDATED: 'debt:updated',
  DEBT_DELETED: 'debt:deleted',
  DEBT_PAYMENT: 'debt:payment',

  // Rollover events
  ROLLOVER_SETTINGS_CHANGED: 'rollover:settings_changed',

  // Savings goal events
  SAVINGS_GOAL_ADDED: 'savings:goal_added',
  SAVINGS_GOAL_DELETED: 'savings:goal_deleted',
  SAVINGS_CONTRIBUTION_ADDED: 'savings:contribution_added',

  // Storage sync events (used by storage-manager)
  STORAGE_SYNC: 'storage:sync'
} as const;

// Export type for Events keys
export type EventName = typeof Events[keyof typeof Events];
