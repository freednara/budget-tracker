/**
 * Shared batching infrastructure for state actions.
 *
 * All action modules that need to queue events during batched updates
 * import `queueEvent` from this file. The `batchUpdates` function is
 * the public API consumers use to wrap multi-signal mutations.
 *
 * @module actions/action-utils
 */
import { batch } from '@preact/signals-core';
import { emit } from '../event-bus.js';
import { trackError } from '../error-tracker.js';

interface PendingEvent {
  event: string;
  payload: unknown;
}

let batchDepth = 0;
let pendingEvents: PendingEvent[] = [];

/**
 * Batch multiple state changes into a single render cycle.
 * Events are collected and emitted after all changes complete.
 *
 * rev 12 L38 (#32 observability): when `fn` throws, accumulated events are
 * dropped instead of flushed. Emitting events after a partial-failure would
 * expose subscribers to state reflecting the pre-throw partial mutation —
 * the canonical "subscribers see budget allocation update without the paired
 * transaction insert" hazard. The throw still propagates to the caller; we
 * simultaneously route it through `trackError` so the dropped batch is
 * visible in prod telemetry. Without this, both the failure *and* the
 * subscriber starvation are silent.
 */
export function batchUpdates(fn: () => void): void {
  batchDepth++;
  let caughtErr: unknown = null;
  let didThrow = false;
  try {
    batch(fn);
  } catch (err) {
    didThrow = true;
    caughtErr = err;
    throw err;
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      if (didThrow) {
        // Drop pending events — emitting them after a partial-failure
        // would expose subscribers to inconsistent intermediate state.
        pendingEvents = [];
        try {
          trackError(
            caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr)),
            { module: 'ActionUtils', action: 'batchUpdates_threw' }
          );
        } catch {
          // trackError must never mask the original throw; the caller
          // already gets `caughtErr` via the `throw err` above.
        }
      } else {
        flushPendingEvents();
      }
    }
  }
}

/**
 * Queue an event for emission (used internally during batching)
 */
export function queueEvent(event: string, payload?: unknown): void {
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
