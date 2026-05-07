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

import { trackError } from './error-tracker.js';
import { generateSecureId } from './utils-dom.js';
import { CONFIG } from './config.js';

const DEV = import.meta.env.DEV;

// Prevent infinite recursion when a listener failure's trackError call
// itself goes through the event bus (e.g. if error-tracker listeners
// re-emit SHOW_TOAST which in turn has a failing handler).
let isReportingListenerFailure = false;

function isEventDebugEnabled(): boolean {
  return DEV && typeof window !== 'undefined' && window.__APP_DEBUG_EVENTS__ === true;
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Subscribers may be sync or async. Returning a Promise is supported so
// callers don't have to wrap every `on(EVENT, async () => {...})` call in
// an IIFE just to satisfy no-misused-promises. Rejection handling is
// centralized in emitImmediate (mirrors the AsyncEventHandler pattern in
// event-binding.ts): async subscribers that throw are routed through
// trackError rather than becoming unhandled rejections.
export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export type UnsubscribeFn = () => void;

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — the subscribe()-site payload passes
// `groupId: options?.groupId` / `componentName: options?.componentName`
// straight through as `string | undefined`.
export interface EventSubscription {
  event: string;
  /** The wrapped handler stored in the listeners Set. */
  handler: EventHandler;
  /** CR-Apr24-I finding 275: original unwrapped handler for off() matching. */
  originalHandler: EventHandler;
  unsubscribe: UnsubscribeFn;
  id: string;
  groupId?: string | undefined;
  componentName?: string | undefined;
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
const MEMORY_CHECK_INTERVAL = CONFIG.TIMING.PERIODIC_CLEANUP_INTERVAL;

// Memory monitoring
let memoryCheckTimer: number | null = null;
let totalSubscriptions = 0;

// rev 12 M36 (#32 observability): memory-leak signals were DEV-only-
// logged, so a real leak in prod produced no telemetry at all. These
// two pieces of state rate-limit the new trackError calls so we surface
// breaches without spamming every emit / every minute.
//
// `reportedHighListenerEvents` — fire once per (event, breach); clear
// when the listener count drops back under threshold so a true leak
// that recurs after cleanup still surfaces.
//
// `lastTotalSubsBand` — band transitions only. "normal" → "warn" fires
// once; staying in "warn" during subsequent 1-minute checks does not.
const reportedHighListenerEvents = new Set<string>();
type SubsBand = 'normal' | 'warn' | 'critical';
let lastTotalSubsBand: SubsBand = 'normal';
let lastOldSubsReportedAt = 0;
const OLD_SUBS_REPORT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

// ==========================================
// LIFECYCLE MANAGEMENT
// ==========================================

/**
 * Create a listener group for a component
 * This enables bulk cleanup when the component is destroyed
 */
export function createListenerGroup(componentName: string): string {
  // Fixes L61 (Inline-Behavior-Review rev 12): use the
  // crypto.getRandomValues-backed helper so group/subscription IDs
  // follow the same standard as transaction / savings-goal / debt IDs
  // (generateSecureId). Prior `Date.now()+Math.random()` pair is both
  // predictable and collision-prone under rapid component churn.
  const groupId = `group_${generateSecureId()}`;
  
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
    // rev 12 M36 (#32 observability): surface once per (event, breach).
    // Prior DEV-only log meant a genuine memory leak on this event went
    // undetected in prod until users complained of runaway memory.
    if (!reportedHighListenerEvents.has(event)) {
      reportedHighListenerEvents.add(event);
      trackError(
        new Error(`Event "${event}" has ${handlerCount} listeners (max ${MAX_LISTENERS_PER_EVENT}); possible memory leak`),
        { module: 'event-bus', action: `high_listener_count_${event}` }
      );
    }
  } else if (reportedHighListenerEvents.has(event)) {
    // Cleared below threshold — allow the next breach to re-fire telemetry.
    reportedHighListenerEvents.delete(event);
  }

  for (const fn of handlers) {
    try {
      // EventHandler may return void or Promise<void>. If it returns a
      // Promise, attach a rejection handler so async subscribers that
      // throw are routed through trackError rather than surfacing as
      // unhandled rejections. Parallels the AsyncEventHandler pattern
      // in event-binding.ts.
      const result = fn(payload);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((asyncErr: unknown) => {
          reportListenerFailure(event, asyncErr);
        });
      }
    } catch (e) {
      // Fixes H20 (Inline-Behavior-Review rev 12): listener exceptions
      // used to be DEV-only console.error. Promote to trackError so a
      // broken subscriber is visible in production telemetry.
      reportListenerFailure(event, e);
    }
  }
}

