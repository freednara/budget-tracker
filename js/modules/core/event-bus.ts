/**
 * Event Bus Module
 *
 * Lightweight pub/sub for targeted UI updates with lifecycle management and performance optimizations.
 * Replaces brute-force refreshAll() with granular event-driven rendering.
 *
 * Key improvements:
 * - Lifecycle-aware listener management
 * - Event flood prevention and throttling
 * - Memory leak detection and prevention
 * - Performance monitoring
 *
 * @module event-bus
 */

const DEV = import.meta.env.DEV;

function isEventDebugEnabled(): boolean {
  return DEV && typeof window !== 'undefined' && (window as any).__APP_DEBUG_EVENTS__ === true;
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export type EventHandler<T = unknown> = (payload: T) => void;

export type UnsubscribeFn = () => void;

export interface EventSubscription {
  event: string;
  handler: EventHandler;
  unsubscribe: UnsubscribeFn;
  id: string;
  groupId?: string;
  componentName?: string;
  createdAt: number;
}

export interface EventMetrics {
  name: string;
  emitCount: number;
  lastEmitted: number;
  listenerCount: number;
  throttleHits: number;
}

export interface ListenerGroup {
  id: string;
  componentName: string;
  subscriptions: EventSubscription[];
  createdAt: number;
}

// ==========================================
// EVENT LISTENER STORAGE
// ==========================================

const listeners = new Map<string, Set<EventHandler>>();
const subscriptions = new Map<string, EventSubscription>();
const listenerGroups = new Map<string, ListenerGroup>();

// Performance tracking
const eventMetrics = new Map<string, EventMetrics>();
const throttleDelays = new Map<string, number>();
const lastEmitTimes = new Map<string, number>();

// Configuration
const DEFAULT_THROTTLE_MS = 100;
const MAX_LISTENERS_PER_EVENT = 50;
const MEMORY_CHECK_INTERVAL = 60000; // 1 minute

// Memory monitoring
let memoryCheckTimer: number | null = null;
let totalSubscriptions = 0;

// ==========================================
// LIFECYCLE MANAGEMENT
// ==========================================

/**
 * Create a listener group for a component
 * This enables bulk cleanup when the component is destroyed
 */
export function createListenerGroup(componentName: string): string {
  const groupId = `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  listenerGroups.set(groupId, {
    id: groupId,
    componentName,
    subscriptions: [],
    createdAt: Date.now()
  });
  
  return groupId;
}

/**
 * Destroy a listener group and clean up all its subscriptions
 */
export function destroyListenerGroup(groupId: string): void {
  const group = listenerGroups.get(groupId);
  if (!group) {
    if (DEV) console.warn(`Listener group ${groupId} not found for cleanup`);
    return;
  }
  
  // Unsubscribe all subscriptions in this group through the canonical removal path
  const subscriptionIds = group.subscriptions.map((subscription) => subscription.id);
  subscriptionIds.forEach((subscriptionId) => {
    removeSubscriptionById(subscriptionId);
  });
  
  listenerGroups.delete(groupId);
  
  if (DEV) console.debug(`Cleaned up ${group.subscriptions.length} listeners for component: ${group.componentName}`);
}

/**
 * Get statistics about listener groups for debugging
 */
export function getListenerGroupStats(): Array<{ componentName: string; listenerCount: number; age: number }> {
  return Array.from(listenerGroups.values()).map(group => ({
    componentName: group.componentName,
    listenerCount: group.subscriptions.length,
    age: Date.now() - group.createdAt
  }));
}

// ==========================================
// THROTTLING AND FLOOD PREVENTION
// ==========================================

/**
 * Set throttle delay for a specific event to prevent floods
 */
export function setEventThrottle(event: string, delayMs: number): void {
  throttleDelays.set(event, delayMs);
}

/**
 * Check if an event is being throttled
 */
function isEventThrottled(event: string): boolean {
  // Only throttle events that have been explicitly configured via setEventThrottle
  const throttleDelay = throttleDelays.get(event);
  if (!throttleDelay) return false;

  const lastEmit = lastEmitTimes.get(event) || 0;
  const now = Date.now();
  
  if (now - lastEmit < throttleDelay) {
    // Update metrics
    const metrics = eventMetrics.get(event);
    if (metrics) {
      metrics.throttleHits++;
    }
    return true;
  }
  
  return false;
}

// Pending trailing payloads for throttled events
const pendingTrailingEmits = new Map<string, { payload: unknown; timerId: number }>();

/**
 * Emit with throttling support (trailing-edge: deferred events are replayed after throttle window)
 */
function emitThrottled<T = unknown>(event: string, payload?: T): void {
  if (isEventThrottled(event)) {
    // Schedule a trailing emit so the last event in a burst is never lost
    const existing = pendingTrailingEmits.get(event);
    if (existing) {
      clearTimeout(existing.timerId);
    }
    const throttleDelay = throttleDelays.get(event) || DEFAULT_THROTTLE_MS;
    const timerId = window.setTimeout(() => {
      pendingTrailingEmits.delete(event);
      lastEmitTimes.set(event, Date.now());
      emitImmediate(event, payload);
    }, throttleDelay);
    pendingTrailingEmits.set(event, { payload, timerId });
    return;
  }

  // Cancel any pending trailing emit since we're emitting now
  const existing = pendingTrailingEmits.get(event);
  if (existing) {
    clearTimeout(existing.timerId);
    pendingTrailingEmits.delete(event);
  }

  lastEmitTimes.set(event, Date.now());
  emitImmediate(event, payload);
}

// ==========================================
// EVENT BUS FUNCTIONS
// ==========================================

/**
 * Emit an event to all registered handlers (immediate, bypasses throttling)
 */
export function emitImmediate<T = unknown>(event: string, payload?: T): void {
  const handlers = listeners.get(event);
  const handlerCount = handlers ? handlers.size : 0;

  // Update metrics
  let metrics = eventMetrics.get(event);
  if (!metrics) {
    metrics = {
      name: event,
      emitCount: 0,
      lastEmitted: 0,
      listenerCount: handlerCount,
      throttleHits: 0
    };
    eventMetrics.set(event, metrics);
  }

  metrics.emitCount++;
  metrics.lastEmitted = Date.now();
  metrics.listenerCount = handlerCount;

  if (!handlers || handlerCount === 0) {
    return;
  }

  if (handlerCount > MAX_LISTENERS_PER_EVENT) {
    if (DEV) console.warn(`Event ${event} has ${handlerCount} listeners (max: ${MAX_LISTENERS_PER_EVENT}). Possible memory leak.`);
  }

  for (const fn of handlers) {
    try {
      fn(payload);
    } catch (e) {
      if (DEV) console.error(`Event handler failed for ${event}:`, e);
    }
  }
}

/**
 * Emit an event to all registered handlers (with throttling)
 */
export function emit<T = unknown>(event: string, payload?: T): void {
  emitThrottled(event, payload);
}

/**
 * Subscribe to an event with optional component grouping
 */
export function on<T = unknown>(
  event: string, 
  handler: EventHandler<T>, 
  options?: { 
    groupId?: string;
    componentName?: string;
    throttle?: number;
  }
): UnsubscribeFn {
  // Set up per-subscriber throttling if specified (only set if no existing throttle or shorter delay)
  if (options?.throttle) {
    const existing = throttleDelays.get(event);
    if (!existing || options.throttle < existing) {
      setEventThrottle(event, options.throttle);
    }
  }

  // Add to listeners (Set for O(1) add/delete)
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler as EventHandler);
  
  // Create subscription record
  const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const subscription: EventSubscription = {
    event,
    handler: handler as EventHandler,
    unsubscribe: () => off(event, handler as EventHandler),
    id: subscriptionId,
    groupId: options?.groupId,
    componentName: options?.componentName,
    createdAt: Date.now()
  };
  
  subscriptions.set(subscriptionId, subscription);
  totalSubscriptions++;
  
  // Add to listener group if specified
  if (options?.groupId) {
    const group = listenerGroups.get(options.groupId);
    if (group) {
      group.subscriptions.push(subscription);
    }
  }
  
  // Start memory monitoring if not already running
  if (!memoryCheckTimer && totalSubscriptions > 0) {
    startMemoryMonitoring();
  }
  
  return () => {
    removeSubscriptionById(subscriptionId);
  };
}

/**
 * Unsubscribe from an event
 */
export function off(event: string, handler: EventHandler): void {
  const subscriptionIds = Array.from(subscriptions.values())
    .filter((subscription) => subscription.event === event && subscription.handler === handler)
    .map((subscription) => subscription.id);

  if (subscriptionIds.length === 0) {
    detachHandler(event, handler);
    return;
  }

  subscriptionIds.forEach((subscriptionId) => {
    removeSubscriptionById(subscriptionId);
  });
}

function detachHandler(event: string, handler: EventHandler): void {
  const handlers = listeners.get(event);
  if (!handlers) return;

  handlers.delete(handler);

  if (handlers.size === 0) {
    listeners.delete(event);
    eventMetrics.delete(event);
    lastEmitTimes.delete(event);
  }
}

function removeSubscriptionById(subscriptionId: string): void {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) return;

  detachHandler(subscription.event, subscription.handler);
  subscriptions.delete(subscriptionId);
  totalSubscriptions = Math.max(0, totalSubscriptions - 1);

  if (subscription.groupId) {
    const group = listenerGroups.get(subscription.groupId);
    if (group) {
      const index = group.subscriptions.findIndex((entry) => entry.id === subscriptionId);
      if (index > -1) {
        group.subscriptions.splice(index, 1);
      }
    }
  }
}

/**
 * Clear all listeners (useful for testing and cleanup)
 */
export function clearAll(): void {
  listeners.clear();
  subscriptions.clear();
  listenerGroups.clear();
  eventMetrics.clear();
  throttleDelays.clear();
  lastEmitTimes.clear();
  // Clear pending trailing emits
  for (const [, { timerId }] of pendingTrailingEmits) {
    clearTimeout(timerId);
  }
  pendingTrailingEmits.clear();
  totalSubscriptions = 0;
  
  if (memoryCheckTimer) {
    clearInterval(memoryCheckTimer);
    memoryCheckTimer = null;
  }
}

// ==========================================
// MEMORY MONITORING
// ==========================================

/**
 * Start periodic memory monitoring
 */
function startMemoryMonitoring(): void {
  if (memoryCheckTimer) clearInterval(memoryCheckTimer);
  memoryCheckTimer = window.setInterval(() => {
    checkMemoryUsage();
  }, MEMORY_CHECK_INTERVAL);
}

/**
 * Check for potential memory leaks
 */
function checkMemoryUsage(): void {
  const now = Date.now();
  const oldSubscriptions = [];
  
  // Find old subscriptions (> 10 minutes)
  for (const [id, subscription] of subscriptions) {
    if (now - subscription.createdAt > 600000) { // 10 minutes
      oldSubscriptions.push(subscription);
    }
  }
  
  if (oldSubscriptions.length > 20) {
    if (isEventDebugEnabled()) console.warn(`Found ${oldSubscriptions.length} old event subscriptions. Potential memory leak.`, {
      componentBreakdown: oldSubscriptions.reduce((acc, sub) => {
        const name = sub.componentName || 'unknown';
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    });
  }
  
  // Clean up if we have too many total subscriptions
  if (totalSubscriptions > 500) {
    if (isEventDebugEnabled()) console.error(`Too many event subscriptions (${totalSubscriptions}). Memory leak detected.`);
  }
  
  // Stop monitoring if no subscriptions left
  if (totalSubscriptions === 0 && memoryCheckTimer) {
    clearInterval(memoryCheckTimer);
    memoryCheckTimer = null;
  }
}

// ==========================================
// PERFORMANCE MONITORING
// ==========================================

/**
 * Get performance metrics for all events
 */
export function getEventMetrics(): EventMetrics[] {
  return Array.from(eventMetrics.values());
}

/**
 * Get metrics for a specific event
 */
export function getEventMetric(event: string): EventMetrics | undefined {
  return eventMetrics.get(event);
}

/**
 * Reset metrics (useful for benchmarking)
 */
export function resetMetrics(): void {
  eventMetrics.clear();
}

// ==========================================
// DEBUGGING UTILITIES
// ==========================================

/**
 * Log current event bus state for debugging
 */
export function debugEventBus(): void {
  if (!DEV) return;
  console.group('Event Bus Debug Info');
  console.log('Total subscriptions:', totalSubscriptions);
  console.log('Active events:', Array.from(listeners.keys()));
  console.log('Listener groups:', getListenerGroupStats());
  console.log('Event metrics:', getEventMetrics());
  console.groupEnd();
}

/**
 * Check for orphaned listeners (debug utility)
 */
export function checkOrphanedListeners(): Array<{ event: string; count: number }> {
  return Array.from(listeners.entries()).map(([event, handlers]) => ({
    event,
    count: handlers.size
  })).filter(item => item.count > 0);
}

// ==========================================
// STANDARD EVENT NAMES
// ==========================================

export const Events = {
  // ---- ACTIVE EVENTS (both emitted and listened) ----
  TRANSACTION_ADDED: 'transaction:added',
  TRANSACTIONS_BATCH_ADDED: 'transactions:batch_added',
  TRANSACTION_UPDATED: 'transaction:updated',
  TRANSACTIONS_REPLACED: 'transactions:replaced',
  TRANSACTION_DELETED: 'transaction:deleted',
  MONTH_CHANGED: 'month:changed',
  BUDGET_UPDATED: 'budget:updated',
  SAVINGS_UPDATED: 'savings:updated',
  CATEGORY_UPDATED: 'category:updated',
  DATA_IMPORTED: 'data:imported',

  // ---- EXTENSION POINTS (emitted but no listeners yet) ----
  // Keep these for future use; emitters exist in the codebase
  TAB_CHANGED: 'tab:changed',
  TRANSACTION_ROLLBACK_BATCH: 'transaction:rollback_batch',
  SAVINGS_CONTRIBUTION_ADDED: 'savings:contribution_added',
  TEMPLATE_APPLIED: 'template:applied',
  FORM_SUBMITTED: 'form:submitted',
  FORM_VALIDATED: 'form:validated',
  STORAGE_SYNC: 'storage:sync',
  DEBT_ADDED: 'debt:added',
  DEBT_UPDATED: 'debt:updated',
  DEBT_DELETED: 'debt:deleted',
  DEBT_PAYMENT: 'debt:payment',

  // ---- RESERVED (no emitters or listeners yet — define when needed) ----
  TRANSACTION_MERGED: 'transaction:merged',
  TRANSACTION_SPLIT: 'transaction:split',
  FILTER_CHANGED: 'filter:changed',
  THEME_CHANGED: 'theme:changed',
  SAVINGS_GOAL_ADDED: 'savings:goal_added',
  SAVINGS_GOAL_DELETED: 'savings:goal_deleted',
  DEBT_PAID_OFF: 'debt:paid_off',
  ROLLOVER_SETTINGS_CHANGED: 'rollover:settings_changed',
  FORM_FIELD_CHANGED: 'form:field_changed'
} as const;

// Export type for Events keys
export type EventName = typeof Events[keyof typeof Events];

// ==========================================
// INITIALIZATION
// ==========================================

// Set up common event throttling (only for events that are actively emitted)
setEventThrottle('scroll', 50);                   // Throttle scroll events

// ==========================================
// EXPORTS
// ==========================================

// Default export kept for backwards compatibility (all consumers use named imports)
export default {
  emit,
  emitImmediate,
  on,
  off,
  clearAll,
  Events
};
