/**
 * Global Error Handler — minimal adapter over error-tracker.ts
 *
 * Phase 5g-3 (Inline-Behavior-Review rev 12, L50 — re-scoped):
 * L50's original premise was "zero external importers — delete the whole
 * 157-LOC module." Re-verification during Phase 5g-3 found one live
 * importer (`form-events.ts`'s `handleError` call established by Phase
 * 5g-2 / L34 and already present before that slice). L50's deeper
 * concern — that the `logDebug`/`logInfo`/`logWarning`/`logError` shims
 * route level-tagged messages through the error queue (so a future
 * `logDebug('x')` call would pollute error telemetry) — remains valid,
 * and all of those shims plus `createLogger`, `tryOperation`, the
 * `installGlobalHandlers` re-export, and the `errorTracker` re-export
 * const were grep-verified zero-caller. The re-scoped fix: delete the
 * misleading level-tagged API surface and the unused internal types,
 * keep only the `handleError` adapter that `form-events.ts` depends on.
 * Module shrunk from 156 LOC to ~35 LOC.
 *
 * @module global-error-handler
 */

import { displayError } from './error-tracker.js';

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — `handleError()` callers commonly pass
// `{ module: someVar }` where `someVar` is typed as `string | undefined`.
export interface ErrorContext {
  module?: string | undefined;
  operation?: string | undefined;
}

/**
 * Route a caught error through trackError (telemetry) + displayError
 * (user-facing toast). For narrower telemetry-only or toast-only paths,
 * call `trackError` / `displayError` directly instead of using this
 * adapter.
 */
export function handleError(
  message: string,
  error?: Error | unknown,
  context?: ErrorContext
): void {
  const err = error instanceof Error ? error : new Error(message);

  // CR-Apr24-G finding 267: removed direct trackError call because
  // displayError already calls trackError internally. Calling both
  // double-tracked every failure in telemetry.
  displayError(err, {
    userMessage: message,
    context: {
      module: context?.module || 'GlobalErrorHandler',
      action: context?.operation || 'error',
    },
  });
}