/**
 * Centralized listener-failure reporter. Used for both sync throws and
 * async rejections so the trackError cooldown and recursion guard apply
 * uniformly to every failure path out of emitImmediate.
 */
function reportListenerFailure(event: string, e: unknown): void {
  if (DEV) console.error(`Event handler failed for ${event}:`, e);
  if (isReportingListenerFailure) return;
  isReportingListenerFailure = true;
  try {
    const err = e instanceof Error ? e : new Error(String(e));
    trackError(err, {
      module: 'event-bus',
      action: `emitImmediate:${event}`
    });
  } catch (reportErr) {
    // Telemetry pipeline itself failed — never let that break the
    // remaining listener loop. Log DEV-only and continue.
    if (DEV) console.error('[event-bus] trackError failed while reporting listener exception:', reportErr);
  } finally {
    isReportingListenerFailure = false;
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

  // CR-Apr24-I finding 275: wrap the handler so each subscription gets
  // a unique function reference in the Set. Without this, two `on(event,
  // sameFn)` calls share one Set entry, so the second is a silent no-op
  // and removing one tears down the other.
  const wrappedHandler: EventHandler = (payload: unknown) => (handler as EventHandler)(payload);

  // Add to listeners (Set for O(1) add/delete)
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(wrappedHandler);

  // Create subscription record
  // L61: same rationale as createListenerGroup above — single ID standard.
  const subscriptionId = `sub_${generateSecureId()}`;
  const subscription: EventSubscription = {
    event,
    handler: wrappedHandler,
    originalHandler: handler as EventHandler,
    unsubscribe: () => removeSubscriptionById(subscriptionId),
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
  // CR-Apr24-I finding 275: match on originalHandler (the unwrapped
  // function the caller passed to on()), not the wrapped handler stored
  // in the Set.
  const matchingSubs = Array.from(subscriptions.values())
    .filter((subscription) => subscription.event === event && subscription.originalHandler === handler);

  if (matchingSubs.length === 0) {
    // Legacy fallback: handler might have been added without on()
    detachHandler(event, handler);
    return;
  }

  // CR-Apr24-I finding 276: only remove the FIRST matching subscription,
  // not all of them. This way each off() call balances exactly one on().
  removeSubscriptionById(matchingSubs[0]!.id);
}

function detachHandler(event: string, handler: EventHandler): void {
  const handlers = listeners.get(event);
  if (!handlers) return;

  handlers.delete(handler);

  if (handlers.size === 0) {
    listeners.delete(event);
    eventMetrics.delete(event);
    lastEmitTimes.delete(event);
    // CR-Apr24-I finding 271: clean up per-event throttle config when
    // the last listener is removed, so stale throttle delays don't
    // accumulate across the session.
    throttleDelays.delete(event);
    // Also cancel any pending trailing emit for this event.
    const pending = pendingTrailingEmits.get(event);
    if (pending) {
      clearTimeout(pending.timerId);
      pendingTrailingEmits.delete(event);
    }
  }
}

function removeSubscriptionById(subscriptionId: string): void {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) return;

  detachHandler(subscription.event, subscription.handler);
  subscriptions.delete(subscriptionId);
  totalSubscriptions = Math.max(0, totalSubscriptions - 1);

  // CR-Apr24-I finding 278: stop the memory-monitor interval immediately
  // when the last subscription is removed, instead of waiting for the
  // next 1-minute periodic sweep.
  if (totalSubscriptions === 0 && memoryCheckTimer) {
    clearInterval(memoryCheckTimer);
    memoryCheckTimer = null;
  }

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

  // CR-Apr24-I finding 272: reset leak-telemetry suppression state so
  // a fresh round of subscriptions can fire breach signals normally.
  reportedHighListenerEvents.clear();
  lastTotalSubsBand = 'normal';
  lastOldSubsReportedAt = 0;
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
  for (const [, subscription] of subscriptions) {
    if (now - subscription.createdAt > 600000) { // 10 minutes
      oldSubscriptions.push(subscription);
    }
  }
  
  if (oldSubscriptions.length > 20) {
    const componentBreakdown = oldSubscriptions.reduce<Record<string, number>>((acc, sub) => {
      const name = sub.componentName || 'unknown';
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});

    if (isEventDebugEnabled()) console.warn(`Found ${oldSubscriptions.length} old event subscriptions. Potential memory leak.`, {
      componentBreakdown
    });

    // rev 12 M36 (#32 observability): the stale-subscription leak signal
    // was gated behind both `DEV` *and* a window debug flag — effectively
    // invisible everywhere except an explicit developer-opted-in session.
    // Surface in prod telemetry with a 5-minute cooldown so the periodic
    // 1-minute check doesn't turn into a telemetry firehose while the
    // leak persists.
    const now = Date.now();
    if (now - lastOldSubsReportedAt > OLD_SUBS_REPORT_COOLDOWN_MS) {
      lastOldSubsReportedAt = now;
      const topComponents = Object.entries(componentBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name}:${count}`)
        .join(',');
      trackError(
        new Error(`event-bus: ${oldSubscriptions.length} stale subscriptions (top: ${topComponents})`),
        { module: 'event-bus', action: 'stale_subscriptions_detected' }
      );
    }
  }

  // Warn if approaching threshold, error if critical.
  // rev 12 M36 (#32 observability): band-transition telemetry — fire
  // once on entering the `warn` band (>200) and once on entering the
  // `critical` band (>500). Sustained residence in a band does NOT
  // refire every minute; dropping back to `normal` re-arms both bands.
  let nextBand: SubsBand = 'normal';
  if (totalSubscriptions > 500) nextBand = 'critical';
  else if (totalSubscriptions > 200) nextBand = 'warn';

  if (nextBand !== lastTotalSubsBand) {
    if (nextBand === 'warn') {
      if (isEventDebugEnabled()) console.warn(`High event subscription count (${totalSubscriptions}). Monitor for memory leaks.`);
      trackError(
        new Error(`event-bus: high subscription count (${totalSubscriptions}, threshold 200)`),
        { module: 'event-bus', action: 'subscription_count_warn' }
      );
    } else if (nextBand === 'critical') {
      if (isEventDebugEnabled()) console.error(`Too many event subscriptions (${totalSubscriptions}). Memory leak detected.`);
      trackError(
        new Error(`event-bus: memory leak — ${totalSubscriptions} subscriptions (threshold 500)`),
        { module: 'event-bus', action: 'subscription_count_critical' }
      );
    }
    lastTotalSubsBand = nextBand;
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
  // CR-Apr24-I finding 273: return live listener counts instead of the
  // stale snapshot updated only during emitImmediate.
  return Array.from(eventMetrics.values()).map(m => ({
    ...m,
    listenerCount: listeners.get(m.name)?.size ?? 0
  }));
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

/**
 * Standard event names for the application event bus.
 *
 * Events are organized into four tiers:
 * - **Active**: Both emitted and listened to in the current codebase.
 * - **Extension points**: Emitted but no listeners yet — ready for future features.
 * - **UI bridge**: Decouple non-UI layers from direct UI imports (core/features → UI).
 * - **Reserved**: Placeholder names for planned features — no emitters or listeners yet.
 */
export const Events = {
  // ---- ACTIVE EVENTS (both emitted and listened) ----

  /** Payload: `Transaction` — Fired after a single transaction is persisted. */
  TRANSACTION_ADDED: 'transaction:added',
  /** Payload: `{ transactions: Transaction[]; count: number }` — Fired after a batch of transactions is persisted (e.g., recurring generation, splits). */
  TRANSACTIONS_BATCH_ADDED: 'transactions:batch_added',
  /** Payload: `Transaction` — Fired after an existing transaction is modified. */
  TRANSACTION_UPDATED: 'transaction:updated',
  /** Payload: `Transaction[]` — Fired when the entire transaction ledger is replaced (e.g., import). */
  TRANSACTIONS_REPLACED: 'transactions:replaced',
  /** Payload: `{ id: string }` — Fired after a transaction is deleted by ID. */
  TRANSACTION_DELETED: 'transaction:deleted',
  /** Payload: `{ month: string }` — Fired when the active month changes (format `YYYY-MM`). */
  MONTH_CHANGED: 'month:changed',
  /** Payload: `MonthAllocations` — Fired when budget allocations are saved. */
  BUDGET_UPDATED: 'budget:updated',
  /** Payload: `SavingsGoal[]` — Fired when savings goals are modified. */
  SAVINGS_UPDATED: 'savings:updated',
  /** Payload: `void` — Fired when category configuration changes. */
  CATEGORY_UPDATED: 'category:updated',
  /** Payload: `void` — Fired after a full data import completes (backup restore, CSV import, merge). */
  DATA_IMPORTED: 'data:imported',
  /** Payload: `CurrencySettings` — Fired when the app currency changes. CR-Apr24-I finding 74. */
  CURRENCY_CHANGED: 'currency:changed',

  // ---- EXTENSION POINTS (emitted but no listeners yet) ----

  /** Payload: `{ tab: string }` — Fired when the active navigation tab changes. */
  TAB_CHANGED: 'tab:changed',
  /** Payload: `{ ids: string[] }` — Fired when a batch of transactions is rolled back. */
  TRANSACTION_ROLLBACK_BATCH: 'transaction:rollback_batch',
  /** Payload: `{ goalId: string; amount: number }` — Fired after a savings contribution is recorded. */
  SAVINGS_CONTRIBUTION_ADDED: 'savings:contribution_added',
  /** Payload: `{ templateId: string; template: TxTemplate }` — Fired when a saved template is applied to the form. */
  TEMPLATE_APPLIED: 'template:applied',
  /** Payload: `{ type: string }` — Fired when the transaction form is submitted. */
  FORM_SUBMITTED: 'form:submitted',
  /** Payload: `{ isValid: boolean; errors: string[] }` — Fired after form validation completes. */
  FORM_VALIDATED: 'form:validated',
  /** Payload: `void` — Fired when cross-tab storage sync occurs. */
  STORAGE_SYNC: 'storage:sync',
  /** Payload: `Debt` — Fired after a new debt is added. */
  DEBT_ADDED: 'debt:added',
  /** Payload: `Debt` — Fired after an existing debt is modified. */
  DEBT_UPDATED: 'debt:updated',
  /** Payload: `{ id: string }` — Fired after a debt is deleted. */
  DEBT_DELETED: 'debt:deleted',
  /** Payload: `DebtPayment` — Fired after a debt payment is recorded. */
  DEBT_PAYMENT: 'debt:payment',

  // ---- UI BRIDGE (core → UI layer without direct imports) ----

  /** Payload: `{ message: string; type?: 'info' | 'success' | 'warning' | 'error' }` — Shows a toast notification. */
  SHOW_TOAST: 'ui:show_toast',
  /** Payload: `{ id: string }` — Opens a modal by its DOM element ID. */
  OPEN_MODAL: 'ui:open_modal',
  /** Payload: `{ id: string }` — Closes a modal by its DOM element ID. */
  CLOSE_MODAL: 'ui:close_modal',
  /** Payload: `{ title: string; text?: string; showBar?: boolean }` — Shows a progress overlay. */
  SHOW_PROGRESS: 'ui:show_progress',
  /** Payload: `{}` — Hides the progress overlay. */
  HIDE_PROGRESS: 'ui:hide_progress',

  // ---- RESERVED (no emitters or listeners yet — define when needed) ----

  /** @reserved Payload TBD — For transaction merge operations. */
  TRANSACTION_MERGED: 'transaction:merged',
  /** @reserved Payload TBD — For transaction split operations. */
  TRANSACTION_SPLIT: 'transaction:split',
  /** @reserved Payload TBD — For filter state changes. */
  FILTER_CHANGED: 'filter:changed',
  /** @reserved Payload TBD — For theme switch events. */
  THEME_CHANGED: 'theme:changed',
  /** @reserved Payload TBD — For new savings goal creation. */
  SAVINGS_GOAL_ADDED: 'savings:goal_added',
  /** @reserved Payload TBD — For savings goal deletion. */
  SAVINGS_GOAL_DELETED: 'savings:goal_deleted',
  /** @reserved Payload TBD — For debt fully paid off celebrations. */
  DEBT_PAID_OFF: 'debt:paid_off',
  /** @reserved Payload TBD — For rollover configuration changes. */
  ROLLOVER_SETTINGS_CHANGED: 'rollover:settings_changed',
  /** @reserved Payload TBD — For individual form field changes. */
  FORM_FIELD_CHANGED: 'form:field_changed'
} as const;

// Export type for Events keys
export type EventName = typeof Events[keyof typeof Events];

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Install the event bus's default throttle configuration.
 *
 * Fixes L60 (Inline-Behavior-Review rev 12): the previous implementation
 * called `setEventThrottle('scroll', 50)` at module-import time, which made
 * the module impossible to import for types alone (any type-only import
 * in a test harness would mutate the bus state and leak across scenarios).
 * Boot code now calls `initEventBusDefaults()` explicitly; tests that want
 * the defaults call it themselves, and tests that don't skip the side effect.
 *
 * Safe to call multiple times — `setEventThrottle` is idempotent.
 */
export function initEventBusDefaults(): void {
  setEventThrottle('scroll', 50);
}

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
  initEventBusDefaults,
  Events
};
